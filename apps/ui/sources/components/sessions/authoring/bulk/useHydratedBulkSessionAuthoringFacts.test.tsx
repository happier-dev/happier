import { act } from 'react';
import { expect, it, onTestFinished } from 'vitest';
import '@/sync/syncEngine';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { useHydratedBulkSessionAuthoringFacts } from './useHydratedBulkSessionAuthoringFacts';

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
