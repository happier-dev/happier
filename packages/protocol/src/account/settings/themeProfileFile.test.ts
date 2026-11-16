import { describe, expect, it } from 'vitest';
import { createThemeProfileFile, parseThemeProfileFile } from './themeProfileFile.js';

describe('portable theme file', () => {
    it('retains the complete document through the exported envelope', () => {
        const raw = { schemaVersion: 2, id: 'paper', name: 'Paper', createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
            css: '.surface {\n color: red;\n}', style: { radius: 'round', futureInk: true }, futurePresentation: { ink: 1 } };
        const result = parseThemeProfileFile({ ...createThemeProfileFile(raw), exportedBy: 'compatible-client' });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.document.raw).toEqual(raw);
            expect(result.document.compatibility.status).toBe('partial');
        }
    });
    it('distinguishes a different file format from an invalid profile', () => {
        expect(parseThemeProfileFile({ kind: 'other', schemaVersion: 1, profile: {} })).toEqual({ ok: false, error: 'unsupportedSchema' });
        expect(parseThemeProfileFile({ kind: 'happier.themeProfile', schemaVersion: 2, profile: {} })).toEqual({ ok: false, error: 'unsupportedSchema' });
        expect(parseThemeProfileFile({ kind: 'happier.themeProfile', schemaVersion: 1, profile: {} })).toEqual({ ok: false, error: 'invalidProfile' });
    });
});
