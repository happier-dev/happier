import { describe, expect, it, vi } from 'vitest';

import {
    buildKeyboardShortcutLabels,
    createKeyboardShortcutDispatcher,
    isKeybindingRuleAvailable,
    normalizeKeyboardEvent,
    normalizeNativeHardwareKeyboardEvent,
    resolveNativeHardwareKeyboardConsumableEventSignatures,
} from './runtime';
import type { KeyboardContext, NormalizedKeyboardEvent } from './types';

const context: KeyboardContext = {
    isEditableTarget: false,
    isComposing: false,
};

function keyEvent(event: Partial<NormalizedKeyboardEvent>): NormalizedKeyboardEvent {
    return {
        key: '',
        code: '',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
        ...event,
    };
}

describe('createKeyboardShortcutDispatcher', () => {
    it('admits literal Ctrl+R for prompt picking on macOS web and every desktop/native host', () => {
        for (const platform of ['macos', 'windows', 'linux', 'ios', 'android'] as const) {
            const options = { enabled: true, platform, singleKeyShortcutsEnabled: false,
                disabledCommandIds: [], overrides: {}, handlers: { 'composer.prompts.open': () => 'handled' as const },
                getContext: () => ({ ...context, isEditableTarget: true }) };
            const chord = keyEvent({ key: 'r', code: 'KeyR', ctrlKey: true });
            expect(createKeyboardShortcutDispatcher({ ...options, surface: 'web', webHost: 'browser' })(chord)).toBe(platform === 'macos');
            expect(createKeyboardShortcutDispatcher({ ...options, surface: 'web', webHost: 'desktop' })(chord)).toBe(true);
            expect(createKeyboardShortcutDispatcher({ ...options, surface: 'native' })(chord)).toBe(true);
            expect(resolveNativeHardwareKeyboardConsumableEventSignatures({ ...options, surface: 'native' }))
                .toContain('r|shift=false|ctrl=true|meta=false|alt=false');
            expect(createKeyboardShortcutDispatcher({ ...options, surface: 'native', disabledCommandIds: ['composer.prompts.open'] })(chord)).toBe(false);
            expect(createKeyboardShortcutDispatcher({ ...options, surface: 'native' })({ ...chord, isComposing: true })).toBe(false);
            expect(createKeyboardShortcutDispatcher({ ...options, surface: 'native', handlers: { 'composer.prompts.open': () => 'pass' } })(chord)).toBe(false);
            expect(createKeyboardShortcutDispatcher({ ...options, surface: 'web', webHost: 'browser' })(keyEvent({ key: 'r', code: 'KeyR', metaKey: true }))).toBe(false);
        }
    });
    it('opens Find from the composer on Windows, Linux and macOS and respects overrides, disabling and IME', () => {
        for (const platform of ['macos', 'windows', 'linux'] as const) {
            let opened = false;
            const options = { enabled: true, platform, surface: 'web' as const, singleKeyShortcutsEnabled: false,
                disabledCommandIds: [], overrides: {}, handlers: { 'find.open': () => { opened = true; } },
                getContext: () => ({ ...context, isEditableTarget: true }) };
            const chord = keyEvent({ key: 'f', code: 'KeyF', metaKey: platform === 'macos', ctrlKey: platform !== 'macos' });
            expect(createKeyboardShortcutDispatcher(options)(chord)).toBe(true);
            expect(opened).toBe(true);
            expect(createKeyboardShortcutDispatcher({ ...options, disabledCommandIds: ['find.open'] })(chord)).toBe(false);
            expect(createKeyboardShortcutDispatcher(options)({ ...chord, isComposing: true })).toBe(false);
            const rebound = { ...options, overrides: { 'find.open': [{ binding: 'Alt+F' }] } };
            expect(createKeyboardShortcutDispatcher(rebound)(chord)).toBe(false);
            expect(createKeyboardShortcutDispatcher(rebound)(keyEvent({ key: 'f', code: 'KeyF', altKey: true }))).toBe(true);
        }
    });
    it('leaves browser defaults and PTY input untouched when the matching handler passes', () => {
        const dispatch = createKeyboardShortcutDispatcher({
            enabled: true, platform: 'macos', surface: 'web', singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides: {}, handlers: { 'voice.toggle': () => 'pass' }, getContext: () => context,
        });
        expect(dispatch(keyEvent({ key: 'v', code: 'KeyV', metaKey: true, altKey: true }))).toBe(false);
    });
    it.each(['macos', 'windows', 'linux', 'ios', 'android'] as const)('opens text in files from editable app focus on %s while respecting disablement', (platform) => {
        const open = vi.fn();
        const options = { enabled: true, platform, surface: platform === 'ios' || platform === 'android' ? 'native' as const : 'web' as const, singleKeyShortcutsEnabled: false, disabledCommandIds: [], overrides: {}, handlers: { 'search.textInFiles': open }, getContext: () => ({ ...context, isEditableTarget: true }) };
        const chord = keyEvent({ key: 'f', code: 'KeyF', shiftKey: true, metaKey: platform === 'macos' || platform === 'ios', ctrlKey: platform !== 'macos' && platform !== 'ios' });
        const dispatch = createKeyboardShortcutDispatcher(options);
        expect(dispatch(chord)).toBe(true);
        expect(open).toHaveBeenCalledOnce();
        expect(dispatch({ ...chord, isComposing: true })).toBe(false);
        expect(createKeyboardShortcutDispatcher({ ...options, disabledCommandIds: ['search.textInFiles'] })(chord)).toBe(false);
    });
    it.each(['macos', 'windows', 'linux'] as const)('invokes Next from editable app-shell focus on %s with surface-appropriate keys', (platform) => {
        let navigations = 0;
        const options = {
            enabled: true, platform, singleKeyShortcutsEnabled: false, disabledCommandIds: [], overrides: {},
            handlers: { 'session.pending.next': () => { navigations += 1; } },
            getContext: () => ({ ...context, isEditableTarget: true }),
        };
        const desktopChord = keyEvent({ key: 'j', code: 'KeyJ', shiftKey: true,
            metaKey: platform === 'macos', ctrlKey: platform !== 'macos' });
        const webChord = keyEvent({ key: 'j', code: 'KeyJ', shiftKey: true, altKey: true });
        const web = createKeyboardShortcutDispatcher({ ...options, surface: 'web' });
        expect(web(webChord)).toBe(true);
        expect(web(desktopChord)).toBe(false);
        const desktop = createKeyboardShortcutDispatcher({ ...options, surface: 'web', webHost: 'desktop' });
        expect(desktop(desktopChord)).toBe(true);
        expect(desktop(webChord)).toBe(false);
        expect(desktop({ ...desktopChord, shiftKey: false })).toBe(false);
        expect(web({ ...webChord, isComposing: true })).toBe(false);
        expect(createKeyboardShortcutDispatcher({ ...options, surface: 'web', disabledCommandIds: ['session.pending.next'] })(webChord)).toBe(false);
        expect(navigations).toBe(2);
    });
    it.each(['macos', 'windows', 'linux', 'ios', 'android'] as const)('toggles Voice while editing on %s without consuming paste, repeat or composition', (platform) => {
        let attempts = 0;
        const options = {
            enabled: true,
            platform,
            surface: platform === 'ios' || platform === 'android' ? 'native' as const : 'web' as const,
            singleKeyShortcutsEnabled: false,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'voice.toggle': () => { attempts += 1; } },
            getContext: () => ({ ...context, isEditableTarget: true }),
        };
        const dispatcher = createKeyboardShortcutDispatcher(options);
        const chord = keyEvent({
            key: 'v', code: 'KeyV', altKey: true,
            metaKey: platform === 'macos' || platform === 'ios',
            ctrlKey: platform !== 'macos' && platform !== 'ios',
        });
        expect(dispatcher({ ...chord, repeat: true })).toBe(false);
        expect(dispatcher({ ...chord, isComposing: true })).toBe(false);
        expect(dispatcher({ ...chord, altKey: false, shiftKey: true })).toBe(false);
        expect(dispatcher(chord)).toBe(true);
        expect(attempts).toBe(1);
        expect(createKeyboardShortcutDispatcher({ ...options, enabled: false })(chord)).toBe(false);
        expect(createKeyboardShortcutDispatcher({ ...options, disabledCommandIds: ['voice.toggle'] })(chord)).toBe(false);
        if (options.surface === 'native') {
            expect(resolveNativeHardwareKeyboardConsumableEventSignatures(options)).toContain(
                `v|shift=false|ctrl=${chord.ctrlKey}|meta=${chord.metaKey}|alt=true`,
            );
            expect(dispatcher(normalizeNativeHardwareKeyboardEvent({
                key: 'v', code: 'KeyV', repeat: false, isEditableTarget: true,
                modifiers: { shift: false, ctrl: chord.ctrlKey, meta: chord.metaKey, alt: true },
            }))).toBe(true);
        }
    });

    it('uses the rebound Voice chord and its label with editable admission preserved', () => {
        let attempts = 0;
        const options = {
            enabled: true, platform: 'macos' as const, surface: 'web' as const,
            singleKeyShortcutsEnabled: false, disabledCommandIds: [],
            overrides: { 'voice.toggle': [{ binding: 'Mod+Alt+B' }] },
            handlers: { 'voice.toggle': () => { attempts += 1; } },
            getContext: () => ({ ...context, isEditableTarget: true }),
        };
        const dispatcher = createKeyboardShortcutDispatcher(options);
        expect(dispatcher(keyEvent({ key: 'v', code: 'KeyV', metaKey: true, altKey: true }))).toBe(false);
        expect(dispatcher(keyEvent({ key: 'b', code: 'KeyB', metaKey: true, altKey: true }))).toBe(true);
        expect(attempts).toBe(1);
        expect(buildKeyboardShortcutLabels('macos', 'web', options)['voice.toggle']).toBe('Cmd+Option+B');
    });

    it('does not classify Shift+Arrow selection bindings as disabled single-key shortcuts', () => {
        expect(isKeybindingRuleAvailable({ binding: 'Shift+ArrowDown' }, {
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: false,
        })).toBe(true);
    });

    it('preserves the legacy zero-argument command callback rather than using the event as a palette query', () => {
        let query = 'not opened';
        const open = (initialQuery?: string) => { query = initialQuery ?? ''; };
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true, platform: 'macos', surface: 'web', singleKeyShortcutsEnabled: true,
            disabledCommandIds: [], overrides: {}, handlers: { 'commandPalette.open': open },
            getContext: () => context,
        });
        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', altKey: true }))).toBe(true);
        expect(query).toBe('');
    });

    it('does not dispatch registry commands when the kill switch is disabled', () => {
        const open = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: false,
            platform: 'macos',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'commandPalette.open': open },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', metaKey: true }))).toBe(false);
        expect(open).not.toHaveBeenCalled();
    });

    it('preserves command palette compatibility through the web-safe default when the registry kill switch is disabled', () => {
        const open = vi.fn();
        const newSession = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: false,
            enabledWhenDisabledCommandIds: ['commandPalette.open'],
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: {
                'commandPalette.open': open,
                'session.new': newSession,
            },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', metaKey: true }))).toBe(false);
        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', altKey: true }))).toBe(true);
        expect(open).toHaveBeenCalledTimes(1);
        expect(dispatcher(keyEvent({ key: 'n', code: 'KeyN', metaKey: true, shiftKey: true }))).toBe(false);
        expect(newSession).not.toHaveBeenCalled();
    });

    it('does not dispatch browser-reserved defaults on web surfaces', () => {
        const newSession = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'session.new': newSession },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: 'n', code: 'KeyN', metaKey: true, shiftKey: true }))).toBe(false);
        expect(newSession).not.toHaveBeenCalled();
    });

    it('uses the web-safe default for new session instead of the browser private-window shortcut', () => {
        const newSession = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'session.new': newSession },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: 'n', code: 'KeyN', metaKey: true, shiftKey: true }))).toBe(false);
        expect(dispatcher(keyEvent({ key: 'n', code: 'KeyN', altKey: true }))).toBe(true);
        expect(newSession).toHaveBeenCalledTimes(1);
    });

    it('uses the web-safe default for command palette instead of the browser address-bar shortcut', () => {
        const open = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'commandPalette.open': open },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', metaKey: true }))).toBe(false);
        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', altKey: true }))).toBe(true);
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('uses web-safe MRU session defaults instead of browser tab cycling shortcuts', () => {
        const next = vi.fn();
        const previous = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: {
                'session.mru.next': next,
                'session.mru.previous': previous,
            },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toBe(false);
        expect(dispatcher(keyEvent({ key: 'PageDown', code: 'PageDown', altKey: true }))).toBe(true);
        expect(dispatcher(keyEvent({ key: 'PageUp', code: 'PageUp', altKey: true }))).toBe(true);
        expect(next).toHaveBeenCalledTimes(1);
        expect(previous).toHaveBeenCalledTimes(1);
    });

    it('keeps session navigation and focused workspace pane movement on distinct shortcuts', () => {
        const sessionVisibleNext = vi.fn();
        const splitCanvasFocusDown = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'native',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: {
                'session.visible.next': sessionVisibleNext,
                'workspace.focusDown': splitCanvasFocusDown,
            },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: 'ArrowDown', code: 'ArrowDown', altKey: true }))).toBe(true);
        expect(sessionVisibleNext).toHaveBeenCalledTimes(1);
        expect(splitCanvasFocusDown).not.toHaveBeenCalled();
        expect(dispatcher(keyEvent({ key: 'ArrowDown', code: 'ArrowDown', altKey: true, metaKey: true }))).toBe(true);
        expect(splitCanvasFocusDown).toHaveBeenCalledTimes(1);
    });

    it('does not dispatch during IME composition', () => {
        const open = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'commandPalette.open': open },
            getContext: () => context,
        });

        const event = normalizeKeyboardEvent({
            key: 'k',
            code: 'KeyK',
            altKey: false,
            ctrlKey: false,
            metaKey: true,
            shiftKey: false,
            repeat: false,
            isComposing: true,
        } as KeyboardEvent);

        expect(dispatcher(event)).toBe(false);
        expect(open).not.toHaveBeenCalled();
    });

    it('requires the single-key toggle for shortcut help', () => {
        const openHelp = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: false,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'shortcutsHelp.open': openHelp },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: '?', code: 'Slash', shiftKey: true }))).toBe(false);
        expect(openHelp).not.toHaveBeenCalled();
    });

    it('only displays labels for commands that can dispatch through active handlers', () => {
        const labels = buildKeyboardShortcutLabels('macos', 'native', {
            disabledCommandIds: [],
            overrides: {},
            singleKeyShortcutsEnabled: true,
            handlers: { 'commandPalette.open': vi.fn() },
        });

        expect(labels['commandPalette.open']).toBe('Cmd+K');
        expect(labels['session.new']).toBeUndefined();
        expect(labels['shortcutsHelp.open']).toBeUndefined();
    });

    it('displays platform-aware web labels for commands with web-specific defaults', () => {
        const labels = buildKeyboardShortcutLabels('macos', 'web', {
            disabledCommandIds: [],
            overrides: {},
            singleKeyShortcutsEnabled: true,
            handlers: {
                'commandPalette.open': vi.fn(),
                'session.new': vi.fn(),
                'session.mru.next': vi.fn(),
                'session.mru.previous': vi.fn(),
            },
        });

        expect(labels['commandPalette.open']).toBe('Option+K');
        expect(labels['session.new']).toBe('Option+N');
        expect(labels['session.mru.next']).toBe('Option+PageDown');
        expect(labels['session.mru.previous']).toBe('Option+PageUp');
    });

    it('uses Ctrl labels for Mod-based web shortcuts on Windows and Linux', () => {
        const labels = buildKeyboardShortcutLabels('windows', 'web', {
            disabledCommandIds: [],
            overrides: {},
            singleKeyShortcutsEnabled: true,
            handlers: {
                'composer.abortConfirm': vi.fn(),
                'commandPalette.open': vi.fn(),
                'session.new': vi.fn(),
            },
        });

        expect(labels['composer.abortConfirm']).toBe('Ctrl+.');
        expect(labels['commandPalette.open']).toBe('Alt+K');
        expect(labels['session.new']).toBe('Alt+N');
    });

    it('derives labels from disabled ids, overrides, single-key state, and active handlers together', () => {
        const labels = buildKeyboardShortcutLabels('macos', 'native', {
            disabledCommandIds: ['commandPalette.open'],
            overrides: {
                'session.new': [{ binding: 'Mod+P' }],
                'shortcutsHelp.open': [{ binding: '?' }],
            },
            singleKeyShortcutsEnabled: false,
            handlers: {
                'commandPalette.open': vi.fn(),
                'session.new': vi.fn(),
                'shortcutsHelp.open': vi.fn(),
                'settings.open': vi.fn(),
                'transcript.message.next': vi.fn(),
            },
        });

        expect(labels['commandPalette.open']).toBeUndefined();
        expect(labels['session.new']).toBe('Cmd+P');
        expect(labels['shortcutsHelp.open']).toBeUndefined();
        // The platform's preferences shortcut opens Settings in the desktop app.
        expect(labels['settings.open']).toBe('Cmd+,');
        // A command with a handler but no binding has no label.
        expect(labels['transcript.message.next']).toBeUndefined();
    });

    it('keeps editable-safe commands editable when their shortcut is overridden', () => {
        const sendImmediate = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {
                'composer.sendImmediate': [{ binding: 'Alt+Enter' }],
            },
            handlers: { 'composer.sendImmediate': sendImmediate },
            getContext: () => ({
                isEditableTarget: true,
                isComposing: false,
            }),
        });

        expect(dispatcher(keyEvent({ key: 'Enter', code: 'Enter', altKey: true }))).toBe(true);
        expect(sendImmediate).toHaveBeenCalledTimes(1);
    });

    it('derives native consumable signatures only from active Enter and Escape handlers', () => {
        const signatures = resolveNativeHardwareKeyboardConsumableEventSignatures({
            enabled: true,
            platform: 'ios',
            surface: 'native',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: ['composer.abortConfirm'],
            overrides: {},
            handlers: {
                'composer.sendImmediate': vi.fn(),
                'composer.abortConfirm': vi.fn(),
                'commandPalette.open': vi.fn(),
            },
            getContext: () => ({
                isEditableTarget: true,
                isComposing: false,
            }),
        });

        expect(signatures).toEqual([
            'Enter|shift=false|ctrl=false|meta=true|alt=false',
        ]);
    });

    it('derives the native Mod+K signature for the canonical Search command', () => {
        const signatures = resolveNativeHardwareKeyboardConsumableEventSignatures({
            enabled: true,
            platform: 'ios',
            surface: 'native',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'commandPalette.open': vi.fn() },
            getContext: () => ({
                isEditableTarget: false,
                isComposing: false,
            }),
        });

        expect(signatures).toEqual([
            'k|shift=false|ctrl=false|meta=true|alt=false',
        ]);
    });

    it('preserves native Search consumption for a user-configured printable-key override', () => {
        const signatures = resolveNativeHardwareKeyboardConsumableEventSignatures({
            enabled: true,
            platform: 'android',
            surface: 'native',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {
                'commandPalette.open': [{ binding: 'Mod+P' }],
            },
            handlers: { 'commandPalette.open': vi.fn() },
            getContext: () => ({
                isEditableTarget: false,
                isComposing: false,
            }),
        });

        expect(signatures).toEqual([
            'p|shift=false|ctrl=true|meta=false|alt=false',
        ]);
    });

    it('does not derive native consumable signatures when the command cannot run', () => {
        const signatures = resolveNativeHardwareKeyboardConsumableEventSignatures({
            enabled: false,
            platform: 'ios',
            surface: 'native',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: {
                'composer.sendImmediate': vi.fn(),
            },
            getContext: () => ({
                isEditableTarget: true,
                isComposing: false,
            }),
        });

        expect(signatures).toEqual([]);
    });
});
