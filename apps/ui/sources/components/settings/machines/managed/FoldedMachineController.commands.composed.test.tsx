import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ACTION_ID_FAMILIES_V1, CURRENT_UI_CONTEXT_COMMAND_INVOKE_ACTION_ID } from '@happier-dev/protocol/actions/actionIds';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { standardCleanup } from '@/dev/testkit';
import { createManagedControllerMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installSettingsViewCommonModuleMocks({ storage: 'real', modal: () => vi.importActual('@/modal') });
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

const { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } =
    await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
const { usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { PageHeader } = await import('@/components/ui/layout/PageHeader');
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { useManagedControllerScope } = await import('./useManagedControllerScope');
const { View } = await import('react-native');
const [readCurrentContext] = ACTION_ID_FAMILIES_V1.current_ui_context;

const homeId = 'srv_folded_controller';
const accountId = 'controller_owner';
const serverUrl = 'https://folded-machine-controller.test';
const initial = { machineId: 'controller-a', installationId: 'installation-a' };
const replacement = { machineId: 'controller-b', installationId: 'installation-b' };
let serverId: string;

beforeEach(async () => {
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(homes.request);
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Build', serverUrl, serverIdentityId: homeId, accountId, currentAccount: true });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer((await TokenStorage.getCredentialsForServerUrl(serverUrl))!);
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    homes.answer(serverId, 'POST /v1/machines/managed/actions/list', { body: { machines: [] } });
    await publishMachineInventoryForTest({ serverId: homeId, accountId }, [
        createManagedControllerMachineFixture({ id: initial.machineId, installationId: initial.installationId, active: true, activeAt: Date.now() }),
        createManagedControllerMachineFixture({ id: replacement.machineId, installationId: replacement.installationId, active: true, activeAt: Date.now() }),
    ]);
});

afterEach(async () => {
    standardCleanup();
    await homes.reset();
});

function Publication() {
    const commands = useCurrentUiContextComposedCommands();
    usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
    return null;
}

function ControllerDraft(props: Readonly<{ disabled?: boolean }>) {
    const [controller, setController] = React.useState(initial);
    const scope = useManagedControllerScope({ serverId, preferred: initial, onSelect: setController,
        testIDPrefix: 'managed-draft.controller', selectorDisabled: props.disabled, observeThisComputer: false });
    return <>
        <PageHeader title="New machine" actions={scope.chip} />
        <View testID={`draft-controller:${controller.machineId}:${controller.installationId}`} />
    </>;
}

it('opens the folded controller picker through the current UI Action and edits the same draft as the phone menu', async () => {
    const executor = createDefaultActionExecutor();
    const caller = { serverId, surface: 'agent' as const, authority: 'account_automation' as const };
    async function commands() {
        const read = await executor.execute(readCurrentContext, {}, caller);
        if (!read.ok) throw new Error(`Current UI read failed: ${read.errorCode}`);
        return (read.result as { commands: readonly { id: string; description?: string }[] }).commands;
    }
    async function invoke(commandId: string) {
        let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
        await act(async () => {
            result = await executor.execute(CURRENT_UI_CONTEXT_COMMAND_INVOKE_ACTION_ID, { commandId }, caller);
        });
        return result;
    }

    const navigation = { push: () => {}, replace: () => {}, back: () => {} };
    const authority = captureActiveServerAccountScopeLifetime();
    const render = (disabled = false) => (
        <CurrentUiContextCommandsProvider authority={authority}>
            <Publication />
            <DestinationInstanceHost tabId="new-machine" ref={{ kind: 'settings', params: {} }}
                pathname="/settings" focused visible phone navigation={navigation}>
                <ControllerDraft disabled={disabled} />
            </DestinationInstanceHost>
        </CurrentUiContextCommandsProvider>
    );
    const screen = await renderMountedCurrentUiContext(render(), { withModalProvider: true });
    const findOpen = async () => (await commands()).find(row => row.description === 'machine.administration.controller.open');
    const open = await findOpen();
    expect(open, 'the folded Machine row publishes its opener').toBeDefined();
    expect(screen.findHostByTestId('managed-draft.controller.picker-list')).toBeNull();
    expect(await invoke(open!.id)).toMatchObject({ ok: true });
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('managed-draft.controller.picker-option:controller-b')).not.toBeNull());
    const choose = (await commands()).find(row => row.description?.startsWith('machine.administration.controller.option:')
        && row.description.endsWith('controller-b'));
    expect(choose, 'the second Machine in the opened picker publishes its row command').toBeDefined();
    expect(await invoke(choose!.id)).toMatchObject({ ok: true });
    expect(screen.findHostByTestId('draft-controller:controller-b:installation-b')).not.toBeNull();
    expect(screen.findHostByTestId('managed-draft.controller.picker-list')).toBeNull();
    expect(await invoke(choose!.id)).toMatchObject({ ok: false });

    await screen.pressByTestIdAsync('page-header-actions.trigger');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('managed-draft.controller.folded')).not.toBeNull());
    await screen.pressByTestIdAsync('managed-draft.controller.folded');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('managed-draft.controller.picker-option:controller-a')).not.toBeNull());
    await screen.pressByTestIdAsync('managed-draft.controller.picker-option:controller-a');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('draft-controller:controller-a:installation-a')).not.toBeNull());

    const existing = await findOpen();
    expect(existing).toBeDefined();
    await screen.update(render(true));
    expect(await findOpen()).toBeUndefined();
    expect(await invoke(existing!.id)).toMatchObject({ ok: false });
    await screen.unmount();
});
