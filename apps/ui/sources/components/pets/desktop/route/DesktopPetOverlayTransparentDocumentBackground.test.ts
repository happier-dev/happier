import { describe, expect, it } from 'vitest';

import { applyDesktopPetOverlayTransparentDocumentBackground } from './DesktopPetOverlayTransparentDocumentBackground';

describe('applyDesktopPetOverlayTransparentDocumentBackground', () => {
    it('forces html body and root backgrounds transparent until disposed', () => {
        const styleElement = {
            id: '',
            nodeName: 'STYLE',
            textContent: '',
            remove: () => {},
        };
        const fakeRoot = {
            style: {
                backgroundColor: 'rgb(255, 255, 255)',
                background: 'rgb(255, 255, 255)',
                margin: '12px',
                padding: '12px',
            },
        };
        const fakeDocument = {
            documentElement: {
                style: {
                    backgroundColor: 'rgb(255, 255, 255)',
                    background: 'rgb(255, 255, 255)',
                },
            },
            body: {
                style: {
                    backgroundColor: 'rgb(255, 255, 255)',
                    background: 'rgb(255, 255, 255)',
                    margin: '8px',
                    padding: '8px',
                    overflow: 'scroll',
                },
            },
            getElementById: (id: string) => (id === 'root' ? fakeRoot : null),
            createElement: () => styleElement,
            head: { appendChild: () => {} },
        } as unknown as Document;

        const dispose = applyDesktopPetOverlayTransparentDocumentBackground(fakeDocument);

        expect(fakeDocument.documentElement.style.backgroundColor).toBe('transparent');
        expect(fakeDocument.documentElement.style.background).toBe('transparent');
        expect(fakeDocument.body.style.backgroundColor).toBe('transparent');
        expect(fakeDocument.body.style.background).toBe('transparent');
        expect(fakeDocument.body.style.margin).toBe('0px');
        expect(fakeDocument.body.style.padding).toBe('0px');
        expect(fakeDocument.body.style.overflow).toBe('hidden');
        expect(fakeRoot.style.backgroundColor).toBe('transparent');
        expect(fakeRoot.style.background).toBe('transparent');
        expect(fakeRoot.style.margin).toBe('0px');
        expect(fakeRoot.style.padding).toBe('0px');
        expect(styleElement.textContent).toContain('html, body, #root, #app, #expo-root');
        expect(styleElement.textContent).not.toContain('#root *, #app *, #expo-root *');

        dispose();

        expect(fakeDocument.documentElement.style.backgroundColor).toBe('rgb(255, 255, 255)');
        expect(fakeDocument.documentElement.style.background).toBe('rgb(255, 255, 255)');
        expect(fakeDocument.body.style.backgroundColor).toBe('rgb(255, 255, 255)');
        expect(fakeDocument.body.style.background).toBe('rgb(255, 255, 255)');
        expect(fakeDocument.body.style.margin).toBe('8px');
        expect(fakeDocument.body.style.padding).toBe('8px');
        expect(fakeDocument.body.style.overflow).toBe('scroll');
        expect(fakeRoot.style.backgroundColor).toBe('rgb(255, 255, 255)');
        expect(fakeRoot.style.background).toBe('rgb(255, 255, 255)');
        expect(fakeRoot.style.margin).toBe('12px');
        expect(fakeRoot.style.padding).toBe('12px');
    });
});
