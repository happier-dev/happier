import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { buildPdfBytes } from '@/dev/testkit/fixtures/pdfFixtures';
import { createPdfDocumentLoader } from './pdfDocumentLoader';
import { usePdfPageCount } from './usePdfPageCount.web';

// The pdf.js worker asset is served by the host app; a test has no such origin, so pdf.js runs its in-process
// fake worker. The loader, the Blob read and the hook stay real.
vi.mock('./loadPdfjs.web', async importOriginal => ({
    ...(await importOriginal<typeof import('./loadPdfjs.web')>()),
    createWebPdfDocumentLoader: async (setDocument: (document: unknown) => void) => {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        return createPdfDocumentLoader({ setDocument, getDocument: bytes => pdfjs.getDocument({ data: bytes }) });
    },
}));

const blobUri = (bytes: Uint8Array) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));

describe('usePdfPageCount (web)', () => {
    it('counts the pages of a PDF read from its owned Blob URI, and follows the URI', async () => {
        const hook = await renderHook((uri: string | null) => usePdfPageCount(uri), { initialProps: blobUri(buildPdfBytes(3)) as string | null });
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toBe(3));
            await hook.rerender(blobUri(buildPdfBytes(5)));
            await vi.waitFor(() => expect(hook.getCurrent()).toBe(5));
            await hook.rerender(null);
            expect(hook.getCurrent()).toBeNull();
        } finally { await hook.unmount(); }
    });

    it('has no count for bytes that are not a PDF', async () => {
        const hook = await renderHook((uri: string | null) => usePdfPageCount(uri), { initialProps: blobUri(new TextEncoder().encode('not a pdf')) as string | null });
        try {
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(hook.getCurrent()).toBeNull();
        } finally { await hook.unmount(); }
    });
});
