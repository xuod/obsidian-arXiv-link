import { EditorExtensions } from "editor-enhancements";
import { Plugin, Editor } from "obsidian";
import {
	AutoLinkTitleSettings,
	AutoLinkTitleSettingTab,
	DEFAULT_SETTINGS,
} from "./settings";
import { CheckIf } from "checkif";
import getPageTitle from "scraper";

interface PasteFunction {
	(this: HTMLElement, ev: ClipboardEvent): void;
}

export default class AutoLinkTitle extends Plugin {
	settings: AutoLinkTitleSettings;
	pasteFunction: PasteFunction;
	blacklist: Array<string>;

	async onload() {
		console.log("loading obsidian-auto-link-title");
		await this.loadSettings();

		this.blacklist = this.settings.websiteBlacklist.split(",").map(s => s.trim()).filter(s => s.length > 0)

		// Listen to paste event
		this.pasteFunction = this.pasteUrlWithTitle.bind(this);

		this.addCommand({
			id: "auto-link-title-paste",
			name: "Paste URL and auto fetch title",
			editorCallback: (editor) => this.manualPasteUrlWithTitle(editor),
			hotkeys: [],
		});

		this.addCommand({
			id: "auto-link-title-normal-paste",
			name: "Normal paste (no fetching behavior)",
			editorCallback: (editor) => this.normalPaste(editor),
			hotkeys: [
				{
					modifiers: ["Mod", "Shift"],
					key: "v",
				},
			],
		});

		this.registerEvent(
			this.app.workspace.on("editor-paste", this.pasteFunction)
		);

		this.addCommand({
			id: "enhance-url-with-title",
			name: "Enhance existing URL with link and title",
			editorCallback: (editor) => this.addTitleToLink(editor),
			hotkeys: [
				{
					modifiers: ["Mod", "Shift"],
					key: "e",
				},
			],
		});

		this.addSettingTab(new AutoLinkTitleSettingTab(this.app, this));
	}

	addTitleToLink(editor: Editor): void {
		// Only attempt fetch if online
		if (!navigator.onLine) return;

		let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();

		// If the cursor is on a raw html link, convert to a markdown link and fetch title
		if (CheckIf.isUrl(selectedText)) {
			this.convertUrlToTitledLink(editor, selectedText);
		}
		// If the cursor is on the URL part of a markdown link, fetch title and replace existing link title
		else if (CheckIf.isLinkedUrl(selectedText)) {
			var link = this.getUrlFromLink(selectedText);
			this.convertUrlToTitledLink(editor, link);
		}
	}

	async normalPaste(editor: Editor): Promise<void> {

		let clipboardText = await navigator.clipboard.readText();
		if (clipboardText === null || clipboardText === "") return;

		editor.replaceSelection(clipboardText);
	}

	// Simulate standard paste but using editor.replaceSelection with clipboard text since we can't seem to dispatch a paste event.
	async manualPasteUrlWithTitle(editor: Editor): Promise<void> {

		// Only attempt fetch if online
		if (!navigator.onLine) {
			editor.replaceSelection(clipboardText);
			return;
		}

		var clipboardText = await navigator.clipboard.readText();
		if (clipboardText == null || clipboardText == "") return;

		// If its not a URL, we return false to allow the default paste handler to take care of it.
		// Similarly, image urls don't have a meaningful <title> attribute so downloading it
		// to fetch the title is a waste of bandwidth.
		if (!CheckIf.isUrl(clipboardText) || CheckIf.isImage(clipboardText)) {
			editor.replaceSelection(clipboardText);
			return;
		}

		let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();
		if (selectedText && !this.settings.shouldReplaceSelection) {
			// If there is selected text and shouldReplaceSelection is false, do not fetch title
			editor.replaceSelection(clipboardText);
			return;
		}

		// If it looks like we're pasting the url into a markdown link already, don't fetch title
		// as the user has already probably put a meaningful title, also it would lead to the title
		// being inside the link.
		if (CheckIf.isMarkdownLinkAlready(editor) || CheckIf.isAfterQuote(editor)) {
			editor.replaceSelection(clipboardText);
			return;
		}

		// At this point we're just pasting a link in a normal fashion, fetch its title.
		this.convertUrlToTitledLink(editor, clipboardText);
		return;
	}

	async pasteUrlWithTitle(clipboard: ClipboardEvent, editor: Editor): Promise<void> {
		if (!this.settings.enhanceDefaultPaste) {
			return;
		}

		// Only attempt fetch if online
		if (!navigator.onLine) return;

		let clipboardText = clipboard.clipboardData.getData("text/plain");
		if (clipboardText === null || clipboardText === "") return;

		// If its not a URL, we return false to allow the default paste handler to take care of it.
		// Similarly, image urls don't have a meaningful <title> attribute so downloading it
		// to fetch the title is a waste of bandwidth.
		if (!CheckIf.isUrl(clipboardText) || CheckIf.isImage(clipboardText)) {
			return;
		}

		let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();
		if (selectedText && !this.settings.shouldReplaceSelection) {
			// If there is selected text and shouldReplaceSelection is false, do not fetch title
			return;
		}

		// We've decided to handle the paste, stop propagation to the default handler.
		clipboard.stopPropagation();
		clipboard.preventDefault();

		// If it looks like we're pasting the url into a markdown link already, don't fetch title
		// as the user has already probably put a meaningful title, also it would lead to the title
		// being inside the link.
		if (CheckIf.isMarkdownLinkAlready(editor) || CheckIf.isAfterQuote(editor)) {
			editor.replaceSelection(clipboardText);
			return;
		}

		// At this point we're just pasting a link in a normal fashion, fetch its title.
		this.convertUrlToTitledLink(editor, clipboardText);
		return;
	}

