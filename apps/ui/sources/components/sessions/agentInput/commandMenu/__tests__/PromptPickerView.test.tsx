import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptLibraryListItem } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { UserMessageHistoryEntriesSnapshot } from '@/hooks/session/useUserMessageHistoryEntries';
import type { PromptPickerViewProps } from '../AgentInputPromptPicker';

// RN TextInput owns soft submit; modifier keys arrive separately from the OS bridge.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { OS: 'ios', select: (value: Record<string, unknown>) => value.ios ?? value.native ?? value.default },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const native = vi.hoisted(() => ({ listeners: new Set<(event: import('@/keyboard/runtime').NativeHardwareKeyboardEventLike) => void>() }));
// Native module delivery is external; subscription counting and shortcut admission remain real.
vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierHardwareKeyboardShortcuts' ? {
        addListener: (event: string, listener: (event: import('@/keyboard/runtime').NativeHardwareKeyboardEventLike) => void) => {
            if (event === 'hardwareKey') native.listeners.add(listener);
            return { remove: () => native.listeners.delete(listener) };
        },
        setHardwareKeyEventsEnabled: () => {},
        setHardwareKeyConsumableEventSignatures: () => {},
    } : null,
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
        loadMore: async () => history(), retry: async () => history(), stop: () => history() };
}

async function mount(options: Readonly<{ hardwareKeyboard?: boolean; initialQuery?: string; library?: Partial<PromptPickerViewProps['library']> }> = {}) {
    const outcomes = {
        applied: [] as Array<{ text: string; mode: 'insert' | 'send' }>,
        favorites: [] as Array<{ artifactId: string; favorite: boolean }>,
        closed: false,
    };
    const setFavorite = async (artifactId: string, favorite: boolean) => { outcomes.favorites.push({ artifactId, favorite }); };
    const onApply: PromptPickerViewProps['onApply'] = async (expand, mode) => {
        outcomes.applied.push({ text: (await expand()).text, mode });
        return true;
    };
    const onRequestClose = () => { outcomes.closed = true; };
    const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><PromptPickerView
        anchor={{ kind: 'view', ref: { current: null } }} serverId="home" sessionId="s1" canSend
        onRequestClose={onRequestClose} onApply={onApply}
        library={{ documents: DOCUMENTS, invocations: [], coverage: 'complete', isLoading: false, error: false,
            read: async () => 'body', setFavorite, adopt: () => {}, retry: () => {}, ...options.library }}
        history={history()} folderNames={new Map()} sessionNames={new Map()} nowMs={0}
        hardwareKeyboard={options.hardwareKeyboard ?? true} initialQuery={options.initialQuery} /></KeyboardShortcutProvider>);
    return { screen, outcomes };
}

describe('prompt picker presentation controls', () => {
    it('places the empty favourites invitation inside the list without adding a selectable row', async () => {
        const { screen, outcomes } = await mount();
        const list = screen.findByTestId('agent-input-prompt-picker:list');
        expect(list?.findAll((node) => node.children.includes('agentInput.promptPicker.favoritesInvite')).length).toBeGreaterThan(0);
        await act(async () => screen.findByTestId('prompt-picker-search')?.props.onSubmitEditing?.());
        expect(outcomes.applied).toEqual([{ text: 'body', mode: 'insert' }]);
    });

    it.each(['', 'kubernetes'])('keeps partial coverage visible with results or no match (query=%s)', async (initialQuery) => {
        const { screen } = await mount({ hardwareKeyboard: false, initialQuery });
        expect(screen.findByTestId('prompt-picker-history-status')).not.toBeNull();
        expect(screen.getTextContent()).toContain('agentInput.promptPicker.partialHistory');
    });
    it('inserts from native soft submit and sends from the focused modifier bridge', async () => {
        const { screen, outcomes } = await mount();
        const search = screen.findByTestId('prompt-picker-search')!;
        await act(async () => search.props.onSubmitEditing?.());
        expect(outcomes.applied).toEqual([{ text: 'body', mode: 'insert' }]);
        await act(async () => search.props.onFocus?.());
        await act(async () => { for (const listener of native.listeners) listener({ key: 'Enter', code: 'Enter', repeat: false,
            modifiers: { shift: false, ctrl: false, meta: true, alt: false } }); });
        expect(outcomes.applied).toEqual([{ text: 'body', mode: 'insert' }, { text: 'body', mode: 'send' }]);
    });

    it('favourites the highlighted prompt from its star or Mod+D, without inserting it', async () => {
        const { screen, outcomes } = await mount();
        await screen.pressByTestIdAsync('prompt-picker-favorite:doc:e2e');
        expect(outcomes.favorites).toEqual([{ artifactId: 'e2e', favorite: true }]);
        const search = screen.findByTestId('prompt-picker-search');
        await act(async () => search?.props.onFocus?.());
        const favoriteKey = { key: 'd', code: 'KeyD', repeat: false, modifiers: { shift: false, ctrl: false, meta: true, alt: false } };
        await act(async () => { for (const listener of native.listeners) listener({ ...favoriteKey, modifiers: { ...favoriteKey.modifiers, ctrl: true } }); });
        await act(async () => { for (const listener of native.listeners) listener(favoriteKey); });
        await act(async () => { for (const listener of native.listeners) listener({ ...favoriteKey, modifiers: { ...favoriteKey.modifiers, meta: false, ctrl: true } }); });
        expect(outcomes.favorites).toEqual([{ artifactId: 'e2e', favorite: true }, { artifactId: 'e2e', favorite: true }]);
        expect(outcomes.applied).toEqual([]);
    });

    it('says what found nothing and clears the query back to every prompt', async () => {
        const { screen } = await mount({ initialQuery: 'kubernetes' });
        expect(screen.findByTestId('prompt-picker-row:doc:e2e')).toBeNull();
        await screen.pressByTestIdAsync('prompt-picker-empty:action');
        expect(screen.findByTestId('prompt-picker-row:doc:e2e')).not.toBeNull();
    });

    it('says its list states through the shared state line, announcing a failed library and retrying it', async () => {
        let retried = 0;
        const { screen } = await mount({ initialQuery: 'kubernetes', library: { error: true, retry: () => { retried += 1; } } });
        const announced = (role: string) => screen.tree.root.findAll((node) => typeof node.type === 'string' && node.props.role === role)
            .map(function text(node: { children: ReadonlyArray<unknown> }): string {
                return node.children.map((child) => typeof child === 'string' ? child : text(child as typeof node)).join('');
            });
        expect(announced('alert').join(' ')).toContain('agentInput.promptPicker.libraryError');
        expect(announced('status').join(' ')).toContain('agentInput.promptPicker.noMatchesFor');
        await screen.pressByTestIdAsync('prompt-picker-library-error:action');
        expect(retried).toBe(1);
    });

    it('drops keyboard hints without a hardware keyboard and closes from its own button', async () => {
        const { screen, outcomes } = await mount({ hardwareKeyboard: false });
        expect(screen.findByTestId('prompt-picker-history-status')).not.toBeNull();
        await screen.pressByTestIdAsync('prompt-picker-close');
        expect(outcomes.closed).toBe(true);
    });
});
