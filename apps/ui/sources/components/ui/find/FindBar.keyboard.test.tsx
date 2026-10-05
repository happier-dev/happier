// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { FindController, HappierFindBarProps } from '@happier-dev/plugin-ui/presentation';

import { KeyboardShortcutProvider, useFindSurfaceRegistration, useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { storage } from '@/sync/domains/state/storage';
import { FindBar } from './FindBar';

// Exercise the actual RNW input and browser propagation, rather than the node host shim.
vi.mock('react-native', async () => await import('react-native-web'));

describe('core Find field keyboard ownership', () => {
    it('routes a committed native submit through current preferences without dispatching the keyPress twice', async () => {
        const originalSettings = storage.getState().settings;
        storage.setState({ settings: { ...originalSettings, keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: false, keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: {} } });
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        let current = 1;
        let keyboardHandlers: HappierFindBarProps['keyboardHandlers'];
        function Surface() {
            const controller: FindController = { query: 'needle', options: { matchCase: false, regex: false },
                status: { kind: 'results', total: 3, current, coverage: 'complete' }, capabilities: { regex: true, stop: false },
                setQuery() {}, setOptions() {}, stop() {}, close() {}, step(direction) { current += direction; } };
            useFindSurfaceRegistration({ surfaceId: 'chat:submit', containsFocus: () => true, isOpen: () => true,
                isInputFocused: () => true, open() {}, controller });
            keyboardHandlers = useFindSurfaceRuntime().keyboardHandlers;
            return null;
        }
        const submit = () => {
            keyboardHandlers!.onKeyPress({ nativeEvent: { key: 'Enter' } });
            keyboardHandlers!.onSubmitEditing();
        };
        try {
            await act(async () => { root.render(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>); });
            submit(); expect(current).toBe(2);
            await act(async () => { storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutDisabledCommandIdsV1: ['find.next'] } }); });
            submit(); expect(current).toBe(2);
            await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
                keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: { 'find.next': [{ binding: 'Mod+H' }] } } }); });
            submit(); expect(current).toBe(2);
            await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
                keyboardShortcutOverridesV1: {}, keyboardShortcutsV2Enabled: false } }); });
            submit(); expect(current).toBe(2);
        } finally {
            await act(async () => { root.unmount(); }); container.remove(); storage.setState({ settings: originalSettings });
        }
    });

    it('steps once, respects disabled and rebound commands, ignores composition and closes once to the origin', async () => {
        Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
        const originalSettings = storage.getState().settings;
        storage.setState({ settings: { ...originalSettings, keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: false, keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: {} } });
        const state = { current: 1, open: true, inputFocused: false, closes: 0 };
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        function Surface() {
            const surfaceRef = React.useRef<HTMLDivElement>(null);
            const originRef = React.useRef<HTMLButtonElement>(null);
            const inputRef = React.useRef<HTMLInputElement>(null);
            const [, refresh] = React.useReducer((value: number) => value + 1, 0);
            const controller: FindController = {
                query: 'needle', options: { matchCase: false, regex: false },
                get status() { return { kind: 'results' as const, current: state.current, total: 3, coverage: 'complete' as const }; },
                capabilities: { regex: true, stop: false },
                setQuery() {}, setOptions() {}, stop() {},
                step(direction) { state.current += direction; refresh(); },
                close() { state.closes += 1; state.open = false; originRef.current?.focus(); refresh(); },
            };
            useFindSurfaceRegistration({ surfaceId: 'chat:dom',
                containsFocus: () => surfaceRef.current?.contains(document.activeElement) === true,
                isOpen: () => state.open, isInputFocused: () => state.inputFocused,
                open: () => { state.open = true; inputRef.current?.focus(); refresh(); }, controller });
            return <div ref={surfaceRef}>
                <button ref={originRef} data-testid="origin">Origin</button>
                {state.open ? <FindBar query={controller.query} options={controller.options} status={controller.status}
                    capabilities={controller.capabilities} onQueryChange={controller.setQuery} onOptionsChange={controller.setOptions}
                    onStep={controller.step} onStop={controller.stop} onClose={controller.close}
                    onInputFocus={() => { state.inputFocused = true; refresh(); }}
                    onInputBlur={() => { state.inputFocused = false; refresh(); }}
                    presentation="inline" surfaceLabel="Find in chat" inputRef={inputRef} autoFocus={false} testID="find" /> : null}
            </div>;
        }
        const key = async (init: KeyboardEventInit) => {
            const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
            await act(async () => { container.querySelector<HTMLInputElement>('[data-testid="find.input"]')!.dispatchEvent(event); });
            return event;
        };
        try {
            await act(async () => { root.render(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>); });
            await act(async () => { container.querySelector<HTMLInputElement>('[data-testid="find.input"]')!.focus(); });
            await key({ key: 'Enter', code: 'Enter' }); expect(state.current).toBe(2);
            await act(async () => { storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutDisabledCommandIdsV1: ['find.next'] } }); });
            await key({ key: 'Enter', code: 'Enter' }); expect(state.current).toBe(2);
            await act(async () => { storage.setState({ settings: { ...storage.getState().settings,
                keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: { 'find.next': [{ binding: 'Mod+H' }] } } }); });
            await key({ key: 'Enter', code: 'Enter' }); expect(state.current).toBe(2);
            await key({ key: 'h', code: 'KeyH', metaKey: true }); expect(state.current).toBe(3);
            await key({ key: 'Enter', code: 'Enter', shiftKey: true, isComposing: true }); expect(state.current).toBe(3);
            await key({ key: 'Enter', code: 'Enter', shiftKey: true }); expect(state.current).toBe(2);
            await key({ key: 'Escape', code: 'Escape' }); expect(state.closes).toBe(1);
            expect(document.activeElement).toBe(container.querySelector('[data-testid="origin"]'));
        } finally {
            await act(async () => { root.unmount(); }); container.remove(); storage.setState({ settings: originalSettings });
        }
    });
});
