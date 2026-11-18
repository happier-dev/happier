import { afterEach, expect, it } from 'vitest';
import '@/sync/syncEngine';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { projectBulkSessionAuthoringFact } from '@/sync/store/bulkSessionAuthoringFacts';
import { readBulkSessionAuthoringSnapshots } from './bulkSessionAuthoringHydration';

let homes: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); await homes?.dispose(); homes = undefined; });

it('loads the same session id from both exact Home authorities without overwriting either', async () => {
    const records = Object.fromEntries(['a', 'b'].map(home => [home, createPlainSessionCurrentProjectionRecordFixture({ id: 'same', active: true,
        metadata: { path: '/repo', host: 'host', flavor: 'codex', machineId: `machine-${home}` } })]));
    const boundary = createSessionReadBatchHttpBoundary(request => request.path === '/v2/sessions/same'
        ? Response.json({ session: records[request.home] }) : undefined);
    homes = await serveAccountHomes({ homes: [
        { key: 'a', serverUrl: 'https://bulk-authoring-a.test', accountId: 'account-a' },
        { key: 'b', serverUrl: 'https://bulk-authoring-b.test', accountId: 'account-b' },
    ], route: request => boundary.handle(request) });
    const targets = ['a', 'b'].map(key => ({ serverId: homes!.homes[key]!.id, sessionId: 'same' }));
    const loaded = await readBulkSessionAuthoringSnapshots(targets);
    expect(loaded.size).toBe(2);
    expect([...loaded.values()].map(value => value.errorCode)).toEqual([null, null]);
    expect(targets.map(target => projectBulkSessionAuthoringFact(target, loaded.get(sessionAddressKey(target))?.session ?? null)))
        .toMatchObject([{ status: 'ready', machineId: 'machine-a' }, { status: 'ready', machineId: 'machine-b' }]);
});

it('preserves nonempty config values for Mixed controls and planner clearing', () => {
    const address = { serverId: 'home', sessionId: 'config' };
    const fact = projectBulkSessionAuthoringFact(address, createSessionFixture({ id: address.sessionId, serverId: address.serverId, active: true,
        metadata: { path: '/repo', host: 'host', agent: 'codex', machineId: 'machine',
            sessionConfigOptionOverridesV1: { v: 1, updatedAt: 4, overrides: { effort: { updatedAt: 4, value: 'high' } } } } }));
    expect(fact.values.sessionConfigOptionOverrides?.overrides.effort?.value).toBe('high');
    expect(fact.planningTarget?.sessionConfigOptionOverrides?.overrides.effort?.value).toBe('high');
    expect(fact.values.sessionConfigOptionOverrides?.overrides.effort?.updatedAt).toBe(0);
});
