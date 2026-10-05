import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptLibraryListItem } from '@happier-dev/protocol';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import type { UserMessageHistoryEntriesSnapshot } from '@/hooks/session/useUserMessageHistoryEntries';

// Real save owner and Account writer (prompt_doc.create through the artifact boundary); only portal
// and window measurement are replaced, so the real menu and selection list stay mounted.
// Native platform: the keyboard provider's web window listeners have no DOM under this runner.
installSettingsViewCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { OS: 'ios', select: (value: Record<string, unknown>) => value.ios ?? value.native ?? value.default },
    }),
});
vi.doUnmock('@/sync/domains/state/storage');
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { PromptPickerView } = await import('../AgentInputPromptPicker');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');

beforeEach(async () => { await harness.reset(); });
afterEach(async () => {
    standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
});

const NOW = 1_800_000_000_000;
const SENT = { serverId: 'home', sessionId: 's1', messageId: 'm1', seq: 4, createdAtMs: NOW - 12 * 60_000,
    text: 'Check the e2e suite still passes\nand tell me what broke.' };
const HISTORY_ROW = `history:${JSON.stringify([SENT.serverId, SENT.sessionId, SENT.messageId])}`;

function history(): UserMessageHistoryEntriesSnapshot {
    return { entries: [SENT], coverage: 'complete', hasMore: false, isLoading: false, error: false,
        progress: { pagesLoaded: 1, sessionsSearched: 1, totalSessions: 1 },
        loadMore: async () => {}, retry: async () => {}, stop: () => {} };
}

/** The picker's open data leaf, reduced to the library snapshot it publishes (adopt included). */
function Picker(props: Readonly<{ serverId: string; onApply: () => Promise<boolean> }>) {
    const [documents, setDocuments] = React.useState<readonly PromptLibraryListItem[]>([]);
    return <KeyboardShortcutProvider handlers={{}}><PromptPickerView
        anchor={{ kind: 'view', ref: { current: null } }} serverId={props.serverId} sessionId="s1" canSend
        onRequestClose={() => {}} onApply={props.onApply}
        library={{ documents, invocations: [], coverage: 'complete', isLoading: false, error: false,
            read: async () => SENT.text, setFavorite: async () => {}, retry: () => {},
            adopt: (item) => setDocuments((previous) => [item, ...previous]) }}
        history={history()} folderNames={new Map()} sessionNames={new Map([['s1', 'Fix settings modal remount']])}
        nowMs={NOW} hardwareKeyboard /></KeyboardShortcutProvider>;
}

async function mount() {
    const serverId = await harness.addHome({ name: 'Prompt Home', serverUrl: 'https://prompt-picker-save.test', accountId: 'prompt-owner' });
    await harness.selectHomes([serverId]);
    const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await switchConnectionToActiveServer();
    const scope = { serverId, accountId: 'prompt-owner' };
    act(() => storage.setState({ settingsScope: scope, profileScope: scope, settingsVersion: 1,
        settings: { ...storage.getState().settings, promptInvocationsV1: { v: 1, entries: [] } } }));
    const onApply = vi.fn(async () => true);
    const screen = await renderScreen(<Picker serverId={serverId} onApply={onApply} />);
    return { screen, serverId, onApply };
}

describe('prompt picker: save what you sent in place (lab R1s)', () => {
    it('stars a Sent before row into a named favourite prompt where it stands, through the one save owner', async () => {
        const { screen, serverId, onApply } = await mount();
        expect(screen.findByTestId(`prompt-picker-row:${HISTORY_ROW}`)).not.toBeNull();

        await screen.pressByTestIdAsync(`prompt-picker-favorite:${HISTORY_ROW}`);
        // The row turned into its name field; opening the form writes nothing.
        expect(screen.findByTestId(`prompt-picker-row:${HISTORY_ROW}`)).toBeNull();
        expect(screen.findByTestId(`prompt-picker-save:${HISTORY_ROW}`)).not.toBeNull();
        expect(screen.findByTestId('prompt-picker-save-name')?.props.value).toBe('Check the e2e suite still passes');
        expect(harness.artifacts(serverId).list()).toHaveLength(0);

        await act(async () => { await screen.findByTestId('prompt-picker-save-name')!.props.onSubmitEditing(); });

        expect(harness.artifacts(serverId).list()).toHaveLength(1);
        const [artifactId] = Object.keys(storage.getState().artifacts);
        const artifact = storage.getState().artifacts[artifactId!]!;
        expect(artifact.header).toMatchObject({ kind: 'prompt_doc.v2', title: 'Check the e2e suite still passes', favorite: true });
        if (typeof artifact.body !== 'string') throw new Error('Expected the saved prompt body to be text');
        expect(JSON.parse(artifact.body).markdown).toBe(SENT.text);
        // It is a favourite prompt now, and no longer repeats under Sent before; nothing was inserted.
        expect(screen.findByTestId(`prompt-picker-row:doc:${artifactId}`)).not.toBeNull();
        expect(screen.findByTestId(`prompt-picker-save:${HISTORY_ROW}`)).toBeNull();
        expect(screen.findByTestId(`prompt-picker-row:${HISTORY_ROW}`)).toBeNull();
        expect(onApply).not.toHaveBeenCalled();
    });

    it('puts the row back without writing when the save is cancelled', async () => {
        const { screen, serverId } = await mount();
        await screen.pressByTestIdAsync(`prompt-picker-favorite:${HISTORY_ROW}`);
        await screen.pressByTestIdAsync('prompt-picker-save-cancel');
        expect(screen.findByTestId(`prompt-picker-save:${HISTORY_ROW}`)).toBeNull();
        expect(screen.findByTestId(`prompt-picker-row:${HISTORY_ROW}`)).not.toBeNull();
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });
});
