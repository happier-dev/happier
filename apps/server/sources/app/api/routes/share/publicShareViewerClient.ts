/// <reference lib="dom" />

import {
    decodeBase64, decodePlainArtifactStoredContent, isPlainArtifactStoredContent,
    openPublicShareDataKeyV1, openSessionDataKeyBundle,
    readStoredContentPublicShareSecretV1, StoredContentPublicShareReadResponseV1Schema,
    ArtifactBlobReferenceV1Schema, artifactHtmlBundleFromBodyV1, isArtifactHtmlHeaderV1,
    readSessionDataKeyBundleV0, openAesGcmPayloadWebCrypto, type ArtifactHtmlBundleV1,
    WidgetDefinitionV1StoredSchema, getWidgetSharedInputIssuesV1, isWidgetDefinitionPubliclyRenderableV1, readWidgetDefinitionNetworkOverrideV1, type WidgetDefinitionV1,
} from "@happier-dev/protocol/sharing/public-viewer";
import { renderArtifactHtmlViewer } from './artifactHtmlViewer';
import { StoredContentPublicShareVisualReadResponseV1Schema } from '@happier-dev/protocol/sharing/public-viewer';
import { isSessionSurfaceItemIdentityCorrespondingV1, SessionSurfaceItemV1StoredSchema, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board/item';
import { readSessionTranscriptSurfaceItemReferencesV1, type SessionTranscriptSurfaceItemReferenceInputV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import type { SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { readPublicSessionVisualMessages } from './publicSessionVisuals';
import type { UiSurfaceNetworkRequestV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import { projectInlineReferenceLabelsV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import { readMessageDisplayText, type Message } from '@happier-dev/session-core/messages';
import { readPublishedSessionTranscript } from '@happier-dev/session-core/transcript';
import { normalizeToolCallForRendering, resolveToolRowPresentation, type ToolStatusIndicatorKind } from '@happier-dev/session-core/tools';

export type PublicSessionVisualResult = { status: 'ready'; item: SessionSurfaceItemV1; networkOff: boolean }
    | { status: 'unavailable' | 'invalid_content' | 'network_error' };
export type PublicSessionOpenedMessage = Readonly<{
    id: string; publishedSessionId: string; seq: number; localId: string | null; createdAt: number; raw: unknown;
    reference: SessionTranscriptSurfaceItemReferenceInputV1 | null;
    messageRole?: SessionMessageRole;
    loadVisual?: (referenceIndex?: number, signal?: AbortSignal) => Promise<PublicSessionVisualResult>;
}>;

export type PublicShareViewerResult =
    | { status: "ready"; title: string; text: string; networkOff?: boolean; messages?: readonly PublicSessionOpenedMessage[]; html?: ArtifactHtmlBundleV1; widgetDefinition?: WidgetDefinitionV1; binary?: { bytes: Uint8Array; mime: string }; nextBeforeSeq: number | null; messagesAccessToken: string | null }
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

export function readPublicSessionTranscriptText(messages: readonly PublicSessionOpenedMessage[]): string {
    return readPublishedSessionTranscript(messages).messages.flatMap(message => {
        if (message.kind === 'user-text' || message.kind === 'agent-text') return [readMessageDisplayText(message)];
        if (message.kind === 'tool-call') return [resolveToolRowPresentation(normalizeToolCallForRendering(message.tool)).title];
        return [];
    }).join('\n\n');
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
        const opened = await openSessionDataKeyBundle(decodeBase64(encoded), key!);
        if (opened.status !== "authenticated") throw new Error("Content authentication failed");
        return opened.value;
    };
    try {
        if (share.content.kind === "artifact") {
            const header = record(await open(share.content.header));
            const body = record(await open(share.content.body));
            if (!header || !body) return { status: "invalid_content" };
            if (header.kind === 'widget-definition.v1') {
                if (header.v !== 1 || typeof body.body !== 'string') return { status: 'invalid_content' };
                const stored: unknown = JSON.parse(body.body);
                const definition = WidgetDefinitionV1StoredSchema.parse(stored);
                if (definition.id !== share.subject.id || getWidgetSharedInputIssuesV1({ id: definition.id,
                    definition: { kind: 'inline', definition: stored } }).length > 0) return { status: 'invalid_content' };
                return { status: 'ready', title: definition.name, text: '', widgetDefinition: definition, networkOff: share.networkOff,
                    nextBeforeSeq: null, messagesAccessToken: null };
            }
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
                if (isArtifactHtmlHeaderV1(header)) html = artifactHtmlBundleFromBodyV1(bytes, reference.mime, 'stored');
                else binary = { bytes, mime: reference.mime };
            } else if (isArtifactHtmlHeaderV1(header)) {
                if (typeof body.body !== 'string') return { status: 'invalid_content' };
                html = artifactHtmlBundleFromBodyV1(body.body, typeof header.mime === 'string' ? header.mime : 'text/html', 'stored');
            }
            return { status: "ready", title: typeof header.title === "string" ? header.title : "Shared Artifact", networkOff: share.networkOff,
                text: typeof body.body === 'string' ? body.body : '', ...(html ? { html } : {}), ...(binary ? { binary } : {}), nextBeforeSeq: null, messagesAccessToken: null };
        }
        const messages = await Promise.all(share.content.messages.map(async (message): Promise<PublicSessionOpenedMessage> => {
            if ((share.encryptionMode === 'plain') !== (message.content.t === 'plain')) throw new Error('Content mode mismatch');
            const raw = message.content.t === 'plain' ? message.content.v : await open(message.content.c);
            const reference = message.surfaceItemReference ?? null;
            const references = readSessionTranscriptSurfaceItemReferencesV1(reference);
            const loadVisual = references && share.messagesAccessToken ? async (referenceIndex?: number, signal?: AbortSignal): Promise<PublicSessionVisualResult> => {
                const index = referenceIndex ?? 0;
                const selected = references[index];
                if (!Number.isInteger(index) || index < 0 || !selected) return { status: 'unavailable' };
                const visualUrl = new URL(`/v1/public-shares/${encodeURIComponent(lookupId)}/visual/${encodeURIComponent(message.id)}`, input.location.origin);
                if (referenceIndex !== undefined) visualUrl.searchParams.set('referenceIndex', String(index));
                if (input.consent) visualUrl.searchParams.set('consent', 'true');
                let response: Response;
                try { response = await input.fetch(visualUrl.toString(), { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
                    headers: { 'x-public-share-messages-access-token': share.messagesAccessToken! }, ...(signal ? { signal } : {}) }); }
                catch { return { status: 'network_error' }; }
                if (!response.ok) return { status: response.status === 503 ? 'network_error' : 'unavailable' };
                try {
                    const visual = StoredContentPublicShareVisualReadResponseV1Schema.parse(await response.json());
                    if (visual.messageId !== message.id || visual.encryptionMode !== share.encryptionMode
                        || visual.reference.itemId !== selected.itemId || visual.reference.itemRevision !== selected.itemRevision
                        || visual.reference.sourceAddress.serverId !== selected.sourceAddress.serverId
                        || visual.reference.sourceAddress.sessionId !== selected.sourceAddress.sessionId
                        || ('sourceItemId' in selected && (!('sourceItemId' in visual.reference)
                            || visual.reference.sourceItemId !== selected.sourceItemId
                            || visual.reference.sourceItemRevision !== selected.sourceItemRevision))) return { status: 'invalid_content' };
                    const content = visual.record.content;
                    const value = content.t === 'plain' ? content.v : await open(content.c);
                    const item = SessionSurfaceItemV1StoredSchema.parse(value);
                    if (!isSessionSurfaceItemIdentityCorrespondingV1(selected.itemId, item)) return { status: 'invalid_content' };
                    if (item.destination !== 'transcript' && item.destination !== 'both') return { status: 'unavailable' };
                    return { status: 'ready', item, networkOff: visual.networkOff };
                } catch { return { status: 'invalid_content' }; }
            } : undefined;
            return { id: message.id, publishedSessionId: share.subject.id, seq: message.seq, localId: message.localId ?? null, createdAt: message.createdAt,
                raw, reference, ...(message.messageRole ? { messageRole: message.messageRole } : {}), ...(loadVisual ? { loadVisual } : {}) };
        }));
        messages.sort((a, b) => a.seq - b.seq);
        return { status: "ready", title: "Shared Session", messages, text: readPublicSessionTranscriptText(messages),
            nextBeforeSeq: share.content.hasMore ? share.content.nextBeforeSeq : null,
            messagesAccessToken: share.messagesAccessToken ?? null };
    } catch { return { status: "invalid_content" }; }
}

const binaryObjectUrls = new WeakMap<HTMLElement, string>();
const widgetPresentations = new WeakMap<HTMLElement, { active: boolean; dispose?: () => void }>();
type SessionVisualRow = { body: HTMLElement; source: PublicSessionOpenedMessage; referenceIndex: number;
    loading: boolean; loaded: boolean; visible: boolean; result?: PublicSessionVisualResult;
    request?: AbortController; dispose?: () => void; observer?: IntersectionObserver };
type SessionMessageRow = { element: HTMLElement; body: HTMLElement; visuals: Map<string, SessionVisualRow> };
type SessionPresentation = { active: boolean; rows: Map<string, SessionMessageRow> };
const sessionPresentations = new WeakMap<HTMLElement, SessionPresentation>();

/** A public copy has no installed-plugin runtime or authenticated Resource/Action bridge. */
async function mountPublicWidgetDefinition(root: HTMLElement, definition: WidgetDefinitionV1, options: Readonly<{
    networkOff?: boolean; networkOverride?: UiSurfaceNetworkRequestV1;
}> = {}): Promise<() => void> {
    if (!isWidgetDefinitionPubliclyRenderableV1(definition)) {
        root.setAttribute('data-public-widget-state', 'unavailable');
        root.textContent = 'This live widget needs an available viewer connection in Happier. The author’s credentials are never used by this public link.';
        return () => root.replaceChildren();
    }
    if (definition.body.kind === 'html') {
        renderArtifactHtmlViewer(root, definition.body.source, definition.name, {
            requestedCapabilities: options.networkOverride ?? readWidgetDefinitionNetworkOverrideV1(definition) ?? { network: 'none' },
            networkOff: options.networkOff,
        });
        return () => root.replaceChildren();
    }
    const { mountPublicSessionDeclarative } = await import('./publicDeclarativeViewer');
    root.replaceChildren();
    return mountPublicSessionDeclarative(root, definition.body.document);
}

/** Release opened bytes when their DOM presentation is replaced or the link changes. */
export function disposePublicShareViewerContent(root: HTMLElement): void {
    const widget = widgetPresentations.get(root);
    if (widget) {
        widget.active = false;
        widget.dispose?.();
        widgetPresentations.delete(root);
    }
    const url = binaryObjectUrls.get(root);
    if (url) URL.revokeObjectURL(url);
    binaryObjectUrls.delete(root);
    const presentation = sessionPresentations.get(root);
    if (presentation) {
        presentation.active = false;
        for (const row of presentation.rows.values()) for (const visual of row.visuals.values()) {
            visual.observer?.disconnect(); visual.request?.abort(); visual.dispose?.();
        }
        sessionPresentations.delete(root);
    }
}

const toolStatusLabels: Readonly<Record<ToolStatusIndicatorKind, string>> = {
    permission_blocked: 'Permission denied', permission_pending: 'Waiting for permission',
    running: 'Running', completed: 'Completed', error: 'Failed', none: 'Unavailable',
};

function renderTranscriptMessage(document: Document, message: Message): HTMLElement {
    const element = document.createElement('section');
    element.setAttribute('data-message-id', message.realID ?? message.id);
    element.setAttribute('data-message-kind', message.kind);
    if (message.kind === 'user-text' || message.kind === 'agent-text') {
        const text = document.createElement('pre');
        text.textContent = projectInlineReferenceLabelsV1(readMessageDisplayText(message));
        element.append(text);
        return element;
    }
    if (message.kind === 'tool-call') {
        const tool = normalizeToolCallForRendering(message.tool);
        const presentation = resolveToolRowPresentation(tool);
        const heading = document.createElement('h2');
        heading.textContent = presentation.title;
        const status = document.createElement('p');
        status.textContent = toolStatusLabels[presentation.statusKind];
        element.setAttribute('data-tool-status', presentation.statusKind);
        element.append(heading, status);
        return element;
    }
    const event = document.createElement('p');
    event.textContent = 'Agent event';
    element.append(event);
    return element;
}

function renderSessionMessages(root: HTMLElement, messages: readonly PublicSessionOpenedMessage[], title: HTMLElement, action?: () => void): void {
    const document = root.ownerDocument;
    let presentation = sessionPresentations.get(root);
    if (!presentation) { presentation = { active: true, rows: new Map() }; sessionPresentations.set(root, presentation); }
    const current = presentation;
    const visible = readPublicSessionVisualMessages(messages);
    const elements = readPublishedSessionTranscript(messages).messages.map(message => {
        const stableId = message.realID ?? message.id;
        let row = current.rows.get(stableId);
        if (!row) {
            const element = renderTranscriptMessage(document, message);
            const body = document.createElement('div');
            body.setAttribute('aria-live', 'polite');
            element.append(body);
            row = { element, body, visuals: new Map() };
            current.rows.set(stableId, row);
        }
        return row.element;
    });
    for (const message of [...messages].sort((left, right) => left.seq - right.seq)) {
        let row = current.rows.get(message.id);
        if (!row && (visible.get(message.id)?.length ?? 0) > 0) {
            const element = document.createElement('section');
            element.setAttribute('data-message-id', message.id);
            const body = document.createElement('div');
            body.setAttribute('aria-live', 'polite');
            element.append(body);
            row = { element, body, visuals: new Map() };
            current.rows.set(message.id, row);
        }
        if (!row) continue;
        if ((visible.get(message.id)?.length ?? 0) > 0 && !elements.includes(row.element)) elements.push(row.element);
        for (const visual of visible.get(message.id) ?? []) {
            const key = visual.status === 'available' ? `available:${visual.referenceIndex}` : `not_copied:${visual.sourceKey}`;
            let saved = row.visuals.get(key);
            if (!saved) {
                const body = row.visuals.size === 0 ? row.body : document.createElement('div');
                body.setAttribute('aria-live', 'polite');
                if (row.visuals.size > 0) row.element.append(body);
                saved = { body, source: message, referenceIndex: visual.status === 'available' ? visual.referenceIndex : 0,
                    loading: false, loaded: false, visible: typeof globalThis.IntersectionObserver !== 'function' };
                row.visuals.set(key, saved);
            }
            const target = saved;
            if (visual.status === 'not_copied') {
                target.body.setAttribute('data-public-visual-state', 'not_copied');
                target.body.textContent = 'This visual was not copied into this shared Session.';
            }
            if (visual.status === 'available' && !target.observer && !target.loaded && !target.loading && target.body.childNodes.length === 0) {
                const releaseBody = (): void => {
                    const height = target.body.getBoundingClientRect().height;
                    if (height > 0) target.body.style.minHeight = `${height}px`;
                    target.request?.abort();
                    target.request = undefined;
                    target.dispose?.();
                    target.dispose = undefined;
                    target.loading = false;
                    target.loaded = false;
                    target.body.replaceChildren();
                };
                const open = async (): Promise<void> => {
                    if (target.loading || target.loaded || !target.visible || !current.active || !target.source.loadVisual) return;
                    const request = new AbortController();
                    target.request = request;
                    const isRequested = () => current.active && target.visible && target.request === request && !request.signal.aborted;
                    target.loading = true;
                    target.body.replaceChildren();
                    target.body.textContent = 'Opening visual…';
                    const result = target.result ?? await target.source.loadVisual(target.referenceIndex, request.signal);
                    if (!isRequested()) return;
                    target.result = result;
                    target.loading = false;
                    target.loaded = true;
                    if (result.status !== 'ready') {
                        target.body.textContent = result.status === 'network_error' ? 'This visual could not be reached.'
                            : result.status === 'invalid_content' ? 'This visual could not be opened.' : 'This visual is no longer available in this shared Session.';
                        if (result.status === 'network_error') offerOpen('Try again', true);
                        return;
                    }
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
                            if (isRequested()) target.dispose = mountPublicSessionDeclarative(surface, item.source.document);
                        } catch { if (isRequested()) surface.textContent = 'This visual could not be displayed.'; }
                    } else if (item.source.kind === 'hostedHtml') {
                        try { renderArtifactHtmlViewer(surface, item.source.source, item.title, {
                            requestedCapabilities: item.source.requestedCapabilities ?? { network: 'none' },
                            networkOff: result.networkOff,
                        }); }
                        catch { surface.textContent = 'This HTML visual could not be displayed.'; }
                    } else if (item.source.kind === 'widget' && item.source.instance.definition.kind === 'inline') {
                        try {
                            const dispose = await mountPublicWidgetDefinition(surface, item.source.instance.definition.definition, {
                                networkOff: result.networkOff, networkOverride: item.source.instance.networkOverride,
                            });
                            if (isRequested()) target.dispose = dispose;
                            else dispose();
                        } catch { if (isRequested()) surface.textContent = 'This visual could not be displayed.'; }
                    } else {
                        surface.textContent = item.source.kind === 'widget'
                            ? 'This live widget needs an available viewer connection in Happier. The author’s credentials are never used by this public link.'
                            : 'This walkthrough requires the Session’s Changed files view in Happier.';
                    }
                };
                const offerOpen = (label: string, retry = false): void => {
                    const button = document.createElement('button');
                    button.type = 'button'; button.textContent = label;
                    button.setAttribute('aria-label', `${label} attached to message ${message.seq}`);
                    button.addEventListener('click', () => {
                        target.visible = true;
                        if (retry) { target.result = undefined; target.loaded = false; }
                        void open();
                    }, { once: true });
                    target.body.append(button);
                };
                offerOpen('Open visual');
                if (typeof globalThis.IntersectionObserver === 'function') {
                    target.observer = new IntersectionObserver(entries => {
                        const next = entries.some(entry => entry.isIntersecting);
                        if (target.visible === next) return;
                        target.visible = next;
                        if (next) void open();
                        else releaseBody();
                    });
                    target.observer.observe(target.body);
                }
            }
        }
    }
    root.replaceChildren(title, ...elements);
    if (action) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = 'Load earlier messages';
        button.addEventListener('click', action, { once: true }); root.append(button);
    }
}

