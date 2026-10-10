/// <reference lib="dom" />

import {
    decodeBase64, decodePlainArtifactStoredContent, isPlainArtifactStoredContent,
    openPublicShareDataKeyV1, openSessionDataKeyBundleV0,
    readStoredContentPublicShareSecretV1, StoredContentPublicShareReadResponseV1Schema,
    ArtifactBlobReferenceV1Schema, artifactHtmlBundleFromBodyV1, isArtifactHtmlHeaderV1,
    readSessionDataKeyBundleV0, openAesGcmPayloadWebCrypto, type ArtifactHtmlBundleV1,
} from "@happier-dev/protocol/sharing/public-viewer";
import { renderArtifactHtmlViewer } from './artifactHtmlViewer';
import { StoredContentPublicShareVisualReadResponseV1Schema } from '@happier-dev/protocol/sharing/public-viewer';
import { isSessionSurfaceItemIdentityCorrespondingV1, SessionSurfaceItemV1StoredSchema, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board/item';
import type { SessionTranscriptSurfaceItemReferenceV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import type { SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { readPublicSessionVisualMessages } from './publicSessionVisuals';

export type PublicSessionVisualResult = { status: 'ready'; item: SessionSurfaceItemV1; networkOff: boolean }
    | { status: 'unavailable' | 'invalid_content' | 'network_error' };
export type PublicSessionOpenedMessage = Readonly<{
    id: string; publishedSessionId: string; seq: number; localId: string | null; createdAt: number; raw: unknown; text: string;
    reference: SessionTranscriptSurfaceItemReferenceV1 | null;
    messageRole?: SessionMessageRole;
    loadVisual?: () => Promise<PublicSessionVisualResult>;
}>;

export type PublicShareViewerResult =
    | { status: "ready"; title: string; text: string; messages?: readonly PublicSessionOpenedMessage[]; html?: ArtifactHtmlBundleV1; binary?: { bytes: Uint8Array; mime: string }; nextBeforeSeq: number | null; messagesAccessToken: string | null }
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
        const messages = await Promise.all(share.content.messages.map(async (message): Promise<PublicSessionOpenedMessage> => {
            if ((share.encryptionMode === 'plain') !== (message.content.t === 'plain')) throw new Error('Content mode mismatch');
            const raw = message.content.t === 'plain' ? message.content.v : await open(message.content.c);
            const reference = message.surfaceItemReference ?? null;
            const loadVisual = reference && share.messagesAccessToken ? async (): Promise<PublicSessionVisualResult> => {
                const visualUrl = new URL(`/v1/public-shares/${encodeURIComponent(lookupId)}/visual/${encodeURIComponent(message.id)}`, input.location.origin);
                if (input.consent) visualUrl.searchParams.set('consent', 'true');
                let response: Response;
                try { response = await input.fetch(visualUrl.toString(), { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
                    headers: { 'x-public-share-messages-access-token': share.messagesAccessToken! } }); }
                catch { return { status: 'network_error' }; }
                if (!response.ok) return { status: response.status === 503 ? 'network_error' : 'unavailable' };
                try {
                    const visual = StoredContentPublicShareVisualReadResponseV1Schema.parse(await response.json());
                    if (visual.messageId !== message.id || visual.encryptionMode !== share.encryptionMode
                        || visual.reference.itemId !== reference.itemId || visual.reference.itemRevision !== reference.itemRevision
                        || visual.reference.sourceAddress.serverId !== reference.sourceAddress.serverId
                        || visual.reference.sourceAddress.sessionId !== reference.sourceAddress.sessionId) return { status: 'invalid_content' };
                    const content = visual.record.content;
                    const value = content.t === 'plain' ? content.v : await open(content.c);
                    const item = SessionSurfaceItemV1StoredSchema.parse(value);
                    if (!isSessionSurfaceItemIdentityCorrespondingV1(reference.itemId, item)) return { status: 'invalid_content' };
                    if (item.destination !== 'transcript' && item.destination !== 'both') return { status: 'unavailable' };
                    return { status: 'ready', item, networkOff: visual.networkOff };
                } catch { return { status: 'invalid_content' }; }
            } : undefined;
            return { id: message.id, publishedSessionId: share.subject.id, seq: message.seq, localId: message.localId ?? null, createdAt: message.createdAt,
                raw, text: contentText(raw), reference, ...(message.messageRole ? { messageRole: message.messageRole } : {}), ...(loadVisual ? { loadVisual } : {}) };
        }));
        messages.sort((a, b) => a.seq - b.seq);
        return { status: "ready", title: "Shared Session", messages, text: messages.map(message => message.text).join("\n\n"),
            nextBeforeSeq: share.content.hasMore ? share.content.nextBeforeSeq : null,
            messagesAccessToken: share.messagesAccessToken ?? null };
    } catch { return { status: "invalid_content" }; }
}

const binaryObjectUrls = new WeakMap<HTMLElement, string>();
type SessionVisualRow = { element: HTMLElement; body: HTMLElement; source: PublicSessionOpenedMessage;
    loading: boolean; loaded: boolean; dispose?: () => void; observer?: IntersectionObserver };
type SessionPresentation = { active: boolean; rows: Map<string, SessionVisualRow> };
const sessionPresentations = new WeakMap<HTMLElement, SessionPresentation>();

/** Release opened bytes when their DOM presentation is replaced or the link changes. */
export function disposePublicShareViewerContent(root: HTMLElement): void {
    const url = binaryObjectUrls.get(root);
    if (url) URL.revokeObjectURL(url);
    binaryObjectUrls.delete(root);
    const presentation = sessionPresentations.get(root);
    if (presentation) {
        presentation.active = false;
        for (const row of presentation.rows.values()) { row.observer?.disconnect(); row.dispose?.(); }
        sessionPresentations.delete(root);
    }
}

function renderSessionMessages(root: HTMLElement, messages: readonly PublicSessionOpenedMessage[], title: HTMLElement, action?: () => void): void {
    const document = root.ownerDocument;
    let presentation = sessionPresentations.get(root);
    if (!presentation) { presentation = { active: true, rows: new Map() }; sessionPresentations.set(root, presentation); }
    const current = presentation;
    const visible = readPublicSessionVisualMessages(messages);
    const elements = [...messages].sort((left, right) => left.seq - right.seq).map(message => {
        let row = current.rows.get(message.id);
        if (!row) {
            const element = document.createElement('section');
            element.setAttribute('data-message-id', message.id);
            const text = document.createElement('pre');
            text.textContent = message.text;
            element.append(text);
            const body = document.createElement('div');
            body.setAttribute('aria-live', 'polite');
            element.append(body);
            row = { element, body, source: message, loading: false, loaded: false };
            current.rows.set(message.id, row);
        }
        const target = row;
        if (visible.has(message.id) && !target.loaded && !target.loading && target.body.childNodes.length === 0) {
            const open = async (): Promise<void> => {
                if (target.loading || target.loaded || !current.active || !target.source.loadVisual) return;
                target.loading = true;
                target.observer?.disconnect();
                target.body.textContent = 'Opening visual…';
                const result = await target.source.loadVisual();
                if (!current.active) return;
                target.loading = false;
                if (result.status !== 'ready') {
                    target.body.textContent = result.status === 'network_error' ? 'This visual could not be reached.'
                        : result.status === 'invalid_content' ? 'This visual could not be opened.' : 'This visual is no longer available in this shared Session.';
                    if (result.status === 'network_error') offerOpen('Try again');
                    return;
                }
                target.loaded = true;
                const { item } = result;
                const heading = document.createElement('h2');
                heading.textContent = item.title;
                const surface = document.createElement('div');
                target.body.replaceChildren(heading, surface);
                if (item.snapshot) {
                    const provenance = document.createElement('p');
                    provenance.textContent = `Snapshot · As of ${item.snapshot.asOf}${item.snapshot.provenance.length ? ' · ' + item.snapshot.provenance.map(entry => entry.label).join(' · ') : ''}`;
                    target.body.append(provenance);
                }
                if (item.source.kind === 'declarative') {
                    try {
                        const { mountPublicSessionDeclarative } = await import('./publicDeclarativeViewer');
                        if (current.active) target.dispose = mountPublicSessionDeclarative(surface, item.source.document);
                    } catch { if (current.active) surface.textContent = 'This visual could not be displayed.'; }
                } else if (item.source.kind === 'hostedHtml') {
                    // The shared bundle/document owner closes network by default. Its admitted
                    // network-policy extension supplies an explicit share-level off override.
                    try { renderArtifactHtmlViewer(surface, item.source.source, item.title); }
                    catch { surface.textContent = 'This HTML visual could not be displayed.'; }
                } else {
                    surface.textContent = item.source.kind === 'widget'
                        ? 'This live widget needs an available viewer connection in Happier. The author’s credentials are never used by this public link.'
                        : 'This walkthrough requires the Session’s Changed files view in Happier.';
                }
            };
            const offerOpen = (label: string): void => {
                const button = document.createElement('button');
                button.type = 'button'; button.textContent = label;
                button.setAttribute('aria-label', `${label} attached to message ${message.seq}`);
                button.addEventListener('click', () => { void open(); }, { once: true });
                target.body.append(button);
            };
            offerOpen('Open visual');
            if (typeof globalThis.IntersectionObserver === 'function') {
                target.observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void open(); });
                target.observer.observe(target.element);
            }
        }
        return target.element;
    });
    root.replaceChildren(title, ...elements);
    if (action) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = 'Load earlier messages';
        button.addEventListener('click', action, { once: true }); root.append(button);
    }
}

export function renderPublicShareViewer(root: HTMLElement, result: PublicShareViewerResult, action?: () => void): void {
    if (result.status !== 'ready' || !result.messages) disposePublicShareViewerContent(root);
    const document = root.ownerDocument;
    const title = document.createElement("h1");
    const content = document.createElement(result.status === "ready" ? "pre" : "p");
    if (result.status === "ready") {
        title.textContent = result.title;
        if (result.messages) { renderSessionMessages(root, result.messages, title, action); return; }
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
