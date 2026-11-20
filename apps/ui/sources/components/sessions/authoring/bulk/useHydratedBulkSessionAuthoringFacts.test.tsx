import { act } from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contributionKey';
import { SESSION_MESSAGE_SEND_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { SESSION_AGENT_TRANSITION_ACTION_ID_V1 } from '@happier-dev/protocol/actions/sessionAgentTransitionActionIdsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import '@/sync/syncEngine';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installRealActionExecutorModuleLoader, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { useBulkSessionComposer } from './useBulkSessionComposer';
import { useHydratedBulkSessionAuthoringFacts } from './useHydratedBulkSessionAuthoringFacts';

const machineTransport = vi.hoisted(() => vi.fn<(request: { method: string; machineId: string; serverId: string; accountId: string }) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc')>(),
    machineRpcWithServerScope: machineTransport,
}));

it('hydrates exact Homes, ignores streaming publications, and refreshes changed authoring metadata', async () => {
    let permissionMode = 'default';
    const record = (home: string) => createPlainSessionCurrentProjectionRecordFixture({ id: 'same', active: true,
        metadata: { path: '/repo', host: 'host', flavor: 'codex', machineId: `machine-${home}`, permissionMode } });
    record('a');
    const boundary = createSessionReadBatchHttpBoundary(request => request.path === '/v2/sessions/same'
        ? Response.json({ session: record(request.home) }) : undefined);
    const homes = await serveAccountHomes({ homes: [
        { key: 'a', serverUrl: 'https://bulk-hook-a.test', accountId: 'account-a' },
        { key: 'b', serverUrl: 'https://bulk-hook-b.test', accountId: 'account-b' },
    ], route: request => boundary.handle(request) });
    onTestFinished(() => homes.dispose());
    const previous = storage.getState();
    onTestFinished(() => storage.setState(previous, true));
    const targets = ['a', 'b'].map(key => ({ serverId: homes.homes[key]!.id, sessionId: 'same' }));
    const row = createSessionFixture({ id: 'same', serverId: targets[0]!.serverId });
    storage.setState({ sessions: {}, sessionListRowsByServerId: { [targets[0]!.serverId]: { same: row } } });
    let renders = 0;
    const mounted = await renderHook(() => { renders++; return useHydratedBulkSessionAuthoringFacts(targets); });
    onTestFinished(() => mounted.unmount());
    // Await the real HTTP boundary rather than replacing the internal reader.
    for (let attempt = 0; attempt < 30 && mounted.getCurrent().facts.some(fact => fact.status !== 'ready'); attempt++) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    expect(mounted.getCurrent().facts).toMatchObject([{ status: 'ready', machineId: 'machine-a' }, { status: 'ready', machineId: 'machine-b' }]);
    const initialFacts = mounted.getCurrent().facts;
    const initialRenders = renders;
    const initialReads = boundary.componentRequests.length;
    for (let seq = 2; seq < 52; seq++) {
        await act(async () => storage.setState({ sessionListRowsByServerId: { [targets[0]!.serverId]: { same: { ...row, seq, updatedAt: seq } } } }));
    }
    expect(renders - initialRenders).toBe(0);
    expect(boundary.componentRequests.length).toBe(initialReads);
    await act(async () => storage.setState({ sessionListRowsByServerId: { [targets[0]!.serverId]: { same: { ...row, metadataVersion: row.metadataVersion + 1 } } } }));
    for (let attempt = 0; attempt < 30; attempt++) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    expect(boundary.componentRequests.length).toBeGreaterThan(initialReads);
    expect(mounted.getCurrent().facts).toEqual(initialFacts);
    expect(renders - initialRenders).toBe(0);
    permissionMode = 'read-only';
    await act(async () => storage.setState({ sessionListRowsByServerId: { [targets[0]!.serverId]: { same: { ...row, metadataVersion: row.metadataVersion + 2 } } } }));
    for (let attempt = 0; attempt < 30 && mounted.getCurrent().facts[0]?.permissionMode !== permissionMode; attempt++) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    expect(mounted.getCurrent().facts[0]?.permissionMode).toBe('read-only');
    expect(renders - initialRenders).toBe(1);
});

