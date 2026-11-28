import { describe, expect, it } from 'vitest';
import { createKeyboardShortcutDispatcher } from './runtime';
import type { KeyboardContext, NormalizedKeyboardEvent } from './types';

const event = (key: string, extra: Partial<NormalizedKeyboardEvent> = {}): NormalizedKeyboardEvent => ({
    key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === '/' ? 'Slash' : '',
    metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, ...extra,
});

describe('review commands through the shared dispatcher', () => {
    it('moves changes on J/K and files only on Shift+J/K; rebinding and editable focus are respected', () => {
        const calls: string[] = [];
        let context: KeyboardContext = { isEditableTarget: false, isComposing: false };
        const options = {
            platform: 'macos' as const, surface: 'web' as const,
            singleKeyShortcutsEnabled: true, disabledCommandIds: [], overrides: {},
            handlers: {
                'review.change.next': () => { calls.push('change+'); },
                'review.change.previous': () => { calls.push('change-'); },
                'review.file.next': () => { calls.push('file+'); },
                'review.file.previous': () => { calls.push('file-'); },
                'review.change.keep': () => { calls.push('keep'); },
            }, getContext: () => context,
        };
        const dispatch = createKeyboardShortcutDispatcher(options);
        for (const key of ['j', 'k']) expect(dispatch(event(key))).toBe(true);
        for (const key of ['J', 'K']) expect(dispatch(event(key, { shiftKey: true }))).toBe(true);
        expect(dispatch(event('r'))).toBe(true);
        expect(calls).toEqual(['change+', 'change-', 'file+', 'file-', 'keep']);
        expect(dispatch(event('n'))).toBe(false);
        context = { ...context, isEditableTarget: true };
        expect(dispatch(event('j'))).toBe(false);
        context = { ...context, isEditableTarget: false };
        const rebound = createKeyboardShortcutDispatcher({ ...options, overrides: { 'review.change.next': [{ binding: 'x' }] } });
        expect(rebound(event('j'))).toBe(false);
        expect(rebound(event('x'))).toBe(true);
        expect(rebound(event('x', { isComposing: true }))).toBe(false);
    });

    it('asks only while a selection handler is registered and otherwise preserves composer focus', () => {
        const calls: string[] = [];
        const options = { platform: 'macos' as const, surface: 'native' as const,
            singleKeyShortcutsEnabled: true, disabledCommandIds: [], overrides: {},
            getContext: () => ({ isEditableTarget: false, isComposing: false }),
        };
        const composer = { 'composer.focus': () => { calls.push('focus'); } };
        const chord = event('i', { metaKey: true });
        expect(createKeyboardShortcutDispatcher({ ...options, handlers: composer })(chord)).toBe(true);
        const selection = { 'editor.selection.ask': () => { calls.push('ask'); }, ...composer };
        expect(createKeyboardShortcutDispatcher({ ...options, handlers: selection })(chord)).toBe(true);
        expect(createKeyboardShortcutDispatcher({ ...options, handlers: selection,
            getContext: () => ({ isEditableTarget: true, isComposing: false }) })(chord)).toBe(true);
        expect(calls).toEqual(['focus', 'ask', 'ask']);
    });
});
