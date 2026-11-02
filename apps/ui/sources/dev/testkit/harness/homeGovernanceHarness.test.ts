import { afterEach, expect, it, vi } from 'vitest';
import { createPlainMachineRowFixture } from '../fixtures/machineFixtures';
import { MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from './homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from './realAppRuntimeHarness';
import { ChangesResponseSchema, CurrentCursorResponseSchema } from '@happier-dev/protocol/changes';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

const homes = createHomeGovernanceHarness();
afterEach(async () => { await homes.reset(); });

it('serves strict selected Machine batches from the same seeded rows without synthetic HTTP reads', async () => {
    const serverUrl = 'https://governance-machines.test';
    const serverId = await homes.addHome({ name: 'Machines', serverUrl, accountId: 'owner' });
    const first = createPlainMachineRowFixture({ id: 'first', accountId: 'owner' });
    const held = createPlainMachineRowFixture({ id: 'held', accountId: 'owner' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    homes.answer(serverId, '/v1/machines/first', { body: { machine: first } });
    homes.answer(serverId, '/v1/machines/held', { body: { machine: held }, respondAfter: gate });
    homes.answer(serverId, '/v1/machines/absent', { status: 404, body: { error: 'not_found' } });
    const request = (machineIds: string[]) => homes.request(`${serverUrl}/v1/machines/read-batch`, {
        method: 'POST', body: JSON.stringify({ machineIds }),
    });
    const settled = vi.fn();
    const pending = request(['first', 'absent', 'held']).then(response => { settled(); return response; });
    await Promise.resolve();
    try {
        expect(settled).not.toHaveBeenCalled();
        release();
        const reply = await pending;
        expect(reply.status).toBe(200);
        expect(MachineReadBatchResponseV1Schema.parse(await reply.json())).toMatchObject({ results: [
            { machineId: 'first', status: 'found', machine: first },
            { machineId: 'absent', status: 'not_found' },
            { machineId: 'held', status: 'found', machine: held },
        ] });
        expect(homes.requests.map(row => row.path)).toEqual(['/v1/machines/read-batch']);
        homes.answer(serverId, '/v1/machines/first', { status: 401, body: { error: 'invalid_token' } });
        const denied = await request(['first', 'absent']);
        expect(denied.status).toBe(401);
        expect(await denied.json()).toEqual({ error: 'invalid_token' });
        homes.answer(serverId, '/v1/machines/first', { dispatchThenFail: true });
        await expect(request(['first'])).rejects.toBeInstanceOf(TypeError);
        homes.answer(serverId, '/v1/machines/first', { body: { machine: { id: 'first' } } });
        await expect(request(['first'])).rejects.toMatchObject({ name: '$ZodError' });
        homes.answer(serverId, 'POST /v1/machines/read-batch', { status: 403, body: { error: 'present_user_required' } });
        const explicit = await request(['held']);
        expect(explicit.status).toBe(403);
        expect(await explicit.json()).toEqual({ error: 'present_user_required' });
    } finally { release(); await pending; }
});

it('lets an explicit managed inventory answer replace the empty Home default', async () => {
    const serverUrl = 'https://governance-managed.test';
    const serverId = await homes.addHome({ name: 'Managed inventory', serverUrl, accountId: 'owner' });
    const path = '/v1/machines/managed/actions/list';
    const request = () => homes.request(`${serverUrl}${path}`, {
        method: 'POST', body: JSON.stringify({ homeId: serverId }),
    });
    expect(await (await request()).json()).toEqual({ machines: [] });
    homes.answer(serverId, path, { status: 503, body: { code: 'controller_unavailable' } });
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'controller_unavailable' });
});

it('publishes committed Artifact changes to the same Account cursor used by warm inventories', async () => {
    installHomeGovernanceBoundaries(homes);
    const serverUrl = 'https://governance-artifacts.test';
    const id = await homes.addHome({ name: 'Artifacts', serverUrl, accountId: 'owner' });
    const request = (path: string, init?: RequestInit) => homes.request(`${serverUrl}${path}`, init);
    const cursor = async () => CurrentCursorResponseSchema.parse(await (await request('/v2/cursor')).json()).cursor;
    const changes = async (after: number, limit = 200) => ChangesResponseSchema.parse(
        await (await request(`/v2/changes?after=${after}&limit=${limit}`)).json());
    expect(await cursor()).toBe(0);
    const input = { id: 'first', header: encodePlainArtifactStoredContent({ title: 'First', kind: 'approval_request.v1' }),
        body: encodePlainArtifactStoredContent({ body: 'first' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
    await request('/v1/artifacts', { method: 'POST', body: JSON.stringify(input) });
    const created = await cursor();
    expect(created).toBeGreaterThan(0);
    expect((await changes(0)).changes).toMatchObject([{ cursor: created, kind: 'artifact', entityId: 'first' }]);
    // Idempotent creates and failed CAS attempts publish no committed change.
    await request('/v1/artifacts', { method: 'POST', body: JSON.stringify(input) });
    await request('/v1/artifacts/first', { method: 'POST', body: JSON.stringify({ body: input.body, expectedBodyVersion: 0 }) });
    expect(await cursor()).toBe(created);
    await request('/v1/artifacts/first', { method: 'POST', body: JSON.stringify({ body: input.body, expectedBodyVersion: 1 }) });
    const updated = await cursor();
    expect(updated).toBeGreaterThan(created);
    const store = homes.artifacts(id);
    const first = store.read('first')!;
    store.replaceStoredRow({ ...first, id: 'second', kind: undefined });
    expect(store.read('second')?.kind).toBe('other');
    const page = await changes(created, 1);
    expect(page.changes).toMatchObject([{ cursor: updated, entityId: 'first' }]);
    expect((await changes(page.nextCursor)).changes).toMatchObject([{ entityId: 'second' }]);
    store.replaceStoredRow({ ...first, id: 'legacy', kind: null });
    expect(store.read('legacy')?.kind).toBeNull();
    store.seedAccountGrant('second', 'recipient', 'view');
    const beforeDelete = await cursor();
    await request('/v1/artifacts/first', { method: 'DELETE' });
    expect((await changes(beforeDelete)).changes).toMatchObject([{ entityId: 'first' }]);
    expect((await request(`/v2/changes?after=${(await cursor()) + 1}`)).status).toBe(410);
    expect((await changes(await cursor())).changes).toEqual([]);
    await homes.switchAccount(id, 'unrelated');
    expect(await cursor()).toBe(0);
    expect((await changes(0)).changes).toEqual([]);
    await homes.switchAccount(id, 'recipient');
    expect((await changes(0)).changes).toMatchObject([{ entityId: 'second' }]);
    const beforeClear = await cursor();
    store.clear();
    expect((await changes(beforeClear)).changes).toMatchObject([{ entityId: 'second' }]);
    const deleted = await (await request('/v1/artifacts/read', {
        method: 'POST', body: JSON.stringify({ artifactIds: ['second'] }),
    })).json();
    expect(deleted).toMatchObject({ items: [{ artifactId: 'second', ok: false, error: 'artifact_not_found' }] });
});

it('switches the applied Account when the app entry has not loaded Sync', async () => {
    installHomeGovernanceBoundaries(homes);
    const id = await homes.addHome({ name: 'Cold Governance', serverUrl: 'https://governance-cold.test', accountId: 'account-a' });
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    storage.getState().activateProfileScope({ serverId: id, accountId: 'account-a' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const previous = captureActiveServerAccountScopeLifetime();
    expect(previous?.scope).toEqual({ serverId: id, accountId: 'account-a' });

    await homes.switchAccount(id, 'account-b');

    expect(previous?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toEqual({ serverId: id, accountId: 'account-b' });
});

it('persists genuine Home credentials and retires a focused Account on replacement and reset', async () => {
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    const id = await homes.addHome({ name: 'Governance', serverUrl: 'https://governance-custody.test', accountId: 'account-a' });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://governance-custody.test', { serverId: id });
    if (!credentials) throw new Error('Home credentials unavailable');
    await restoreConnectionToActiveServer(credentials);
    const { getActiveServerAccountScope, captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    expect(getActiveServerAccountScope()).toEqual({ serverId: id, accountId: 'account-a' });
    const captured = captureActiveServerAccountScopeLifetime();
    expect(captured?.isCurrent()).toBe(true);
    let release: () => void = () => undefined;
    homes.answer(id, '/v1/lifetime-probe', { body: { account: 'a' }, respondAfter: new Promise<void>(resolve => { release = resolve; }) });
    const { serverFetch, StaleServerGenerationError, ServerFetchAbortedForServerSwitchError } = await import('@/sync/http/client');
    const pending = serverFetch('/v1/lifetime-probe', undefined, { retry: 'none' }).then(
        () => false,
        error => error instanceof StaleServerGenerationError || error instanceof ServerFetchAbortedForServerSwitchError
            || (error instanceof DOMException && error.name === 'AbortError'),
    );
    await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/lifetime-probe')).toHaveLength(1));
    await homes.switchAccount(id, 'account-b');
    release();
    expect(await pending).toBe(true);
    expect(captured?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toEqual({ serverId: id, accountId: 'account-b' });
    const replacement = captureActiveServerAccountScopeLifetime();
    await homes.reset();
    expect(replacement?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toBeNull();
    expect(await TokenStorage.getCredentialsForServerUrl('https://governance-custody.test', { serverId: id })).toBeNull();
});

it('addresses the same fixture Home by its published identity without selecting a neighboring Home', async () => {
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    const serverUrl = 'https://governance-published.test';
    const identity = 'srv_governance_published';
    const profileId = await homes.addHome({ name: 'Published', serverUrl, serverIdentityId: identity, accountId: 'account-a' });
    const neighbor = await homes.addHome({ name: 'Neighbor', serverUrl: 'https://governance-neighbor.test',
        serverIdentityId: 'srv_governance_neighbor', accountId: 'neighbor', active: false });
    homes.answer(identity, '/v1/identity-probe', { body: { home: 'published' } });
    const token = homes.findByServerUrl(serverUrl)!.token;
    const response = await homes.request(`${serverUrl}/v1/identity-probe`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await response.json()).toEqual({ home: 'published' });
    expect(homes.requestsFor('/v1/identity-probe')).toMatchObject([{ serverId: profileId, serverUrl }]);
    expect(homes.artifacts(identity)).toBe(homes.artifacts(profileId));
    expect(homes.artifacts(identity)).not.toBe(homes.artifacts(neighbor));
    await homes.switchAccount(identity, 'replacement');
    expect(homes.findByServerUrl(serverUrl)?.accountId).toBe('replacement');
    expect(homes.findByServerUrl('https://governance-neighbor.test')?.accountId).toBe('neighbor');
});

it('retains both named Account approval requirements when seeding them in sequence', async () => {
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    const serverUrl = 'https://governance-policy.test';
    const profileId = await homes.addHome({ name: 'Policy', serverUrl, accountId: 'account-a' });
    await homes.requireUiApproval(profileId, 'machines.processes.kill');
    await homes.requireUiApproval(profileId, 'machines.processes.stop');
    const token = homes.findByServerUrl(serverUrl)!.token;
    const response = await homes.request(`${serverUrl}/v2/account/settings`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await response.json()).toMatchObject({ content: { t: 'plain', v: { actionsSettingsV1: { actions: {
        'machines.processes.kill': { approvalRequiredSurfaces: ['ui'] },
        'machines.processes.stop': { approvalRequiredSurfaces: ['ui'] },
    } } } } });
});

it('fails a wait whose render stopped moving with its own assertion, inside the case budget', async () => {
    installHomeGovernanceBoundaries(homes);
    const started = Date.now();
    await expect(waitForHomeGovernance(() => expect('rendered').toBe('awaited')))
        .rejects.toThrow("expected 'rendered' to be 'awaited'");
    expect(Date.now() - started).toBeLessThan(40_000);
});

it('keeps waiting past the quiet window while the Home keeps serving requests', async () => {
    installHomeGovernanceBoundaries(homes);
    const serverUrl = 'https://governance-progress.test';
    const serverId = await homes.addHome({ name: 'Progress', serverUrl, accountId: 'owner' });
    homes.answer(serverId, '/v1/progress-probe', { body: { ok: true } });
    let reached = false;
    const later = setTimeout(() => { reached = true; }, 25_000);
    let done = false;
    const traffic = (async () => {
        while (!done) {
            await homes.request(`${serverUrl}/v1/progress-probe`, undefined);
            await new Promise(resolve => setTimeout(resolve, 2_000));
        }
    })();
    try {
        // The failure stays identical throughout, so only the served requests count as progress.
        await waitForHomeGovernance(() => expect(reached).toBe(true));
    } finally {
        clearTimeout(later);
        done = true;
        await traffic;
    }
    expect(homes.requestsFor('/v1/progress-probe').length).toBeGreaterThan(10);
});
