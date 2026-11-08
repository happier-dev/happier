import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { DaemonPluginUiTargetedSurfaceMountV1Schema, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginUiTargetedContributionsV1Schema } from '@happier-dev/protocol/plugins/ui';

import { createDeferred, createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createPluginUiProjectionUnionPublication } from '@/sync/domains/plugins/ui/projectionUnion';
import { createPluginDeclarativeModelFixture } from '@/dev/testkit/fixtures/pluginDeclarativeModelFixture';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { storage } from '@/sync/domains/state/storage';
import { publishDaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

const targetedReadMock = vi.hoisted(() => vi.fn());
const describeMock = vi.hoisted(() => vi.fn());
const activeAccountLifetime = vi.hoisted(() => ({
    value: null as null | Readonly<{
        scope: Readonly<{ serverId: string; accountId: string }>;
        isCurrent(): boolean;
        onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
    }>,
}));

// The machine RPC transport is this owner's boundary; the revision registry is
// the real one so an invalidation behaves exactly as in the app.
vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>()),
    machinePluginUiTargetedContributionsRead: targetedReadMock,
    machineContributionRegistryProjectionDescribe: describeMock,
}));

// No scoped RPC can escape this target-read transport fixture. Retain the
// operation module's real neighbouring exports without loading a live channel.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: vi.fn(),
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let focusedHomeId = '';

const sourceCustody = { kind: 'development', registeredRootId: 'triage-root' } as const;

function snapshot(occurrenceId: string) {
    return {
        target: { pluginId: 'acme.triage', occurrenceId, sourceCustody },
        points: [],
    };
}

function mount(occurrenceId: string) {
    return DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
        kind: 'targetedSurface',
        target: { pluginId: 'acme.triage', occurrenceId, sourceCustody },
        point: { pointId: 'review-detail', protocol: { id: 'review/detail', version: 1 } },
        contributor: { pluginId: 'acme.triage', contributionId: 'detail', occurrenceId, sourceCustody },
        role: 'detail',
        presentation: 'content',
        inputSchema: defineProtocolObject({}, { policy: 'closed' }).jsonSchema,
        rendererChain: [{ pluginId: 'acme.triage', localId: 'detail' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.triage', localId: 'detail' },
            renderer: { kind: 'declarative', contributionId: 'detail', model: createPluginDeclarativeModelFixture({
                pluginId: 'acme.triage', localId: 'detail', occurrenceId,
                document: { version: 1, root: { kind: 'state', state: 'empty', title: 'No detail selected' } },
            }) },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: { serverIdentityId: 'srv_mounted', materializationRef: {
            materializationId: 'triage-materialization', machineId: 'machine-1', pluginId: 'acme.triage',
        } },
        resourceCapability: { readable: true, dynamic: false },
        contributorTargetedContributions: snapshot(occurrenceId),
    });
}

// Load the mounted source graph outside an individual hook-case deadline.
const mountedTargetOwner = await import('./mountedTargetedContributions');

/** Mirrors the Host join: one routed binding supplies both target and controller custody. */
function useMountedTargetedContributions(params: Omit<Parameters<typeof mountedTargetOwner.useMountedTargetedContributions>[0], 'accountLifetime'>) {
    const bindings = useServerCredentialAccountScopeBindings(params.serverId ? [params.serverId] : []);
    const accountLifetime = params.serverId
        ? bindings.values().next().value ?? null
        : captureActiveServerAccountScopeLifetime();
    const input = { ...params, accountLifetime };
    return mountedTargetOwner.useMountedTargetedContributions(input);
}

