import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import {
    buildKeyboardShortcutLabels,
    createKeyboardShortcutDispatcher,
    isKeybindingRuleAvailable,
    isKeyboardTargetHidden,
    normalizeKeyboardEvent,
    normalizeNativeHardwareKeyboardEvent,
    readKeyboardContextFromEventTarget,
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
    it.each(['session.action:ui.session.rename', 'action:review.start', 'action:acme.tools/actions/run'] as const)(
        'runs a saved Mod binding for %s while typing, while preserving editable exclusions', commandId => {
            const run = vi.fn();
            const dispatch = (binding: string, allowInEditable?: boolean) => createKeyboardShortcutDispatcher({
                platform: 'macos', surface: 'web', singleKeyShortcutsEnabled: false,
                disabledCommandIds: [], overrides: { [commandId]: [{ binding, ...(allowInEditable == null ? {} : { allowInEditable }) }] },
                handlers: { [commandId]: run },
                getContext: () => ({ isEditableTarget: true, isComposerTarget: true, isComposing: false }),
            });
            expect(dispatch('Mod+Alt+U')(keyEvent({ key: 'u', code: 'KeyU', metaKey: true, altKey: true }))).toBe(true);
            expect(run).toHaveBeenCalledOnce();
            expect(dispatch('Alt+U')(keyEvent({ key: '¨', code: 'KeyU', altKey: true }))).toBe(false);
            expect(dispatch('Mod+Alt+U', false)(keyEvent({ key: 'u', code: 'KeyU', metaKey: true, altKey: true }))).toBe(false);
            expect(run).toHaveBeenCalledOnce();
        },
    );
    it('dispatches both composer mode defaults and picker shortcuts while typing', () => {
        const mode = vi.fn();
        const model = vi.fn();
        const permission = vi.fn();
        const attach = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            platform: 'macos', surface: 'web', singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides: {},
            handlers: { 'mode.cycle': mode, 'session.model.choose': model, 'permission.open': permission, 'composer.attachFile': attach },
            getContext: () => ({ isEditableTarget: true, isComposerTarget: true, isComposing: false }),
        });
        expect(dispatcher(keyEvent({ key: 'Tab', code: 'Tab', shiftKey: true }))).toBe(true);
        expect(dispatcher(keyEvent({ key: 'M', code: 'KeyM', altKey: true, shiftKey: true }))).toBe(true);
        expect(mode).toHaveBeenCalledTimes(2);
        expect(dispatcher(keyEvent({ key: '÷', code: 'Slash', metaKey: true, altKey: true }))).toBe(true);
        expect(dispatcher(keyEvent({ key: 'a', code: 'KeyA', metaKey: true, altKey: true }))).toBe(true);
        expect(dispatcher(keyEvent({ key: 'U', code: 'KeyU', metaKey: true, shiftKey: true }))).toBe(true);
        expect(model).toHaveBeenCalledOnce(); expect(permission).toHaveBeenCalledOnce(); expect(attach).toHaveBeenCalledOnce();
    });
    it('leaves Shift+Tab navigation alone outside the composer', () => {
        const dom = new JSDOM('<div data-testid="session-composer-input"><textarea></textarea></div><input>');
        let target: EventTarget | null = dom.window.document.querySelector('input');
        const mode = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            platform: 'macos', surface: 'web', singleKeyShortcutsEnabled: true,
            disabledCommandIds: [], overrides: {}, handlers: { 'mode.cycle': mode },
            getContext: () => readKeyboardContextFromEventTarget(target),
        });
        expect(dispatcher(keyEvent({ key: 'Tab', code: 'Tab', shiftKey: true }))).toBe(false);
        expect(mode).not.toHaveBeenCalled();
        target = dom.window.document.querySelector('textarea');
        expect(dispatcher(keyEvent({ key: 'Tab', code: 'Tab', shiftKey: true }))).toBe(true);
        expect(mode).toHaveBeenCalledOnce();
        dom.window.close();
    });
    it('consumes configured qualified plugin and catalog Action shortcuts on native hardware', () => {
        for (const commandId of ['action:review.start', 'action:acme.tools/actions/run'] as const) {
            expect(resolveNativeHardwareKeyboardConsumableEventSignatures({ platform: 'ios', surface: 'native',
                singleKeyShortcutsEnabled: false, disabledCommandIds: [], overrides: { [commandId]: [{ binding: 'Mod+Shift+9' }] },
                handlers: { [commandId]: () => {} }, getContext: () => context }))
                .toContain('9|shift=true|ctrl=false|meta=true|alt=false');
        }
    });
    it('dispatches a configured qualified plugin Action through the registered palette handler', () => {
        const commandId = 'action:acme.tools/actions/run';
        const run = vi.fn();
        const overrides = { [commandId]: [{ binding: 'Mod+Shift+9' }] };
        const handlers = { [commandId]: run };
        const dispatch = createKeyboardShortcutDispatcher({ platform: 'macos', surface: 'web', singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides, handlers, getContext: () => context });
        expect(dispatch(keyEvent({ key: '9', code: 'Digit9', metaKey: true, shiftKey: true }))).toBe(true);
        expect(run).toHaveBeenCalledOnce();
        expect(buildKeyboardShortcutLabels('macos', 'web', { overrides, handlers })[commandId]).toBe('Cmd+Shift+9');
    });
    it('dispatches an explicitly bound catalog Action and publishes its shortcut label', () => {
        let invoked = false;
        const commandId = 'action:review.start';
        const overrides = { [commandId]: [{ binding: 'Mod+Shift+9' }] };
        const handlers = { [commandId]: () => { invoked = true; } };
        const dispatch = createKeyboardShortcutDispatcher({ platform: 'macos', surface: 'web', singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides, handlers, getContext: () => context });
        expect(dispatch(keyEvent({ key: '9', code: 'Digit9', metaKey: true, shiftKey: true }))).toBe(true);
        expect(invoked).toBe(true);
        expect(buildKeyboardShortcutLabels('macos', 'web', { overrides, handlers })[commandId]).toBe('Cmd+Shift+9');
    });
    it('advertises registered focused commands to native hardware with single-key shortcuts off', () => {
        const options = {
            platform: 'ios' as const, surface: 'native' as const,
            singleKeyShortcutsEnabled: false, disabledCommandIds: [], overrides: {},
            handlers: { 'annotation.arrow': () => {}, 'annotation.undo': () => {},
                'screenCapture.copy': () => {}, 'screenCapture.chooseSession': () => {} },
            getContext: () => context,
        };
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures(options)).toEqual(expect.arrayContaining([
            'a|shift=false|ctrl=false|meta=false|alt=false',
            'z|shift=false|ctrl=false|meta=true|alt=false',
            'c|shift=false|ctrl=false|meta=true|alt=false',
            'k|shift=false|ctrl=false|meta=true|alt=false',
        ]));
        expect(createKeyboardShortcutDispatcher(options)(keyEvent({ key: 'c', code: 'KeyC', metaKey: true }))).toBe(true);
        expect(createKeyboardShortcutDispatcher(options)(keyEvent({ key: 'k', code: 'KeyK', metaKey: true }))).toBe(true);
        expect(createKeyboardShortcutDispatcher(options)(keyEvent({ key: 'n', code: 'KeyN', metaKey: true }))).toBe(false);
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures({ ...options, handlers: {} })).toEqual([]);
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures({ ...options,
            disabledCommandIds: ['annotation.arrow', 'annotation.undo', 'screenCapture.copy', 'screenCapture.chooseSession'] })).toEqual([]);
    });

    it.each([
        ['macos', 'web', 'browser'],
        ['windows', 'web', 'desktop'],
        ['linux', 'native', undefined],
        ['ios', 'native', undefined],
        ['android', 'native', undefined],
    ] as const)('formats with Alt+Shift+F and moves a session row with Alt+Shift+G on %s/%s/%s', (platform, surface, webHost) => {
        const dom = new JSDOM('<div role="textbox" tabindex="0"><span></span></div><button>Session row</button>');
        try {
            const calls: string[] = [];
            let target: EventTarget | null = dom.window.document.querySelector('[role="textbox"] span');
            const dispatch = createKeyboardShortcutDispatcher({
                platform, surface, webHost, singleKeyShortcutsEnabled: false,
                disabledCommandIds: [], overrides: {},
                // Both surfaces can stay mounted without competing for a chord.
                handlers: {
                    'code.format': () => { calls.push('format'); },
                    'sessions.row.moveToFolder': () => { calls.push('moveToFolder'); },
                },
                getContext: () => readKeyboardContextFromEventTarget(target),
            });
            const moveChord = keyEvent({ key: 'G', code: 'KeyG', altKey: true, shiftKey: true });
            const formatChord = keyEvent({ key: 'F', code: 'KeyF', altKey: true, shiftKey: true });
            expect(dispatch(formatChord)).toBe(true);
            expect(calls).toEqual(['format']);
            expect(dispatch(moveChord)).toBe(false);
            expect(dispatch({ ...formatChord, isComposing: true })).toBe(false);
            target = dom.window.document.querySelector('button');
            expect(dispatch({ ...moveChord, isComposing: true })).toBe(false);
            expect(dispatch(moveChord)).toBe(true);
            expect(calls).toEqual(['format', 'moveToFolder']);
            // Format is also available from the read-view command handler.
            expect(dispatch(formatChord)).toBe(true);
            expect(calls).toEqual(['format', 'moveToFolder', 'format']);
            expect(resolveNativeHardwareKeyboardConsumableEventSignatures({
                platform, surface: 'native', singleKeyShortcutsEnabled: false,
                disabledCommandIds: [], overrides: {}, handlers: { 'code.format': () => {} },
                getContext: () => ({ isEditableTarget: false, isComposing: false }),
            })).toContain('f|shift=true|ctrl=false|meta=false|alt=true');
            const rebound = createKeyboardShortcutDispatcher({
                platform, surface, webHost, singleKeyShortcutsEnabled: false,
                disabledCommandIds: [],
                overrides: {
                    'code.format': [{ binding: 'Mod+Alt+Shift+F' }],
                    'sessions.row.moveToFolder': [{ binding: 'Alt+Shift+F' }],
                },
                handlers: {
                    'code.format': () => { calls.push('customFormat'); },
                    'sessions.row.moveToFolder': () => { calls.push('customMove'); },
                },
                getContext: () => readKeyboardContextFromEventTarget(target),
            });
            expect(rebound(moveChord)).toBe(false);
            expect(rebound(formatChord)).toBe(true);
            target = dom.window.document.querySelector('[role="textbox"] span');
            expect(rebound(formatChord)).toBe(false);
            expect(rebound({ ...formatChord, metaKey: platform === 'macos' || platform === 'ios',
                ctrlKey: platform !== 'macos' && platform !== 'ios' })).toBe(true);
            expect(calls.slice(-2)).toEqual(['customMove', 'customFormat']);
        } finally { dom.window.close(); }
    });
    it('leaves review letters with an ARIA textbox editor that uses EditContext rather than contenteditable', () => {
        const dom = new JSDOM('<div role="textbox" tabindex="0"><span></span></div><button>Review</button>');
        try {
            let kept = 0;
            let target: EventTarget | null = dom.window.document.querySelector('[role="textbox"]');
            const dispatch = createKeyboardShortcutDispatcher({
                platform: 'linux', surface: 'web', singleKeyShortcutsEnabled: true,
                disabledCommandIds: [], overrides: {}, handlers: { 'review.change.keep': () => { kept++; } },
                getContext: () => readKeyboardContextFromEventTarget(target),
            });
            const letter = keyEvent({ key: 'r', code: 'KeyR' });
            expect(dispatch(letter)).toBe(false);
            target = dom.window.document.querySelector('span');
            expect(dispatch(letter)).toBe(false);
            expect(kept).toBe(0);
            target = dom.window.document.querySelector('button');
            expect(dispatch(letter)).toBe(true);
            expect(kept).toBe(1);
        } finally { dom.window.close(); }
    });
    it.each(['macos', 'windows', 'linux', 'ios', 'android'] as const)('opens Files and Symbols from editable focus on %s without consuming IME', (platform) => {
        for (const [id, key, shiftKey] of [['search.files', 'p', false], ['search.symbols', 'o', true]] as const) {
            const open = vi.fn();
            const options = { platform, surface: 'native' as const, singleKeyShortcutsEnabled: false,
                disabledCommandIds: [], overrides: {}, handlers: { [id]: open }, getContext: () => ({ ...context, isEditableTarget: true }) };
            const chord = keyEvent({ key, code: `Key${key.toUpperCase()}`, shiftKey,
                metaKey: platform === 'macos' || platform === 'ios', ctrlKey: platform !== 'macos' && platform !== 'ios' });
            expect(createKeyboardShortcutDispatcher(options)(chord)).toBe(true);
            expect(open).toHaveBeenCalledOnce();
            expect(createKeyboardShortcutDispatcher(options)({ ...chord, isComposing: true })).toBe(false);
            expect(createKeyboardShortcutDispatcher({ ...options, disabledCommandIds: [id] })(chord)).toBe(false);
        }
    });
    it('admits literal Ctrl+R for prompt picking on macOS web and every desktop/native host', () => {
        for (const platform of ['macos', 'windows', 'linux', 'ios', 'android'] as const) {
            const options = { platform, singleKeyShortcutsEnabled: false,
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
            const options = { platform, surface: 'web' as const, singleKeyShortcutsEnabled: false,
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
            platform: 'macos', surface: 'web', singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides: {}, handlers: { 'voice.toggle': () => 'pass' }, getContext: () => context,
        });
        expect(dispatch(keyEvent({ key: 'v', code: 'KeyV', metaKey: true, altKey: true }))).toBe(false);
    });
    it.each(['macos', 'windows', 'linux', 'ios', 'android'] as const)('opens text in files from editable app focus on %s while respecting disablement', (platform) => {
        const open = vi.fn();
        const options = { platform, surface: platform === 'ios' || platform === 'android' ? 'native' as const : 'web' as const, singleKeyShortcutsEnabled: false, disabledCommandIds: [], overrides: {}, handlers: { 'search.textInFiles': open }, getContext: () => ({ ...context, isEditableTarget: true }) };
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
            platform, singleKeyShortcutsEnabled: false, disabledCommandIds: [], overrides: {},
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
            platform: 'macos' as const, surface: 'web' as const,
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
            platform: 'macos', surface: 'web', singleKeyShortcutsEnabled: true,
            disabledCommandIds: [], overrides: {}, handlers: { 'commandPalette.open': open },
            getContext: () => context,
        });
        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', altKey: true }))).toBe(true);
        expect(query).toBe('');
    });

    it.each([
        ['macos', { metaKey: true }],
        ['windows', { ctrlKey: true }],
        ['linux', { ctrlKey: true }],
    ] as const)('opens the one Search palette from Cmd/Ctrl+K in a browser on %s, beside Alt+K', (platform, modifier) => {
        const open = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            platform, surface: 'web', webHost: 'browser', singleKeyShortcutsEnabled: true,
            disabledCommandIds: [], overrides: {}, handlers: { 'commandPalette.open': open },
            getContext: () => context,
        });
        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', ...modifier }))).toBe(true);
        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', altKey: true }))).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['macos', { metaKey: true }],
        ['windows', { ctrlKey: true }],
        ['linux', { ctrlKey: true }],
    ] as const)('opens the palette while typing on %s, including overrides, without consuming Alt+K', (platform, modifier) => {
        const open = vi.fn();
        const options = {
            platform, surface: 'web' as const, webHost: 'browser' as const,
            singleKeyShortcutsEnabled: true, disabledCommandIds: [],
            handlers: { 'commandPalette.open': open },
            getContext: () => ({ ...context, isEditableTarget: true }),
        };
        const dispatcher = createKeyboardShortcutDispatcher({ ...options, overrides: {} });
        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', ...modifier }))).toBe(true);
        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', altKey: true }))).toBe(false);
        const overridden = createKeyboardShortcutDispatcher({
            ...options, overrides: { 'commandPalette.open': [{ binding: 'Mod+J' }] },
        });
        expect(overridden(keyEvent({ key: 'j', code: 'KeyJ', ...modifier }))).toBe(true);
    });

    it('dispatches command palette defaults through the shared registry', () => {
        const open = vi.fn();
        const newSession = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
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

        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', metaKey: true }))).toBe(true);
        expect(dispatcher(keyEvent({ key: 'k', code: 'KeyK', altKey: true }))).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
        expect(dispatcher(keyEvent({ key: 'n', code: 'KeyN', metaKey: true, shiftKey: true }))).toBe(false);
        expect(newSession).not.toHaveBeenCalled();
    });

    it('does not dispatch browser-reserved defaults on web surfaces', () => {
        const newSession = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
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

    it('uses web-safe MRU session defaults instead of browser tab cycling shortcuts', () => {
        const next = vi.fn();
        const previous = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
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

        // Search shows its Cmd+K default first; Alt+K remains a web alternative.
        expect(labels['commandPalette.open']).toBe('Cmd+K');
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
        expect(labels['commandPalette.open']).toBe('Ctrl+K');
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
                'code.showInfo': vi.fn(),
            },
        });

        expect(labels['commandPalette.open']).toBeUndefined();
        expect(labels['session.new']).toBe('Cmd+P');
        expect(labels['shortcutsHelp.open']).toBeUndefined();
        // The platform's preferences shortcut opens Settings in the desktop app.
        expect(labels['settings.open']).toBe('Cmd+,');
        // A command with a handler but no binding has no label.
        expect(labels['code.showInfo']).toBeUndefined();
    });

    it.each([
        ['browser.back', '[', 'BracketLeft'],
        ['browser.forward', ']', 'BracketRight'],
        ['browser.reload', 'r', 'KeyR'],
    ] as const)('dispatches %s from the editable Browser address with its default binding', (commandId, key, code) => {
        const navigate = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
            platform: 'linux',
            surface: 'web',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: [],
            overrides: {},
            handlers: { [commandId]: navigate },
            getContext: () => ({ isEditableTarget: true, isComposing: false }),
        });

        expect(dispatcher(keyEvent({ key, code, altKey: true }))).toBe(true);
        expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('keeps editable-safe commands editable when their shortcut is overridden', () => {
        const sendImmediate = vi.fn();
        const dispatcher = createKeyboardShortcutDispatcher({
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

    it('derives native consumable signatures from active editable-safe commands', () => {
        const signatures = resolveNativeHardwareKeyboardConsumableEventSignatures({
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
            'k|shift=false|ctrl=false|meta=true|alt=false',
        ]);
    });

    it('derives the native Mod+K signature for the canonical Search command', () => {
        const signatures = resolveNativeHardwareKeyboardConsumableEventSignatures({
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
            platform: 'ios',
            surface: 'native',
            singleKeyShortcutsEnabled: true,
            disabledCommandIds: ['composer.sendImmediate'],
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

describe('isKeyboardTargetHidden', () => {
    // The composer's editor sits ~70 elements deep, and this runs on every keydown. `checkVisibility`
    // is the browser boundary jsdom lacks: false for a node under display: none (itself or an
    // ancestor) or, with `visibilityProperty`, whose own computed visibility is hidden or collapse.
    function deepTarget(dom: JSDOM, depth: number) {
        let parent: Element = dom.window.document.body;
        const chain: Element[] = [];
        for (let index = 0; index < depth; index++) {
            const child = dom.window.document.createElement('div');
            parent.appendChild(child);
            chain.push(child);
            parent = child;
        }
        return chain;
    }
    function installCheckVisibility(dom: JSDOM) {
        const view = dom.window;
        // The browser answers natively; this stand-in must not count as page reads of computed style.
        const computed = view.getComputedStyle.bind(view);
        (view.Element.prototype as unknown as { checkVisibility: (options?: { visibilityProperty?: boolean }) => boolean })
            .checkVisibility = function (this: Element, options?: { visibilityProperty?: boolean }) {
                for (let node: Element | null = this; node; node = node.parentElement) {
                    if (computed(node).display === 'none') return false;
                }
                const visibility = computed(this).visibility;
                return !(options?.visibilityProperty && (visibility === 'hidden' || visibility === 'collapse'));
            };
    }

    it('answers for a deep visible target without reading every ancestor\'s computed style', () => {
        const dom = new JSDOM('<!doctype html><body></body>');
        installCheckVisibility(dom);
        const chain = deepTarget(dom, 70);
        const target = chain.at(-1)!;
        const reads = vi.spyOn(dom.window, 'getComputedStyle');
        expect(isKeyboardTargetHidden(target)).toBe(false);
        // The walk read the computed style of all 70 ancestors on every keydown.
        expect(reads).not.toHaveBeenCalled();
    });

    it('still finds a target hidden by an ancestor attribute, display or its own visibility', () => {
        const dom = new JSDOM('<!doctype html><body></body>');
        installCheckVisibility(dom);
        for (const hide of [
            (element: HTMLElement) => element.setAttribute('aria-hidden', 'true'),
            (element: HTMLElement) => { element.hidden = true; },
            (element: HTMLElement) => element.setAttribute('inert', ''),
            (element: HTMLElement) => { element.style.display = 'none'; },
            (element: HTMLElement) => { element.style.visibility = 'hidden'; },
        ]) {
            const chain = deepTarget(dom, 12) as HTMLElement[];
            hide(chain[3]!);
            expect(isKeyboardTargetHidden(chain.at(-1)!)).toBe(true);
        }
        expect(isKeyboardTargetHidden(dom.window.document.body)).toBe(false);
        expect(isKeyboardTargetHidden(dom.window)).toBe(false);
        expect(isKeyboardTargetHidden(null)).toBe(false);
    });

    it('walks the ancestors where the engine has no checkVisibility', () => {
        const dom = new JSDOM('<!doctype html><body></body>');
        const chain = deepTarget(dom, 8) as HTMLElement[];
        chain[2]!.style.visibility = 'collapse';
        expect(isKeyboardTargetHidden(chain.at(-1)!)).toBe(true);
        chain[2]!.style.visibility = '';
        expect(isKeyboardTargetHidden(chain.at(-1)!)).toBe(false);
    });
});
