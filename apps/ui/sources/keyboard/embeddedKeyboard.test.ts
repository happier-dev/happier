import { describe, expect, it } from 'vitest';
import { selectEmbeddedKeyboardHandlers } from './embeddedKeyboard';
import { createKeyboardShortcutDispatcher, normalizeNativeHardwareKeyboardEvent, resolveNativeHardwareKeyboardConsumableEventSignatures } from './runtime';

describe('embedded keyboard command boundary', () => {
    it('routes browser address shortcuts from guest editors through configured host bindings', () => {
        let focused = false;
        const options = {
            enabled: true, platform: 'macos' as const, surface: 'web' as const, webHost: 'desktop' as const,
            singleKeyShortcutsEnabled: false, disabledCommandIds: [], overrides: {},
            handlers: selectEmbeddedKeyboardHandlers({ 'browser.address.focus': () => { focused = true; }, 'composer.focus': () => {} }, 'browser'),
            getContext: () => ({ isEditableTarget: true, isComposing: false }),
        };
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures(options)).toContain('l|shift=false|ctrl=false|meta=true|alt=false');
        expect(createKeyboardShortcutDispatcher(options)(normalizeNativeHardwareKeyboardEvent({ key: 'l', code: 'KeyL', repeat: false,
            modifiers: { shift: false, ctrl: false, meta: true, alt: false } }))).toBe(true);
        expect(focused).toBe(true);
        expect(selectEmbeddedKeyboardHandlers({ 'composer.focus': () => {} }, 'browser')['composer.focus']).toBeUndefined();
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures({ ...options, disabledCommandIds: ['browser.address.focus'] })).toEqual([]);
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures({ ...options,
            overrides: { 'browser.address.focus': [{ binding: 'Mod+Shift+Y' }] } })).toContain('y|shift=true|ctrl=false|meta=true|alt=false');
    });
    it('forwards editor Save and Ask alongside Find while terminals retain their Find-only boundary', () => {
        const find = () => {};
        const save = () => {};
        const ask = () => {};
        const handlers = { 'find.open': find, 'files.editor.save': save, 'editor.selection.ask': ask, 'composer.focus': () => {} };
        const editor = selectEmbeddedKeyboardHandlers(handlers, 'editor');
        expect(editor['find.open']).toBe(find);
        expect(editor['files.editor.save']).toBe(save);
        expect(editor['editor.selection.ask']).toBe(ask);
        expect(editor['composer.focus']).toBeUndefined();
        const terminal = selectEmbeddedKeyboardHandlers(handlers, 'find');
        expect(terminal['find.open']).toBe(find);
        expect(terminal['files.editor.save']).toBeUndefined();
        expect(terminal['editor.selection.ask']).toBeUndefined();
    });
});
