/**
 * A PDF's page count for a summary line, when the host can read one. Native keeps pdf.js inside the
 * viewer's WebView (`PdfViewer.native`), so a native summary states the size alone; `usePdfPageCount.web.ts`
 * counts through the same pdf.js loader the web viewer uses.
 */
export function usePdfPageCount(_uri: string | null): number | null {
    return null;
}
