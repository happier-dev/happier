import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { BrowserDiagnosticsEvalResultV1Schema } from '@happier-dev/protocol/browser/diagnostics/v1';
import { renderHook, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real', text: async () => vi.importActual<typeof import('@/text')>('@/text') });
// Substitute Metro's deferred loader only; the default executor, policy and approval owner stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { useBrowserDiagnosticsRuntime } = await import('./useBrowserDiagnosticsRuntime');
const { createBrowserControlState, dispatchBrowserControlCommand } = await import('@/sync/domains/browser/control');
const { registerBrowserRuntimeControlAdapter, clearBrowserRuntimeControlRegistryForTests } = await import('@/sync/domains/browser/actions/runtimeControlRegistry');

afterEach(async () => {
    await standardCleanup();
    clearBrowserRuntimeControlRegistryForTests();
    const { publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    publishAppliedActiveServerRuntimeAvailability(false);
    vi.unstubAllGlobals();
    await homes.reset();
});

it('resumes the exact mounted console after an Inbox approval through default UI composition', async () => {
    vi.stubGlobal('crypto', globalThis.crypto ?? webcrypto);
    await loadSyncSingletonForTests();
    const serverId = await homes.addHome({ name: 'Diagnostics Home', serverUrl: 'https://diagnostics-home.test',
        serverIdentityId: 'srv_diagnostics', accountId: 'diagnostics_owner', currentAccount: true });
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'diagnostics_owner' };
    const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        actions: { 'browser.diagnostics.eval': { approvalRequiredSurfaces: ['ui'] } } }) };
    storage.setState({ profileScope: scope, settingsScope: scope, settings, settingsVersion: 1 });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    const state = dispatchBrowserControlCommand(createBrowserControlState(), {
        kind: 'openView', commandId: 'open_diagnostics', browserSessionId: 'browser_session_1', viewId: 'view_1',
        target: { kind: 'externalUrl', targetId: 'mounted_page', url: 'https://mounted-page.test' },
        platform: 'ios', currentUrl: 'https://mounted-page.test', focus: true,
    }).state;
    const view = state.viewsById.view_1;
    if (!view) throw new Error('Canonical Browser control owner did not create the fixture view');
    const hook = await renderHook(() => {
        const actions = useMountedActionExecution(scope, { retainInvocation: true });
        const diagnostics = useBrowserDiagnosticsRuntime({ view, enabled: true, actionExecute: actions.execute });
        React.useEffect(() => registerBrowserRuntimeControlAdapter({ browserSessionId: view.browserSessionId,
            control: { readState: () => state, applyDispatchResult: () => {} }, diagnostics: diagnostics?.runtimeAdapter,
        }), [diagnostics?.runtimeAdapter]);
        return { actions, diagnostics };
    });
    await waitForHomeGovernance(() => expect(hook.getCurrent().actions.ready).toBe(true));
    await act(async () => hook.getCurrent().diagnostics?.interaction?.onEnableInteraction?.());
    await act(async () => { hook.getCurrent().diagnostics?.requestEval({ expression: 'document.title' }); });
    await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect(homes.artifacts(serverId).list()).toHaveLength(1);
    });
    expect(hook.getCurrent().diagnostics?.bridge?.evalRequest).toBeUndefined();
    const artifactId = homes.artifacts(serverId).list()[0]!.id;
    const deciding = decideApprovalAsInbox(serverId, artifactId, 'approve');
    await waitForHomeGovernance(() => expect(hook.getCurrent().diagnostics?.bridge?.evalRequest).toMatchObject({ expression: 'document.title' }));
    const request = hook.getCurrent().diagnostics!.bridge!.evalRequest!;
    await act(async () => hook.getCurrent().diagnostics?.bridge?.onEvalResult?.(BrowserDiagnosticsEvalResultV1Schema.parse({
        v: 1, evalRequestId: request.evalRequestId, viewId: view.viewId, navigationGeneration: view.navigationGeneration,
        tier: 'injectedPage', audited: true, status: 'completed', result: { type: 'string', value: 'exact mounted page' },
    })));
    expect(await deciding).toMatchObject({ ok: true });
    await waitForHomeGovernance(() => {
        expect(hook.getCurrent().diagnostics?.interaction?.evalConsole?.entries).toMatchObject([
            { status: 'completed', result: { value: 'exact mounted page' } },
        ]);
        expect(homes.artifacts(serverId).readPlainBody(artifactId)).toContain('"status":"executed"');
    });
    await hook.unmount();
});