describe('useMountedTargetedContributions', () => {
    beforeEach(async () => {
        targetedReadMock.mockReset();
        describeMock.mockReset();
        describeMock.mockResolvedValue({ supported: true, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1 }) });
        await homes.reset();
        focusedHomeId = await homes.addHome({ name: 'Focused Home', serverUrl: 'https://mounted-home-a.test',
            serverIdentityId: 'server-1', accountId: 'account-a' });
        storage.setState({ profileScope: { serverId: focusedHomeId, accountId: 'account-a' } });
        publishAppliedActiveServerSnapshot({ serverId: focusedHomeId, serverUrl: 'https://mounted-home-a.test', generation: 1 });
        activeAccountLifetime.value = captureActiveServerAccountScopeLifetime();
        if (!activeAccountLifetime.value) throw new Error('Expected the focused Account lifetime');
    });

    afterEach(async () => {
        standardCleanup();
        publishAppliedActiveServerRuntimeAvailability(false);
        storage.setState(storage.getInitialState(), true);
        await homes.reset();
    });

    it('does not describe or reread a presented Home target for unrelated Session stream arrivals', async () => {
        const session = createSessionFixture({ id: 'home-target-stream', serverId: focusedHomeId, owner: 'account-a' });
        storage.getState().applySessions([session]);
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: snapshot('occurrence-a'), targetedSurfaceMounts: [] });
        let renders = 0;
        const rendered = await renderHook(() => {
            React.useSyncExternalStore(storage.subscribe, () => storage.getState().sessionMessages[session.id]);
            renders++;
            return useMountedTargetedContributions({ machineId: 'machine-home-stream', serverId: focusedHomeId,
                pluginId: 'acme.triage', mountedOccurrenceId: 'occurrence-a', enabled: true });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().phase).toBe('ready');
        const initial = rendered.getCurrent();
        const initialReads = targetedReadMock.mock.calls.length;
        const initialDescribes = describeMock.mock.calls.length;
        expect(initialReads).toBe(1);
        expect(initialDescribes).toBe(1);
        const initialRenders = renders;
        for (let chunk = 0; chunk < 5; chunk++) {
            await act(async () => {
                storage.getState().applyMessages(session.id, [{ id: `home-stream-${chunk}`, localId: `home-stream-${chunk}`,
                    createdAt: chunk + 1, isSidechain: false, role: 'agent', content: [{ type: 'text',
                        text: `Home streaming chunk ${chunk}`, uuid: `home-stream-${chunk}`, parentUUID: null }] }]);
            });
        }
        expect(renders).toBeGreaterThan(initialRenders);
        expect(targetedReadMock.mock.calls.length - initialReads).toBe(0);
        expect(describeMock.mock.calls.length - initialDescribes).toBe(0);
        expect(rendered.getCurrent()).toBe(initial);

        // The quiet-path assertion must not suppress an actual registry change.
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-home-stream', serverId: focusedHomeId }, 'refresh'); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(targetedReadMock.mock.calls.length - initialReads).toBe(1);
        expect(describeMock.mock.calls.length - initialDescribes).toBe(1);
        expect(rendered.getCurrent().phase).toBe('ready');
        await rendered.unmount();
    });

    it('uses the routed Home lifetime while another Home is focused and withdraws it on that Home retirement', async () => {
        const focusedLifetime = activeAccountLifetime.value!;
        const homeB = await homes.addHome({ name: 'Routed Home', serverUrl: 'https://mounted-home-b.test',
            serverIdentityId: 'server-b', accountId: 'account-b', active: false });
        const binding = await renderHook(() => useServerCredentialAccountScopeBindings([homeB]));
        await vi.waitFor(() => expect(binding.getCurrent().get(homeB)?.accountId).toBe('account-b'));
        const lifetimeB = binding.getCurrent().get(homeB)!;
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 73 });
        describeMock.mockResolvedValue({ supported: true, projection });
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: snapshot('occurrence-a'), targetedSurfaceMounts: [mount('occurrence-a')] });
        const rendered = await renderHook(() => useMountedTargetedContributions({ machineId: 'machine-routed', serverId: homeB,
            pluginId: 'acme.triage', mountedOccurrenceId: 'occurrence-a', enabled: true }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        const request = targetedReadMock.mock.lastCall?.[1];
        expect(request?.accountLifetime.scope).toEqual({ serverId: homeB, accountId: 'account-b' });
        expect(rendered.getCurrent().phase).toBe('ready');
        expect(rendered.getCurrent().projectionInputs?.pluginProjectionV2).toBe(projection);
        expect(describeMock.mock.lastCall?.[1]).toMatchObject({ selection: 'mountedActions',
            accountLifetime: { scope: { serverId: homeB, accountId: 'account-b' } },
            callers: [snapshot('occurrence-a').target], actions: [] });
        expect(focusedLifetime.isCurrent()).toBe(true);
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
        await rendered.rerender();
        expect(focusedLifetime.isCurrent()).toBe(false);
        expect(request?.accountLifetime.isCurrent()).toBe(true);
        expect(rendered.getCurrent().projectionInputs?.pluginProjectionV2).toBe(projection);

        let settleLateRead: ((result: Readonly<{ supported: true; targetedContributions: ReturnType<typeof snapshot>; targetedSurfaceMounts: ReturnType<typeof mount>[] }>) => void) | undefined;
        const lateRead = new Promise<Readonly<{ supported: true; targetedContributions: ReturnType<typeof snapshot>; targetedSurfaceMounts: ReturnType<typeof mount>[] }>>(resolve => { settleLateRead = resolve; });
        targetedReadMock.mockReturnValueOnce(lateRead).mockReturnValue(new Promise(() => {}));
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-routed', serverId: homeB }, 'authority'); });
        const pendingRequest = targetedReadMock.mock.lastCall?.[1];
        expect(rendered.getCurrent().targetedContributions).toEqual(snapshot('occurrence-a'));
        await act(async () => { await homes.switchAccount(homeB, 'account-b-next'); });
        expect(lifetimeB.isCurrent()).toBe(false);
        expect(request?.accountLifetime.isCurrent()).toBe(false);
        expect(pendingRequest?.signal.aborted).toBe(true);
        await act(async () => { settleLateRead?.({ supported: true, targetedContributions: snapshot('late-private-occurrence'), targetedSurfaceMounts: [] }); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().targetedContributions).toBeNull();
        expect(rendered.getCurrent().projectionInputs).toBeNull();
        expect(rendered.getCurrent().pluginUiProjection).toBeNull();
    });

    it('re-opens a target from its last answer, always revalidates, and leaves reachability to the currentness owner', async () => {
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: snapshot('occurrence-a'),
            targetedSurfaceMounts: [mount('occurrence-a')] });
        const input = { machineId: 'machine-reopen', serverId: focusedHomeId, pluginId: 'acme.triage',
            mountedOccurrenceId: 'occurrence-a', enabled: true };
        const { createMachineFixture } = await import('@/dev/testkit');
        const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
        const machine = createMachineFixture({ id: input.machineId, active: true, activeAt: Date.now() });
        storage.setState({ endpointStatus: 'online', machineListByServerId: { [focusedHomeId]: [machine] }, machineListStatusByServerId: { [focusedHomeId]: 'idle' } });
        observeMachinePresenceForTest({ serverId: focusedHomeId, accountId: 'account-a' }, [machine.id]);
        // The Host supplies its already bound lifetime; the hook's own phases are what a re-open draws.
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        // The AppShell's own Machine projection answer, which the target answer is read beside.
        const { loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: input.machineId, serverId: focusedHomeId, accountLifetime });
        const open = async () => {
            const firstRows: unknown[] = [];
            const rendered = await renderHook(() => {
                const state = mountedTargetOwner.useMountedTargetedContributions({ ...input, accountLifetime });
                firstRows.push(state.targetedContributions);
                return state;
            });
            await flushHookEffects({ cycles: 2, turns: 2 });
            const result = { lastGoodAtFirstRender: firstRows[0] !== null && firstRows[0] !== undefined,
                phase: rendered.getCurrent().phase };
            await rendered.unmount();
            return result;
        };
        const reads = () => targetedReadMock.mock.calls.length;
        const first = await open();
        const afterFirst = reads();

        // Equal inputs: the re-open draws the kept answer at once and revalidates it.
        const equal = { ...(await open()), reads: reads() - afterFirst };

        // Request reachability failed while closed. Reachability is the currentness owner's decision,
        // not this custody's: the re-open still draws last-good and asks again.
        const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
        recordMachineRequestFailed({ serverId: focusedHomeId, accountId: 'account-a', machineId: machine.id });
        const beforeUnreachable = reads();
        const unreachable = { ...(await open()), reads: reads() - beforeUnreachable };

        // A Home transport gap while closed: the same, last-good plus one revalidation.
        storage.setState({ endpointStatus: 'connecting' });
        storage.setState({ endpointStatus: 'online' });
        const beforeTransport = reads();
        const transport = { ...(await open()), reads: reads() - beforeTransport };

        expect({ first, equal, unreachable, transport }).toEqual({
            first: { lastGoodAtFirstRender: false, phase: 'ready' },
            equal: { lastGoodAtFirstRender: true, phase: 'ready', reads: 1 },
            unreachable: { lastGoodAtFirstRender: true, phase: 'ready', reads: 1 },
            transport: { lastGoodAtFirstRender: true, phase: 'ready', reads: 1 },
        });

        // Another Account lifetime of the same Home never inherits the answer.
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        retireActiveServerAccountScopeLifetime();
        const otherHome = await homes.addHome({ name: 'Other Home', serverUrl: 'https://mounted-home-b.test',
            serverIdentityId: 'server-2', accountId: 'account-b' });
        const otherAccount = { ...input, serverId: otherHome };
        const otherRows: unknown[] = [];
        const beforeOther = reads();
        const rendered = await renderHook(() => {
            const state = useMountedTargetedContributions(otherAccount);
            otherRows.push(state.targetedContributions);
            return state;
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect({ inherited: otherRows[0] != null, reads: reads() - beforeOther }).toEqual({ inherited: false, reads: 1 });
        await rendered.unmount();
    });

    it('keeps last-good ready through a same-authority refresh, re-opens from it while revalidating, and withdraws on authority', async () => {
        targetedReadMock.mockImplementation(async () => ({ supported: true, targetedContributions: snapshot('occurrence-a'),
            targetedSurfaceMounts: [mount('occurrence-a')] }));
        const input = { machineId: 'machine-refresh', serverId: focusedHomeId, pluginId: 'acme.triage',
            mountedOccurrenceId: 'occurrence-a', enabled: true };
        const scope = { machineId: input.machineId, serverId: focusedHomeId };
        const { createMachineFixture } = await import('@/dev/testkit');
        const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
        const machine = createMachineFixture({ id: input.machineId, active: true, activeAt: Date.now() });
        storage.setState({ endpointStatus: 'online', machineListByServerId: { [focusedHomeId]: [machine] }, machineListStatusByServerId: { [focusedHomeId]: 'idle' } });
        observeMachinePresenceForTest({ serverId: focusedHomeId, accountId: 'account-a' }, [machine.id]);
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        const { loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: input.machineId, serverId: focusedHomeId, accountLifetime });
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
        const open = async () => {
            const phases: string[] = [];
            const rendered = await renderHook(() => {
                const state = mountedTargetOwner.useMountedTargetedContributions({ ...input, accountLifetime });
                phases.push(state.phase);
                return state;
            });
            await flushHookEffects({ cycles: 2, turns: 2 });
            return { rendered, phases };
        };
        const first = await open();
        expect(first.rendered.getCurrent().phase).toBe('ready');
        const answered = first.rendered.getCurrent();

        // A same-authority refresh re-reads in the background: readiness is never withdrawn,
        // and an equal answer republishes nothing.
        first.phases.length = 0;
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation(scope, 'refresh'); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        const refreshed = { reads: targetedReadMock.mock.calls.length, phases: [...new Set(first.phases)],
            sameState: first.rendered.getCurrent() === answered };

        // An authority change still withdraws readiness before the re-read answers (fail closed).
        first.phases.length = 0;
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation(scope, 'authority'); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        const authority = { reads: targetedReadMock.mock.calls.length, sawLoading: first.phases.includes('loading'),
            phase: first.rendered.getCurrent().phase };
        await first.rendered.unmount();

        // A refresh while closed: the re-open draws the last answer at once and revalidates it.
        publishMachineContributionRegistryProjectionInvalidation(scope, 'refresh');
        const reopened = await open();
        const reopen = { reads: targetedReadMock.mock.calls.length, phases: [...new Set(reopened.phases)] };
        await reopened.rendered.unmount();

        // An authority change while closed: the re-open reads before it is ready.
        publishMachineContributionRegistryProjectionInvalidation(scope, 'authority');
        const afterAuthority = await open();
        const authorityReopen = { reads: targetedReadMock.mock.calls.length, sawLoading: afterAuthority.phases.includes('loading') };
        await afterAuthority.rendered.unmount();

        expect({ refreshed, authority, reopen, authorityReopen }).toEqual({
            refreshed: { reads: 2, phases: ['ready'], sameState: true },
            authority: { reads: 3, sawLoading: true, phase: 'ready' },
            reopen: { reads: 4, phases: ['ready'] },
            authorityReopen: { reads: 5, sawLoading: true },
        });
    });

    it('reads only the target slice and prepares its mounts', async () => {
        const resourcesById = PluginProjectionV2Schema.parse({ v: 2, generation: 1, resourcesById: {
            'acme.triage/state': { id: 'state', pluginId: 'acme.triage', resourceKind: 'config', scope: 'session' },
        } }).resourcesById;
        const resourceDeclarationsByPluginId = { 'acme.triage': resourcesById, 'acme.external': {} };
        targetedReadMock.mockResolvedValue({
            supported: true,
            targetedContributions: snapshot('occurrence-a'),
            targetedSurfaceMounts: [mount('occurrence-a')],
            resourceDeclarationsByPluginId,
        });
        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: 'machine-1',
            serverId: focusedHomeId,
            pluginId: 'acme.triage',
            mountedOccurrenceId: 'occurrence-a',
            enabled: true,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'ready',
            targetedContributions: snapshot('occurrence-a'),
            resourceDeclarationsByPluginId,
            failure: null,
        });
        expect(rendered.getCurrent().preparedTargetedSurfaceMounts?.[0]?.inputValidation).toBeDefined();
        expect(rendered.getCurrent().preparedTargetedSurfaceMounts?.[0]?.resourceDeclarations).toEqual(resourcesById);
        expect(targetedReadMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({ serverId: focusedHomeId, pluginId: 'acme.triage' }));
        expect(describeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            selection: 'mountedActions', callers: [snapshot('occurrence-a').target], actions: [],
        }));
        expect(describeMock.mock.calls.filter(([, request]) => request.selection !== 'mountedActions')).toHaveLength(0);
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: snapshot('occurrence-a'),
            targetedSurfaceMounts: [], resourceDeclarationsByPluginId: { 'acme.triage': {} } });
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: focusedHomeId }, 'authority'); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent()).toMatchObject({ resourceDeclarationsByPluginId: { 'acme.triage': {} } });
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: snapshot('occurrence-a'), targetedSurfaceMounts: [] });
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: focusedHomeId }, 'authority'); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent()).toMatchObject({ resourceDeclarationsByPluginId: null });
    });

    it('publishes selected ready facts with the target and refreshes them on projection invalidation', async () => {
        const actionKey = 'acme.triage/inspect';
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 41, actionsById: { [actionKey]: {
            id: 'inspect', pluginId: 'acme.triage', occurrenceId: 'occurrence-a', title: 'Inspect', scopes: ['global'],
            surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' }, available: true,
        } } });
        const declarations = publishDaemonMergedProjectionInputs({ projection }).pluginUiProjection;
        describeMock.mockResolvedValue({ supported: true, projection });
        const input = { machineId: 'machine-published', serverId: focusedHomeId };
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: snapshot('occurrence-a'), targetedSurfaceMounts: [mount('occurrence-a')] });
        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: input.machineId, serverId: input.serverId, pluginId: 'acme.triage', mountedOccurrenceId: 'occurrence-a', enabled: true,
            pluginUiProjection: declarations,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().projectionInputs?.pluginProjectionV2).toBe(projection);
        expect(rendered.getCurrent().pluginUiProjection?.actionsById[actionKey]?.available).toBe(true);
        const next = PluginProjectionV2Schema.parse({ ...projection, generation: 42,
            actionsById: { [actionKey]: { ...projection.actionsById[actionKey], available: false } } });
        describeMock.mockResolvedValue({ supported: true, projection: next });
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation(input, 'authority'); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().projectionInputs?.pluginProjectionV2).toBe(next);
        expect(rendered.getCurrent().pluginUiProjection?.actionsById[actionKey]?.available).toBe(false);
        expect(rendered.getCurrent().preparedTargetedSurfaceMounts?.[0]?.inputValidation).toBeDefined();
        expect(targetedReadMock).toHaveBeenCalledTimes(2);
        expect(describeMock.mock.calls.map(([, request]) => request.selection)).toEqual(['mountedActions', 'mountedActions']);
    });

    it('keeps the admitted mounted Actions through an equal reload and republishes once for a real change', async () => {
        const { MountedClientActionDemandContext } = await import('@/components/appShell/plugins/mountedClientActionDemand');
        const actionKey = 'acme.triage/inspect';
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 41, actionsById: { [actionKey]: {
            id: 'inspect', pluginId: 'acme.triage', occurrenceId: 'occurrence-a', title: 'Inspect', scopes: ['global'],
            surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' }, available: true,
        } } });
        const declarations = publishDaemonMergedProjectionInputs({ projection }).pluginUiProjection;
        describeMock.mockResolvedValue({ supported: true, projection });
        const input = { machineId: 'machine-held-actions', serverId: focusedHomeId };
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: snapshot('occurrence-a'), targetedSurfaceMounts: [mount('occurrence-a')] });
        const published: unknown[] = [];
        const publish = (_owner: symbol, _lifetime: unknown, source: unknown) => { published.push(source); };
        const wrapper = ({ children }: React.PropsWithChildren) => <MountedClientActionDemandContext.Provider value={publish}>{children}</MountedClientActionDemandContext.Provider>;
        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: input.machineId, serverId: input.serverId, pluginId: 'acme.triage', mountedOccurrenceId: 'occurrence-a', enabled: true,
            pluginUiProjection: declarations,
        }), { wrapper });
        await vi.waitFor(() => expect(rendered.getCurrent().phase).toBe('ready'));
        await flushHookEffects({ cycles: 2, turns: 2 });
        const admitted = published.at(-1);
        expect(admitted).toBeTruthy();
        const changesSince = (from: number) => {
            const later = published.slice(from);
            return { withdrawals: later.filter(source => source === null).length,
                republished: new Set(later.filter(source => source !== null && source !== admitted)).size };
        };
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
        // The Machine answers again with the same facts under a new generation stamp.
        describeMock.mockResolvedValue({ supported: true, projection: PluginProjectionV2Schema.parse({ ...projection, generation: 42 }) });
        const equalFrom = published.length;
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation(input, 'authority'); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        await vi.waitFor(() => expect(targetedReadMock).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(rendered.getCurrent().phase).toBe('ready'));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(changesSince(equalFrom)).toEqual({ withdrawals: 0, republished: 0 });
        // A real change still replaces the admitted source, exactly once and without a withdrawal gap.
        describeMock.mockResolvedValue({ supported: true, projection: PluginProjectionV2Schema.parse({ ...projection, generation: 43,
            actionsById: { [actionKey]: { ...projection.actionsById[actionKey], available: false } } }) });
        const changedFrom = published.length;
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation(input, 'authority'); });
        await vi.waitFor(() => expect(targetedReadMock).toHaveBeenCalledTimes(3));
        await vi.waitFor(() => expect(rendered.getCurrent().pluginUiProjection?.actionsById[actionKey]?.available).toBe(false));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(changesSince(changedFrom)).toEqual({ withdrawals: 0, republished: 1 });
    });

    it('keeps cold mounted caller Actions from the exact response without ambient hydration or unrelated rereads', async () => {
        // The Machine Describe RPC is the boundary. The CLI producer's strict
        // output and executable dispatch are covered by their composed suites.
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 73, actionsById: {
            'acme.triage/inspect': { id: 'inspect', pluginId: 'acme.triage', occurrenceId: 'occurrence-a',
                title: 'Inspect', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                execution: { target: 'daemon' }, available: true },
            'acme.triage/select-view': { id: 'select-view', pluginId: 'acme.triage', occurrenceId: 'occurrence-a',
                title: 'Select view', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                execution: { target: 'client', platforms: ['web'], client: { artifactId: 'view', exportName: 'activate' } }, available: true },
        } });
        describeMock.mockResolvedValue({ supported: true, projection });
        const cold = PluginProjectionV2Schema.parse({ v: 2, generation: 73 });
        let declarations = publishDaemonMergedProjectionInputs({ projection: cold }).pluginUiProjection;
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: snapshot('occurrence-a'), targetedSurfaceMounts: [] });
        const rendered = await renderHook(() => useMountedTargetedContributions({ machineId: 'machine-cold-caller-actions', serverId: focusedHomeId,
            pluginId: 'acme.triage', mountedOccurrenceId: 'occurrence-a', enabled: true, pluginUiProjection: declarations }));
        await vi.waitFor(() => expect(rendered.getCurrent().phase).toBe('ready'));
        expect(Object.keys(rendered.getCurrent().pluginUiProjection?.actionsById ?? {}))
            .toEqual(['acme.triage/inspect', 'acme.triage/select-view']);
        expect(describeMock.mock.lastCall?.[1]).toMatchObject({ selection: 'mountedActions', actions: [],
            callers: [snapshot('occurrence-a').target] });
        for (let index = 0; index < 100; index += 1) {
            declarations = { ...declarations, generation: index, actionsById: {} };
            await rendered.rerender();
        }
        expect(describeMock.mock.calls.map(([, request]) => request.selection)).toEqual(['mountedActions']);
        expect(targetedReadMock).toHaveBeenCalledTimes(1);
    });

    it('keeps one mounted Action acquisition through other suppliers changing and reads new declarations on registry invalidation', async () => {
        const machineId = 'machine-selected';
        const action = { id: 'inspect', pluginId: 'acme.triage', occurrenceId: 'occurrence-a', title: 'Inspect',
            scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
            execution: { target: 'daemon' }, available: true };
        const sourceProjection = (sourceMachineId: string, includeNewAction = false) => PluginProjectionV2Schema.parse({
            v: 2, generation: 41, actionsById: Object.fromEntries([action, ...(includeNewAction ? [{ ...action, id: 'inspect-next' }] : [])]
                .map(value => [`acme.triage/${value.id}`, { ...value, executionOrigin: { serverIdentityId: 'srv_mounted',
                    sourceRef: { machineId: sourceMachineId, pluginId: 'acme.triage', sourceCustody } } }])),
        });
        const currentProjection = sourceProjection(machineId);
        const peerProjection = publishDaemonMergedProjectionInputs({ projection: sourceProjection('machine-peer') }).pluginUiProjection;
        const publication = createPluginUiProjectionUnionPublication();
        let selectedProjection = publishDaemonMergedProjectionInputs({ projection: currentProjection }).pluginUiProjection;
        const projectSuppliers = (peerReady: boolean) => {
            const projection = publication.publish([
            { machineId, serverId: focusedHomeId, serverIdentityId: 'srv_mounted', projection: selectedProjection,
                phase: 'current', interactionEnabled: true },
            { machineId: 'machine-peer', serverId: focusedHomeId, serverIdentityId: 'srv_mounted', projection: peerProjection,
                phase: peerReady ? 'current' : 'establishing', interactionEnabled: peerReady },
            ]).pluginUiProjection;
            if (!projection) throw new Error('Expected the admitted supplier projection');
            return projection;
        };
        let declarations = projectSuppliers(true);
        expect(declarations.actionsById['acme.triage/inspect']).toBeDefined();
        const pending = createDeferred<{ supported: true; projection: typeof currentProjection }>();
        onTestFinished(() => pending.resolve({ supported: true, projection: currentProjection }));
        describeMock.mockReturnValueOnce(pending.promise);
        const emptyTargetedContributions = PluginUiTargetedContributionsV1Schema.parse(snapshot('occurrence-a'));
        const rendered = await renderHook(() => useMountedTargetedContributions({ machineId, serverId: focusedHomeId,
            pluginId: 'acme.triage', mountedOccurrenceId: 'occurrence-a', enabled: true,
            emptyTargetedContributions, pluginUiProjection: declarations }));
        await vi.waitFor(() => expect(describeMock).toHaveBeenCalledTimes(1));
        const signal = describeMock.mock.calls[0][1].signal as AbortSignal;
        const firstActions = declarations.actionsById;
        for (let index = 0; index < 100; index += 1) {
            declarations = projectSuppliers(index % 2 !== 0);
            await rendered.rerender();
        }
        expect(declarations.actionsById).not.toBe(firstActions);
        expect(signal.aborted).toBe(false);
        expect(describeMock).toHaveBeenCalledTimes(1);
        expect(rendered.getCurrent().phase).toBe('loading');
        await act(async () => { pending.resolve({ supported: true, projection: currentProjection }); });
        await vi.waitFor(() => expect(rendered.getCurrent().phase).toBe('ready'));
        const admittedProjection = rendered.getCurrent().projectionInputs;
        declarations = projectSuppliers(false);
        await rendered.rerender();
        expect(rendered.getCurrent().phase).toBe('ready');
        expect(rendered.getCurrent().projectionInputs).toBe(admittedProjection);
        expect(describeMock).toHaveBeenCalledTimes(1);

        // A real registry change still invalidates this exact target and reads
        // the latest declarations; presentation updates never own that wake.
        const next = sourceProjection(machineId, true);
        selectedProjection = publishDaemonMergedProjectionInputs({ projection: next }).pluginUiProjection;
        declarations = projectSuppliers(true);
        describeMock.mockResolvedValue({ supported: true, projection: next });
        await rendered.rerender();
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId, serverId: focusedHomeId }, 'authority'); });
        await vi.waitFor(() => expect(rendered.getCurrent().phase).toBe('ready'));
        expect(describeMock).toHaveBeenCalledTimes(2);
        expect(describeMock.mock.lastCall?.[1].actions).toEqual(expect.arrayContaining([
            { pluginId: 'acme.triage', localId: 'inspect' }, { pluginId: 'acme.triage', localId: 'inspect-next' },
        ]));
    });

    it('keeps Account callee custody beside an ordinary mounted Machine source through Action dispatch', async () => {
        const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
        onTestFinished(clearPluginAccountAvailabilityProjection);
        const { PluginAccountAvailabilityIntentReadResponseV1Schema, PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
        const { readPluginUiAccountExecutableOrigin } = await import('../reactNative/executableModuleHost');
        const { createPluginUiProjectedActionResolver } = await import('@/sync/domains/plugins/ui/projection');
        const { dispatchPluginSurfaceAction } = await import('./pluginSurfaceActionDispatch');
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'acme.triage',
            version: '1.0.0', displayName: 'Aggregate', runtime: { apiVersion: 1 }, contributes: { actions: [{
                id: 'aggregate', title: 'Aggregate', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                dangerLevel: 'safe', execution: { target: 'account', account: { artifactId: 'aggregate', exportName: 'activate' } },
            }] } });
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: { availabilityCursor: 1,
            materializations: [], snapshots: [], intentReads: [{ pluginId: manifest.id,
                response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                    hostingCapability: { enabled: false }, intent: { pluginId: manifest.id, desiredVersion: manifest.version,
                        enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'current' },
                    release: { ref: { pluginId: manifest.id, version: manifest.version }, normalizedManifest: manifest,
                        archiveDigestSha256: `sha256:${'a'.repeat(64)}`, collectionContracts: [], uiSlots: [],
                        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
                    uiArtifacts: [], packageAssets: [] }) }] } });
        const accountAction = readPluginAccountAvailability(lifetime.scope).readAccountUiProjection()?.actionsById['acme.triage/aggregate'];
        if (!accountAction || !readPluginUiAccountExecutableOrigin(accountAction)) throw new Error('Expected admitted Account callee custody');
        const machineId = 'machine-selected-source';
        const action = { id: 'scan', pluginId: 'acme.source', occurrenceId: 'source-selected', title: 'Scan',
            scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' },
            available: true, authorization: { generation: { targetGeneration: 'source-selected', desiredGeneration: 'source-selected',
                appliedGeneration: 'source-selected' }, resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } };
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 49,
            actionsById: { 'acme.source/scan': action, 'acme.triage/aggregate': { ...action, ...manifest.contributes.actions[0],
                pluginId: manifest.id, occurrenceId: 'occurrence-a' } } });
        describeMock.mockResolvedValue({ supported: true, projection });
        const declaredProjection = publishDaemonMergedProjectionInputs({ projection }).pluginUiProjection;
        const contributor = { pluginId: 'acme.source', contributionId: 'scan', occurrenceId: 'source-selected', sourceCustody };
        const protocol = { id: 'review/detail', version: 1 };
        const target = PluginUiTargetedContributionsV1Schema.parse({ ...snapshot('occurrence-a'), points: [{ pointId: 'review-detail',
            protocols: [{ protocol, contributions: [{ contributor, protocol, surfaces: [], operations: [{
                point: { pointId: 'review-detail', protocol }, contributor, role: 'scan', action: { pluginId: 'acme.source', localId: 'scan' },
            }] }] }] }] });
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: target, targetedSurfaceMounts: [] });
        const rendered = await renderHook(() => useMountedTargetedContributions({ machineId, serverId: focusedHomeId,
            pluginId: manifest.id, mountedOccurrenceId: 'occurrence-a', enabled: true, pluginUiProjection: declaredProjection }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        const mounted = rendered.getCurrent();
        expect(mounted.phase).toBe('ready');
        expect(mounted.projectionInputs?.pluginProjectionV2).toBe(projection);
        expect(describeMock.mock.lastCall?.[1]).toMatchObject({ selection: 'mountedActions', callers: [target.target],
            actions: [{ pluginId: 'acme.triage', localId: 'aggregate' }, { pluginId: 'acme.source', localId: 'scan' }] });
        expect(mounted.pluginUiProjection?.actionsById['acme.source/scan']).toMatchObject({ occurrenceId: 'source-selected', execution: { target: 'daemon' } });
        // Machine declarations cannot replace the independently admitted Account callee.
        const mountedAccountAction = mounted.pluginUiProjection?.actionsById['acme.triage/aggregate'];
        expect(mountedAccountAction?.execution.target).toBe('account');
        expect(mountedAccountAction && readPluginUiAccountExecutableOrigin(mountedAccountAction))
            .toEqual(readPluginUiAccountExecutableOrigin(accountAction));
        const requests: string[] = [];
        const result = await dispatchPluginSurfaceAction({ action: { pluginId: 'acme.source', localId: 'scan' }, input: {},
            expectedContributorOccurrenceId: 'source-selected', invocationSurface: 'ui',
            pluginUiProjection: mounted.pluginUiProjection,
            resolveContributedAction: createPluginUiProjectedActionResolver(mounted.pluginUiProjection?.actionsById),
            contributedAction: { machineId, serverId: focusedHomeId, execute: async (target, request) => {
                expect(target).toBe(machineId);
                requests.push(request.expectedContributorOccurrenceId);
                return { supported: true, result: { ok: true, result: { rows: ['selected source'] } } };
            } } });
        expect(result).toEqual({ ok: true, result: { rows: ['selected source'] } });
        expect(requests).toEqual(['source-selected']);
    });

    it('keeps admitted presentation beside exact facts while a selected refresh is pending', async () => {
        const machineId = 'machine-retained-before-selected';
        const sourceProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 31,
                installedPackagesById: { 'acme.triage': { id: 'acme.triage', displayName: 'Triage', enabled: true,
                    source: { kind: 'local', locator: '/plugins/triage' } } },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                    'translations:acme.triage': { id: 'translations:acme.triage', pluginId: 'acme.triage', occurrenceId: 'occurrence-a',
                        contributionKind: 'translations', locales: ['en'], bundles: { en: { title: 'Own retained text' } } },
                } } },
            });
        const sourcePresentation = publishDaemonMergedProjectionInputs({ projection: sourceProjection }).pluginUiProjection;
        const text = sourcePresentation.translationsByPluginId['acme.triage'];
        if (!text) throw new Error('Expected the admitted source translations');
        const presentation = { ...sourcePresentation, translationsByPluginId: {
            ...sourcePresentation.translationsByPluginId,
            'acme.triage': { ...text, bundles: { en: { title: 'Wrong ambient replica' } } },
        } };
        const firstProjection = PluginProjectionV2Schema.parse({ ...sourceProjection, generation: 32 });
        describeMock.mockResolvedValue({ supported: true, projection: firstProjection });
        const emptyTargetedContributions = PluginUiTargetedContributionsV1Schema.parse(snapshot('occurrence-a'));
        const rendered = await renderHook(() => useMountedTargetedContributions({ machineId, serverId: focusedHomeId,
            pluginId: 'acme.triage', mountedOccurrenceId: 'occurrence-a', enabled: true,
            emptyTargetedContributions, pluginUiProjection: presentation }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().phase).toBe('ready');
        expect(targetedReadMock).not.toHaveBeenCalled();
        expect(rendered.getCurrent().projectionInputs?.pluginProjectionV2).toBe(firstProjection);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.triage']?.bundles).toEqual({ en: { title: 'Own retained text' } });
        const firstPresentation = rendered.getCurrent().pluginUiProjection;
        expect(rendered.getCurrent().actionInputSelectionFactsKey.hasPluginProjection).toBe(true);
        let settleFacts: ((result: { supported: true; projection: ReturnType<typeof PluginProjectionV2Schema.parse> }) => void) | undefined;
        describeMock.mockReturnValueOnce(new Promise(resolve => { settleFacts = resolve; }));
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId, serverId: focusedHomeId }, 'authority'); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().phase).toBe('loading');
        expect(rendered.getCurrent().targetedContributions).toEqual(emptyTargetedContributions);
        expect(rendered.getCurrent().projectionInputs?.pluginProjectionV2).toBe(firstProjection);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.triage']?.bundles).toEqual({ en: { title: 'Own retained text' } });
        const projection = PluginProjectionV2Schema.parse({ ...sourceProjection, generation: 33 });
        await act(async () => { settleFacts?.({ supported: true, projection }); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().phase).toBe('ready');
        expect(rendered.getCurrent().projectionInputs?.pluginProjectionV2).toBe(projection);
        expect(rendered.getCurrent().pluginUiProjection).toBe(firstPresentation);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.triage']?.bundles).toEqual({ en: { title: 'Own retained text' } });
        expect(describeMock.mock.calls.map(([, request]) => request.selection)).toEqual(['mountedActions', 'mountedActions']);
        describeMock.mockResolvedValue({ supported: true, projection: PluginProjectionV2Schema.parse({ ...sourceProjection,
            generation: 34, familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                'translations:acme.triage': { ...text, bundles: { en: { title: 'Fresh source text' } } },
            } } },
        }) });
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId, serverId: focusedHomeId }, 'authority'); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.triage']?.bundles).toEqual({ en: { title: 'Fresh source text' } });
        expect(describeMock.mock.calls.map(([, request]) => request.selection)).toEqual(['mountedActions', 'mountedActions', 'mountedActions']);
    });

    it('follows a reloaded occurrence: asks the machine projection to refresh once instead of failing', async () => {
        const { getMachineContributionRegistryProjectionRevision } = await import('@/sync/ops/machineContributionRegistryProjection');
        targetedReadMock.mockResolvedValue({
            supported: true,
            targetedContributions: snapshot('occurrence-b'),
            targetedSurfaceMounts: [],
        });
        const scope = { machineId: 'machine-reload', serverId: focusedHomeId };
        const revisionBefore = getMachineContributionRegistryProjectionRevision(scope);

        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: 'machine-reload',
            serverId: focusedHomeId,
            pluginId: 'acme.triage',
            mountedOccurrenceId: 'occurrence-a',
            enabled: true,
        }));
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'ready',
            targetedContributions: snapshot('occurrence-b'),
            failure: null,
        });
        // One invalidation for the (a → b) pair; the re-read it causes returns
        // the same tag and does not publish again.
        expect(getMachineContributionRegistryProjectionRevision(scope)).toBe(revisionBefore + 1);
        expect(targetedReadMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the classified failure reason and the last snapshot through a failed refresh', async () => {
        targetedReadMock
            .mockResolvedValueOnce({
                supported: true,
                targetedContributions: snapshot('occurrence-a'),
                targetedSurfaceMounts: [],
            })
            .mockResolvedValueOnce({ supported: false, reason: 'timeout' });
        const mod = await import('@/sync/ops/machineContributionRegistryProjection');
        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: 'machine-timeout',
            serverId: focusedHomeId,
            pluginId: 'acme.triage',
            mountedOccurrenceId: 'occurrence-a',
            enabled: true,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        await act(async () => {
            mod.publishMachineContributionRegistryProjectionInvalidation({
                machineId: 'machine-timeout',
                serverId: focusedHomeId,
            }, 'authority');
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'failed',
            failure: { reason: 'timeout' },
            targetedContributions: snapshot('occurrence-a'),
        });
    });
});
