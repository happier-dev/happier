import { describe, expect, it } from 'vitest';
import { createPdfSliceAssembler, parsePdfWebViewMessage, shouldAllowPdfWebViewNavigation } from './pdfNativeBridge';

describe('native PDF byte boundary', () => {
    it('parses only exact small message shapes and valid counts', () => {
        expect(parsePdfWebViewMessage(JSON.stringify({ type: 'ready', pages: 14 }))).toEqual({ type: 'ready', pages: 14 });
        expect(parsePdfWebViewMessage(JSON.stringify({ type: 'location', page: 3, top: 50.5, left: 0 })))
            .toEqual({ type: 'location', page: 3, top: 50.5, left: 0 });
        expect(parsePdfWebViewMessage(JSON.stringify({ type: 'zoom', zoom: 'fit-width' }))).toEqual({ type: 'zoom', zoom: 'fit-width' });
        expect(parsePdfWebViewMessage(JSON.stringify({ type: 'zoom', zoom: 1.75 }))).toEqual({ type: 'zoom', zoom: 1.75 });
        expect(parsePdfWebViewMessage(JSON.stringify({ type: 'find', current: 3, total: 9, complete: false })))
            .toEqual({ type: 'find', current: 3, total: 9, complete: false });
        for (const value of [{ type: 'ready', pages: 0 }, { type: 'ready', pages: 1, url: 'https://example.org' },
            { type: 'page', page: 1.5 }, { type: 'zoom', zoom: 0 }, { type: 'zoom', zoom: 'fit-height' }, { type: 'zoom', zoom: 2, extra: 1 }, { type: 'location', page: 1, top: -1, left: 0 }, { type: 'find', current: 10, total: 9, complete: true }]) {
            expect(parsePdfWebViewMessage(JSON.stringify(value))).toBeNull();
        }
        expect(shouldAllowPdfWebViewNavigation('about:blank')).toBe(true);
        expect(shouldAllowPdfWebViewNavigation('https://example.org')).toBe(false);
    });
    it('assembles exact raw slices and rejects truncation, changed length, invalid base64 and writes after completion', () => {
        const assembler = createPdfSliceAssembler(5);
        assembler.append('AQID');
        assembler.append('BAU=');
        expect(assembler.finish()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
        expect(() => assembler.append('AA==')).toThrow();
        expect(() => createPdfSliceAssembler(3).finish()).toThrow();
        expect(() => createPdfSliceAssembler(1).append('AQI=')).toThrow();
        expect(() => createPdfSliceAssembler(3).append('!!!!')).toThrow();
        expect(() => createPdfSliceAssembler(1).append('AB==')).toThrow();
    });
});
