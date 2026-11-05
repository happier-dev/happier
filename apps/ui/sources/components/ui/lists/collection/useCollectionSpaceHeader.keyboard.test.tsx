import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { DEFAULT_WORKFLOW_LIST_FILTER_V1, workflowListFilterFieldsV1 } from '@happier-dev/protocol/workflows/listing/workflowListFilterV1';
import { DEFAULT_DISCUSSION_LIST_FILTER_V1, discussionListFilterFieldsV1 } from '@happier-dev/protocol/discussions/listing/discussionListFilterV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { KeyboardShortcutProvider, useKeyboardCommand } from '@/keyboard/KeyboardShortcutProvider';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useCollectionSpaceFilter, createCollectionSpaceDraftStore } from './useCollectionSpaceFilter';
import { useCollectionSpaceHeader } from './useCollectionSpaceHeader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/components/ui/popover', async original => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(original));
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); vi.unstubAllGlobals(); });

describe('focused collection header commands', () => {
    it('selects the focused entity in catalog order, opens its filter, and suspends digits when spaces are off', async () => {
        const browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        Object.defineProperty(browser.window.navigator, 'platform', { configurable: true, value: 'MacIntel' });
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ keyboardShortcutsV2Enabled: true }) });
        const workflow = { ...createDefaultCollectionSpaceV1('workflow'), id: 'workflow-second', name: 'Scheduled', filter: { view: 'triggered' as const } };
        const discussion = { ...createDefaultCollectionSpaceV1('discussion'), id: 'discussion-second', name: 'Unread', filter: { ...DEFAULT_DISCUSSION_LIST_FILTER_V1, unreadOnly: true } };
        account.replaceSettings(settingsParse({ ...account.persistedSettings, collectionSpacesV1: { v: 1, spaces: [workflow, discussion] } }));
        const workflowDraft = createCollectionSpaceDraftStore<'workflow'>();
        const discussionDraft = createCollectionSpaceDraftStore<'discussion'>();
        let command: ReturnType<typeof useKeyboardCommand>;
        let selected: readonly string[] = [];
        let secondSpaceShortcut: string | undefined;
        function Headers({ focus }: Readonly<{ focus: 'workflow' | 'discussion' }>) {
            command = useKeyboardCommand();
            secondSpaceShortcut = useKeyboardShortcutLabel('sessionList.space.select2');
            const lifetime = useActiveServerAccountScopeLifetime();
            const work = useCollectionSpaceFilter('workflow', { lifetime, defaultName: 'Workflows', defaultFilter: DEFAULT_WORKFLOW_LIST_FILTER_V1, draft: workflowDraft });
            const talk = useCollectionSpaceFilter('discussion', { lifetime, defaultName: 'Discussions', defaultFilter: DEFAULT_DISCUSSION_LIST_FILTER_V1, draft: discussionDraft });
            const workHeader = useCollectionSpaceHeader({ entityKind: 'workflow', testIDPrefix: 'work', defaultName: 'Workflows', view: { ...work, setFilters: filters => work.update({ filters }) }, registry: workflowListFilterFieldsV1, bindings: {}, defaultIcon: workflow.icon, keyboardEnabled: focus === 'workflow' });
            const talkHeader = useCollectionSpaceHeader({ entityKind: 'discussion', testIDPrefix: 'talk', defaultName: 'Discussions', view: { ...talk, setFilters: filters => talk.update({ filters }) }, registry: discussionListFilterFieldsV1, bindings: {}, defaultIcon: discussion.icon, keyboardEnabled: focus === 'discussion' });
            selected = [work.selectedSpaceId, talk.selectedSpaceId];
            return <>{workHeader.titleControl}{workHeader.overlays}{talkHeader.titleControl}{talkHeader.overlays}</>;
        }
        const element = (focus: 'workflow' | 'discussion') => <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}><KeyboardShortcutProvider handlers={{}}><Headers focus={focus} /></KeyboardShortcutProvider></HappierUiPlatformProvider>;
        try {
            const screen = await renderScreen(element('workflow'));
            await act(async () => { expect(command!('sessionList.space.select2')).toBe(true); });
            await vi.waitFor(() => expect(selected).toEqual(['workflow-second', 'all-discussions']));
            await act(async () => { expect(command!('sessionList.filter.open')).toBe(true); });
            expect(screen.findByTestId('work-editor')).not.toBeNull();
            expect(screen.findByTestId('talk-editor')).toBeNull();
            await act(async () => { account.replaceSettings(settingsParse({
                ...account.persistedSettings,
                keyboardShortcutOverridesV1: { 'sessionList.space.select2': [{ binding: 'Ctrl+Shift+2' }] },
            })); });
            const workMenu = screen.tree.findAllByType(DropdownMenu).find(node => node.props.items.some((item: { testID?: string }) => item.testID === 'work-menu-filter'));
            expect(secondSpaceShortcut).toBeDefined();
            expect(workMenu?.props.items.find((item: { testID?: string }) => item.testID === 'work-menu:workflow-second')?.shortcut).toBe(secondSpaceShortcut);
            await screen.update(element('discussion'));
            await act(async () => { expect(command!('sessionList.space.select2')).toBe(true); });
            await vi.waitFor(() => expect(selected).toEqual(['workflow-second', 'discussion-second']));
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, discussionSpacesEnabled: false })); });
            expect(command!('sessionList.space.select1')).toBe(false);
            await act(async () => { expect(command!('sessionList.filter.open')).toBe(true); });
            expect(screen.findByTestId('talk-editor')).not.toBeNull();
        } finally { standardCleanup(); await account.dispose(); browser.restore(); }
    });
});