	async isBlacklisted(url: string): Promise<boolean> {
		await this.loadSettings();
		this.blacklist = this.settings.websiteBlacklist.split(/,|\n/).map(s => s.trim()).filter(s => s.length > 0)
		return this.blacklist.some(site => url.contains(site))
	}

	async convertUrlToTitledLink(editor: Editor, url: string): Promise<void> {
		if (await this.isBlacklisted(url)) {
			let domain = new URL(url).hostname;
			editor.replaceSelection(`[${domain}](${url})`);
			return;
		}

		let pasteId = ``;
		let escapedTitle = ``;

		if (url.includes("arxiv.org")) {
			// Generate a unique id for find/replace operations for the title.
			pasteId += `Fetching arXiv data #${this.createBlockHash()} :`;

			// Instantly paste so you don't wonder if paste is broken
			editor.replaceSelection(`${pasteId}`);

			// Fetch arXiv metadata and format with template
			escapedTitle += await this.getarXivTitle(url);
		}
		else {
			// Generate a unique id for find/replace operations for the title.
			pasteId += `Fetching Title#${this.createBlockHash()}`;

			// Instantly paste so you don't wonder if paste is broken
			editor.replaceSelection(`[${pasteId}](${url})`);

			// Fetch title from site, replace Fetching Title with actual title
			const title = await this.fetchUrlTitle(url);

			escapedTitle += this.escapeMarkdown(title);
		}

		const text = editor.getValue();

		const start = text.indexOf(pasteId);
		if (start < 0) {
			console.log(
				`Unable to find text "${pasteId}" in current editor, bailing out; link ${url}`
			);
		} else {
			const end = start + pasteId.length;
			const startPos = EditorExtensions.getEditorPositionFromIndex(text, start);
			const endPos = EditorExtensions.getEditorPositionFromIndex(text, end);

			editor.replaceRange(escapedTitle, startPos, endPos);
		}
	}

	escapeMarkdown(text: string): string {
		var unescaped = text.replace(/\\(\*|_|`|~|\\|\[|\])/g, '$1'); // unescape any "backslashed" character
		var escaped = unescaped.replace(/(\*|_|`|~|\\|\[|\])/g, '\\$1'); // escape *, _, `, ~, \, [, ]
		return escaped.replace(/(\r\n|\n|\r)/gm, " ").replace("  ", " ").trim();
	}

	async fetchUrlTitle(url: string): Promise<string> {
		try {
			const title = await getPageTitle(url);
			return title.replace(/(\r\n|\n|\r)/gm, "").trim();
		} catch (error) {
			console.error(error)
			return "Site Unreachable";
		}
	}

	public getUrlFromLink(link: string): string {
		let urlRegex = new RegExp(DEFAULT_SETTINGS.linkRegex);
		return urlRegex.exec(link)[2];
	}

	// Custom hashid by @shabegom
	private createBlockHash(): string {
		let result = "";
		var characters = "abcdefghijklmnopqrstuvwxyz0123456789";
		var charactersLength = characters.length;
		for (var i = 0; i < 4; i++) {
			result += characters.charAt(Math.floor(Math.random() * charactersLength));
		}
		return result;
	}


	public getIdentifierFromUrl(url: string): string {
		//if url ends in / remove it
		if (url.endsWith("/"))
			url = url.slice(0, -1);
		return url.split("/").slice(-1)[0];
	}

	async getarXivTitle(url: string): Promise<string> {
		try {
			let id = this.getIdentifierFromUrl(url);

			let response = await fetch(`https://export.arxiv.org/api/query?id_list=` + id)
			let data = await response.text()

			let parser = new DOMParser();
			let xmlDoc = parser.parseFromString(data, "text/xml");

			let title =
				xmlDoc.getElementsByTagName("title")[1].textContent;
			let abstract =
				xmlDoc.getElementsByTagName("summary")[0].textContent;
			let authors = xmlDoc.getElementsByTagName("author");
			let authorString = "";
			for (let i = 0; i < authors.length; i++) {
				if (i > 0) {
					authorString += ", ";
				}
				authorString +=
					authors[i].getElementsByTagName("name")[0]
						.textContent;
			}
			let date =
				xmlDoc.getElementsByTagName("published")[0]
					.textContent;
			if (date) date = date.split("T")[0]; //make the date human-friendly

			if (title == null) title = "undefined";

			// const dateNow = new Date(Date.now());
			// let doi = xmlDoc.getElementsByTagName("doi")[0].textContent;

			let content = this.settings.template;
			content = content.replace("{{TITLE}}", this.escapeMarkdown(title));
			content = content.replace("{{AUTHOR}}", this.escapeMarkdown(authorString));
			content = content.replace("{{ABSTRACT}}", abstract.replace(/(\r\n|\n|\r)/gm, " ").replace("  ", " ").trim());
			content = content.replace("{{DATEPUBLISHED}}", date);
			content = content.replace("{{URL}}", url);
			content = content.replace("{{ARXIVID}}", id);
			// content = content.replace("{{DATEREAD}}", dateNow);
			// content = content.replace("{{DOI}}", doi);

			return content

		} catch (error) {
			console.error(error);
			return "arXiv unreachable or error";
		}
	}

	onunload() {
		console.log("unloading obsidian-auto-link-title");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
