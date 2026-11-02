import { describe, expect, it } from 'vitest';
import { resolveExternalUrlIframeSandbox, resolveLocalPreviewIframeSandbox } from './localPreview';

describe('browser page sandbox', () => {
    it('allows pointer-lock applications while retaining each page origin boundary', () => {
        const external = resolveExternalUrlIframeSandbox().split(' ');
        const pathPreview = resolveLocalPreviewIframeSandbox('https://home.test/v1/local-services/preview/id/').split(' ');
        const isolatedPreview = resolveLocalPreviewIframeSandbox('https://preview.test/app').split(' ');
        for (const sandbox of [external, pathPreview, isolatedPreview]) expect(sandbox).toContain('allow-pointer-lock');
        expect(external).not.toContain('allow-same-origin');
        expect(pathPreview).not.toContain('allow-same-origin');
        expect(isolatedPreview).toContain('allow-same-origin');
    });
});