export interface PublicShareViewerRenderOptions {
    delivery?: 'main-origin' | 'isolated-origin';
}

export function renderPublicShareViewer(root: HTMLElement, result: PublicShareViewerResult, action?: () => void, options: PublicShareViewerRenderOptions = {}): void {
    if (result.status !== 'ready' || !result.messages) disposePublicShareViewerContent(root);
    const document = root.ownerDocument;
    const title = document.createElement("h1");
    const content = document.createElement(result.status === "ready" ? "pre" : "p");
    if (result.status === "ready") {
        title.textContent = result.title;
        if (result.messages) { renderSessionMessages(root, result.messages, title, action); return; }
        if (result.widgetDefinition) {
            const definition = result.widgetDefinition;
            const surface = document.createElement('div');
            root.replaceChildren(title, surface);
            const presentation: { active: boolean; dispose?: () => void } = { active: true };
            widgetPresentations.set(root, presentation);
            surface.textContent = 'Opening visual…';
            void mountPublicWidgetDefinition(surface, definition, { networkOff: result.networkOff }).then(dispose => {
                if (presentation.active) presentation.dispose = dispose;
                else dispose();
            }).catch(() => { if (presentation.active) surface.textContent = 'This visual could not be displayed.'; });
            return;
        }
        if (result.html) {
            try { renderArtifactHtmlViewer(root, result.html, result.title, { networkOff: result.networkOff }); }
            catch { renderPublicShareViewer(root, { status: 'invalid_content' }); }
            return;
        }
        if (result.binary) {
            // Only inert browser-native formats receive their MIME. SVG, HTML and
            // other active documents are download-only, even if opened in a tab.
            const mime = result.binary.mime.toLowerCase();
            const image = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp))$/u.test(mime);
            const pdf = mime === 'application/pdf' && options.delivery === 'isolated-origin';
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
