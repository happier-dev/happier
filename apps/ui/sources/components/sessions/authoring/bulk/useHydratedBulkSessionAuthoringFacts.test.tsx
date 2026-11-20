import { act } from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contributionKey';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import '@/sync/syncEngine';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { bulkChangeTargetKey } from './executeBulkSessionChanges';
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

it('retries only failed Sessions after the switched Session publishes an inactive contributed Agent', async () => {
    const muse = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.muse', localId: 'muse' } };
    const museId = buildQualifiedPluginContributionKey(muse.identity);
    const ids = ['switched', 'failed', 'sent'];
    const machineId = 'switch-machine';
    let switched = false;
    let retrying = false;
    const record = (id: string, currentAgentId: string, active: boolean, metadataVersion: number) =>
        createPlainSessionCurrentProjectionRecordFixture({ id, active, metadataVersion,
            metadata: { path: '/repo', host: 'host', machineId, flavor: currentAgentId,
                ...(currentAgentId === museId ? {
                    runtimeDescriptorV1: { v: 1, agentId: museId, agent: {} },
                } : {}),
            },
        });
    const initialRecords = new Map(ids.map(id => [id, record(id, id === 'switched' ? 'codex' : museId, true, 1)]));
    const switchedRecord = record('switched', museId, false, 2);
    const boundary = createSessionReadBatchHttpBoundary(request => {
        const id = /^\/v2\/sessions\/([^/]+)$/.exec(request.path)?.[1];
        const snapshot = id === 'switched' && switched ? switchedRecord : initialRecords.get(id ?? '');
        return snapshot ? Response.json({ session: snapshot }) : undefined;
    });
    const homes = await serveAccountHomes({ homes: [
        { key: 'target', serverUrl: 'https://bulk-retry-target.test', accountId: 'target-account' },
        { key: 'focused', serverUrl: 'https://bulk-retry-focused.test', accountId: 'focused-account' },
    ], route: request => boundary.handle(request) });
    onTestFinished(() => homes.dispose());
    onTestFinished(() => machineTransport.mockReset());
    const serverId = homes.homes.target!.id;
    machineTransport.mockImplementation(async request => {
        expect(request).toMatchObject({ machineId, serverId, accountId: 'target-account', method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE });
        return { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
            [museId]: { id: museId, identity: muse.identity, capabilities: {
                sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
            } },
        } }) };
    });
    const before = storage.getState();
    onTestFinished(() => storage.setState(before, true));
    const switchedRow = createSessionFixture({ id: 'switched', serverId, active: true });
    storage.setState({ sessionListRowsByServerId: { [serverId]: { switched: switchedRow } } });
    const targets = ids.map(sessionId => ({ serverId, sessionId }));
    const [switchTarget, failedTarget, sentTarget] = targets;
    const retryCalls: Array<{ action: string; targets: typeof targets }> = [];
    const mounted = await renderHook(() => {
        const { facts } = useHydratedBulkSessionAuthoringFacts(targets);
        const composer = useBulkSessionComposer({ targets: facts.flatMap(fact => fact.planningTarget ? [fact.planningTarget] : []),
            initialText: 'QA draft',
            executeConfirmed: async (action, input) => {
                const addresses = (input as { sessionId: { addresses: typeof targets } }).sessionId.addresses;
                if (retrying) retryCalls.push({ action, targets: addresses });
                return { ok: true, result: { kind: 'fanout', results: addresses.map(target => ({
                    target,
                    result: action === 'session.agent.transition' ? { ok: true, result: { type: 'accepted' } }
                        : retrying || target.sessionId === 'sent' ? { ok: true, result: { status: 'accepted', localId: target.sessionId } }
                            : { ok: false, errorCode: 'resume_failed', error: 'resume_failed' },
                })) } };
            },
        });
        return { facts, composer };
    });
    onTestFinished(() => mounted.unmount());
    await waitForHomeGovernance(() => expect(mounted.getCurrent().facts.map(fact => fact.status)).toEqual(['ready', 'ready', 'ready']));
    await act(async () => mounted.getCurrent().composer.setSelection({ agentTarget: muse }));
    await act(async () => mounted.getCurrent().composer.send());
    expect(mounted.getCurrent().composer.rows).toMatchObject([
        { target: switchTarget, switchedTo: museId, state: 'failed' },
        { target: failedTarget, state: 'failed' },
        { target: sentTarget, state: 'sent' },
    ]);

    switched = true;
    await act(async () => storage.setState({ sessionListRowsByServerId: {
        [serverId]: { switched: { ...switchedRow, active: false, metadataVersion: switchedRow.metadataVersion + 1 } },
    } }));
    await waitForHomeGovernance(() => expect(mounted.getCurrent().facts[0]?.agentId).toBe(museId));
    retrying = true;
    await act(async () => mounted.getCurrent().composer.retryFailed());
    expect(retryCalls.map(request => ({ action: request.action, targets: request.targets.map(bulkChangeTargetKey).sort() })))
        .toEqual([{ action: 'session.message.send', targets: [switchTarget!, failedTarget!].map(bulkChangeTargetKey).sort() }]);
    expect(mounted.getCurrent().composer.rows.map(row => row.state)).toEqual(['sent', 'sent', 'sent']);
});
