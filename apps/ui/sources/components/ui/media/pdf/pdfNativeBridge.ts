/** Embedded font/image resources and the inline legacy worker stay local to the locked document. */
export const PDF_WEBVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; media-src 'none'; font-src data: blob:; worker-src blob:; frame-src 'none'; base-uri 'none'; form-action 'none'";

export type PdfWebViewMessage =
    | Readonly<{ type: 'ready'; pages: number }>
    | Readonly<{ type: 'page'; page: number }>
    | Readonly<{ type: 'location'; page: number; top: number; left: number }>
    | Readonly<{ type: 'zoom'; zoom: PdfZoom }>
    | Readonly<{ type: 'find'; current: number; total: number; complete: boolean }>
    | Readonly<{ type: 'state'; state: 'loading' | 'protected' | 'error' }>;

const integer = (value: unknown, minimum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;

/** The WebView returns metadata only. Unknown fields never cross this exact-shape boundary. */
export function parsePdfWebViewMessage(raw: unknown): PdfWebViewMessage | null {
    if (typeof raw !== 'string') return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(',');
    if (record.type === 'ready' && keys === 'pages,type' && integer(record.pages, 1)) return { type: 'ready', pages: record.pages };
    if (record.type === 'page' && keys === 'page,type' && integer(record.page, 1)) return { type: 'page', page: record.page };
    if (record.type === 'location' && keys === 'left,page,top,type' && integer(record.page, 1)
        && typeof record.top === 'number' && Number.isFinite(record.top) && record.top >= 0
        && typeof record.left === 'number' && Number.isFinite(record.left) && record.left >= 0) {
        return { type: 'location', page: record.page, top: record.top, left: record.left };
    }
    if (record.type === 'zoom' && keys === 'type,zoom' && (record.zoom === 'fit-width' || record.zoom === 'fit-page'
        || (typeof record.zoom === 'number' && Number.isFinite(record.zoom) && record.zoom > 0))) {
        return { type: 'zoom', zoom: record.zoom };
    }
    if (record.type === 'find' && keys === 'complete,current,total,type' && integer(record.current, 0) && integer(record.total, 0)
        && record.current <= record.total && (record.total > 0 || record.current === 0) && typeof record.complete === 'boolean') {
        return { type: 'find', current: record.current, total: record.total, complete: record.complete };
    }
    if (record.type === 'state' && keys === 'state,type' && (record.state === 'loading' || record.state === 'protected' || record.state === 'error')) {
        return { type: 'state', state: record.state };
    }
    return null;
}

export function shouldAllowPdfWebViewNavigation(url: string): boolean { return url === 'about:blank'; }

/** Preallocate exactly the stat'd file length; the sender never encodes a whole document. */
export function createPdfSliceAssembler(size: number) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid PDF byte length');
    let bytes: Uint8Array | null = new Uint8Array(size);
    let offset = 0;
    return {
        append(base64: string) {
            if (!bytes) throw new Error('PDF byte assembly already finished');
            const length = readCanonicalPaddedBase64DecodedLength(base64);
            if (!base64 || length === null) throw new Error('Invalid PDF byte slice');
            if (offset + length > size) throw new Error('PDF file changed during download');
            const decoded = atob(base64);
            for (let index = 0; index < decoded.length; index++) bytes[offset++] = decoded.charCodeAt(index);
        },
        finish(): Uint8Array {
            if (!bytes || offset !== size) throw new Error('Incomplete PDF byte assembly');
            const result = bytes; bytes = null;
            return result;
        },
    };
}
import { readCanonicalPaddedBase64DecodedLength } from '@happier-dev/protocol/crypto/base64';
import type { PdfZoom } from './pdfZoom';

