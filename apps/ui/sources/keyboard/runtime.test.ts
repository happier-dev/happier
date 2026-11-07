import { describe, expect, it, vi } from 'vitest';

import {
    buildKeyboardShortcutLabels,
    createKeyboardShortcutDispatcher,
    isKeybindingRuleAvailable,
    normalizeKeyboardEvent,
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

    it('opens a new session from inside a text field only on the chord that cannot type a character', () => {
        const newSession = vi.fn();
        const dispatcherFor = (surface: 'native' | 'web') => createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface,
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'session.new': newSession },
            getContext: () => ({ ...context, isEditableTarget: true }),
        });

        expect(dispatcherFor('web')(keyEvent({ key: 'n', code: 'KeyN', altKey: true }))).toBe(false);
        expect(dispatcherFor('native')(keyEvent({ key: 'n', code: 'KeyN', metaKey: true, shiftKey: true }))).toBe(true);
        expect(newSession).toHaveBeenCalledTimes(1);
    });

    it('dispatches the web-safe new session default instead of the Chrome private-window shortcut', () => {
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

        expect(dispatcher(keyEvent({ key: 'n', code: 'KeyN', altKey: true }))).toBe(true);
        expect(newSession).toHaveBeenCalledTimes(1);
    });

    it('dispatches the web-safe command palette default instead of the Chrome address-bar shortcut', () => {
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

    it('dispatches web-safe MRU defaults instead of browser tab-cycle shortcuts', () => {
        const next = vi.fn();
        const previous = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'windows',
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

    it('builds computer-aware web labels from the active safe default', () => {
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

    it('omits native labels for bindings that iOS and Android hardware modules cannot emit', () => {
        const labels = buildKeyboardShortcutLabels('ios', 'native', {
            disabledCommandIds: [],
            overrides: {},
            singleKeyShortcutsEnabled: true,
            handlers: {
                'commandPalette.open': vi.fn(),
                'composer.sendImmediate': vi.fn(),
            },
        });

        expect(labels['commandPalette.open']).toBeUndefined();
        expect(labels['composer.sendImmediate']).toBe('Cmd+Enter');
    });

    it('treats non-Enter and non-Escape native bindings as unavailable on iOS and Android', () => {
        expect(isKeybindingRuleAvailable({ binding: 'Mod+K' }, {
            platform: 'ios',
            surface: 'native',
            singleKeyShortcutsEnabled: true,
        })).toBe(false);
        expect(isKeybindingRuleAvailable({ binding: 'Alt+ArrowDown' }, {
            platform: 'android',
            surface: 'native',
            singleKeyShortcutsEnabled: true,
        })).toBe(false);
        expect(isKeybindingRuleAvailable({ binding: 'Mod+Enter', allowInEditable: true }, {
            platform: 'ios',
            surface: 'native',
            singleKeyShortcutsEnabled: true,
        })).toBe(true);
    });

    it('dispatches session-list selection commands only outside editable targets', () => {
        const selectAll = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'sessions.selection.selectAll': selectAll },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: 'a', code: 'KeyA', metaKey: true }))).toBe(true);
        expect(selectAll).toHaveBeenCalledTimes(1);

        const editableDispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'sessions.selection.selectAll': selectAll },
            getContext: () => ({ ...context, isEditableTarget: true }),
        });

        expect(editableDispatcher(keyEvent({ key: 'a', code: 'KeyA', metaKey: true }))).toBe(false);
        expect(selectAll).toHaveBeenCalledTimes(1);
    });

    it('does not expose Space row-selection when single-key shortcuts are disabled', () => {
        const toggleFocused = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: false,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'sessions.selection.toggleFocused': toggleFocused },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: ' ', code: 'Space' }))).toBe(false);
        expect(toggleFocused).not.toHaveBeenCalled();
    });

    it('keeps Shift+Arrow session-list range selection available when single-key shortcuts are disabled', () => {
        const extendDown = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            enabled: true,
            platform: 'macos',
            surface: 'web',
            singleKeyShortcutsEnabled: false,
            disabledCommandIds: [],
            overrides: {},
            handlers: { 'sessions.selection.extendDown': extendDown },
            getContext: () => context,
        });

        expect(dispatcher(keyEvent({ key: 'ArrowDown', code: 'ArrowDown', shiftKey: true }))).toBe(true);
        expect(extendDown).toHaveBeenCalledTimes(1);
    });
});