it('delivers Retry only to the failed Sessions, including the inactive Session on its new Agent', async () => {
    const muse = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.muse', localId: 'muse' } };
    const museId = buildQualifiedPluginContributionKey(muse.identity);
    const codexId = buildQualifiedPluginContributionKey({ pluginId: 'happier.agent.codex', localId: 'codex' });
    const ids = ['switched', 'failed', 'sent'];
    const machineId = 'switch-machine';
    const serverUrl = 'https://bulk-retry-target.test';
    const serverIdentityId = 'srv_bulk_retry_target';
    const accountId = 'target-account';
    const draft = 'QA draft';
    const record = (id: string, flavor: string, active: boolean, metadataVersion: number) =>
        createPlainSessionCurrentProjectionRecordFixture({ id, active, metadataVersion,
            metadata: { path: '/repo', host: 'host', machineId, flavor,
                ...(flavor === museId ? { runtimeDescriptorV1: { v: 1, agentId: museId, agent: {} } } : {}),
            },
        });
    const records = new Map(ids.map(id => [id, record(id, id === 'switched' ? codexId : museId, true, 1)]));
    const transitions: unknown[] = [];
    const deliveries: Array<{ sessionId: string; message: string; localId: string; machineId: string }> = [];
    const attempted = new Set<string>();
    const receiver = { serverUrl, serverIdentityId, accountId, machineId, tokenEpoch: 0 };
    const transition = await createExternalActionAccountHttpBoundary({
        ...receiver, actionId: SESSION_AGENT_TRANSITION_ACTION_ID_V1,
        execute: (input, { target, requestId }) => {
            transitions.push({ input, target });
            records.set('switched', record('switched', museId, false, 2));
            return { type: 'accepted', localId: requestId };
        },
    });
    const message = await createExternalActionAccountHttpBoundary({
        ...receiver, actionId: SESSION_MESSAGE_SEND_ACTION_ID_V1,
        execute: (input, { target }) => {
            const { sessionId, message, localId } = input as { sessionId: string; message: string; localId: string };
            deliveries.push({ sessionId, message, localId, machineId: target.machineId });
            const firstAttempt = !attempted.has(sessionId);
            attempted.add(sessionId);
            return firstAttempt && sessionId !== 'sent' ? { status: 'unavailable' } : { status: 'accepted', localId };
        },
        failure: result => (result as { status: string }).status === 'unavailable'
            ? { errorCode: 'resume_failed', error: 'resume_failed' } : null,
    });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, agentSwitching: { enabled: true } } } });
    const boundary = createSessionReadBatchHttpBoundary(request => {
        const id = /^\/v2\/sessions\/([^/]+)$/.exec(request.path)?.[1];
        const snapshot = id ? records.get(id) : undefined;
        return request.home === 'target' && snapshot ? Response.json({ session: snapshot }) : undefined;
    });
    const homes = await serveAccountHomes({ homes: [
        { key: 'target', serverUrl, serverIdentityId, accountId, currentAccount: true },
        { key: 'focused', serverUrl: 'https://bulk-retry-focused.test', accountId: 'focused-account' },
    ], route: async request => {
        if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(features);
        const sessionResponse = await boundary.handle(request);
        if (sessionResponse !== undefined) return sessionResponse;
        if (request.home !== 'target') return undefined;
        const init = { method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) };
        return (await transition.handle(request.url, init)) ?? (await message.handle(request.url, init)) ?? undefined;
    } });
    onTestFinished(() => homes.dispose());
    onTestFinished(await installRealActionExecutorModuleLoader());
    onTestFinished(() => machineTransport.mockReset());
    const serverId = homes.homes.target!.id;
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    machineTransport.mockImplementation(async request => {
        expect(request).toMatchObject({ machineId, serverId, accountId, method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE });
        return { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
            [museId]: { id: museId, identity: muse.identity, capabilities: {
                sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
            } },
        } }) };
    });
    const before = storage.getState();
    onTestFinished(() => storage.setState(before, true));
    const switchedRow = createSessionFixture({ id: 'switched', serverId, active: true, metadataVersion: 1 });
    storage.setState({ sessionListRowsByServerId: { [serverId]: { switched: switchedRow } } });
    const targets = ids.map(sessionId => ({ serverId, sessionId }));
    const [switchTarget, failedTarget, sentTarget] = targets;
    const mounted = await renderHook(() => {
        const { facts } = useHydratedBulkSessionAuthoringFacts(targets);
        const composer = useBulkSessionComposer({ targets: facts.flatMap(fact => fact.planningTarget ? [fact.planningTarget] : []),
            initialText: draft });
        return { facts, composer };
    });
    onTestFinished(() => mounted.unmount());
    await waitForHomeGovernance(() => expect(mounted.getCurrent().facts.map(fact => fact.status)).toEqual(['ready', 'ready', 'ready']));
    expect(mounted.getCurrent().facts[0]?.planningTarget?.agentId).toBe(codexId);
    await act(async () => mounted.getCurrent().composer.setSelection({ agentTarget: muse }));
    await act(async () => mounted.getCurrent().composer.send());
    const machine = { kind: 'machine', machineId };
    const expectedTransition = [{ target: machine, input: expect.objectContaining({
        sessionId: 'switched', expectedCurrentAgentId: codexId, selection: { v: 1, agentId: museId },
    }) }];
    const expectedDelivery = (sessionId: string) => ({ sessionId, machineId, message: draft, localId: expect.any(String) });
    expect(transitions).toEqual(expectedTransition);
    expect(deliveries).toHaveLength(3);
    expect(deliveries).toEqual(expect.arrayContaining(ids.map(expectedDelivery)));
    expect(mounted.getCurrent().composer.rows).toMatchObject([
        { target: switchTarget, switchedTo: museId, state: 'failed', code: 'resume_failed' },
        { target: failedTarget, state: 'failed', code: 'resume_failed' },
        { target: sentTarget, state: 'sent' },
    ]);

    // The list publication carries the new version; hydration reads the Agent from the transitioned Home record.
    await act(async () => storage.setState({ sessionListRowsByServerId: {
        [serverId]: { switched: { ...switchedRow, active: false, metadataVersion: records.get('switched')!.metadataVersion } },
    } }));
    await waitForHomeGovernance(() => expect(mounted.getCurrent().facts[0]?.agentId).toBe(museId));
    await act(async () => mounted.getCurrent().composer.retryFailed());
    const retried = deliveries.slice(3);
    expect(retried.map(delivery => delivery.sessionId).sort()).toEqual(['failed', 'switched']);
    expect(mounted.getCurrent().facts[0]?.planningTarget).toMatchObject({ agentId: museId, machineId });
    expect(retried).toEqual(expect.arrayContaining([
        deliveries.slice(0, 3).find(delivery => delivery.sessionId === 'switched'),
        deliveries.slice(0, 3).find(delivery => delivery.sessionId === 'failed'),
    ]));
    expect(transitions).toEqual(expectedTransition);
    const rows = mounted.getCurrent().composer.rows;
    expect(rows).toHaveLength(targets.length);
    expect(rows).toEqual(expect.arrayContaining(targets.map(target => expect.objectContaining({ target, state: 'sent' }))));
});
