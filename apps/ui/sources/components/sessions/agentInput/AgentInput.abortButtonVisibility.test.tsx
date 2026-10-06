import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type { MultiTextInputProps } from '@/components/ui/forms/MultiTextInput';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
        });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();
let AgentInput: typeof import('./AgentInput')['AgentInput'];
let MultiTextInput: typeof import('@/components/ui/forms/MultiTextInput')['MultiTextInput'];

beforeEach(async () => {
    ({ AgentInput } = await import('./AgentInput'));
    ({ MultiTextInput } = await import('@/components/ui/forms/MultiTextInput'));
    storage.setState({ settings: {
        ...storage.getState().settings,
        agentInputEnterToSend: true,
        agentInputActionBarLayout: 'wrap',
        agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate',
    } });
});
afterEach(() => vi.useRealTimers());

const suggestion: AutocompleteSuggestion = { kind: 'file', key: 'path', text: '@/components', label: 'components' };
const suggestions = async () => [suggestion];
const noSuggestions = async () => [];

function findInput(screen: Awaited<ReturnType<typeof renderScreen>>): MultiTextInputProps {
    // React TestRenderer exposes untyped component props at this framework boundary.
    return screen.tree.root.findByType(MultiTextInput).props;
}

async function mount(params: Partial<React.ComponentProps<typeof AgentInput>> = {}) {
    return renderScreen(<AgentInput
        value=""
        placeholder="Type"
        onChangeText={() => {}}
        onSend={() => {}}
        autocompleteKinds={[]}
        autocompleteSuggestions={noSuggestions}
        {...params}
    />, { wrapper: runtime.Wrapper });
}

async function showSuggestions(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await act(async () => {
        const input = findInput(screen);
        input.onFocus?.();
        input.onChangeText('@comp');
        input.onStateChange?.({ text: '@comp', selection: { start: 5, end: 5 } });
    });
    await flushHookEffects();
    expect(findInput(screen).accessibilityState?.expanded).toBe(true);
}

async function press(screen: Awaited<ReturnType<typeof renderScreen>>, key: 'Enter' | 'Escape', shiftKey = false) {
    let handled: boolean | undefined;
    await act(async () => { handled = findInput(screen).onKeyPress?.({ key, shiftKey }); });
    return handled;
}

describe('AgentInput (abort button visibility)', () => {
    it('does not render the stop button when showAbortButton is false (even if onAbort exists)', async () => {
        const screen = await mount({ onAbort: vi.fn(), showAbortButton: false });
        expect(screen.findByTestId('agent-input-abort')).toBeNull();
    });

    it('renders the stop button when showAbortButton is true and onAbort exists', async () => {
        const screen = await mount({ onAbort: vi.fn(), showAbortButton: true });
        expect(screen.findByTestId('agent-input-abort')).toBeTruthy();
    });

    it('does not abort from plain Escape', async () => {
        const onAbort = vi.fn();
        const screen = await mount({ onAbort, showAbortButton: true });
        expect(await press(screen, 'Escape')).toBe(false);
        expect(onAbort).not.toHaveBeenCalled();
    });

    it('selects visible autocomplete suggestion before plain Enter can send', async () => {
        const onSend = vi.fn();
        const onChangeText = vi.fn();
        const screen = await mount({ value: '@comp', onSend, onChangeText,
            showAbortButton: false, autocompleteKinds: ['file'], autocompleteSuggestions: suggestions });
        await showSuggestions(screen);
        onChangeText.mockClear();
        expect(await press(screen, 'Enter')).toBe(true);
        expect(onChangeText).toHaveBeenCalledWith('@/components ');
        expect(onSend).not.toHaveBeenCalled();
    });

    it('confirms abort with Shift+Escape when autocomplete suggestions are visible', async () => {
        const onAbort = vi.fn();
        const screen = await mount({ value: '@comp', onAbort, showAbortButton: true,
            autocompleteKinds: ['file'], autocompleteSuggestions: suggestions });
        await showSuggestions(screen);
        expect(await press(screen, 'Escape', true)).toBe(true);
        expect(onAbort).not.toHaveBeenCalled();
        expect(await press(screen, 'Escape', true)).toBe(true);
        expect(onAbort).toHaveBeenCalledTimes(1);
    });

    it('requires a second Shift+Escape within the confirmation window before aborting', async () => {
        const onAbort = vi.fn();
        const screen = await mount({ onAbort, showAbortButton: true });
        expect(await press(screen, 'Escape', true)).toBe(true);
        expect(onAbort).not.toHaveBeenCalled();
        expect(await press(screen, 'Escape', true)).toBe(true);
        expect(onAbort).toHaveBeenCalledTimes(1);
    });

    it('expires the Shift+Escape abort confirmation window', async () => {
        const onAbort = vi.fn();
        const screen = await mount({ onAbort, showAbortButton: true });
        // The clock boundary changes only after the real Account and Sync are ready.
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        expect(await press(screen, 'Escape', true)).toBe(true);
        vi.setSystemTime(2_501);
        expect(await press(screen, 'Escape', true)).toBe(true);
        expect(onAbort).not.toHaveBeenCalled();
        expect(await press(screen, 'Escape', true)).toBe(true);
        expect(onAbort).toHaveBeenCalledTimes(1);
    });
});
