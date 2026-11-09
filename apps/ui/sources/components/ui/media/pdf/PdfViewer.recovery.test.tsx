// @vitest-environment jsdom
import * as React from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

import { renderHook, renderScreen } from '@/dev/testkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { transferMachine } from '@/components/sessions/files/sessionFileTransferTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPdfSliceAssembler } from './pdfNativeBridge';
import { PdfViewer as NativePdfViewer } from './PdfViewer';
import { PdfViewer as WebPdfViewer } from './PdfViewer.web';
import { useFilePreviewSource, type FilePreviewSourceState, type UseFilePreviewSourceInput } from '../useFilePreviewSource';

const files = vi.hoisted(() => new Map<string, { exists: boolean; bytes: number[] }>());
const pages = vi.hoisted(() => [] as Array<{
    loaded: boolean; scripts: string[]; opened: Uint8Array | null;
}>);
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
// The OS file API is the sink/read boundary; preview and PDF slice custody stay real.
vi.mock('expo-file-system', () => ({
    Paths: { cache: 'file:///pdf-recovery-cache' },
    Directory: class {
        readonly uri: string;
        constructor(parent: string | { uri: string }, name?: string) { this.uri = (typeof parent === 'string' ? parent : parent.uri) + (name ? '/' + name : ''); }
        create() {}
    },
    File: class {
        readonly uri: string;
        constructor(parent: string | { uri: string }, name?: string) {
            this.uri = (typeof parent === 'string' ? parent : parent.uri) + (name ? '/' + name : '');
            if (!files.has(this.uri)) files.set(this.uri, { exists: false, bytes: [] });
        }
        get size() { return files.get(this.uri)!.bytes.length; }
        create() { files.get(this.uri)!.exists = true; }
        delete() { files.get(this.uri)!.exists = false; }
        open() {
            const file = files.get(this.uri)!;
            return { offset: 0, writeBytes: (bytes: Uint8Array) => file.bytes.push(...bytes),
                readBytes(length: number) { const value = new Uint8Array(file.bytes.slice(this.offset, this.offset + length)); this.offset += value.length; return value; },
                close() {} };
        }
    },
}));
// Physical WebView loading/injection is the boundary; execute the real slice assembler.
vi.mock('react-native-webview', async () => {
    const React = await import('react');
    return { WebView: React.forwardRef(function WebView(props: Record<string, unknown>, ref) {
        const [page] = React.useState(() => {
            const value = { loaded: false, scripts: [] as string[], opened: null as Uint8Array | null };
            pages.push(value); return value;
        });
        const assembler = React.useRef<ReturnType<typeof createPdfSliceAssembler> | null>(null);
        React.useImperativeHandle(ref, () => ({ injectJavaScript(script: string) {
            page.scripts.push(script);
            if (!page.loaded) return;
            Function('window', script)({
                __pdfRestore() {}, __pdfZoom() {}, __pdfDispose() {},
                __pdfBegin(size: number) { assembler.current = createPdfSliceAssembler(size); },
                __pdfAppend(slice: string) { assembler.current!.append(slice); },
                __pdfOpen() {
                    page.opened = assembler.current!.finish();
                    (props.onMessage as (event: unknown) => void)({ nativeEvent: { data: JSON.stringify({ type: 'ready', pages: 1 }) } });
                },
            });
        } }), [page, props.onMessage]);
        return React.createElement('WebView', { ...props, onLoadEnd: () => {
            page.loaded = true; (props.onLoadEnd as () => void)();
        } });
    }) };
});
// pdf.js is the library boundary. Loader, canvas owner, state and Find remain real.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
    version: 'test', GlobalWorkerOptions: { workerSrc: '' },
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1,
        getPage: async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
            getTextContent: async () => ({ items: [] }), render: () => ({ promise: Promise.resolve(), cancel() {} }) }),
    }), destroy: async () => {} }),
    TextLayer: class { textDivs: HTMLElement[] = []; render = async () => {}; cancel() {} },
}));

