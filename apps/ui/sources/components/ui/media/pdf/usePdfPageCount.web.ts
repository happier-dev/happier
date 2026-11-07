import * as React from 'react';

import { createWebPdfDocumentLoader, readPdfBlobBytes } from './loadPdfjs.web';

/** A PDF's page count, read through the viewer's pdf.js loader from an owned Blob URI; null until known or unreadable. */
export function usePdfPageCount(uri: string | null): number | null {
    const [counted, setCounted] = React.useState<Readonly<{ uri: string; pages: number }> | null>(null);
    React.useEffect(() => {
        if (!uri) return;
        const controller = new AbortController();
        let loader: Awaited<ReturnType<typeof createWebPdfDocumentLoader>> | null = null;
        void (async () => {
            try {
                loader = await createWebPdfDocumentLoader(() => {});
                const result = await loader.load(await readPdfBlobBytes(uri, controller.signal));
                if (result.status === 'ready' && !controller.signal.aborted) setCounted({ uri, pages: result.document.numPages });
            } catch {
                // A protected, damaged or unreadable PDF has no count; the row keeps its size and Open actions.
            } finally {
                await loader?.dispose();
            }
        })();
        return () => {
            controller.abort();
            void loader?.dispose();
        };
    }, [uri]);
    return uri && counted?.uri === uri ? counted.pages : null;
}
