import { describe, expect, it, vi } from "vitest";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { encodePlainArtifactStoredContent, sealPublicShareDataKeyV1,
    sealSessionDataKeyBundleV0, sealAesGcmPayloadWebCrypto, frameSessionDataKeyBundleV0 } from '@happier-dev/protocol';
import { ARTIFACT_HTML_BUNDLE_MIME_V1, encodeBase64 } from "@happier-dev/protocol/sharing/public-viewer";
import { createHash } from 'node:crypto';
import { loadPublicShareViewerContent, renderPublicShareViewer } from "./publicShareViewerClient";
import { PUBLIC_SHARE_VIEWER_SCRIPT } from "./publicShareViewerBundle.generated";
import { readPublicSessionVisualMessages } from './publicSessionVisuals';
import { normalizeRawMessages } from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { normalizeToolCallForRendering, resolveToolRowPresentation } from '@happier-dev/session-core/tools';

// The viewer clones JSON schema DTOs, not binary values. Its VM platform shim
// must create VM-owned objects, as a browser's own structuredClone does.
const viewerBrowserScript = `globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));\n${PUBLIC_SHARE_VIEWER_SCRIPT}`;

const secret = "A".repeat(43);
const location = { origin: "https://share.preview.example.test", pathname: "/s/lookup", hash: `#k=${secret}` };
const plain = {
    subject: { kind: "artifact", id: "artifact" }, encryptionMode: "plain", encryptedDataKey: null,
    keyDerivation: "fragment_v1", isConsentRequired: false,
    content: { kind: "artifact", header: encodePlainArtifactStoredContent({ title: "Shared document" }),
        body: encodePlainArtifactStoredContent({ body: "<script>globalThis.pwned=true</script>" }), headerVersion: 1, bodyVersion: 1 },
};

interface ElementBoundary {
    tag: string; textContent: string | null; click?: () => void;
    ownerDocument: DocumentBoundary;
    src?: string; srcdoc?: string; data?: string; href?: string; download?: string; type?: string; alt?: string;
    style: { cssText: string; minHeight?: string }; attributes: Record<string, string>;
    childNodes: ElementBoundary[];
    append(...children: ElementBoundary[]): void;
    replaceChildren(...children: ElementBoundary[]): void;
    getBoundingClientRect(): { height: number };
    setAttribute(name: string, value: string): void;
    addEventListener(type: string, callback: () => void): void;
}
// One browser HTTP signature avoids losing URL admission to merged Node overloads in vi.Mock.
type BrowserFetchBoundary = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
interface RootBoundary { ownerDocument: DocumentBoundary; replaceChildren(...children: ElementBoundary[]): void; append(element: ElementBoundary): void; textContent: string; getAttribute(name: string): string | null }
interface DocumentBoundary { getElementById(): RootBoundary; createElement(tag: string): ElementBoundary }
function createBrowserBoundary(delivery?: string) {
    const elements: ElementBoundary[] = [];
    const document: DocumentBoundary = { getElementById: () => root, createElement: (tag: string): ElementBoundary => ({ tag, textContent: null, ownerDocument: document,
        style: { cssText: '' }, attributes: {}, childNodes: [],
        append(...children) { this.childNodes.push(...children); },
        replaceChildren(...children) { this.childNodes.splice(0, this.childNodes.length, ...children); },
        getBoundingClientRect() { return { height: 240 }; },
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(_type, callback) { this.click = callback; },
    }) };
    const root: RootBoundary = { ownerDocument: document, getAttribute: name => name === 'data-public-share-delivery' ? delivery ?? null : null,
        replaceChildren: (...children: ElementBoundary[]) => { elements.splice(0, elements.length, ...children); },
        append: (element: ElementBoundary) => elements.push(element),
        set textContent(value: string) { elements.splice(0, elements.length, { tag: "#text", textContent: value, ownerDocument: document, style: { cssText: '' }, attributes: {}, childNodes: [], append() {}, replaceChildren() {}, getBoundingClientRect: () => ({ height: 240 }), setAttribute() {}, addEventListener() {} }); } };
    return { elements, document, root };
}

// Inspect the attached DOM, not just the root children or detached created nodes.
function attachedElements(elements: readonly ElementBoundary[]): ElementBoundary[] {
    return elements.flatMap(element => [element, ...attachedElements(element.childNodes)]);
}

