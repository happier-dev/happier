import { describe, expect, it } from 'vitest';
import { createKeyboardShortcutDispatcher } from './runtime';
import type { KeyboardSurface, KeyboardWebHost, NormalizedKeyboardEvent } from './types';
import { defaultKeyboardCommands } from './commands';

describe('code intelligence commands', () => {
    it('projects every code command through the real Settings declarations without blocking Settings startup', async () => {
        const { resolveKeyboardCommandSetting } = await import('@/components/settings/keyboard/keyboardSettings');
        for (const command of defaultKeyboardCommands.filter(entry => entry.id.startsWith('code.'))) {
            expect(resolveKeyboardCommandSetting(command.id)).toMatchObject({
                anchor: `keyboard.${command.id}`, storage: { scope: 'account', kind: 'owner', access: 'read_write' },
            });
        }
    });

    it('routes the unbound info, Problems and restart commands only after a user assigns shortcuts', () => {
        const calls: string[] = [];
        const handlers = {
            'code.showInfo': () => { calls.push('info'); },
            'code.showProblems': () => { calls.push('problems'); },
            'code.restart': () => { calls.push('restart'); },
        };
        const base = { platform: 'macos' as const, surface: 'web' as const, webHost: 'desktop' as const,
            singleKeyShortcutsEnabled: false, disabledCommandIds: [], handlers,
            getContext: () => ({ isEditableTarget: false, isComposing: false }) };
        const event: NormalizedKeyboardEvent = { key: 'i', code: 'KeyI', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true, repeat: false, isComposing: false };
        expect(createKeyboardShortcutDispatcher({ ...base, overrides: {} })(event)).toBe(false);
        const dispatch = createKeyboardShortcutDispatcher({ ...base, overrides: {
            'code.showInfo': [{ binding: 'Mod+Alt+i' }],
            'code.showProblems': [{ binding: 'Mod+Alt+p' }],
            'code.restart': [{ binding: 'Mod+Alt+r' }],
        } });
        expect(dispatch(event)).toBe(true);
        expect(dispatch({ ...event, key: 'p', code: 'KeyP' })).toBe(true);
        expect(dispatch({ ...event, key: 'r', code: 'KeyR' })).toBe(true);
        expect(calls).toEqual(['info', 'problems', 'restart']);
    });

    it.each([
        ['web', 'browser'], ['web', 'desktop'], ['native', undefined],
    ] satisfies Array<[KeyboardSurface, KeyboardWebHost | undefined]>)('routes navigation and problem traversal in editable code on %s/%s', (surface, webHost) => {
        const calls: string[] = [];
        const dispatch = createKeyboardShortcutDispatcher({
            platform: 'macos', surface, webHost, singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides: {},
            handlers: {
                'code.goToDefinition': () => { calls.push('definition'); }, 'code.findReferences': () => { calls.push('references'); },
                'code.problem.next': () => { calls.push('next'); }, 'code.problem.previous': () => { calls.push('previous'); },
            },
            getContext: () => ({ isEditableTarget: true, isComposing: false }),
        });
        const event: NormalizedKeyboardEvent = { key: 'F12', code: 'F12', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false };
        expect(dispatch(event)).toBe(true);
        expect(dispatch({ ...event, shiftKey: true })).toBe(true);
        expect(dispatch({ ...event, key: 'F8', code: 'F8' })).toBe(true);
        expect(dispatch({ ...event, key: 'F8', code: 'F8', shiftKey: true })).toBe(true);
        expect(calls).toEqual(['definition', 'references', 'next', 'previous']);
        expect(dispatch({ ...event, isComposing: true })).toBe(false);
    });
});
