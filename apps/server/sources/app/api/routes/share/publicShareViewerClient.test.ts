import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { encodePlainArtifactStoredContent, sealPublicShareDataKeyV1,
    sealSessionDataKeyBundleV0, sealAesGcmPayloadWebCrypto, frameSessionDataKeyBundleV0 } from '@happier-dev/protocol';
import { ARTIFACT_HTML_BUNDLE_MIME_V1, encodeBase64 } from "@happier-dev/protocol/sharing/public-viewer";
import { createHash } from 'node:crypto';
import { loadPublicShareViewerContent, renderPublicShareViewer } from "./publicShareViewerClient";
import { PUBLIC_SHARE_VIEWER_SCRIPT } from "./publicShareViewerBundle.generated";

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
    src?: string; data?: string; href?: string; download?: string; type?: string; alt?: string;
    style: { cssText: string }; attributes: Record<string, string>;
    setAttribute(name: string, value: string): void;
    addEventListener(type: string, callback: () => void): void;
}
interface RootBoundary { ownerDocument: DocumentBoundary; replaceChildren(...children: ElementBoundary[]): void; append(element: ElementBoundary): void; textContent: string }
interface DocumentBoundary { getElementById(): RootBoundary; createElement(tag: string): ElementBoundary }
function createBrowserBoundary() {
    const elements: ElementBoundary[] = [];
    const document: DocumentBoundary = { getElementById: () => root, createElement: (tag: string): ElementBoundary => ({ tag, textContent: null,
        style: { cssText: '' }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(_type, callback) { this.click = callback; },
    }) };
    const root: RootBoundary = { ownerDocument: document, replaceChildren: (...children: ElementBoundary[]) => { elements.splice(0, elements.length, ...children); },
        append: (element: ElementBoundary) => elements.push(element),
        set textContent(value: string) { elements.splice(0, elements.length, { tag: "#text", textContent: value, style: { cssText: '' }, attributes: {}, setAttribute() {}, addEventListener() {} }); } };
    return { elements, document, root };
}

describe("isolated public viewer browser boundary", () => {
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
            const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify(payload)));
            const result = await loadPublicShareViewerContent({ location, fetch });
            expect(result).toMatchObject({ status: 'ready', binary: { bytes, mime } });
            const { root, elements } = createBrowserBoundary();
            renderPublicShareViewer(root as unknown as HTMLElement, result);
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
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
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
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(plain)));
        const result = await loadPublicShareViewerContent({ location, fetch });
        expect(result).toMatchObject({ status: "ready", title: "Shared document", text: "<script>globalThis.pwned=true</script>" });
        expect(fetch).toHaveBeenCalledWith(`${location.origin}/v1/public-shares/lookup/content`, expect.objectContaining({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }));
        expect(JSON.stringify(fetch.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(fetch.mock.calls)).not.toContain("Authorization");
    });

    it.each(["", "#k=wrong", "#k=" + secret + "&k=" + secret, "#secret=" + secret])("fails closed before fetching for fragment %s", async hash => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        expect(await loadPublicShareViewerContent({ location: { ...location, hash }, fetch })).toMatchObject({ status: "invalid_link" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("reports consent without implicitly admitting the viewer and retries only the owner consent query", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: "consent_required", requiresConsent: true }), { status: 403 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(plain)));
        expect(await loadPublicShareViewerContent({ location, fetch })).toMatchObject({ status: "consent_required" });
        expect(await loadPublicShareViewerContent({ location, fetch, consent: true })).toMatchObject({ status: "ready" });
        expect(fetch.mock.calls[1]?.[0]).toBe(`${location.origin}/v1/public-shares/lookup/content?consent=true`);
    });

    it("refuses revoked responses and mode/content mismatches", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(new Response("{}", { status: 404 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...plain, encryptionMode: "e2ee" })));
        expect(await loadPublicShareViewerContent({ location, fetch })).toMatchObject({ status: "unavailable" });
        expect(await loadPublicShareViewerContent({ location, fetch })).toMatchObject({ status: "invalid_content" });
    });

    it.each([404, 429])('the served browser client renders denied content (%s) as the canonical unavailable state', async status => {
        const { elements, document } = createBrowserBoundary();
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"error":"public_share_unavailable"}', { status }));
        runInNewContext(PUBLIC_SHARE_VIEWER_SCRIPT, { document, location, fetch, TextEncoder, TextDecoder, URL, URLSearchParams, crypto: globalThis.crypto, Uint8Array,
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
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify(encrypted)));
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
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(response)));
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

    it("the served browser bundle preserves opened text when an earlier page cannot be reached", async () => {
        const { elements, document } = createBrowserBoundary();
        const response = { subject: { kind: "session", id: "session" }, encryptionMode: "plain", encryptedDataKey: null,
            keyDerivation: "fragment_v1", isConsentRequired: false, messagesAccessToken: "grant", content: {
                kind: "session", metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
                messages: [{ id: "message", seq: 4, createdAt: 0, content: { t: "plain", v: { content: { type: "text", text: "Opened text" } } } }],
                hasMore: true, nextBeforeSeq: 4,
            } };
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify(response))).mockRejectedValueOnce(new Error("offline"));
        const viewerLocation = { ...location };
        let fragmentChanged: (() => void) | undefined;
        runInNewContext(PUBLIC_SHARE_VIEWER_SCRIPT, { document, location: viewerLocation, fetch, TextEncoder, TextDecoder, URL, URLSearchParams, crypto: globalThis.crypto, Uint8Array,
            addEventListener: (type: string, callback: () => void) => { if (type === "hashchange") fragmentChanged = callback; } });
        await vi.waitFor(() => expect(elements.find(element => element.tag === "pre")?.textContent).toBe("Opened text"));
        elements.find(element => element.tag === "button")?.click?.();
        await vi.waitFor(() => expect(elements.some(element => element.tag === "p" && element.textContent?.includes("Earlier messages"))).toBe(true));
        expect(elements.find(element => element.tag === "pre")?.textContent).toBe("Opened text");
        viewerLocation.hash = "#k=wrong";
        fragmentChanged?.();
        await vi.waitFor(() => expect(elements.some(element => element.tag === "p" && element.textContent?.includes("incomplete"))).toBe(true));
        expect(elements.some(element => element.tag === "pre")).toBe(false);
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
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify(payload)));
        const viewerLocation = { ...location };
        let fragmentChanged: (() => void) | undefined;
        runInNewContext(PUBLIC_SHARE_VIEWER_SCRIPT, { document, location: viewerLocation, fetch, TextEncoder, TextDecoder, URL, URLSearchParams, Blob, crypto: globalThis.crypto, Uint8Array,
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
        const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(pending);
        runInNewContext(PUBLIC_SHARE_VIEWER_SCRIPT, { document, location: viewerLocation, fetch, TextEncoder, TextDecoder, URL, URLSearchParams, Blob, crypto: globalThis.crypto, Uint8Array,
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