describe('PDF rendered recovery', () => {
    let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
    let failOpen = false;
    const bytes = new TextEncoder().encode('%PDF-1.7');
    beforeAll(prepareSessionFilesViewTestkit);
    beforeEach(async () => {
        Platform.OS = 'ios'; files.clear(); pages.length = 0;
        failOpen = false;
        transfer = createSessionFileNativeTransferBoundary({ bytes, name: 'recovery.pdf' });
        const serverUrl = 'https://session-file-views.test';
        const serverIdentityId = 'srv_pdf_recovery';
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'alice', machineId: 'm1',
            actionId: 'daemon.filesystem.download', tokenEpoch: 0,
            execute: (input, { target }) => {
                if (target.kind !== 'machine') throw new Error('Expected the preview Machine target');
                return transfer.rpc({ targetId: target.machineId,
                    method: getActionSpec('daemon.filesystem.download').bindings!.rpcMethod!, payload: input });
            },
        });
        const machine = transferMachine({ id: 'm1', storageMode: 'plain', installationId: boundary.machine.installationId,
            installationPublicKey: boundary.machine.installationPublicKey, replacedByMachineId: null, access: boundary.machine.access });
        const row = { ...boundary.machine, operationProtocolCapabilities: machine.operationProtocolCapabilities,
            operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision,
            daemonState: encodePlainMachineStoredContent(machine.daemonState) };
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', machine, serverIdentityId,
            credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'alice', provenance: { v: 1, kind: 'account', authority: 'present_user' }, tokenEpoch: 0 })).toString('base64url')}.signature` },
            machineCarrierOrigin: transfer.origin, rpc: transfer.rpc, request: async (url, init) => {
                const parsed = new URL(String(url));
                if (parsed.pathname === '/v1/machines') return Response.json([row]);
                if (parsed.pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                    id => id === row.id ? row : null);
                if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: row });
                if (parsed.pathname.startsWith('/v1/actions/')) {
                    const response = await boundary.handle(parsed, init);
                    if (response) return response;
                }
                if (failOpen && parsed.pathname.endsWith('/open')) throw new Error('offline');
                return transfer.request(url, init);
            } });
        fixture.storage.getState().applySettingsLocal({ filesImagePreviewCacheMaxEntries: 10, filesImagePreviewCacheMaxTotalBytes: 1_000_000, filesImagePreviewMaxBytes: 1_000_000 });
    });
    afterEach(async () => { await fixture.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
    const base = { title: 'recovery.pdf', isActive: true, findSurfaceId: 'pdf-recovery', zoom: 'fit-width' as const, onZoomChange() {}, showPagePill: false };

    it('retries a failed native preview transfer and waits for the replacement WebView load', async () => {
        failOpen = true;
        const screen = await renderScreen(<NativePdfViewer {...base} source={{ enabled: true,
            source: { kind: 'workspace', scope: fixture.scope, filePath: 'native-retry.pdf' }, cacheKey: 'native-retry', mimeType: 'application/pdf', sizeBytes: bytes.length }} />);
        await vi.waitFor(() => expect(screen.findByTestId('pdf-viewer-failed')).not.toBeNull());
        expect(transfer.prepares).toHaveLength(1);
        failOpen = false;
        await screen.pressByTestIdAsync('pdf-viewer-failed-action');
        await vi.waitFor(() => expect(transfer.prepares).toHaveLength(2));
        await vi.waitFor(() => expect(screen.findAllByType('WebView')).toHaveLength(1));
        expect(pages.at(-1)?.scripts).toEqual([]);
        await act(async () => screen.findByType('WebView').props.onLoadEnd());
        await vi.waitFor(() => expect(pages.at(-1)?.opened).toEqual(bytes));
        expect(screen.findByTestId('pdf-viewer-loading')).toBeNull();
        await screen.unmount();
    });

    it('loads again after cancel and binds byte injection to the new native WebView', async () => {
        const held = transfer.deferNextComplete();
        const source = { enabled: true, source: { kind: 'workspace' as const, scope: fixture.scope, filePath: 'native-cancel.pdf' },
            cacheKey: 'native-cancel', mimeType: 'application/pdf', sizeBytes: bytes.length };
        const screen = await renderScreen(<NativePdfViewer {...base} source={source} />);
        // Boot can overlap a download, but no byte injection may borrow that page's readiness.
        const initialPage = screen.findAllByType('WebView')[0];
        if (initialPage) await act(async () => initialPage.props.onLoadEnd());
        await vi.waitFor(() => expect(screen.findByTestId('pdf-viewer-loading-cancel')).not.toBeNull());
        await screen.pressByTestIdAsync('pdf-viewer-loading-cancel');
        expect(screen.findByTestId('pdf-viewer-stopped')).not.toBeNull();
        await screen.pressByTestIdAsync('pdf-viewer-stopped-action');
        held.resolve();
        await vi.waitFor(() => expect(transfer.prepares).toHaveLength(2));
        // Observe the same canonical cache fill: readiness must still be false after bytes arrive.
        const preview = await renderHook(() => useFilePreviewSource(source));
        await vi.waitFor(() => expect(preview.getCurrent().status).toBe('loaded'));
        await act(async () => {});
        expect(pages.at(-1)?.scripts).toEqual([]);
        await act(async () => screen.findByType('WebView').props.onLoadEnd());
        await vi.waitFor(() => expect(pages.at(-1)?.opened).toEqual(bytes));
        expect(screen.findByTestId('pdf-viewer-stopped')).toBeNull();
        expect(screen.findByTestId('pdf-viewer-loading')).toBeNull();
        await preview.unmount();
        await screen.unmount();
    });

    it('retries a failed web preview materialization through the real preview and PDF owners', async () => {
        Platform.OS = 'web';
        vi.stubGlobal('Blob', NodeBlob);
        const blobs = new Map<string, NodeBlob>();
        let fail = true;
        vi.stubGlobal('URL', class extends URL {
            static createObjectURL(blob: Blob | MediaSource) {
                if (fail) throw new Error('blob allocation failed');
                const uri = `blob:pdf-recovery-${blobs.size}`; blobs.set(uri, blob as unknown as NodeBlob); return uri;
            }
            static revokeObjectURL() {}
        });
        vi.stubGlobal('fetch', async (uri: string) => ({ ok: true, arrayBuffer: () => blobs.get(uri)!.arrayBuffer() }));
        vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
        const containers: HTMLElement[] = [];
        const screen = await renderScreen(<WebPdfViewer {...base} source={{ enabled: true,
            source: { kind: 'bytes', bytes, name: 'web-retry.pdf' }, cacheKey: 'web-retry', mimeType: 'application/pdf' }} />,
        { createNodeMock: ({ props }) => {
            if (!props.dataSet) return null;
            const container = document.createElement('div'); containers.push(container); return container;
        } });
        await vi.waitFor(() => expect(screen.findByTestId('pdf-viewer-failed')).not.toBeNull());
        fail = false;
        await screen.pressByTestIdAsync('pdf-viewer-failed-action');
        await vi.waitFor(() => expect(containers.some(container => container.querySelector('[data-pdf-page="1"]'))).toBe(true));
        expect(screen.findByTestId('pdf-viewer-failed')).toBeNull();
        expect(screen.findByTestId('pdf-viewer-loading')).toBeNull();
        await screen.unmount();
    });

    it('re-fits a fit-width web PDF when its column narrows, and leaves a chosen zoom alone', async () => {
        Platform.OS = 'web';
        vi.stubGlobal('Blob', NodeBlob);
        const blobs = new Map<string, NodeBlob>();
        vi.stubGlobal('URL', class extends URL {
            static createObjectURL(blob: Blob | MediaSource) { const uri = `blob:pdf-fit-${blobs.size}`; blobs.set(uri, blob as unknown as NodeBlob); return uri; }
            static revokeObjectURL() {}
        });
        vi.stubGlobal('fetch', async (uri: string) => ({ ok: true, arrayBuffer: () => blobs.get(uri)!.arrayBuffer() }));
        vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
        // ResizeObserver is the browser layout boundary: the test says when the column's box changed.
        const resized: Array<(entries?: ResizeObserverEntry[]) => void> = [];
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: ResizeObserverCallback) { resized.push((entries = []) => callback(entries, this as unknown as ResizeObserver)); }
            observe() {} unobserve() {} disconnect() {}
        });
        let columnWidth = 800;
        let hidden = false;
        let container: HTMLElement | null = null;
        const source = { enabled: true, source: { kind: 'bytes' as const, bytes, name: 'fit.pdf' }, cacheKey: 'fit', mimeType: 'application/pdf' };
        const nodeMock = { createNodeMock: ({ props }: { props: Record<string, unknown> }) => {
            if (!props.dataSet) return null;
            const element = document.createElement('div');
            Object.defineProperty(element, 'clientWidth', { get: () => columnWidth });
            Object.defineProperty(element, 'clientHeight', { get: () => hidden ? 0 : 1000 });
            Object.defineProperty(element, 'checkVisibility', { value: () => !hidden });
            container = element; return element;
        } };
        const pageWidth = () => (container?.querySelector<HTMLElement>('[data-pdf-page="1"]')?.style.width ?? null);
        const screen = await renderScreen(<WebPdfViewer {...base} source={source} />, nodeMock);
        await vi.waitFor(() => expect(pageWidth()).toBe('800px'));
        columnWidth = 400;
        act(() => { for (const notify of resized) notify(); });
        expect(pageWidth()).toBe('400px');
        // A retained pane hiding the viewer (display: none) reports the column 0×0: that is not a narrower
        // column, so the pages keep their fitted scale and are not re-rendered for it, nor again on show.
        hidden = true; columnWidth = 0;
        act(() => { for (const notify of resized) notify([{ contentRect: { width: 0, height: 0 } } as ResizeObserverEntry]); });
        expect(pageWidth()).toBe('400px');
        hidden = false; columnWidth = 400;
        act(() => { for (const notify of resized) notify([{ contentRect: { width: 400, height: 1000 } } as ResizeObserverEntry]); });
        expect(pageWidth()).toBe('400px');
        await screen.unmount();

        // A zoom the person chose (125%) is theirs: a narrower column scrolls instead of shrinking the pages.
        columnWidth = 800;
        const chosen = await renderScreen(<WebPdfViewer {...base} zoom={1.25} source={{ ...source, cacheKey: 'fit-chosen' }} />, nodeMock);
        await vi.waitFor(() => expect(pageWidth()).toBe('750px'));
        columnWidth = 400;
        act(() => { for (const notify of resized) notify(); });
        expect(pageWidth()).toBe('750px');
        await chosen.unmount();
    });

    it('waits for the current WebView when the source changes after a decoder failure', async () => {
        const nextBytes = new TextEncoder().encode('%PDF-2.0 replacement');
        const observed: FilePreviewSourceState[] = [];
        const onPreviewChange = (preview: FilePreviewSourceState) => { observed.push(preview); };
        const source = (name: string, bytes: Uint8Array): UseFilePreviewSourceInput => ({
            enabled: true, source: { kind: 'bytes', name, bytes }, mimeType: 'application/pdf',
        });
        const screen = await renderScreen(<NativePdfViewer {...base} source={source('first.pdf', bytes)} onPreviewChange={onPreviewChange} />);
        await vi.waitFor(() => expect(observed.at(-1)).toMatchObject({ status: 'loaded' }));
        await act(async () => screen.findByType('WebView').props.onLoadEnd());
        await vi.waitFor(() => expect(pages.at(-1)?.opened).toEqual(bytes));
        await act(async () => screen.findByType('WebView').props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'state', state: 'error' }) } }));
        expect(screen.findByTestId('pdf-viewer-failed')).not.toBeNull();
        const previousUri = observed.at(-1)?.uri;
        await screen.update(<NativePdfViewer {...base} source={source('replacement.pdf', nextBytes)} onPreviewChange={onPreviewChange} />);
        await vi.waitFor(() => {
            expect(observed.at(-1)).toMatchObject({ status: 'loaded' });
            expect(observed.at(-1)?.uri).not.toBe(previousUri);
        });
        await act(async () => {});
        expect(pages.at(-1)?.loaded).toBe(false);
        expect(pages.at(-1)?.scripts).toEqual([]);
        await act(async () => screen.findByType('WebView').props.onLoadEnd());
        await vi.waitFor(() => expect(pages.at(-1)?.opened).toEqual(nextBytes));
        expect(screen.findByTestId('pdf-viewer-failed')).toBeNull();
        await screen.unmount();
    });
});
