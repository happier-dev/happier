/// <reference lib="dom" />

import { disposePublicShareViewerContent, loadPublicShareViewerContent, renderPublicShareViewer, type PublicSessionOpenedMessage } from "./publicShareViewerClient";

const root = document.getElementById("public-share-viewer");
if (root) {
    let consent = false;
    let text = "";
    let messages: readonly PublicSessionOpenedMessage[] = [];
    let token: string | null = null;
    let current: Extract<Awaited<ReturnType<typeof loadPublicShareViewerContent>>, { status: "ready" }> | null = null;
    const load = async (beforeSeq?: number): Promise<void> => {
        const fragment = location.hash;
        const result = await loadPublicShareViewerContent({ location, fetch: globalThis.fetch.bind(globalThis), consent, beforeSeq, messagesAccessToken: token });
        if (location.hash !== fragment) return;
        if (result.status === "ready") {
            token = result.messagesAccessToken ?? token;
            text = beforeSeq === undefined ? result.text : [result.text, text].filter(Boolean).join("\n\n");
            if (result.messages) {
                const byId = new Map((beforeSeq === undefined ? [] : messages).map(message => [message.id, message]));
                for (const message of result.messages) byId.set(message.id, message);
                messages = [...byId.values()].sort((left, right) => left.seq - right.seq);
                text = messages.map(message => message.text).join('\n\n');
            }
            current = { ...result, text, ...(result.messages ? { messages } : {}) };
            renderPublicShareViewer(root, current, result.nextBeforeSeq === null ? undefined : () => { void load(result.nextBeforeSeq!); });
        } else if (result.status === "network_error" && current && beforeSeq !== undefined) {
            renderPublicShareViewer(root, current, () => { void load(beforeSeq); });
            const notice = root.ownerDocument.createElement("p");
            notice.textContent = "Earlier messages could not be reached. Try again.";
            root.append(notice);
        } else {
            renderPublicShareViewer(root, result, result.status === "consent_required" ? () => { consent = true; void load(); }
                : result.status === "network_error" ? () => { void load(beforeSeq); } : undefined);
        }
    };
    globalThis.addEventListener("hashchange", () => {
        disposePublicShareViewerContent(root);
        consent = false;
        text = "";
        messages = [];
        token = null;
        current = null;
        root.textContent = "Opening shared content…";
        void load();
    });
    void load();
}
