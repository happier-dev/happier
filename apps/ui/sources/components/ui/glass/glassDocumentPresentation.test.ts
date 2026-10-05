/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { applyGlassDocumentPresentation } from './glassDocumentPresentation';
import { glassPresetMaterials } from './glassMaterial';

describe('live document material boundary', () => {
    it('reveals native material only after application succeeds, restoring original canvas on flatten/unmount', () => {
        const doc = document.implementation.createHTMLDocument();
        doc.body.innerHTML = '<div id="root"></div>';
        const canvas = [doc.documentElement, doc.body, doc.getElementById('root')!];
        canvas.forEach(node => { node.style.backgroundColor = 'rgb(12, 14, 16)'; });
        const unavailable = applyGlassDocumentPresentation(doc, {}, { desktopWindow: true, nativeWindowMaterialLive: false });
        expect(doc.body.style.backgroundColor).toBe('rgb(12, 14, 16)');
        unavailable();
        const live = applyGlassDocumentPresentation(doc, {}, { desktopWindow: true, nativeWindowMaterialLive: true });
        expect(canvas.map(node => node.style.backgroundColor)).toEqual(['transparent', 'transparent', 'transparent']);
        live();
        expect(canvas.map(node => node.style.backgroundColor)).toEqual(['rgb(12, 14, 16)', 'rgb(12, 14, 16)', 'rgb(12, 14, 16)']);
        const reduced = applyGlassDocumentPresentation(doc, {}, { desktopWindow: true, nativeWindowMaterialLive: true, reduceTransparency: true });
        expect(doc.body.style.backgroundColor).toBe('rgb(12, 14, 16)');
        reduced();
    });

    it('publishes exact zero-opacity custom values and avoids a second nested coat', () => {
        const doc = document.implementation.createHTMLDocument();
        const stop = applyGlassDocumentPresentation(doc, {
            glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), content: { blur: 'strong', opacity: 0 } },
        }, {});
        expect(doc.documentElement.style.getPropertyValue('--happier-glass-content-opacity')).toBe('0%');
        expect(doc.documentElement.style.getPropertyValue('--happier-glass-content-nested-opacity')).toBe('0%');
        expect(doc.documentElement.style.getPropertyValue('--happier-glass-content-blur')).toBe('16px');
        stop();
        expect(doc.documentElement.style.getPropertyValue('--happier-glass-content-opacity')).toBe('');
    });
});
