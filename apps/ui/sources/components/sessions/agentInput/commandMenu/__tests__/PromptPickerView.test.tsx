import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptLibraryListItem } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { UserMessageHistoryEntriesSnapshot } from '@/hooks/session/useUserMessageHistoryEntries';

// RN TextInput owns soft submit; modifier keys arrive separately from the OS bridge.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { OS: 'ios', select: (value: Record<string, unknown>) => value.ios ?? value.native ?? value.default },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const native = vi.hoisted(() => ({ listener: null as null | ((event: import('@/keyboard/runtime').NativeHardwareKeyboardEventLike) => void) }));
vi.mock('@/components/sessions/agentInput/subscribeToIosHardwareShiftEnter', () => ({
    subscribeToNativeHardwareKeyboardEvents: (listener: NonNullable<typeof native.listener>) => {
        native.listener = listener;
        return { remove: () => { native.listener = null; } };
    },
    configureNativeHardwareKeyboardConsumableEventSignatures: () => {},
}));

// Only portal/window measurement is replaced; the real menu and selection list stay mounted.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
afterEach(standardCleanup);

const { PromptPickerView } = await import('../AgentInputPromptPicker');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');

const DOCUMENTS: readonly PromptLibraryListItem[] = [
    { artifactId: 'e2e', title: 'Run the settings e2e tests', folderId: null, tags: [], favorite: false, updatedAtMs: 0 },
];

function history(): UserMessageHistoryEntriesSnapshot {
    return { entries: [], coverage: 'partial', hasMore: false, isLoading: false, error: false,
        progress: { pagesLoaded: 0, sessionsSearched: 0, totalSessions: 0 },
        loadMore: async () => {}, retry: async () => {}, stop: () => {} };
}

async function mount(options: Readonly<{ hardwareKeyboard?: boolean; initialQuery?: string }> = {}) {
    const setFavorite = vi.fn(async () => {});
    const onApply = vi.fn(async () => true);
    const onRequestClose = vi.fn();
    const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><PromptPickerView
        anchor={{ kind: 'view', ref: { current: null } }} serverId="home" sessionId="s1" canSend
        onRequestClose={onRequestClose} onApply={onApply}
        library={{ documents: DOCUMENTS, invocations: [], coverage: 'complete', isLoading: false, error: false,
            read: async () => 'body', setFavorite, adopt: () => {}, retry: () => {} }}
        history={history()} folderNames={new Map()} sessionNames={new Map()} nowMs={0}
        hardwareKeyboard={options.hardwareKeyboard ?? true} initialQuery={options.initialQuery} /></KeyboardShortcutProvider>);
    return { screen, setFavorite, onApply, onRequestClose };
}

describe('prompt picker presentation controls', () => {
    it.each(['', 'kubernetes'])('keeps partial coverage visible with results or no match (query=%s)', async (initialQuery) => {
        const { screen } = await mount({ hardwareKeyboard: false, initialQuery });
        expect(screen.findByTestId('prompt-picker-history-coverage')).not.toBeNull();
        expect(screen.getTextContent()).toContain('agentInput.promptPicker.partialHistory');
    });
    it('inserts from native soft submit and sends from the focused modifier bridge', async () => {
        const { screen, onApply } = await mount();
        const search = screen.findByTestId('prompt-picker-search')!;
        await act(async () => search.props.onSubmitEditing?.());
        expect(onApply).toHaveBeenLastCalledWith(expect.any(Function), 'insert');
        await act(async () => search.props.onFocus?.());
        await act(async () => native.listener?.({ key: 'Enter', code: 'Enter', repeat: false,
            modifiers: { shift: false, ctrl: false, meta: true, alt: false } }));
        expect(onApply).toHaveBeenLastCalledWith(expect.any(Function), 'send');
        expect(onApply).toHaveBeenCalledTimes(2);
    });

    it('favourites the highlighted prompt from its star or Mod+D, without inserting it', async () => {
        const { screen, setFavorite, onApply } = await mount();
        await screen.pressByTestIdAsync('prompt-picker-favorite:doc:e2e');
        expect(setFavorite).toHaveBeenLastCalledWith('e2e', true);
        const search = screen.findByTestId('prompt-picker-search');
        await act(async () => search?.props.onFocus?.());
        const favoriteKey = { key: 'd', code: 'KeyD', repeat: false, modifiers: { shift: false, ctrl: false, meta: true, alt: false } };
        await act(async () => native.listener?.({ ...favoriteKey, modifiers: { ...favoriteKey.modifiers, ctrl: true } }));
        await act(async () => native.listener?.(favoriteKey));
        await act(async () => native.listener?.({ ...favoriteKey, modifiers: { ...favoriteKey.modifiers, meta: false, ctrl: true } }));
        expect(setFavorite).toHaveBeenCalledTimes(2);
        expect(onApply).not.toHaveBeenCalled();
    });

    it('says what found nothing and clears the query back to every prompt', async () => {
        const { screen } = await mount({ initialQuery: 'kubernetes' });
        expect(screen.findByTestId('prompt-picker-row:doc:e2e')).toBeNull();
        await screen.pressByTestIdAsync('prompt-picker-empty:action');
        expect(screen.findByTestId('prompt-picker-row:doc:e2e')).not.toBeNull();
    });

    it('drops keyboard hints without a hardware keyboard and closes from its own button', async () => {
        const { screen, onRequestClose } = await mount({ hardwareKeyboard: false });
        expect(screen.findByTestId('prompt-picker-history-coverage')).not.toBeNull();
        await screen.pressByTestIdAsync('prompt-picker-close');
        expect(onRequestClose).toHaveBeenCalledOnce();
    });
});
