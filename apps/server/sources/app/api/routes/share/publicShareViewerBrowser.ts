/// <reference lib="dom" />

import { disposePublicShareViewerContent, loadPublicShareViewerContent, renderPublicShareViewer } from "./publicShareViewerClient";
import { readArtifactHtmlPreviewBundleV1 } from '@happier-dev/protocol/sharing/public-viewer';
import { renderArtifactHtmlViewer } from './artifactHtmlViewer';

const root = document.getElementById("public-share-viewer");
if (root) {
    if (/^\/a\/[^/]+\/?$/u.test(location.pathname)) {
        const render = (): void => {
            try {
                if (location.protocol !== 'https:') throw new Error('HTTPS is required');
                renderArtifactHtmlViewer(root, readArtifactHtmlPreviewBundleV1(location.hash), 'HTML Artifact');
            } catch { root.textContent = 'This HTML document could not be opened. JavaScript modules and external assets are unsupported; publish a classic script bundle with local assets.'; }
        };
        globalThis.addEventListener('hashchange', render);
        render();
    } else {
    let consent = false;
    let text = "";
    let token: string | null = null;
    let current: Extract<Awaited<ReturnType<typeof loadPublicShareViewerContent>>, { status: "ready" }> | null = null;
    const load = async (beforeSeq?: number): Promise<void> => {
        const fragment = location.hash;
        const result = await loadPublicShareViewerContent({ location, fetch: globalThis.fetch.bind(globalThis), consent, beforeSeq, messagesAccessToken: token });
        if (location.hash !== fragment) return;
        if (result.status === "ready") {
            token = result.messagesAccessToken ?? token;
            text = beforeSeq === undefined ? result.text : [result.text, text].filter(Boolean).join("\n\n");
            current = { ...result, text };
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
        token = null;
        current = null;
        root.textContent = "Opening shared content…";
        void load();
    });
    void load();
    }
}
