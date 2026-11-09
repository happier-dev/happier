import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';

const boundary = vi.hoisted(() => ({
    rpc: vi.fn(),
    bindings: new Map<string, unknown>(),
    projection: { inputs: null as unknown },
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});
// The Account's credential scope and the daemon registry read are the boundaries; the capabilities cache and counting stay real.
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeBindings: () => boundary.bindings,
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({ phase: boundary.projection.inputs ? 'ready' : 'idle', inputs: boundary.projection.inputs }),
}));

import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { useMachineToolsSummary } from './useMachineToolsSummary';

const request: CapabilitiesDetectRequest = { checklistId: CHECKLIST_IDS.MACHINE_DETAILS };
const account: ServerAccountScopeLifetime = { scope: { serverId: 'tools-home', accountId: 'acct-1' }, isCurrent: () => true,
    onRetire() { return { dispose() {} }; } };
const pluginProjection = { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, resourcesById: {},
    settingsById: {}, diagnostics: [], familiesById: {} } as unknown as PluginProjectionV2;

/** Every enabled tool the real registry lists, answered by the machine: `installedIds` installed, the rest absent. */
function inventory(installedIds: ReadonlySet<string>, downloadingIds: ReadonlySet<string> = new Set()) {
    const results: Record<string, unknown> = {};
    for (const entry of getInstallablesRegistryEntries({ pluginProjection })) {
        if (!entry.enabledWhen()) continue;
        const installed = installedIds.has(entry.capabilityId);
        results[entry.capabilityId] = { ok: true, checkedAt: 1, data: { installed, installedVersion: null, sourceKind: 'system',
            lastInstallLogPath: null, lastBackgroundUpdateCheckAtMs: null,
            ...(downloadingIds.has(entry.capabilityId) ? { runtimeState: 'downloading' } : {}) } };
    }
    return { protocolVersion: 1, results };
}

async function seed(machineId: string, response: unknown) {
    boundary.rpc.mockResolvedValueOnce(response);
    await prefetchMachineCapabilities({ machineId, serverId: 'tools-home', request, accountLifetime: account });
}

afterEach(() => { boundary.rpc.mockReset(); boundary.bindings.clear(); boundary.projection.inputs = null; });

describe('useMachineToolsSummary', () => {
    it('counts the tools the Tools page already read, without asking the machine', async () => {
        const ids = getInstallablesRegistryEntries({ pluginProjection }).filter(entry => entry.enabledWhen()).map(entry => entry.capabilityId);
        expect(ids.length).toBeGreaterThan(1);
        await seed('m-counted', inventory(new Set(ids), new Set([ids[0]!])));
        boundary.bindings.set('tools-home', account);
        boundary.projection.inputs = { pluginProjectionV2: pluginProjection };
        const calls = boundary.rpc.mock.calls.length;
        const hook = await renderHook(() => useMachineToolsSummary({ serverId: 'tools-home', machineId: 'm-counted' }));
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual({ status: 'ready', installed: ids.length, ready: ids.length - 1, held: false });
        expect(boundary.rpc.mock.calls.length).toBe(calls);
        await hook.unmount();
    });

    it('stays unknown, never zero, until both the registry and the Account\'s inventory were observed', async () => {
        await seed('m-unobserved', inventory(new Set()));
        boundary.bindings.set('tools-home', account);
        const withoutRegistry = await renderHook(() => useMachineToolsSummary({ serverId: 'tools-home', machineId: 'm-unobserved' }));
        await flushHookEffects();
        expect(withoutRegistry.getCurrent()).toEqual({ status: 'unknown' });
        await withoutRegistry.unmount();
        boundary.projection.inputs = { pluginProjectionV2: pluginProjection };
        const otherMachine = await renderHook(() => useMachineToolsSummary({ serverId: 'tools-home', machineId: 'm-never-read' }));
        await flushHookEffects();
        expect(otherMachine.getCurrent()).toEqual({ status: 'unknown' });
        await otherMachine.unmount();
        boundary.bindings.clear();
        const signedOut = await renderHook(() => useMachineToolsSummary({ serverId: 'tools-home', machineId: 'm-unobserved' }));
        await flushHookEffects();
        expect(signedOut.getCurrent()).toEqual({ status: 'unknown' });
        await signedOut.unmount();
    });
});