describe("isolated public viewer browser boundary", () => {
    it.each(['plain', 'e2ee'] as const)('applies the public-link network restriction to %s HTML without rewriting its bundle', async mode => {
        const key = new Uint8Array(32).fill(23);
        const encode = async (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : Buffer.from(await sealSessionDataKeyBundleV0(value, key)).toString('base64');
        const html = { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html',
            contentBase64: encodeBase64(new TextEncoder().encode('<p>Public folder</p>')) } }, requestedCapabilities: { network: 'open' } };
        for (const networkOff of [false, true]) {
            const payload = { ...plain, encryptionMode: mode, networkOff,
                encryptedDataKey: mode === 'plain' ? null : sealPublicShareDataKeyV1({ dataKey: key, secret,
                    randomBytes: length => new Uint8Array(length).fill(3) }),
                content: { ...plain.content, header: await encode({ kind: 'html', title: 'Public folder', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 }),
                    body: await encode({ body: JSON.stringify(html) }) } };
            const result = await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(payload)) });
            expect(result).toMatchObject({ status: 'ready', html: { requestedCapabilities: { network: 'open' } } });
            const browser = createBrowserBoundary();
            renderPublicShareViewer(browser.root as unknown as HTMLElement, result);
            const frame = attachedElements(browser.elements).find(element => element.tag === 'iframe');
            expect(frame?.srcdoc).toContain(networkOff ? 'connect-src data:;' : 'connect-src data: https:;');
            const served = createBrowserBoundary();
            runInNewContext(viewerBrowserScript, { document: served.document, location,
                fetch: async () => new Response(JSON.stringify(payload)),
                TextEncoder, TextDecoder, URL, URLSearchParams, crypto: globalThis.crypto, Uint8Array, addEventListener() {} });
            await vi.waitFor(() => expect(attachedElements(served.elements).find(element => element.tag === 'iframe')?.srcdoc)
                .toContain(networkOff ? 'connect-src data:;' : 'connect-src data: https:;'));
        }
    });
    it.each(['source', 'served bundle'] as const)('renders the retained commandExecution denial through %s without disclosing owner AgentState', async mode => {
        // R54 Verdant row: completed transport, no isError flag, native result.status=declined.
        // Stored Codex envelopes follow createRuntimeTranscriptProjector; only row fields are retained.
        const messages = [
            { id: 'retained-call', seq: 1, localId: null, createdAt: 1, content: { t: 'plain', v: {
                role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'exec-retained',
                    name: 'Bash', input: { command: '/bin/bash -lc pwd', cwd: '/repo' } } } } } },
            { id: 'retained-result', seq: 2, localId: null, createdAt: 2, content: { t: 'plain', v: {
                role: 'agent', content: { type: 'codex', data: { type: 'tool-result', callId: 'exec-retained',
                    output: { type: 'commandExecution', id: 'exec-retained', command: '/bin/bash -lc pwd',
                        source: 'agent', status: 'declined', aggregatedOutput: '', exitCode: null, durationMs: null,
                        _happier: { v: 2, protocol: 'acp', provider: 'codex', rawToolName: 'Bash', canonicalToolName: 'Bash' } } } } } } },
        ];
        const payload = { subject: { kind: 'session', id: 'session' }, encryptionMode: 'plain',
            encryptedDataKey: null, keyDerivation: 'fragment_v1', isConsentRequired: false,
            content: { kind: 'session', metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
                messages, hasMore: false, nextBeforeSeq: null } };
        const browser = createBrowserBoundary();
        const fetch = vi.fn(async () => new Response(JSON.stringify(payload)));
        if (mode === 'source') {
            const result = await loadPublicShareViewerContent({ location, fetch });
            expect(result.status).toBe('ready');
            renderPublicShareViewer(browser.root as unknown as HTMLElement, result);
        } else {
            runInNewContext(viewerBrowserScript, { document: browser.document, location, fetch,
                TextEncoder, TextDecoder, URL, URLSearchParams, crypto: globalThis.crypto, Uint8Array, addEventListener() {} });
            await vi.waitFor(() => expect(attachedElements(browser.elements).some(element => element.attributes['data-message-kind'] === 'tool-call')).toBe(true));
        }
        const rows = attachedElements(browser.elements).filter(element => element.attributes['data-message-kind'] === 'tool-call');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.childNodes.slice(0, 2).map(element => element.textContent)).toEqual(['Run pwd', 'Permission denied']);
        expect(rows[0]?.attributes['data-tool-status']).toBe('permission_blocked');
        expect(fetch).toHaveBeenCalledTimes(1); // No owner-state read or per-tool network request.
    });
    it('renders the canonical command title and denied outcome from a completed permission-wrapped call', () => {
        const browser = createBrowserBoundary();
        renderPublicShareViewer(browser.root as unknown as HTMLElement, {
            status: 'ready', title: 'Shared Session', text: '', nextBeforeSeq: null, messagesAccessToken: null,
            messages: [{ id: 'denied-call', publishedSessionId: 'session', seq: 1, localId: null, createdAt: 1,
                reference: null, raw: { role: 'agent', content: { type: 'output', data: { type: 'assistant',
                    uuid: 'call-uuid', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'denied', name: 'Bash', input: { command: 'pwd' } }] } } } } },
                { id: 'denied-result', publishedSessionId: 'session', seq: 2, localId: null, createdAt: 2,
                    reference: null, raw: { role: 'agent', content: { type: 'output', data: { type: 'user',
                        uuid: 'result-uuid', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'denied', content: 'Permission denied',
                            is_error: false, permissions: { date: 2, result: 'denied' } }] } } } } }],
        });
        const rows = attachedElements(browser.elements).filter(element => element.attributes['data-message-kind'] === 'tool-call');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.attributes['data-tool-status']).toBe('permission_blocked');
        expect(rows[0]?.childNodes.slice(0, 2).map(element => element.textContent)).toEqual(['Run pwd', 'Permission denied']);
    });
    it.each(['plain', 'e2ee'] as const)('renders decrypted %s Codex tool records as the canonical transcript row', async mode => {
        const key = new Uint8Array(32).fill(9);
        // Redacted stored-record shapes emitted by createRuntimeTranscriptProjector
        // and persisted by createSessionMessage before the share route envelopes them.
        const stored = [
            { id: 'stored-call', seq: 1, localId: 'call-local', createdAt: 1, messageRole: 'agent' as const,
                raw: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'call-1',
                    id: 'call-1', name: 'exec_command', input: { cmd: 'pwd' } } } } },
            { id: 'stored-result', seq: 2, localId: 'result-local', createdAt: 2, messageRole: 'agent' as const,
                raw: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'call-1',
                    id: 'result-1', output: 'workspace', isError: false } } } },
        ];
        const canonical = reducer(createReducer(), normalizeRawMessages(stored.map(message => ({
            id: message.id, seq: message.seq, localId: message.localId, createdAt: message.createdAt,
            messageRole: message.messageRole, raw: message.raw,
        }))), null).messages;
        expect(canonical).toMatchObject([{ kind: 'tool-call', tool: { name: 'exec_command', state: 'completed' } }]);
        const envelope = async (value: unknown) => mode === 'plain'
            ? { t: 'plain' as const, v: value }
            : { t: 'encrypted' as const, c: encodeBase64(await sealSessionDataKeyBundleV0(value, key)) };
        const payload = {
            subject: { kind: 'session', id: 'session' }, encryptionMode: mode,
            encryptedDataKey: mode === 'plain' ? null : sealPublicShareDataKeyV1({
                dataKey: key, secret, randomBytes: length => new Uint8Array(length).fill(4),
            }),
            keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: true, messagesAccessToken: null,
            content: { kind: 'session', metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
                messages: await Promise.all(stored.map(async message => ({ id: message.id, seq: message.seq,
                    localId: message.localId, createdAt: message.createdAt, messageRole: message.messageRole,
                    content: await envelope(message.raw) }))), hasMore: false, nextBeforeSeq: null },
        };
        const result = await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(payload)) });
        const browser = createBrowserBoundary();
        renderPublicShareViewer(browser.root as unknown as HTMLElement, result);
        const transcriptRows = attachedElements(browser.elements).filter(element => element.attributes['data-message-kind']);
        expect(transcriptRows.map(row => ({ kind: row.attributes['data-message-kind'], id: row.attributes['data-message-id'] })))
            .toEqual(canonical.map(message => ({ kind: message.kind, id: message.realID ?? message.id })));
        expect(transcriptRows).toHaveLength(1);
        const tool = canonical[0]?.kind === 'tool-call' ? normalizeToolCallForRendering(canonical[0].tool) : null;
        expect(attachedElements(transcriptRows).some(element => element.textContent === (tool ? resolveToolRowPresentation(tool).title : null))).toBe(true);
        expect(attachedElements(browser.elements).some(element => element.textContent?.includes('"type": "codex"'))).toBe(false);
    });

    it('renders reference labels without exposing tokens in shared Session text', () => {
        const { root, elements } = createBrowserBoundary();
        const text = 'Read [Auth](happier-ref:session:s1)';
        renderPublicShareViewer(root as unknown as HTMLElement, {
            status: 'ready', title: 'Shared Session', text,
            messages: [{ id: 'message', publishedSessionId: 'session', seq: 1, localId: null, createdAt: 1,
                raw: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } }, reference: null }],
            nextBeforeSeq: null, messagesAccessToken: null,
        });
        expect(elements.find(element => element.attributes['data-message-id'] === 'message')?.childNodes[0]?.textContent).toBe('Read Auth');
    });

    it('renders an HTML Artifact with its stored egress and no authenticated host bridge', async () => {
        const payload = { ...plain, content: { ...plain.content,
            header: encodePlainArtifactStoredContent({ kind: 'html', title: 'Saved HTML', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, entrypoint: 'index.html', requestedCapabilities: { networkOrigins: ['https://assets.example.test'] }, files: {
                'index.html': { mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode('<script>globalThis.local = true</script>')) },
            } }) }) } };
        const result = await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(payload)) });
        const browser = createBrowserBoundary();
        renderPublicShareViewer(browser.root as unknown as HTMLElement, result);
        const frame = attachedElements(browser.elements).find(element => element.tag === 'iframe');
        expect(frame?.srcdoc).toContain('connect-src data: https://assets.example.test;');
        expect(frame?.srcdoc).not.toContain('host.request');
        expect(frame?.attributes.sandbox).toBe('allow-scripts');
    });
    it('opens a saved declarative definition as typed content and rejects substituted definition identities', async () => {
        const definition = { v: 1, id: 'artifact', name: 'Saved chart',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Saved content' } } },
            inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            provenance: { source: { kind: 'authored' } } };
        const payload = { ...plain, content: { ...plain.content,
            header: encodePlainArtifactStoredContent({ kind: 'widget-definition.v1', v: 1, title: definition.name }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(definition) }) } };
        expect(await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(payload)) }))
            .toMatchObject({ status: 'ready', widgetDefinition: definition });
        const substituted = { ...payload, content: { ...payload.content,
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ ...definition, id: 'other' }) }) } };
        expect(await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(substituted)) }))
            .toMatchObject({ status: 'invalid_content' });
        const stored = { ...definition, futureDisplayField: 1,
            body: { ...definition.body, futureDisplayField: 1, document: { ...definition.body.document,
                root: { ...definition.body.document.root, futureDisplayField: 1 } } },
            provenance: { ...definition.provenance, futureDisplayField: 1 } };
        const read = (value: unknown) => loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify({
            ...payload, content: { ...payload.content, body: encodePlainArtifactStoredContent({ body: JSON.stringify(value) }) },
        })) });
        const result = await read(stored);
        expect(result).toMatchObject({ status: 'ready', widgetDefinition: definition });
        if (result.status !== 'ready') throw new Error('Expected stored definition to open');
        expect(result.widgetDefinition).toEqual(definition);
        for (const invalid of [{ ...stored, id: 'other' }, { ...stored, name: null },
            { ...stored, futureInput: { service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'private' } }]) {
            expect(await read(invalid)).toEqual({ status: 'invalid_content' });
        }
    });
    it.each(['plain', 'e2ee'] as const)('renders a saved %s HTML widget with its copied override and no author bridge', async mode => {
        const key = new Uint8Array(32).fill(9);
        const opened = async (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value) : encodeBase64(await sealSessionDataKeyBundleV0(value, key));
        const source = { v: 1, entrypoint: 'index.html', requestedCapabilities: { network: 'open' }, files: {
            'index.html': { mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode('<button>Local interaction</button><script>globalThis.local = true</script>')) },
        } };
        for (const { networkOverride, networkOff } of [
            { networkOverride: { network: 'none' }, networkOff: false },
            { networkOverride: { networkOrigins: ['https://assets.example.test'] }, networkOff: false },
            { networkOverride: undefined, networkOff: false },
            { networkOverride: undefined, networkOff: true },
        ]) {
            const definition = { v: 1, id: 'artifact', name: 'Saved HTML',
                sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
                body: { kind: 'html', source, requestedCapabilities: { network: 'open' } },
                ...(networkOverride ? { networkOverride } : {}),
                inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } } };
            const payload = { ...plain, encryptionMode: mode, networkOff,
                encryptedDataKey: mode === 'plain' ? null : sealPublicShareDataKeyV1({ dataKey: key, secret, randomBytes: length => new Uint8Array(length).fill(4) }),
                content: { ...plain.content, header: await opened({ kind: 'widget-definition.v1', v: 1, title: 'Saved HTML' }),
                    body: await opened({ body: JSON.stringify({ ...definition, futureDisplayField: 1,
                        body: { ...definition.body, futureDisplayField: 1,
                            requestedCapabilities: { ...definition.body.requestedCapabilities, futureDisplayField: 1 } },
                        sizeDeclaration: { ...definition.sizeDeclaration, futureDisplayField: 1 } }) }) } };
            const browser = createBrowserBoundary();
            const result = await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(payload)) });
            expect(result.status).toBe('ready');
            renderPublicShareViewer(browser.root as unknown as HTMLElement, result);
            const frame = attachedElements(browser.elements).find(element => element.tag === 'iframe');
            expect(frame?.srcdoc).toContain(networkOff || networkOverride?.network === 'none' ? 'connect-src data:;'
                : networkOverride?.networkOrigins ? 'connect-src data: https://assets.example.test;' : 'connect-src data: https:;');
            expect(frame?.attributes.sandbox).toBe('allow-scripts');
            expect(frame?.srcdoc).toContain('globalThis.local = true');
            expect(frame?.srcdoc).not.toContain('host.request');
        }
    });
    it('keeps an installed widget truthfully unavailable without a hidden authenticated read', async () => {
        const definition = { v: 1, id: 'artifact', name: 'Installed live widget',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            body: { kind: 'installed', surface: { pluginId: 'com.acme.widget', localId: 'live' } },
            inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } } };
        const payload = { ...plain, content: { ...plain.content,
            header: encodePlainArtifactStoredContent({ kind: 'widget-definition.v1', v: 1, title: definition.name }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(definition) }) } };
        const fetch = vi.fn(async () => new Response(JSON.stringify(payload)));
        const result = await loadPublicShareViewerContent({ location, fetch });
        const browser = createBrowserBoundary();
        renderPublicShareViewer(browser.root as unknown as HTMLElement, result);
        expect(attachedElements(browser.elements).find(element => element.attributes['data-public-widget-state'] === 'unavailable')?.textContent)
            .toContain('viewer connection');
        expect(fetch.mock.calls).toHaveLength(1);
        expect(attachedElements(browser.elements).some(element => element.tag === 'iframe')).toBe(false);
    });
    it('keeps a live Resource definition unavailable instead of silently displaying a stale snapshot', async () => {
        const definition = { v: 1, id: 'artifact', name: 'Live metric',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Count',
                data: { kind: 'resource', resource: { pluginId: 'com.acme.widget', localId: 'metrics' },
                    inputSchema: { type: 'object', additionalProperties: false },
                    outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } },
                value: { path: ['count'], type: 'number' } } } },
            inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } } };
        const payload = { ...plain, content: { ...plain.content,
            header: encodePlainArtifactStoredContent({ kind: 'widget-definition.v1', v: 1, title: definition.name }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(definition) }) } };
        const fetch = vi.fn(async () => new Response(JSON.stringify(payload)));
        const result = await loadPublicShareViewerContent({ location, fetch });
        expect(result.status).toBe('ready');
        const browser = createBrowserBoundary();
        renderPublicShareViewer(browser.root as unknown as HTMLElement, result);
        expect(attachedElements(browser.elements).find(element => element.attributes['data-public-widget-state'] === 'unavailable')?.textContent)
            .toContain('viewer connection');
        expect(fetch.mock.calls).toHaveLength(1);
    });
    it.each(['plain', 'e2ee'] as const)('opens a saved %s builtin as live-only content without author authority and rejects unknown builtin ids', async mode => {
        const key = new Uint8Array(32).fill(9);
        const encode = async (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(await sealSessionDataKeyBundleV0(value, key));
        const definition = { v: 1, id: 'artifact', name: 'Saved daily usage',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            body: { kind: 'builtin', id: 'usage_daily' },
            inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            provenance: { source: { kind: 'authored' } } };
        const payload = { ...plain, encryptionMode: mode,
            encryptedDataKey: mode === 'plain' ? null : sealPublicShareDataKeyV1({ dataKey: key, secret, randomBytes: length => new Uint8Array(length).fill(4) }),
            content: { ...plain.content,
                header: await encode({ kind: 'widget-definition.v1', v: 1, title: definition.name }),
                body: await encode({ body: JSON.stringify(definition) }) } };
        const fetch = vi.fn<BrowserFetchBoundary>().mockResolvedValue(new Response(JSON.stringify(payload)));
        const result = await loadPublicShareViewerContent({ location, fetch });
        expect(result).toMatchObject({ status: 'ready', widgetDefinition: definition });
        const browser = createBrowserBoundary();
        renderPublicShareViewer(browser.root as unknown as HTMLElement, result);
        expect(attachedElements(browser.elements).find(element => element.attributes['data-public-widget-state'] === 'unavailable')?.textContent)
            .toContain('viewer connection');
        expect(attachedElements(browser.elements).some(element => element.tag === 'iframe')).toBe(false);
        expect(fetch.mock.calls.map(([url, init]) => ({ url: String(url), credentials: init?.credentials })))
            .toEqual([{ url: `${location.origin}/v1/public-shares/lookup/content`, credentials: 'omit' }]);
        const unknown = { ...payload, content: { ...payload.content,
            body: await encode({ body: JSON.stringify({ ...definition, body: { kind: 'builtin', id: 'unknown_widget' } }) }) } };
        expect(await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(unknown)) }))
            .toEqual({ status: 'invalid_content' });
    });
    it('renders a Session visual with its stored network and applies the public share network-off choice', async () => {
        const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
        const reference = { v: 1, itemId: 'visual', itemRevision: revision, sourceAddress: { serverId: 'home', sessionId: 'session' } };
        const original = { v: 1, destination: 'transcript', title: 'Network HTML', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'hostedHtml', source: { v: 1, entrypoint: 'index.html', requestedCapabilities: { network: 'open' }, files: {
                'index.html': { mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode('<script>globalThis.local = true</script>')) },
            } } } };
        const acknowledgement = { v: 1, serverId: 'home', sessionId: 'session', itemDestination: 'transcript', destination: null,
            result: { operation: 'upsert_item', itemId: 'visual', itemRevision: revision, outcome: 'created' } };
        for (const { networkOff, declared, widget = false, override = undefined } of [
            { networkOff: false, declared: 'open' }, { networkOff: true, declared: 'open' },
            { networkOff: false, declared: 'none' }, { networkOff: false, declared: undefined },
            { networkOff: false, declared: 'open', widget: true, override: { network: 'none' } },
            { networkOff: true, declared: 'open', widget: true },
        ]) {
            const htmlSource = { ...original.source,
                ...(declared === undefined ? {} : { requestedCapabilities: { network: declared } }),
            };
            const item = { ...original, source: widget ? { kind: 'widget', instance: { v: 1, id: 'visual', bindings: {},
                ...(override ? { networkOverride: override } : {}),
                definition: { kind: 'inline', definition: { v: 1, id: 'definition', name: 'HTML widget',
                    sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
                    inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
                    body: { kind: 'html', source: htmlSource.source, requestedCapabilities: htmlSource.requestedCapabilities } } },
            } } : htmlSource };
            const input = { itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item };
            const payload = { subject: { kind: 'session', id: 'session' }, encryptionMode: 'plain', encryptedDataKey: null,
                keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff, messagesAccessToken: 'grant',
                content: { kind: 'session', metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0, hasMore: false, nextBeforeSeq: null,
                    messages: [{ id: 'call', seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: {
                        type: 'tool-call', callId: 'tool', id: 'call', name: 'session_board_item_upsert', input,
                    } } } } }, { id: 'message', seq: 2, createdAt: 2, surfaceItemReference: reference, content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: {
                        type: 'tool-call-result', callId: 'tool', id: 'message', output: JSON.stringify(acknowledgement), isError: false,
                    } } } } }] } };
            const visual = { messageId: 'message', reference, encryptionMode: 'plain', networkOff,
                record: { id: 'record', revision, address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' },
                    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', content: { t: 'plain', v: item } } };
            const browser = createBrowserBoundary();
            const result = await loadPublicShareViewerContent({ location, fetch: vi.fn(async url => new Response(JSON.stringify(String(url).includes('/visual/') ? visual : payload))) });
            expect(result.status).toBe('ready');
            renderPublicShareViewer(browser.root as unknown as HTMLElement, result);
            const open = attachedElements(browser.elements).find(element => element.tag === 'button');
            open?.click?.();
            await vi.waitFor(() => expect(attachedElements(browser.elements).some(element => element.tag === 'iframe')).toBe(true));
            const frame = attachedElements(browser.elements).find(element => element.tag === 'iframe')!;
            expect(frame.srcdoc).toContain(!networkOff && declared === 'open' && override?.network !== 'none' ? 'connect-src data: https:;' : 'connect-src data:;');
            expect(frame.srcdoc).toContain('globalThis.local = true');
        }
    });
    it('disposes an offscreen visual body, suppresses withdrawn work and resumes the stable row on visibility', async () => {
        // IntersectionObserver and layout measurement are real browser boundaries.
        let visibility: (visible: boolean) => void = () => { throw new Error('Missing observer'); };
        vi.stubGlobal('IntersectionObserver', class {
            private disconnected = false;
            constructor(callback: IntersectionObserverCallback) {
                visibility = visible => { if (!this.disconnected) callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver); };
            }
            observe() {}
            disconnect() { this.disconnected = true; }
        });
        try {
            const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
            const reference = { v: 1, itemId: 'visual', itemRevision: revision, sourceAddress: { serverId: 'home', sessionId: 'session' } };
            const item = { v: 1, destination: 'transcript', title: 'Visible HTML', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'hostedHtml', source: { v: 1, entrypoint: 'index.html', files: {
                    'index.html': { mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode('<h1>Visible content</h1>')) },
                } } } };
            const input = { itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item };
            const acknowledgement = { v: 1, serverId: 'home', sessionId: 'session', itemDestination: 'transcript', destination: null,
                result: { operation: 'upsert_item', itemId: 'visual', itemRevision: revision, outcome: 'created' } };
            const payload = { subject: { kind: 'session', id: 'session' }, encryptionMode: 'plain', encryptedDataKey: null,
                keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: true, messagesAccessToken: 'grant',
                content: { kind: 'session', metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0, hasMore: false, nextBeforeSeq: null,
                    messages: [{ id: 'call', seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: {
                        type: 'tool-call', callId: 'tool', id: 'call', name: 'session_board_item_upsert', input,
                    } } } } }, { id: 'answer', seq: 2, createdAt: 2, surfaceItemReference: reference, content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: {
                        type: 'tool-call-result', callId: 'tool', id: 'answer', output: JSON.stringify(acknowledgement), isError: false,
                    } } } } }] } };
            const visual = { messageId: 'answer', encryptionMode: 'plain', networkOff: true, reference, record: {
                id: 'record', revision, address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' },
                content: { t: 'plain', v: item }, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
            } };
            let completeWithdrawnRequest!: (response: Response) => void;
            const fetch = vi.fn<BrowserFetchBoundary>().mockResolvedValueOnce(new Response(JSON.stringify(payload)))
                .mockImplementationOnce(() => new Promise(resolve => { completeWithdrawnRequest = resolve; }))
                .mockResolvedValue(new Response(JSON.stringify(visual)));
            const result = await loadPublicShareViewerContent({ location, fetch });
            const { root, elements } = createBrowserBoundary();
            renderPublicShareViewer(root as unknown as HTMLElement, result);
            const row = elements.find(element => element.attributes['data-message-id'] === 'answer')!;
            const body = row.childNodes[0];
            const frames = () => body.childNodes.flatMap(child => child.childNodes).filter(child => child.tag === 'iframe');
            visibility(true);
            expect(fetch).toHaveBeenCalledTimes(2);
            visibility(false);
            completeWithdrawnRequest(new Response(JSON.stringify(visual)));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(frames()).toEqual([]);
            expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
            expect(body.style.minHeight).toBe('240px');
            visibility(true);
            await vi.waitFor(() => expect(frames()).toHaveLength(1));
            const previous = frames()[0];
            renderPublicShareViewer(root as unknown as HTMLElement, result);
            expect(elements).toContain(row);
            visibility(false);
            expect(frames()).toEqual([]);
            visibility(true);
            await vi.waitFor(() => expect(frames()).toHaveLength(1));
            expect(frames()[0]).not.toBe(previous);
            expect(fetch).toHaveBeenCalledTimes(3);
            renderPublicShareViewer(root as unknown as HTMLElement, { status: 'unavailable' });
        } finally { vi.unstubAllGlobals(); }
    });
    it('recognizes only completed acknowledged transcript visuals from the real message reducer, including a call/result page boundary', () => {
        const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
        const item = { v: 1, title: 'Result', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Result' } } } };
        const input = { itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item };
        const result = { v: 1, serverId: 'home', sessionId: 'session', result: { operation: 'upsert_item', itemId: 'visual', outcome: 'created', itemRevision: revision },
            destination: null, itemDestination: 'transcript' };
        const call = { id: 'call-message', publishedSessionId: 'session', seq: 1, localId: null, createdAt: 1, text: '', reference: null,
            raw: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'call', name: 'session_board_item_upsert', input, id: 'call' } } } };
        const answer = { id: 'answer-message', publishedSessionId: 'session', seq: 2, localId: null, createdAt: 2, text: '',
            reference: { v: 1 as const, itemId: 'visual', itemRevision: revision, sourceAddress: { serverId: 'home', sessionId: 'session' } },
            loadVisual: async () => ({ status: 'unavailable' as const }),
            raw: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'call', output: JSON.stringify(result), id: 'answer', isError: false } } } };
        expect([...readPublicSessionVisualMessages([answer]).keys()]).toEqual([]);
        expect([...readPublicSessionVisualMessages([answer, call]).keys()]).toEqual(['answer-message']);
        expect([...readPublicSessionVisualMessages([{ ...answer, raw: { text: JSON.stringify(result) } }, call]).keys()]).toEqual([]);
        expect([...readPublicSessionVisualMessages([{ ...answer, reference: null }, call]).keys()]).toEqual([]);
        const boardCall = { ...call, raw: { role: 'agent', content: { type: 'codex', data: {
            ...call.raw.content.data, input: { ...input, destination: 'board', expectedItemRevision: revision },
        } } } };
        const boardAnswer = { ...answer, raw: { role: 'agent', content: { type: 'codex', data: {
            ...answer.raw.content.data, output: JSON.stringify({ ...result, result: { ...result.result, outcome: 'updated' }, itemDestination: 'board' }),
        } } } };
        expect([...readPublicSessionVisualMessages([boardAnswer, boardCall]).keys()]).toEqual([]);
        // A v3 historical import retains the immutable original Board acknowledgement,
        // but its server-stamped association names the independently owned child copy.
        expect([...readPublicSessionVisualMessages([{ ...boardAnswer, publishedSessionId: 'child-session',
            reference: { v: 1 as const, references: [{ ...answer.reference, itemId: 'child-visual', itemRevision: 'ssr1.AAAACHN5c3JlY18yAAAAAQ',
                sourceItemId: 'visual', sourceItemRevision: revision }] } }, boardCall]).keys()]).toEqual(['answer-message']);
        expect([...readPublicSessionVisualMessages([{ ...answer,
            reference: { ...answer.reference, itemId: 'substituted-visual' } }, call]).keys()]).toEqual([]);
        expect([...readPublicSessionVisualMessages([{ ...answer,
            reference: { ...answer.reference, itemRevision: 'ssr1.AAAACHN5c3JlY18yAAAAAQ' } }, call]).keys()]).toEqual([]);
        const failedCopy = { ...boardAnswer, publishedSessionId: 'child-session', reference: null, loadVisual: undefined,
            raw: { ...boardAnswer.raw, meta: { forkVisualOriginV1: {
                v: 1, serverId: 'home', sessionId: 'session', sourceMessageId: 'original-answer-message', sourceSeq: 2,
            } } } };
        const importedCall = { ...boardCall, publishedSessionId: 'child-session',
            raw: { ...boardCall.raw, meta: { forkVisualOriginV1: {
                v: 1, serverId: 'home', sessionId: 'session', sourceMessageId: 'original-call-message', sourceSeq: 1,
            } } } };
        expect([...readPublicSessionVisualMessages([failedCopy]).entries()]).toEqual([]);
        expect([...readPublicSessionVisualMessages([failedCopy, importedCall]).entries()]).toEqual([['answer-message', [{ status: 'not_copied', sourceKey: expect.any(String) }]]]);
        expect([...readPublicSessionVisualMessages([{ ...failedCopy, raw: { text: JSON.stringify(result), meta: failedCopy.raw.meta } }, importedCall]).entries()]).toEqual([]);
        const { root, elements } = createBrowserBoundary();
        renderPublicShareViewer(root as unknown as HTMLElement, { status: 'ready', title: 'Shared child', text: '',
            messages: [failedCopy, importedCall], nextBeforeSeq: null, messagesAccessToken: 'grant' });
        expect(elements.find(element => element.attributes['data-message-id'] === 'answer-message')?.childNodes[0].attributes['data-public-visual-state']).toBe('not_copied');
    });
    it('publishes an approved Ask occurrence through its admitted Session association at the original request position', () => {
        const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
        const input = { sessionId: 'session', itemId: 'visual', expectedItemRevision: null, destination: 'transcript',
            item: { v: 1, title: 'Result', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Result' } } } } };
        const receipt = { kind: 'approval_request_created', artifactId: 'approval', actionId: 'session.board.item.upsert' };
        const call = { id: 'request-call', publishedSessionId: 'session', seq: 1, localId: null, createdAt: 1, text: '', reference: null,
            raw: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'call', name: 'session_board_item_upsert', input } } } };
        const pending = { id: 'request-result', publishedSessionId: 'session', seq: 2, localId: null, createdAt: 2, text: '', reference: null,
            raw: { role: 'agent', content: { type: 'codex', data: { type: 'tool-result', callId: 'call', output: receipt } } } };
        // Pending/denied requests have no settled publication. The Session writer
        // adds this owned association only after the visual mutation is applied.
        expect([...readPublicSessionVisualMessages([call, pending])]).toEqual([]);
        const association = { v: 1 as const, references: [{ v: 1 as const, itemId: 'visual', itemRevision: revision,
            sourceAddress: { serverId: 'home', sessionId: 'session' }, sourceItemId: 'visual', sourceItemRevision: revision,
            approvalRequestArtifactId: 'approval' }] };
        const approved = { ...pending, reference: association, loadVisual: async () => ({ status: 'unavailable' as const }) };
        expect([...readPublicSessionVisualMessages([call, approved])]).toEqual([
            ['request-result', [{ status: 'available', referenceIndex: 0 }]],
        ]);
        expect([...readPublicSessionVisualMessages([{ ...call, raw: { ...call.raw,
            content: { ...call.raw.content, data: { ...call.raw.content.data, name: 'mcp__happier__action_execute',
                input: { actionId: 'session.board.item.upsert', input } } } } }, approved])])
            .toEqual([['request-result', [{ status: 'available', referenceIndex: 0 }]]]);
        const { sessionId: _implicitSession, ...implicitInput } = input;
        expect([...readPublicSessionVisualMessages([{ ...call, raw: { ...call.raw,
            content: { ...call.raw.content, data: { ...call.raw.content.data, input: implicitInput } } } }, approved])])
            .toEqual([['request-result', [{ status: 'available', referenceIndex: 0 }]]]);
        const substituted = { ...association, references: [{ ...association.references[0]!, sourceItemId: 'other' }] };
        expect([...readPublicSessionVisualMessages([call, { ...approved, reference: substituted }])]).toEqual([]);
        const otherReceipt = { ...association, references: [{ ...association.references[0]!, approvalRequestArtifactId: 'other-approval' }] };
        expect([...readPublicSessionVisualMessages([call, { ...approved, reference: otherReceipt }])]).toEqual([]);
        const { approvalRequestArtifactId: _receiptId, ...untagged } = association.references[0]!;
        expect([...readPublicSessionVisualMessages([call, { ...approved,
            reference: { v: 1, references: [untagged] } }])]).toEqual([]);
        const childOrigin = { v: 1, serverId: 'home', sessionId: 'session', sourceMessageId: pending.id, sourceSeq: pending.seq,
            settledApprovalReferences: [{ approvalRequestArtifactId: 'approval', sourceItemId: 'visual', sourceItemRevision: revision }] };
        const failedChild = { ...pending, publishedSessionId: 'child-session', raw: { ...pending.raw, meta: { forkVisualOriginV1: childOrigin } } };
        const unscopedChildCall = { ...call, publishedSessionId: 'child-session' };
        expect([...readPublicSessionVisualMessages([unscopedChildCall, failedChild])]).toEqual([]);
        // The fork seeder stamps every imported native row. Both ends of a tool
        // call must have the same Home/Session scope before they can correspond.
        const childCall = { ...unscopedChildCall, raw: { ...call.raw, meta: { forkVisualOriginV1: {
            ...childOrigin, sourceMessageId: call.id, sourceSeq: call.seq,
        } } } };
        expect([...readPublicSessionVisualMessages([childCall, failedChild])]).toEqual([
            ['request-result', [{ status: 'not_copied', sourceKey: expect.any(String) }]],
        ]);
        expect([...readPublicSessionVisualMessages([childCall, { ...failedChild, raw: { ...failedChild.raw,
            meta: { forkVisualOriginV1: { ...childOrigin, settledApprovalReferences: [] } } } }])]).toEqual([]);
        expect([...readPublicSessionVisualMessages([childCall, { ...failedChild, raw: { ...failedChild.raw,
            meta: { forkVisualOriginV1: { ...childOrigin, settledApprovalReferences: [
                { ...childOrigin.settledApprovalReferences[0]!, approvalRequestArtifactId: 'different-approval' },
            ] } } } }])]).toEqual([]);
    });
    it('renders each admitted Session message as a stable addressed row instead of flattening the public page', () => {
        const { root, elements } = createBrowserBoundary();
        renderPublicShareViewer(root as unknown as HTMLElement, { status: 'ready', title: 'Shared Session', text: 'Published text',
            messages: [{ id: 'message', publishedSessionId: 'session', seq: 3, localId: null, createdAt: 1,
                raw: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Published text' } } }, reference: null }],
            nextBeforeSeq: null, messagesAccessToken: 'grant' });
        expect(elements.some(element => element.attributes['data-message-id'] === 'message')).toBe(true);
    });
    it('retains admitted Session message identity for lazy visual publication without fetching items eagerly', async () => {
        const fetch = vi.fn<BrowserFetchBoundary>().mockResolvedValue(new Response(JSON.stringify({
            subject: { kind: 'session', id: 'session' }, encryptionMode: 'plain', encryptedDataKey: null,
            keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: true, messagesAccessToken: 'grant',
            content: { kind: 'session', metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
                messages: [{ id: 'published-message', seq: 3, localId: null, createdAt: 1, content: { t: 'plain', v: {
                    role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Published text' } },
                } } }],
                hasMore: true, nextBeforeSeq: 3 },
        })));
        const result = await loadPublicShareViewerContent({ location, fetch });
        expect(result).toMatchObject({ status: 'ready', text: 'Published text', messages: [{ id: 'published-message', seq: 3 }], nextBeforeSeq: 3 });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it.each(['plain', 'e2ee'] as const)('lazily opens a message-anchored %s visual with the fragment key and refuses a substituted item', async mode => {
        const key = new Uint8Array(32).fill(9);
        const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
        const reference = { v: 1, itemId: 'visual', itemRevision: revision, sourceAddress: { serverId: 'home', sessionId: 'session' } };
        const item = { v: 1, destination: 'transcript', title: 'Opened visual', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Visible declarative content' } } } };
        const envelope = async (value: unknown) => mode === 'plain' ? { t: 'plain', v: value } : { t: 'encrypted', c: encodeBase64(await sealSessionDataKeyBundleV0(value, key)) };
        const payload = { subject: { kind: 'session', id: 'session' }, encryptionMode: mode,
            encryptedDataKey: mode === 'plain' ? null : sealPublicShareDataKeyV1({ dataKey: key, secret, randomBytes: length => new Uint8Array(length).fill(4) }),
            keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: true, messagesAccessToken: 'grant',
            content: { kind: 'session', metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
                messages: [{ id: 'published-message', seq: 3, localId: null, createdAt: 1, content: await envelope({
                    role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Published text' } },
                }), surfaceItemReference: reference }],
                hasMore: false, nextBeforeSeq: null } };
        const visual = { messageId: 'published-message', encryptionMode: mode, networkOff: true, reference,
            record: { id: 'record', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' }, revision,
                content: await envelope(item), createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } };
        const fetch = vi.fn<BrowserFetchBoundary>().mockResolvedValueOnce(new Response(JSON.stringify(payload)))
            .mockResolvedValueOnce(new Response(JSON.stringify(visual)))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...visual, record: { ...visual.record, address: { ...visual.record.address, localId: 'other' } } })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...visual, record: { ...visual.record, content: await envelope({ ...item, destination: 'board' }) } })));
        const result = await loadPublicShareViewerContent({ location, fetch });
        expect(fetch).toHaveBeenCalledTimes(1);
        if (result.status !== 'ready') throw new Error('Expected admitted Session page');
        expect(await result.messages![0].loadVisual!()).toMatchObject({ status: 'ready', item, networkOff: true });
        expect(fetch.mock.calls[1]).toEqual([`${location.origin}/v1/public-shares/lookup/visual/published-message`, expect.objectContaining({
            credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'x-public-share-messages-access-token': 'grant' },
        })]);
        expect(JSON.stringify(fetch.mock.calls)).not.toContain(secret);
        expect(await result.messages![0].loadVisual!()).toEqual({ status: 'invalid_content' });
        expect(await result.messages![0].loadVisual!()).toEqual({ status: 'unavailable' });
    });
    it('opens both native Claude visuals in one admitted result row through distinct granted members', async () => {
        const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
        const item = (title: string) => ({ v: 1, destination: 'transcript', title, frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'hostedHtml', source: { v: 1, entrypoint: 'index.html', files: {
                'index.html': { mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode(`<h1>${title}</h1>`)) },
            } } } });
        const origin = { v: 1, serverId: 'home', sessionId: 'parent', sourceMessageId: 'original-result', sourceSeq: 2 };
        const ids = ['first', 'second'];
        const calls = ids.map(id => ({ type: 'tool_use', id, name: 'session_board_item_upsert',
            input: { itemId: id, expectedItemRevision: null, destination: 'transcript', item: item(id) } }));
        const results = ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ v: 1,
            serverId: 'home', sessionId: 'parent', itemDestination: 'transcript', destination: null,
            result: { operation: 'upsert_item', itemId: id, itemRevision: revision, outcome: 'created' } }) }));
        const reference = { v: 1, references: ids.map(id => ({ v: 1, itemId: `child-${id}`, itemRevision: revision,
            sourceAddress: { serverId: 'home', sessionId: 'parent' }, sourceItemId: id, sourceItemRevision: revision })) };
        const raw = (content: unknown[], type: string, seq: number) => ({ role: 'agent', content: { type: 'output', data: {
            type, uuid: `native-${seq}`, message: { role: type === 'assistant' ? 'assistant' : 'user', content },
        } }, meta: { forkVisualOriginV1: { ...origin, sourceMessageId: `original-${seq}`, sourceSeq: seq } } });
        const payload = { subject: { kind: 'session', id: 'child' }, encryptionMode: 'plain', encryptedDataKey: null,
            keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: true, messagesAccessToken: 'grant',
            content: { kind: 'session', metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
                messages: [{ id: 'native-call', seq: 1, createdAt: 1, content: { t: 'plain', v: raw(calls, 'assistant', 1) } },
                    { id: 'native-result', seq: 2, createdAt: 2, content: { t: 'plain', v: raw(results, 'user', 2) }, surfaceItemReference: reference }],
                hasMore: false, nextBeforeSeq: null } };
        const fetch = vi.fn<BrowserFetchBoundary>().mockImplementation(async url => {
            const parsed = new URL(String(url));
            if (parsed.pathname.endsWith('/content')) return new Response(JSON.stringify(payload));
            const index = Number(parsed.searchParams.get('referenceIndex'));
            const member = reference.references[index];
            return new Response(JSON.stringify({ messageId: 'native-result', encryptionMode: 'plain', networkOff: true, reference: member,
                record: { id: `record-${index}`, address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: member.itemId },
                    revision, content: { t: 'plain', v: item(member.itemId) }, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } }));
        });
        const loaded = await loadPublicShareViewerContent({ location, fetch });
        if (loaded.status !== 'ready') throw new Error('Expected admitted native Claude rows');
        expect(readPublicSessionVisualMessages(loaded.messages!).get('native-result')).toEqual([
            { status: 'available', referenceIndex: 0 }, { status: 'available', referenceIndex: 1 },
        ]);
        const observers: IntersectionObserverCallback[] = [];
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
            observe() {} disconnect() {}
        });
        const { root, elements } = createBrowserBoundary();
        renderPublicShareViewer(root as unknown as HTMLElement, loaded);
        expect(fetch).toHaveBeenCalledTimes(1);
        for (const callback of observers) callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        await vi.waitFor(() => expect(attachedElements(elements).filter(element => element.tag === 'iframe')).toHaveLength(2));
        expect(fetch.mock.calls.slice(1).map(([url]) => new URL(String(url)).searchParams.get('referenceIndex'))).toEqual(['0', '1']);
        expect(elements.find(element => element.attributes['data-message-id'] === 'native-result')?.childNodes.filter(element => element.tag === 'div')).toHaveLength(2);
        expect(JSON.stringify(fetch.mock.calls)).not.toContain('parent');
    });
    it("opens explicit HTML kind as a document bundle while ordinary content stays text", async () => {
        const html = { ...plain, content: { ...plain.content,
            header: encodePlainArtifactStoredContent({ title: "HTML", kind: "html" }),
        } };
        const result = await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(html)) });
        expect(result).toMatchObject({ status: "ready", html: { v: 1, entrypoint: "index.html", files: {
            "index.html": { mime: "text/html", contentBase64: encodeBase64(new TextEncoder().encode("<script>globalThis.pwned=true</script>")) },
        } } });
    });
    it.each(['plain', 'e2ee'] as const)('opens the existing %s binary bundle envelope and rejects substituted bytes', async mode => {
        const key = new Uint8Array(32).fill(19);
        const bundle = { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode('<h1>Binary</h1>')) } } };
        const bytes = new TextEncoder().encode(JSON.stringify(bundle));
        const blobId = crypto.randomUUID();
        const reference = { blobId, mime: ARTIFACT_HTML_BUNDLE_MIME_V1, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        const openValue = async (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value) : encodeBase64(await sealSessionDataKeyBundleV0(value, key));
        const payload = { ...plain, encryptionMode: mode, encryptedDataKey: mode === 'plain' ? null : sealPublicShareDataKeyV1({ dataKey: key, secret, randomBytes: length => new Uint8Array(length).fill(4) }), content: {
            ...plain.content, header: await openValue({ kind: 'html', title: 'Binary' }), body: await openValue({ body: reference }),
            blob: { blobId, content: mode === 'plain' ? { t: 'plain', v: encodeBase64(bytes) } : { t: 'encrypted', c: encodeBase64(frameSessionDataKeyBundleV0(await sealAesGcmPayloadWebCrypto(bytes, key))) } },
        } };
        const fetch = async () => new Response(JSON.stringify(payload));
        expect(await loadPublicShareViewerContent({ location, fetch })).toMatchObject({ status: 'ready', html: bundle });
        const file = { ...payload, content: { ...payload.content, header: await openValue({ kind: 'file', title: 'File' }) } };
        expect(await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(file)) })).toMatchObject({ status: 'ready', binary: { bytes, mime: reference.mime } });
        const damaged = { ...payload, content: { ...payload.content, blob: { ...payload.content.blob, content: { t: 'plain', v: encodeBase64(new Uint8Array([1])) } } } };
        expect(await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(damaged)) })).toEqual({ status: 'invalid_content' });
    });
    it.each(['plain', 'e2ee'] as const)('opens and projects %s PNG, PDF and file bytes only after integrity and mode admission', async mode => {
        const key = new Uint8Array(32).fill(21);
        const encode = async (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value) : encodeBase64(await sealSessionDataKeyBundleV0(value, key));
        for (const [kind, mime, tag] of [['image', 'image/png', 'img'], ['pdf', 'application/pdf', 'object'], ['file', 'application/octet-stream', null], ['file', 'image/svg+xml', null]] as const) {
            const bytes = new Uint8Array([0, 128, 255, 13, 10]);
            const blobId = crypto.randomUUID();
            const reference = { blobId, mime, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
            const content = mode === 'plain' ? { t: 'plain', v: encodeBase64(bytes) } : { t: 'encrypted', c: encodeBase64(frameSessionDataKeyBundleV0(await sealAesGcmPayloadWebCrypto(bytes, key))) };
            const payload = { ...plain, encryptionMode: mode, encryptedDataKey: mode === 'plain' ? null : sealPublicShareDataKeyV1({ dataKey: key, secret, randomBytes: length => new Uint8Array(length).fill(4) }), content: {
                ...plain.content, header: await encode({ title: 'Download.bin', kind }), body: await encode({ body: reference }), blob: { blobId, content },
            } };
            const fetch = vi.fn<BrowserFetchBoundary>().mockImplementation(async () => new Response(JSON.stringify(payload)));
            const result = await loadPublicShareViewerContent({ location, fetch });
            expect(result).toMatchObject({ status: 'ready', binary: { bytes, mime } });
            const { root, elements } = createBrowserBoundary();
            renderPublicShareViewer(root as unknown as HTMLElement, result, undefined, { delivery: 'isolated-origin' });
            const download = elements.find(element => element.tag === 'a');
            expect(download).toMatchObject({ download: 'Download.bin', href: expect.stringMatching(/^blob:/u) });
            const renderedBlob = await globalThis.fetch(download!.href!).then(response => response.blob());
            expect(new Uint8Array(await renderedBlob.arrayBuffer())).toEqual(bytes);
            expect(renderedBlob.type).toBe(tag ? mime : 'application/octet-stream');
            if (tag) expect(elements.find(element => element.tag === tag)).toMatchObject(tag === 'img' ? { src: download!.href, alt: 'Download.bin' } : { data: download!.href, type: 'application/pdf' });
            else expect(elements.some(element => ['img', 'object', 'iframe'].includes(element.tag))).toBe(false);
            renderPublicShareViewer(root as unknown as HTMLElement, { status: 'unavailable' });
            await expect(globalThis.fetch(download!.href!)).rejects.toThrow();
            expect(JSON.stringify(fetch.mock.calls)).not.toContain(secret);
            if (mode === 'e2ee') expect(await loadPublicShareViewerContent({ location: { ...location, hash: '#k=' + 'B'.repeat(43) }, fetch })).toEqual({ status: 'invalid_link' });
            const damaged = { ...payload, content: { ...payload.content, blob: { blobId, content: { ...content, [mode === 'plain' ? 'v' : 'c']: encodeBase64(new Uint8Array([1])) } } } };
            expect(await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(damaged)) })).toEqual({ status: 'invalid_content' });
            const substitutedBytes = bytes.slice();
            substitutedBytes[0] ^= 1;
            const substituted = { ...payload, content: { ...payload.content, blob: { blobId, content: mode === 'plain'
                ? { t: 'plain', v: encodeBase64(substitutedBytes) }
                : { t: 'encrypted', c: encodeBase64(frameSessionDataKeyBundleV0(await sealAesGcmPayloadWebCrypto(substitutedBytes, key))) },
            } } };
            expect(await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(substituted)) })).toEqual({ status: 'invalid_content' });
            if (mode === 'e2ee') {
                const wrongKey = { ...payload, content: { ...payload.content, blob: { blobId, content: { t: 'encrypted',
                    c: encodeBase64(frameSessionDataKeyBundleV0(await sealAesGcmPayloadWebCrypto(bytes, new Uint8Array(32).fill(22)))),
                } } } };
                expect(await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(wrongKey)) })).toEqual({ status: 'invalid_content' });
            }
            const mismatch = { ...payload, content: { ...payload.content, blob: { blobId, content: mode === 'plain' ? { t: 'encrypted', c: '' } : { t: 'plain', v: encodeBase64(bytes) } } } };
            expect(await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify(mismatch)) })).toEqual({ status: 'invalid_content' });
        }
    });
    it("renders the typed owner-upgrade state without displaying legacy metadata", async () => {
        const fetch = vi.fn<BrowserFetchBoundary>().mockResolvedValue(new Response(JSON.stringify({
            error: "Session metadata privacy upgrade required", code: "metadata_privacy_upgrade_required",
        }), { status: 409 }));
        const result = await loadPublicShareViewerContent({ location, fetch });
        expect(result).toEqual({ status: "metadata_privacy_upgrade_required" });
        const { root, elements } = createBrowserBoundary();
        renderPublicShareViewer(root as unknown as HTMLElement, result);
        expect(elements.some(element => element.tag === "p" && element.textContent?.includes("owner"))).toBe(true);
        expect(elements.some(element => element.tag === "pre")).toBe(false);
    });
    it("fetches by lookup alone without credentials and opens the canonical plain Artifact codec", async () => {
        const fetch = vi.fn<BrowserFetchBoundary>().mockResolvedValue(new Response(JSON.stringify(plain)));
        const result = await loadPublicShareViewerContent({ location, fetch });
        expect(result).toMatchObject({ status: "ready", title: "Shared document", text: "<script>globalThis.pwned=true</script>" });
        expect(fetch).toHaveBeenCalledWith(`${location.origin}/v1/public-shares/lookup/content`, expect.objectContaining({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }));
        expect(JSON.stringify(fetch.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(fetch.mock.calls)).not.toContain("Authorization");
    });

    it.each(["", "#k=wrong", "#k=" + secret + "&k=" + secret, "#secret=" + secret])("fails closed before fetching for fragment %s", async hash => {
        const fetch = vi.fn<BrowserFetchBoundary>();
        expect(await loadPublicShareViewerContent({ location: { ...location, hash }, fetch })).toMatchObject({ status: "invalid_link" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("reports consent without implicitly admitting the viewer and retries only the owner consent query", async () => {
        const fetch = vi.fn<BrowserFetchBoundary>()
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: "consent_required", requiresConsent: true }), { status: 403 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(plain)));
        expect(await loadPublicShareViewerContent({ location, fetch })).toMatchObject({ status: "consent_required" });
        expect(await loadPublicShareViewerContent({ location, fetch, consent: true })).toMatchObject({ status: "ready" });
        expect(fetch.mock.calls[1]?.[0]).toBe(`${location.origin}/v1/public-shares/lookup/content?consent=true`);
    });

    it("refuses revoked responses and mode/content mismatches", async () => {
        const fetch = vi.fn<BrowserFetchBoundary>()
            .mockResolvedValueOnce(new Response("{}", { status: 404 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...plain, encryptionMode: "e2ee" })));
        expect(await loadPublicShareViewerContent({ location, fetch })).toMatchObject({ status: "unavailable" });
        expect(await loadPublicShareViewerContent({ location, fetch })).toMatchObject({ status: "invalid_content" });
    });

    it('the served browser bundle renders an additive stored widget without granting unknown capabilities', async () => {
        const definition = { v: 1, id: 'artifact', name: 'Saved HTML', futureDisplayField: 1,
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium', futureDisplayField: 1 },
            body: { kind: 'html', futureDisplayField: 1, requestedCapabilities: { network: 'none', futureNetwork: 'open' },
                source: { v: 1, entrypoint: 'index.html', files: {
                    'index.html': { mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode('<h1>Stored widget</h1>')) },
                } } }, inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            provenance: { source: { kind: 'authored' } } };
        const payload = { ...plain, content: { ...plain.content,
            header: encodePlainArtifactStoredContent({ kind: 'widget-definition.v1', v: 1, title: definition.name }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(definition) }) } };
        const { elements, document } = createBrowserBoundary();
        const context = createContext({ document, location,
            fetch: async () => new Response(JSON.stringify(payload)), TextEncoder, TextDecoder, URL, URLSearchParams,
            crypto: globalThis.crypto, Uint8Array, atob: globalThis.atob, btoa: globalThis.btoa, addEventListener() {} });
        runInContext('globalThis.self = globalThis;', context);
        runInContext(viewerBrowserScript, context);
        await vi.waitFor(() => expect(attachedElements(elements).find(element => element.tag === 'iframe')).toBeDefined());
        expect(attachedElements(elements).find(element => element.tag === 'iframe')?.srcdoc).toContain('Stored widget');
        expect(attachedElements(elements).find(element => element.tag === 'iframe')?.srcdoc).toContain('connect-src data:;');
    });

    it.each([404, 429])('the served browser client renders denied content (%s) as the canonical unavailable state', async status => {
        const { elements, document } = createBrowserBoundary();
        const fetch = vi.fn<BrowserFetchBoundary>().mockResolvedValue(new Response('{"error":"public_share_unavailable"}', { status }));
        runInNewContext(viewerBrowserScript, { document, location, fetch, TextEncoder, TextDecoder, URL, URLSearchParams, crypto: globalThis.crypto, Uint8Array,
            addEventListener() {} });
        await vi.waitFor(() => expect(elements.find(element => element.tag === 'p')?.textContent).toContain('revoked'));
        expect(elements.find(element => element.tag === 'h1')?.textContent).toBe('Shared content');
        expect(elements.some(element => element.tag === 'pre')).toBe(false);
        expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    });

    it('offers the existing retry state for temporarily unavailable public blob bytes', async () => {
        const result = await loadPublicShareViewerContent({ location,
            fetch: async () => new Response(JSON.stringify({ error: 'public_share_unavailable' }), { status: 503 }) });
        expect(result).toEqual({ status: 'network_error' });
    });

    it("authenticates encrypted Artifact content using only the fragment secret", async () => {
        const dataKey = new Uint8Array(32).fill(7);
        const encryptedDataKey = sealPublicShareDataKeyV1({ dataKey, secret, randomBytes: length => new Uint8Array(length).fill(2) });
        const encrypted = { ...plain, encryptionMode: "e2ee", encryptedDataKey, content: { ...plain.content,
            header: encodeBase64(await sealSessionDataKeyBundleV0({ title: "Private document" }, dataKey)),
            body: encodeBase64(await sealSessionDataKeyBundleV0({ body: "Opened in this browser" }, dataKey)),
        } };
        const fetch = vi.fn<BrowserFetchBoundary>().mockImplementation(async () => new Response(JSON.stringify(encrypted)));
        expect(await loadPublicShareViewerContent({ location, fetch })).toMatchObject({ status: "ready", text: "Opened in this browser" });
        expect(await loadPublicShareViewerContent({ location: { ...location, hash: "#k=" + "B".repeat(43) }, fetch })).toMatchObject({ status: "invalid_link" });
        expect(await loadPublicShareViewerContent({ location, fetch: async () => new Response(JSON.stringify({ ...encrypted, content: { ...encrypted.content, body: plain.content.body } })) })).toMatchObject({ status: "invalid_content" });
    });

    it("opens real encrypted Session messages and pages using the owner's grant", async () => {
        const dataKey = new Uint8Array(32).fill(7);
        const encryptedDataKey = sealPublicShareDataKeyV1({ dataKey, secret, randomBytes: length => new Uint8Array(length).fill(2) });
        const response = { subject: { kind: "session", id: "session" }, encryptionMode: "e2ee", encryptedDataKey,
            keyDerivation: "fragment_v1", isConsentRequired: false, messagesAccessToken: "grant",
            content: { kind: "session", metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
                messages: [{ id: "message", seq: 4, createdAt: 0, content: { t: "encrypted", c: encodeBase64(await sealSessionDataKeyBundleV0({ role: "user", content: { type: "text", text: "Hello" } }, dataKey)) } }],
                hasMore: true, nextBeforeSeq: 4 } };
        const fetch = vi.fn<BrowserFetchBoundary>().mockResolvedValue(new Response(JSON.stringify(response)));
        expect(await loadPublicShareViewerContent({ location, fetch, beforeSeq: 5, messagesAccessToken: "grant" })).toMatchObject({ status: "ready", text: "Hello", nextBeforeSeq: 4, messagesAccessToken: "grant" });
        expect(fetch.mock.calls[0]).toEqual([`${location.origin}/v1/public-shares/lookup/content?beforeSeq=5`, expect.objectContaining({ headers: { "x-public-share-messages-access-token": "grant" }, credentials: "omit" })]);
    });

    it("renders untrusted content only through text nodes", () => {
        const nodes: Array<{ tag: string; textContent: string | null }> = [];
        // Document is the browser/OS boundary. Its HTML sink rejects writes so the
        // test detects accidental HTML rendering without replacing content logic.
        const root = {
            ownerDocument: { createElement: (tag: string) => ({ tag, textContent: null,
                set innerHTML(_value: string) { throw new Error("HTML sink used"); } }) },
            replaceChildren: (...children: Array<{ tag: string; textContent: string | null }>) => { nodes.push(...children); },
        } as unknown as HTMLElement;
        renderPublicShareViewer(root, { status: "ready", title: "<img onerror=alert(1)>", text: "<script>alert(1)</script>", nextBeforeSeq: null, messagesAccessToken: null });
        expect(nodes).toEqual([{ tag: "h1", textContent: "<img onerror=alert(1)>" }, { tag: "pre", textContent: "<script>alert(1)</script>" }]);
    });

    it.each(['main-origin', undefined] as const)('offers PDF bytes only as an octet-stream download for %s delivery', async delivery => {
        const { root, elements } = createBrowserBoundary();
        const bytes = new Uint8Array([37, 80, 68, 70, 45]);
        renderPublicShareViewer(root as unknown as HTMLElement, { status: 'ready', title: 'Shared.pdf', text: '',
            binary: { bytes, mime: 'application/pdf' }, nextBeforeSeq: null, messagesAccessToken: null }, undefined, { delivery });
        expect(elements.some(element => ['object', 'iframe', 'embed'].includes(element.tag))).toBe(false);
        const download = elements.find(element => element.tag === 'a');
        expect(download).toMatchObject({ download: 'Shared.pdf', href: expect.stringMatching(/^blob:/u) });
        const response = await globalThis.fetch(download!.href!);
        expect(response.headers.get('content-type')).toBe('application/octet-stream');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
        renderPublicShareViewer(root as unknown as HTMLElement, { status: 'unavailable' });
        await expect(globalThis.fetch(download!.href!)).rejects.toThrow();
    });

    it.each(['main-origin', 'isolated-origin', 'malformed'] as const)('the served browser bundle obeys trusted %s PDF delivery', async delivery => {
        const { elements, document } = createBrowserBoundary(delivery);
        const bytes = new Uint8Array([37, 80, 68, 70, 45]);
        const blobId = crypto.randomUUID();
        const reference = { blobId, mime: 'application/pdf', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        const payload = { ...plain, content: { ...plain.content,
            header: encodePlainArtifactStoredContent({ kind: 'pdf', title: 'Shared.pdf' }),
            body: encodePlainArtifactStoredContent({ body: reference }), blob: { blobId, content: { t: 'plain', v: encodeBase64(bytes) } },
        } };
        const fetch = vi.fn<BrowserFetchBoundary>().mockImplementation(async () => new Response(JSON.stringify(payload)));
        runInNewContext(viewerBrowserScript, { document, location, fetch, TextEncoder, TextDecoder, URL, URLSearchParams, Blob, crypto: globalThis.crypto, Uint8Array, addEventListener() {} });
        await vi.waitFor(() => expect(elements.some(element => element.tag === 'a')).toBe(true));
        expect(elements.some(element => element.tag === 'object')).toBe(delivery === 'isolated-origin');
        const download = elements.find(element => element.tag === 'a')!;
        const downloaded = await globalThis.fetch(download.href!);
        expect(downloaded.headers.get('content-type')).toBe(delivery === 'isolated-origin' ? 'application/pdf' : 'application/octet-stream');
        expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
        URL.revokeObjectURL(download.href!);
    });

    it('the served browser bundle opens a saved HTML widget under its copied network override and withdraws its iframe', async () => {
        const { elements, document } = createBrowserBoundary();
        const definition = { v: 1, id: 'artifact', name: 'Saved HTML widget',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            body: { kind: 'html', requestedCapabilities: { network: 'open' }, source: { v: 1, entrypoint: 'index.html', files: {
                'index.html': { mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode('<script>globalThis.local = true</script>')) },
            } } }, networkOverride: { network: 'none' },
            inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } } };
        const payload = { ...plain, content: { ...plain.content,
            header: encodePlainArtifactStoredContent({ kind: 'widget-definition.v1', v: 1, title: definition.name }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(definition) }) } };
        const fetch = vi.fn<BrowserFetchBoundary>().mockResolvedValue(new Response(JSON.stringify(payload)));
        const viewerLocation = { ...location };
        let fragmentChanged: (() => void) | undefined;
        const context = createContext({ document, location: viewerLocation, fetch, TextEncoder, TextDecoder, URL, URLSearchParams,
            crypto: globalThis.crypto, Uint8Array, atob: globalThis.atob, btoa: globalThis.btoa,
            addEventListener: (type: string, callback: () => void) => { if (type === 'hashchange') fragmentChanged = callback; } });
        // The HTML lexer uses the browser's self alias; retain this VM's own
        // intrinsics instead of exposing the Node host through that boundary.
        runInContext('globalThis.self = globalThis;', context);
        runInContext(viewerBrowserScript, context);
        await vi.waitFor(() => expect(attachedElements(elements).some(element => element.tag === 'iframe'),
            JSON.stringify({ dom: attachedElements(elements).map(element => ({ tag: element.tag, text: element.textContent })) })).toBe(true));
        const frame = attachedElements(elements).find(element => element.tag === 'iframe')!;
        expect(frame.srcdoc).toContain('connect-src data:;');
        expect(frame.srcdoc).toContain('globalThis.local = true');
        expect(frame.srcdoc).not.toContain('host.request');
        expect(frame.attributes.sandbox).toBe('allow-scripts');
        viewerLocation.hash = '';
        fragmentChanged?.();
        await vi.waitFor(() => expect(attachedElements(elements).some(element => element.tag === 'iframe')).toBe(false));
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('the served browser bundle keeps a saved builtin unavailable without authenticated reads or a snapshot', async () => {
        const { elements, document } = createBrowserBoundary();
        const definition = { v: 1, id: 'artifact', name: 'Saved daily usage',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            body: { kind: 'builtin', id: 'usage_daily' },
            inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            provenance: { source: { kind: 'authored' } } };
        const payload = { ...plain, content: { ...plain.content,
            header: encodePlainArtifactStoredContent({ kind: 'widget-definition.v1', v: 1, title: definition.name }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(definition) }) } };
        const fetch = vi.fn<BrowserFetchBoundary>().mockResolvedValue(new Response(JSON.stringify(payload)));
        runInNewContext(viewerBrowserScript, { document, location, fetch, TextEncoder, TextDecoder,
            URL, URLSearchParams, crypto: globalThis.crypto, Uint8Array, addEventListener() {} });
        await vi.waitFor(() => expect(attachedElements(elements).find(element => element.attributes['data-public-widget-state'] === 'unavailable')?.textContent)
            .toContain('viewer connection'));
        expect(attachedElements(elements).some(element => element.tag === 'iframe')).toBe(false);
        expect(fetch.mock.calls.map(([url, init]) => ({ url: String(url), credentials: init?.credentials })))
            .toEqual([{ url: `${location.origin}/v1/public-shares/lookup/content`, credentials: 'omit' }]);
    });

    it("the served browser bundle preserves opened text when an earlier page cannot be reached", async () => {
        const { elements, document } = createBrowserBoundary();
        const response = { subject: { kind: "session", id: "session" }, encryptionMode: "plain", encryptedDataKey: null,
            keyDerivation: "fragment_v1", isConsentRequired: false, messagesAccessToken: "grant", content: {
                kind: "session", metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
                messages: [{ id: "message", seq: 4, createdAt: 0, messageRole: "user",
                    content: { t: "plain", v: { role: "user", content: { type: "text", text: "Opened text" } } } }],
                hasMore: true, nextBeforeSeq: 4,
            } };
        const fetch = vi.fn<BrowserFetchBoundary>().mockResolvedValueOnce(new Response(JSON.stringify(response))).mockRejectedValueOnce(new Error("offline"));
        const viewerLocation = { ...location };
        let fragmentChanged: (() => void) | undefined;
        runInNewContext(viewerBrowserScript, { document, location: viewerLocation, fetch, TextEncoder, TextDecoder, URL, URLSearchParams, crypto: globalThis.crypto, Uint8Array,
            addEventListener: (type: string, callback: () => void) => { if (type === "hashchange") fragmentChanged = callback; } });
        await vi.waitFor(() => expect(attachedElements(elements).find(element => element.tag === "pre")?.textContent).toBe("Opened text"));
        elements.find(element => element.tag === "button")?.click?.();
        await vi.waitFor(() => expect(elements.some(element => element.tag === "p" && element.textContent?.includes("Earlier messages"))).toBe(true));
        expect(attachedElements(elements).find(element => element.tag === "pre")?.textContent).toBe("Opened text");
        viewerLocation.hash = "#k=wrong";
        fragmentChanged?.();
        await vi.waitFor(() => expect(elements.some(element => element.tag === "p" && element.textContent?.includes("incomplete"))).toBe(true));
        expect(attachedElements(elements).some(element => element.tag === "pre")).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('the served browser bundle opens a binary image and releases its URL when the fragment changes', async () => {
        const { elements, document } = createBrowserBoundary();
        const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGgAAAABJRU5ErkJggg==', 'base64'));
        const blobId = crypto.randomUUID();
        const reference = { blobId, mime: 'image/png', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        const payload = { ...plain, content: { ...plain.content,
            header: encodePlainArtifactStoredContent({ kind: 'image', title: 'Shared image.png' }),
            body: encodePlainArtifactStoredContent({ body: reference }), blob: { blobId, content: { t: 'plain', v: encodeBase64(bytes) } },
        } };
        const fetch = vi.fn<BrowserFetchBoundary>().mockImplementation(async () => new Response(JSON.stringify(payload)));
        const viewerLocation = { ...location };
        let fragmentChanged: (() => void) | undefined;
        runInNewContext(viewerBrowserScript, { document, location: viewerLocation, fetch, TextEncoder, TextDecoder, URL, URLSearchParams, Blob, crypto: globalThis.crypto, Uint8Array,
            addEventListener: (type: string, callback: () => void) => { if (type === 'hashchange') fragmentChanged = callback; } });
        await vi.waitFor(() => expect(elements.find(element => element.tag === 'img')?.alt).toBe('Shared image.png'));
        const url = elements.find(element => element.tag === 'a')!.href!;
        const downloaded = await globalThis.fetch(url);
        const downloadedBytes = await downloaded.arrayBuffer();
        expect(new Uint8Array(downloadedBytes)).toEqual(bytes);
        viewerLocation.hash = '#k=wrong';
        fragmentChanged?.();
        await vi.waitFor(() => expect(elements.some(element => element.tag === 'p' && element.textContent?.includes('incomplete'))).toBe(true));
        expect(elements.some(element => element.tag === 'img')).toBe(false);
        await expect(globalThis.fetch(url)).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("the served browser bundle never renders an in-flight response for a removed fragment", async () => {
        const { elements, document } = createBrowserBoundary();
        const viewerLocation = { ...location };
        let fragmentChanged: (() => void) | undefined;
        let release!: (response: Response) => void;
        const pending = new Promise<Response>(resolve => { release = resolve; });
        const fetch = vi.fn<BrowserFetchBoundary>().mockReturnValue(pending);
        runInNewContext(viewerBrowserScript, { document, location: viewerLocation, fetch, TextEncoder, TextDecoder, URL, URLSearchParams, Blob, crypto: globalThis.crypto, Uint8Array,
            addEventListener: (type: string, callback: () => void) => { if (type === "hashchange") fragmentChanged = callback; } });
        viewerLocation.hash = "";
        fragmentChanged?.();
        await vi.waitFor(() => expect(elements.some(element => element.textContent?.includes("incomplete"))).toBe(true));
        const bytes = new Uint8Array([1, 2, 3]);
        const blobId = crypto.randomUUID();
        const delayed = { ...plain, content: { ...plain.content,
            header: encodePlainArtifactStoredContent({ kind: 'file', title: 'Earlier link' }),
            body: encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }),
            blob: { blobId, content: { t: 'plain', v: encodeBase64(bytes) } },
        } };
        const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
        release(new Response(JSON.stringify(delayed)));
        // Drain the response's real asynchronous JSON read before checking that
        // the preceding fragment cannot replace the current failure state.
        await vi.waitFor(() => expect(digest).toHaveBeenCalled());
        await digest.mock.results[0].value;
        await new Promise<void>(resolve => setImmediate(resolve));
        digest.mockRestore();
        expect(elements.some(element => element.tag === "pre")).toBe(false);
        expect(elements.some(element => element.tag === 'a')).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
