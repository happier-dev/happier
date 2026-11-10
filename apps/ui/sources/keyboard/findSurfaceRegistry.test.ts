import { describe, expect, it } from 'vitest';
import type { FindController, FindStatus } from '@happier-dev/plugin-ui/presentation';
import { createFindSurfaceRegistry, type FindSurfaceRegistration } from './findSurfaceRegistry';
import { createKeyboardShortcutDispatcher, resolveNativeHardwareKeyboardConsumableEventSignatures } from './runtime';
import type { NormalizedKeyboardEvent } from './types';

function event(key: string, modifiers: Partial<NormalizedKeyboardEvent> = {}): NormalizedKeyboardEvent {
    return { key, code: key === 'Enter' || key === 'Escape' ? key : `Key${key.toUpperCase()}`, metaKey: false, ctrlKey: false,
        shiftKey: false, altKey: false, repeat: false, isComposing: false, ...modifiers };
}

function surfaceFixture(surfaceId: string) {
    const state = { focused: true, inputFocused: false, open: false, current: 0, total: 3, stopped: false };
    let query = '';
    let options = { matchCase: false, regex: false };
    const controller: FindController = {
        get query() { return query; }, get options() { return options; },
        get status(): FindStatus { return { kind: 'results', current: state.current, total: state.total, coverage: 'loaded' }; },
        capabilities: { regex: true, stop: true },
        setQuery(value) { query = value; }, setOptions(value) { options = value; },
        step(direction) { state.current += direction; }, stop() { state.stopped = true; }, close() { state.open = false; state.inputFocused = false; },
    };
    const surface: FindSurfaceRegistration = { surfaceId, controller, containsFocus: () => state.focused,
        open: () => { state.open = true; state.inputFocused = true; }, isOpen: () => state.open, isInputFocused: () => state.inputFocused };
    return { state, surface };
}

