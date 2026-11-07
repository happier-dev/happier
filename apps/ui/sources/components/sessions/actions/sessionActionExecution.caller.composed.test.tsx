import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import type { CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

installSettingsViewCommonModuleMocks({ storage: 'real', text: async () => vi.importActual<typeof import('@/text')>('@/text') });
// Substitute Metro's deferred loader only; the mounted engine and Action admission remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { storage } = await import('@/sync/domains/state/storage');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { useOptionalCurrentUiContextReader, usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands, useCurrentUiContextLocalCommands } = await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { executeSessionLifecycleAction } = await import('./sessionActionExecution');

afterEach(async () => { await standardCleanup(); vi.unstubAllGlobals(); await homes.reset(); });

it('preserves the command caller through the lifecycle helper and keeps touch Unarchive available', async () => {
    vi.stubGlobal('crypto', globalThis.crypto ?? webcrypto);
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(homes.request);
    await loadSyncSingletonForTests();
    const serverId = await homes.addHome({ name: 'Lifecycle Home', serverUrl: 'https://lifecycle-caller.test',
        serverIdentityId: 'srv_lifecycle_caller', accountId: 'lifecycle_owner', currentAccount: true });
    await homes.setActionPolicy(serverId, 'session.unarchive', 'agent', 'off');
    await homes.setActionPolicy(serverId, 'session.unarchive', 'ui', 'allowed');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer((await TokenStorage.getCredentialsForServerUrl('https://lifecycle-caller.test'))!);
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    const target = createSessionFixture({ id: 'lifecycle-target', serverId, archivedAt: 42 });
    const callerSession = createSessionFixture({ id: 'lifecycle-caller', serverId });
    for (const session of [target, callerSession]) homes.answer(serverId, `/v2/sessions/${session.id}`,
        { body: createPlainSessionByIdResponseFixture(session) });
    storage.getState().applySessions([target]);
    let writes = 0;
    homes.answer(serverId, `/v2/sessions/${target.id}/unarchive`, { select: () => {
        writes += 1; return { body: { success: true, archivedAt: null } };
    } });
    let outcome: Awaited<ReturnType<typeof executeSessionLifecycleAction>> | undefined;
    let reader: ReturnType<typeof useOptionalCurrentUiContextReader> = null;
    function LifecycleCommand() {
        reader = useOptionalCurrentUiContextReader();
        const { execute, executeForCaller, binding } = useMountedActionExecution(serverId);
        const engine = React.useMemo(() => ({ execute, executeForCaller, binding }), [execute, executeForCaller, binding]);
        const unarchive = React.useCallback(async (invocation: CurrentUiContextCommandInvocation) => {
            outcome = await executeSessionLifecycleAction('session.unarchive', target.id, {
                serverId, mountedCommand: { invocation, engine },
            });
            return outcome.success;
        }, [engine]);
        useCurrentUiContextLocalCommands(React.useMemo(() => [{ key: 'lifecycle-unarchive', title: 'Unarchive',
            invoke: async (_input: unknown, _context: unknown, invocation: CurrentUiContextCommandInvocation) => {
                await unarchive(invocation);
            },
        }], [unarchive]));
        const commands = useCurrentUiContextComposedCommands();
        usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
        return null;
    }
    const screen = await renderMountedCurrentUiContext(<CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
        <LifecycleCommand />
    </CurrentUiContextCommandsProvider>, { withModalProvider: true });
    try {
        await waitForHomeGovernance(() => expect(reader?.readCurrentUiContext()?.commands.some(command => command.title === 'Unarchive')).toBe(true));
        const command = reader!.readCurrentUiContext()!.commands.find(command => command.title === 'Unarchive')!;
        const executor = createDefaultActionExecutor();
        await act(async () => { await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, {
            serverId, surface: 'agent', authority: 'account_automation', defaultSessionId: callerSession.id,
            actionCaller: { kind: 'session', sessionId: callerSession.id, starterDepth: 0, turnDepth: 0 },
        }); });
        expect.soft(outcome).toMatchObject({ success: false, code: 'action_disabled' });
        expect.soft(writes).toBe(0);
        outcome = undefined;
        await act(async () => { await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { serverId, surface: 'ui' }); });
        expect(outcome).toMatchObject({ success: true });
        expect(writes).toBe(1);
    } finally { await screen.unmount(); }
});
