import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPdfSliceAssembler } from './pdfNativeBridge';
import { createPdfDocumentLoader } from './pdfDocumentLoader';
import { createPdfCanvasViewer, type PdfTextLayerFactory } from './pdfCanvasViewer';
import { createPdfFindModel } from './pdfFindModel';
import { readPdfViewport, resolvePdfScale, type PdfZoom } from './pdfZoom';
import type { PdfWebViewMessage } from './pdfNativeBridge';
import { createPdfViewPosition, type PdfViewPosition } from './pdfViewPosition';

declare const __PDFJS_WORKER_SOURCE__: string;
declare global {
    interface Window {
        ReactNativeWebView?: { postMessage(message: string): void };
        __pdfBegin(size: number): void;
        __pdfAppend(slice: string): void;
        __pdfOpen(): Promise<void>;
        __pdfFind(query: string, matchCase?: boolean): void;
        __pdfStep(direction: 1 | -1): void;
        __pdfZoom(zoom: PdfZoom, anchor?: { x: number; y: number }): void;
        __pdfGoToPage(page: number): void;
        __pdfRestore(position: PdfViewPosition | null): void;
        __pdfDispose(): Promise<void>;
    }
}

const send = (message: PdfWebViewMessage) => window.ReactNativeWebView?.postMessage(JSON.stringify(message));
const emit = (name: string, detail: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));
const workerUrl = URL.createObjectURL(new Blob([__PDFJS_WORKER_SOURCE__], { type: 'text/javascript' }));
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
let assembler: ReturnType<typeof createPdfSliceAssembler> | null = null;
let viewer: ReturnType<typeof createPdfCanvasViewer> | null = null;
let activeDocument: pdfjs.PDFDocumentProxy | null = null;
let zoom: PdfZoom = 'fit-width';
let firstPageWidth = 0;
let firstPageHeight = 0;
let disposed = false;
let restorePosition: PdfViewPosition | null = null;
let position: ReturnType<typeof createPdfViewPosition> | null = null;
const runtimeListeners = new AbortController();

const textLayer: PdfTextLayerFactory = async (page, viewport, container) => {
    const content = await page.getTextContent();
    const layer = new pdfjs.TextLayer({ textContentSource: content, container, viewport });
    return { render: () => layer.render(), cancel: () => layer.cancel(), get textDivs() { return layer.textDivs; }, items: content.items };
};
const find = createPdfFindModel({ reveal: match => { viewer?.revealMatch(match); emit('happier-pdf-find-match', match); } });
const unsubscribe = find.subscribe(() => {
    const snapshot = find.getSnapshot();
    viewer?.setFindMatches(snapshot.matches, snapshot.current);
    if (snapshot.status.kind === 'results' || snapshot.status.kind === 'searching') {
        send({ type: 'find', current: snapshot.status.current ?? 0, total: snapshot.status.total, complete: snapshot.status.kind === 'results' });
    } else if (snapshot.status.kind === 'idle') send({ type: 'find', current: 0, total: 0, complete: true });
});
const container = () => {
    const element = document.getElementById('pdf-pages');
    if (!element) throw new Error('PDF WebView requires the pdf-pages scroll container');
    return element;
};
const scaleFor = (mode: PdfZoom = zoom) => {
    const element = container();
    return resolvePdfScale(mode, { pageWidth: firstPageWidth, pageHeight: firstPageHeight, ...readPdfViewport(element) });
};
const loader = createPdfDocumentLoader({
    getDocument: bytes => pdfjs.getDocument({ data: bytes, useWorkerFetch: false, useWasm: false }),
    setDocument: (next, signal) => {
        if (viewer) position?.locationChanged(viewer.getViewPosition());
        position?.dispose(); position = null;
        viewer?.dispose(); viewer = null;
        activeDocument = next; find.setDocument(next);
        emit('happier-pdf-document', { document: next, signal });
        if (!next) return;
        void next.getPage(1).then(page => {
            if (signal?.aborted || activeDocument !== next) return;
            const viewport = page.getViewport({ scale: 1 });
            firstPageWidth = viewport.width; firstPageHeight = viewport.height;
            position = createPdfViewPosition({ initial: restorePosition, restore: value => viewer?.restorePosition(value), persist: value => send({ type: 'location', ...value }) });
            restorePosition = null;
            viewer = createPdfCanvasViewer({ container: container(), document: next, scale: scaleFor(), signal, createTextLayer: textLayer,
                onPageChange: page => { send({ type: 'page', page }); emit('happier-pdf-page', page); },
                onError: () => send({ type: 'state', state: 'error' }),
                onReaderMove: () => position?.readerMoved(), onLocationChange: value => position?.locationChanged(value),
                onPagesInit: count => position?.pagesInit(count), onPagesLoaded: count => position?.pagesLoaded(count),
                fitScale: () => scaleFor('fit-width'),
                onScaleChange: (_scale, next) => { zoom = next; send({ type: 'zoom', zoom: next }); emit('happier-pdf-zoom', next); },
            });
            return viewer.ready.then(() => {
                if (signal?.aborted) return;
                const snapshot = find.getSnapshot(); viewer?.setFindMatches(snapshot.matches, snapshot.current);
                if (snapshot.current) viewer?.revealMatch(snapshot.current);
                send({ type: 'ready', pages: next.numPages });
            });
        }).catch(() => { if (!signal?.aborted) send({ type: 'state', state: 'error' }); });
    },
});

window.__pdfBegin = size => {
    if (disposed) return;
    assembler = createPdfSliceAssembler(size);
    void loader.clear().catch(() => send({ type: 'state', state: 'error' }));
    send({ type: 'state', state: 'loading' });
};
window.__pdfAppend = slice => { if (!assembler || disposed) throw new Error('PDF byte assembly has not started'); assembler.append(slice); };
window.__pdfOpen = async () => {
    if (!assembler || disposed) return;
    const pending = assembler; assembler = null;
    try {
        const result = await loader.load(pending.finish());
        if (result.status === 'error') send({ type: 'state', state: result.reason === 'protected' ? 'protected' : 'error' });
    } catch { send({ type: 'state', state: 'error' }); }
};
window.__pdfFind = (query, matchCase = false) => { find.setOptions({ regex: false, matchCase }); find.setQuery(query); };
window.__pdfStep = direction => find.step(direction);
window.__pdfZoom = (next, anchor) => { zoom = next; if (viewer) viewer.setScale(scaleFor(), anchor); emit('happier-pdf-zoom', next); };
window.__pdfGoToPage = page => viewer?.goToPage(page);
window.__pdfRestore = next => { restorePosition = next; };
window.__pdfDispose = async () => {
    if (disposed) return; disposed = true; assembler = null;
    find.close(); unsubscribe();
    runtimeListeners.abort();
    try { await loader.dispose(); } finally { URL.revokeObjectURL(workerUrl); }
};
window.addEventListener('resize', () => { if (viewer && typeof zoom !== 'number') viewer.setScale(scaleFor()); }, { signal: runtimeListeners.signal });
window.addEventListener('pagehide', () => { void window.__pdfDispose(); }, { once: true, signal: runtimeListeners.signal });
