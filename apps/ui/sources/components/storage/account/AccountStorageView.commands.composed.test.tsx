import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({
  storage: 'real',
  modal: () => vi.importActual('@/modal'),
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { renderMountedCurrentUiContext } =
  await import('@/dev/testkit/harness/mountedCurrentUiContext');
const {
  CurrentUiContextCommandsProvider,
  useCurrentUiContextComposedCommands,
} =
  await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
const { usePublishCurrentUiContext } =
  await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { captureActiveServerAccountScopeLifetime } =
  await import('@/sync/domains/scope/activeServerAccountScope');
const { createDefaultActionExecutor } =
  await import('@/sync/ops/actions/defaultActionExecutor');
const { StorageSpecimen } =
  await import('@/components/dev/storage/StorageSpecimen');
const { t } = await import('@/text');
let serverId: string;

function Publication() {
  const commands = useCurrentUiContextComposedCommands();
  usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
  return null;
}

beforeEach(async () => {
  const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
  setRuntimeFetch(homes.request);
  await loadSyncSingletonForTests();
  const serverUrl = 'https://storage-view-commands.test';
  serverId = await homes.addHome({
    name: 'Storage commands',
    serverUrl,
    serverIdentityId: 'srv_storage_commands',
    accountId: 'storage_owner',
    currentAccount: true,
  });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const { restoreConnectionToActiveServer } =
    await import('@/sync/runtime/orchestration/connectionManager');
  await restoreConnectionToActiveServer(
    (await TokenStorage.getCredentialsForServerUrl(serverUrl))!,
  );
  const { publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
  const { getActiveServerSnapshot } =
    await import('@/sync/domains/server/serverRuntime');
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
});
afterEach(async () => {
  standardCleanup();
  await homes.reset();
});

/** An agent's way in: read the current UI's commands and invoke one by its title with an input. */
async function invoke(title: string, input: unknown) {
  const executor = createDefaultActionExecutor();
  const caller = {
    serverId,
    surface: 'agent' as const,
    authority: 'account_automation' as const,
  };
  const read = await executor.execute('ui.current_context.read', {}, caller);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error('Current UI read failed');
  const command = (
    read.result as { commands: readonly { id: string; title: string }[] }
  ).commands.find((row) => row.title === title);
  expect(command, title).toBeDefined();
  let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
  await act(async () => {
    result = await executor.execute(
      'ui.current_context.command.invoke',
      { commandId: command!.id, input },
      caller,
    );
  });
  expect(result).toMatchObject({ ok: true });
}

it("lets an agent drive the Storage view's own controls: List | Map and the kind filter", async () => {
  const screen = await renderMountedCurrentUiContext(
    <CurrentUiContextCommandsProvider
      authority={captureActiveServerAccountScopeLifetime()}
    >
      <Publication />
      <StorageSpecimen state="settings" />
    </CurrentUiContextCommandsProvider>,
    { withModalProvider: true },
  );
  expect(screen.findByTestId('storage:map')).toBeNull();
  await invoke(t('artifacts.browser.storageView.items.shapeLabel'), {
    value: 'map',
  });
  expect(screen.findByTestId('storage:map')).not.toBeNull();
  await invoke(t('artifacts.browser.storageView.items.filterLabel'), {
    value: 'artifacts',
  });
  // The filter is the same control a press sets: its chosen kind is now Artifacts.
  expect(screen.findAll(node => node.props.testIDPrefix === 'storage:filter').at(0)?.props.activeTabId).toBe('artifacts');
});
