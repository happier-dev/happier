/// <reference lib="dom" />

import {
    decodeBase64, decodePlainArtifactStoredContent, isPlainArtifactStoredContent,
    openPublicShareDataKeyV1, openSessionDataKeyBundleV0,
    readStoredContentPublicShareSecretV1, StoredContentPublicShareReadResponseV1Schema,
    ArtifactBlobReferenceV1Schema, artifactHtmlBundleFromBodyV1, isArtifactHtmlHeaderV1,
    readSessionDataKeyBundleV0, openAesGcmPayloadWebCrypto, type ArtifactHtmlBundleV1,
} from "@happier-dev/protocol/sharing/public-viewer";
import { renderArtifactHtmlViewer } from './artifactHtmlViewer';

export type PublicShareViewerResult =
    | { status: "ready"; title: string; text: string; html?: ArtifactHtmlBundleV1; binary?: { bytes: Uint8Array; mime: string }; nextBeforeSeq: number | null; messagesAccessToken: string | null }
    | { status: "invalid_link" | "unavailable" | "invalid_content" | "consent_required" | "network_error" | "metadata_privacy_upgrade_required" };

interface ViewerInput {
    location: Pick<Location, "pathname" | "hash" | "origin">;
    fetch: typeof fetch;
    consent?: boolean;
    beforeSeq?: number;
    messagesAccessToken?: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// This is presentation only. Structured transcript records remain readable without
// interpreting their tool payloads, links, HTML, or executable content.
function contentText(value: unknown): string {
    if (typeof value === "string") return value;
    const entry = record(value);
    if (typeof entry?.text === "string") return entry.text;
    const content = record(entry?.content);
    if (typeof content?.text === "string") return content.text;
    return JSON.stringify(value, null, 2) ?? "";
}

export async function loadPublicShareViewerContent(input: ViewerInput): Promise<PublicShareViewerResult> {
    const secret = readStoredContentPublicShareSecretV1(input.location.hash);
    const match = /^\/s\/([^/]+)\/?$/.exec(input.location.pathname);
    if (!secret || !match) return { status: "invalid_link" };
    let lookupId: string;
    try { lookupId = decodeURIComponent(match[1]); } catch { return { status: "invalid_link" }; }
    const url = new URL(`/v1/public-shares/${encodeURIComponent(lookupId)}/content`, input.location.origin);
    if (input.consent) url.searchParams.set("consent", "true");
    if (input.beforeSeq !== undefined) url.searchParams.set("beforeSeq", String(input.beforeSeq));
    let response: Response;
    try {
        response = await input.fetch(url.toString(), {
            credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
            ...(input.messagesAccessToken ? { headers: { "x-public-share-messages-access-token": input.messagesAccessToken } } : {}),
        });
    } catch { return { status: "network_error" }; }
    if (response.status === 503) return { status: "network_error" };
    let raw: unknown;
    try { raw = await response.json(); } catch { return { status: response.ok ? "invalid_content" : "unavailable" }; }
    if (!response.ok) {
        if (response.status === 409 && record(raw)?.code === "metadata_privacy_upgrade_required") return { status: "metadata_privacy_upgrade_required" };
        if (response.status === 403 && record(raw)?.requiresConsent === true) return { status: "consent_required" };
        return { status: "unavailable" };
    }
    const parsed = StoredContentPublicShareReadResponseV1Schema.safeParse(raw);
    if (!parsed.success || parsed.data.keyDerivation !== "fragment_v1") return { status: "invalid_content" };
    const share = parsed.data;
    const key = share.encryptionMode === "e2ee" && share.encryptedDataKey
        ? openPublicShareDataKeyV1({ encryptedDataKey: share.encryptedDataKey, secret }) : null;
    if (share.encryptionMode === "e2ee" && !key) return { status: "invalid_link" };
    const open = async (encoded: string): Promise<unknown> => {
        if (share.encryptionMode === "plain") {
            if (!isPlainArtifactStoredContent(encoded)) throw new Error("Content mode mismatch");
            return decodePlainArtifactStoredContent(encoded);
        }
        const opened = await openSessionDataKeyBundleV0(decodeBase64(encoded), key!);
        if (opened.status !== "authenticated") throw new Error("Content authentication failed");
        return opened.value;
    };
    try {
        if (share.content.kind === "artifact") {
            const header = record(await open(share.content.header));
            const body = record(await open(share.content.body));
            if (!header || !body) return { status: "invalid_content" };
            let html: ArtifactHtmlBundleV1 | undefined;
            let binary: { bytes: Uint8Array; mime: string } | undefined;
            if (body.body !== null && typeof body.body !== 'string') {
                const reference = ArtifactBlobReferenceV1Schema.parse(body.body);
                const blob = share.content.blob;
                if (!blob || blob.blobId !== reference.blobId || (share.encryptionMode === 'plain') !== (blob.content.t === 'plain')) throw new Error('Artifact blob mode mismatch');
                let bytes: Uint8Array;
                if (blob.content.t === 'plain') bytes = decodeBase64(blob.content.v);
                else {
                    const parts = readSessionDataKeyBundleV0(decodeBase64(blob.content.c));
                    if (parts.status !== 'ready' || !key) throw new Error('Artifact blob unavailable');
                    bytes = await openAesGcmPayloadWebCrypto(parts.payload, key);
                }
                const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
                const hash = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
                if (bytes.byteLength !== reference.sizeBytes || hash !== reference.sha256) throw new Error('Artifact blob integrity mismatch');
                if (isArtifactHtmlHeaderV1(header)) html = artifactHtmlBundleFromBodyV1(bytes, reference.mime);
                else binary = { bytes, mime: reference.mime };
            } else if (isArtifactHtmlHeaderV1(header)) {
                if (typeof body.body !== 'string') return { status: 'invalid_content' };
                html = artifactHtmlBundleFromBodyV1(body.body);
            }
            return { status: "ready", title: typeof header.title === "string" ? header.title : "Shared Artifact",
                text: typeof body.body === 'string' ? body.body : '', ...(html ? { html } : {}), ...(binary ? { binary } : {}), nextBeforeSeq: null, messagesAccessToken: null };
        }
        const messages = await Promise.all(share.content.messages.map(async message => {
            if (share.encryptionMode === "plain") {
                if (message.content.t !== "plain") throw new Error("Content mode mismatch");
                return { seq: message.seq, text: contentText(message.content.v) };
            }
            if (message.content.t !== "encrypted") throw new Error("Content mode mismatch");
            return { seq: message.seq, text: contentText(await open(message.content.c)) };
        }));
        return { status: "ready", title: "Shared Session", text: messages.sort((a, b) => a.seq - b.seq).map(message => message.text).join("\n\n"),
            nextBeforeSeq: share.content.hasMore ? share.content.nextBeforeSeq : null,
            messagesAccessToken: share.messagesAccessToken ?? null };
    } catch { return { status: "invalid_content" }; }
}

const binaryObjectUrls = new WeakMap<HTMLElement, string>();

/** Release opened bytes when their DOM presentation is replaced or the link changes. */
export function disposePublicShareViewerContent(root: HTMLElement): void {
    const url = binaryObjectUrls.get(root);
    if (url) URL.revokeObjectURL(url);
    binaryObjectUrls.delete(root);
}

export function renderPublicShareViewer(root: HTMLElement, result: PublicShareViewerResult, action?: () => void): void {
    disposePublicShareViewerContent(root);
    const document = root.ownerDocument;
    const title = document.createElement("h1");
    const content = document.createElement(result.status === "ready" ? "pre" : "p");
    if (result.status === "ready") {
        title.textContent = result.title;
        if (result.html) {
            try { renderArtifactHtmlViewer(root, result.html, result.title); }
            catch { renderPublicShareViewer(root, { status: 'invalid_content' }); }
            return;
        }
        if (result.binary) {
            // Only inert browser-native formats receive their MIME. SVG, HTML and
            // other active documents are download-only, even if opened in a tab.
            const mime = result.binary.mime.toLowerCase();
            const image = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp))$/u.test(mime);
            const pdf = mime === 'application/pdf';
            const url = URL.createObjectURL(new Blob([new Uint8Array(result.binary.bytes)], { type: image || pdf ? mime : 'application/octet-stream' }));
            binaryObjectUrls.set(root, url);
            const download = document.createElement('a');
            download.href = url;
            download.download = result.title;
            download.textContent = 'Download file';
            if (image) {
                const preview = document.createElement('img');
                preview.src = url;
                preview.alt = result.title;
                preview.style.cssText = 'max-width:100%;height:auto';
                root.replaceChildren(title, preview, download);
            } else if (pdf) {
                const preview = document.createElement('object');
                preview.type = 'application/pdf';
                preview.data = url;
                preview.setAttribute('aria-label', result.title);
                preview.style.cssText = 'width:100%;height:80vh';
                preview.textContent = 'Download this PDF to open it if your browser cannot preview it.';
                root.replaceChildren(title, preview, download);
            } else {
                const notice = document.createElement('p');
                notice.textContent = 'Download this file to open it.';
                root.replaceChildren(title, notice, download);
            }
            return;
        }
        content.textContent = result.text || "This shared content is empty.";
    } else {
        title.textContent = "Shared content";
        const copy = {
            invalid_link: "This link is incomplete or its key is incorrect. Ask the owner for the full link.",
            unavailable: "This link has expired, reached its viewing limit, or been revoked.",
            invalid_content: "This content could not be opened. Ask the owner for a new link.",
            consent_required: "Opening this link records a visit with the owner. Continue to view the shared content.",
            network_error: "The shared content could not be reached. Try again.",
            metadata_privacy_upgrade_required: "This link is being updated by its owner. Ask them to open Happier, then try this link again.",
        };
        content.textContent = copy[result.status];
    }
    root.replaceChildren(title, content);
    if (action) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = result.status === "consent_required" ? "Continue" : result.status === "ready" ? "Load earlier messages" : "Try again";
        button.addEventListener("click", action, { once: true });
        root.append(button);
    }
}
