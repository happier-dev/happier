import { describe, expect, it, vi } from 'vitest';

import {
    buildKeyboardShortcutLabels,
    createKeyboardShortcutDispatcher,
    isKeybindingRuleAvailable,
    normalizeKeyboardEvent,
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
    it('does not classify Shift+Arrow selection bindings as disabled single-key shortcuts', () => {
        expect(isKeybindingRuleAvailable({ binding: 'Shift+ArrowDown' }, {
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: false,
        })).toBe(true);
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

    it('prefers split-canvas focus over global session-list navigation for shared Alt+Arrow defaults', () => {
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
                'splitCanvas.focusDown': splitCanvasFocusDown,
            },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: 'ArrowDown', code: 'ArrowDown', altKey: true }))).toBe(true);
        expect(splitCanvasFocusDown).toHaveBeenCalledTimes(1);
        expect(sessionVisibleNext).not.toHaveBeenCalled();
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
            },
        });

        expect(labels['commandPalette.open']).toBeUndefined();
        expect(labels['session.new']).toBe('Cmd+P');
        expect(labels['shortcutsHelp.open']).toBeUndefined();
        expect(labels['settings.open']).toBeUndefined();
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