describe('mounted Find keyboard resolution', () => {
    it('passes outside a surface and on a second Find, steps only in the input and lets closed Ctrl+G reach the PTY', () => {
        const find = createFindSurfaceRegistry();
        const dispatch = createKeyboardShortcutDispatcher({ enabled: true, platform: 'windows', surface: 'web', singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides: {}, handlers: {
                'find.open': (key) => find.command('find.open', key), 'find.next': (key) => find.command('find.next', key),
                'find.previous': (key) => find.command('find.previous', key),
            }, getContext: () => ({ isEditableTarget: true, isComposing: false }) });
        expect(dispatch(event('f', { ctrlKey: true }))).toBe(false);
        const { surface, state } = surfaceFixture('terminal:leaf');
        const release = find.register(surface);
        expect(dispatch(event('g', { ctrlKey: true }))).toBe(false);
        expect(dispatch(event('f', { ctrlKey: true }))).toBe(true);
        expect(state.open).toBe(true);
        expect(dispatch(event('f', { ctrlKey: true }))).toBe(false);
        expect(dispatch(event('Enter', { isComposing: true }))).toBe(false);
        expect(state.current).toBe(0);
        expect(dispatch(event('Enter'))).toBe(true);
        expect(state.current).toBe(1);
        expect(dispatch(event('Enter', { shiftKey: true }))).toBe(true);
        expect(state.current).toBe(0);
        state.inputFocused = false;
        expect(dispatch(event('Enter'))).toBe(false);
        expect(dispatch(event('g', { ctrlKey: true }))).toBe(true);
        state.inputFocused = true;
        expect(find.closeFromKeyboard(event('Escape', { isComposing: true }))).toBe('pass');
        expect(find.closeFromKeyboard(event('Escape'))).toBe('handled');
        expect(dispatch(event('g', { ctrlKey: true }))).toBe(false);
        release();
        expect(dispatch(event('f', { ctrlKey: true }))).toBe(false);
    });

    it('targets the focused split leaf and retires a replaced registration without clearing its successor', () => {
        const find = createFindSurfaceRegistry();
        const hidden = surfaceFixture('hidden'); hidden.state.focused = false;
        const visible = surfaceFixture('visible');
        find.register(hidden.surface);
        const releaseOld = find.register(visible.surface);
        const replacement = surfaceFixture('visible'); find.register(replacement.surface);
        releaseOld();
        expect(find.open()).toBe(true);
        expect(replacement.state.open).toBe(true);
        expect(visible.state.open).toBe(false);
        expect(hidden.state.open).toBe(false);
        expect(find.open('missing')).toBe(false);
    });

    it('opens a surface that registers right after an intent that brought it forward, once', () => {
        // Phone cockpit: Find from another tab switches to the chat tab, whose transcript registers only
        // once it is in front (device 11-10: the tab switched but the find field stayed closed).
        const find = createFindSurfaceRegistry();
        expect(find.open('chat', { whenRegistered: true })).toBe(false);
        const chat = surfaceFixture('chat');
        const release = find.register(chat.surface);
        expect(chat.state.open).toBe(true);
        chat.state.open = false;
        release();
        find.register(chat.surface);
        expect(chat.state.open).toBe(false);
        // The tab switch remounts the chat scene: the mount that opened is replaced while open, and the
        // replacement opens too, in either order of mount and unmount (device 11-10).
        const placeholder = surfaceFixture('remount');
        expect(find.open('remount', { whenRegistered: true })).toBe(false);
        const releasePlaceholder = find.register(placeholder.surface);
        expect(placeholder.state.open).toBe(true);
        const real = surfaceFixture('remount');
        find.register(real.surface);
        releasePlaceholder();
        expect(real.state.open).toBe(true);
        const again = surfaceFixture('remount2');
        expect(find.open('remount2', { whenRegistered: true })).toBe(false);
        const releaseFirst = find.register(again.surface);
        releaseFirst();
        const replacement = surfaceFixture('remount2');
        find.register(replacement.surface);
        expect(replacement.state.open).toBe(true);
        // A plain open of a missing surface leaves nothing behind.
        const other = surfaceFixture('other');
        expect(find.open('other')).toBe(false);
        find.register(other.surface);
        expect(other.state.open).toBe(false);
    });

    it('keeps interaction ownership local to an available mount and gives actual focus precedence', () => {
        const find = createFindSurfaceRegistry();
        const transcript = surfaceFixture('chat'); transcript.state.focused = false;
        const file = surfaceFixture('file'); file.state.focused = false;
        let available = true;
        const release = find.register({ ...transcript.surface, containsTarget: target => target === 'transcript',
            isAvailable: () => available });
        find.register({ ...file.surface, containsTarget: target => target === 'file' });
        find.recordInteraction('transcript');
        expect(find.resolve()?.surfaceId).toBe('chat');
        file.state.focused = true;
        expect(find.resolve()?.surfaceId).toBe('file');
        file.state.focused = false;
        available = false;
        expect(find.resolve()).toBeUndefined();
        available = true;
        find.recordInteraction('outside');
        expect(find.resolve()).toBeUndefined();
        find.recordInteraction('transcript');
        release();
        expect(find.resolve()).toBeUndefined();
    });

    it('does not consume native Return until the Find input owns focus and respects disabling and overrides', () => {
        const options = { enabled: true, platform: 'ios' as const, surface: 'native' as const, singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides: {}, handlers: { 'find.next': () => 'handled' as const },
            getContext: () => ({ isEditableTarget: true, isComposing: false }) };
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures(options)).toEqual(['g|shift=false|ctrl=false|meta=true|alt=false']);
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures({ ...options, getContext: () => ({ isEditableTarget: true, isComposing: false, findInputFocused: true }) }))
            .toContain('Enter|shift=false|ctrl=false|meta=false|alt=false');
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures({ ...options, disabledCommandIds: ['find.next'] })).toEqual([]);
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures({ ...options, overrides: { 'find.next': [{ binding: 'Mod+H' }] } }))
            .toEqual(['h|shift=false|ctrl=false|meta=true|alt=false']);
        const find = createFindSurfaceRegistry();
        const fixture = surfaceFixture('chat:override');
        fixture.state.open = true;
        find.register(fixture.surface);
        const modifiedEnter = { ...options, overrides: { 'find.next': [{ binding: 'Mod+Enter' }] },
            handlers: { 'find.next': (key?: NormalizedKeyboardEvent) => find.command('find.next', key) } };
        expect(resolveNativeHardwareKeyboardConsumableEventSignatures(modifiedEnter))
            .toEqual(['Enter|shift=false|ctrl=false|meta=true|alt=false']);
        expect(createKeyboardShortcutDispatcher(modifiedEnter)(event('Enter', { metaKey: true }))).toBe(true);
        expect(fixture.state.current).toBe(1);
    });
});
