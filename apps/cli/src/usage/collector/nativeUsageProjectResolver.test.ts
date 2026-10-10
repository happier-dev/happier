import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectAccountOrganizationV1Schema, ProjectAccountRowMutationRequestV1Schema,
    StoredProjectAccountRowPayloadV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createNativeUsageProjectResolver } from './nativeUsageProjectResolver';
import { FeaturesResponseSchema, UsageEventIngestRequestSchema } from '@happier-dev/protocol';
import { createPiExternalSessionsContribution } from '../../../../../packages/plugins/pi/src/agent/externalSessions/contribution';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { createUsageObservationPublisher } from '../createUsageObservationPublisher';
import { createNativeUsageCaptureStore, type NativeUsageCaptureSource } from './nativeUsageCaptureState';
import { createNativeUsageCollector } from './nativeUsageCollector';
import type { StoredCredentials } from '@/persistence';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { createExternalSessionsInvocationFixture } from '@/testkit/backends/externalSessionFixtures';

afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });
const authority = { serverId: 'home', accountId: 'account', machineId: 'machine' };
const token = `header.${Buffer.from(JSON.stringify({ sub: authority.accountId })).toString('base64url')}.signature`;
// HTTP is the Account persistence boundary; the real mode, cipher, mutation, and ref owners run beneath it.
function accountBoundary(rows: ProjectAccountRowV1[]) {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
    return vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        expect(url.startsWith('https://home.test/')).toBe(true);
        if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [...rows] } };
        const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
        const accepted = request.mutations.map(mutation => ({ key: mutation.key,
            revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content }));
        for (const row of accepted) {
            const index = rows.findIndex(existing => JSON.stringify(existing.key) === JSON.stringify(row.key));
            if (index < 0) rows.push(row); else rows[index] = row;
        }
        return { status: 200, data: { status: 'updated', cursor: 1, rows: accepted } };
    });
}
async function fixture(run: (resolve: ReturnType<typeof createNativeUsageProjectResolver>) => Promise<void>,
    encryption: StoredCredentials['encryption'] = null) {
    const directory = await mkdtemp(join(tmpdir(), 'happier-native-project-'));
    try {
        const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
        await run(createNativeUsageProjectResolver({ authority, storage, serverHttpBaseUrl: 'https://home.test',
            readCredentials: async () => ({ token, encryption }) }));
    } finally { await rm(directory, { recursive: true, force: true }); }
}

describe('native accounting Account Project resolution', () => {
    it('admits only the canonical optional human label while stored readers retain known organization fields', () => {
        expect(ProjectAccountOrganizationV1Schema.parse({ label: 'Native repository', pinned: true }))
            .toEqual({ label: 'Native repository', pinned: true });
        expect(ProjectAccountOrganizationV1Schema.safeParse({ label: 'Native repository', rootPath: '/private' }).success).toBe(false);
        const key = { kind: 'project-organization', serverId: 'home', projectKey: 'opaque' };
        expect(StoredProjectAccountRowPayloadV1Schema.parse({ key, value: { label: 'Native repository', pinned: true, future: 1 } }))
            .toEqual({ key, value: { label: 'Native repository', pinned: true } });
    });
    it('accepts a canonical opaque Project and private label without sending the native root in any HTTP body', async () => {
        const rows: ProjectAccountRowV1[] = [];
        const transport = accountBoundary(rows);
        await fixture(async resolve => {
            const result = await resolve({ rootPath: '/work/native', label: 'Native repository' }, new AbortController().signal);
            expect(result).toEqual({ projectKey: expect.any(String) });
            expect(result.projectKey).not.toContain('/work/native');
            expect(rows).toEqual([expect.objectContaining({ key: { kind: 'project-organization', serverId: 'home', projectKey: result.projectKey },
                content: { t: 'plain', v: { key: { kind: 'project-organization', serverId: 'home', projectKey: result.projectKey }, value: { label: 'Native repository' } } } })]);
            const acceptedRows = structuredClone(rows);
            expect(await resolve({ rootPath: '/work/native' }, new AbortController().signal)).toEqual(result);
            expect(rows).toEqual(acceptedRows);
            expect(JSON.stringify(transport.mock.calls.map(([, body]) => body))).not.toContain('/work/native');
        });
    });
    it('reuses the exact accepted Project anchor without replacing its Account label', async () => {
        const ref = { id: 'workspace-accepted', projectKey: 'project-accepted', serverId: 'home', machineId: 'machine',
            rootPath: '/work/native', label: 'User label', createdAtMs: 1 };
        const key = { kind: 'workspace-ref' as const, serverId: 'home', id: ref.id };
        const rows: ProjectAccountRowV1[] = [{ key, revision: 0, content: { t: 'plain', v: { key, value: ref } } }];
        accountBoundary(rows);
        await fixture(async resolve => {
            expect(await resolve({ rootPath: '/work/native', label: 'Vendor label' }, new AbortController().signal))
                .toEqual({ projectKey: 'project-accepted', workspaceId: 'workspace-accepted' });
            expect(rows).toEqual([{ key, revision: 0, content: { t: 'plain', v: { key, value: ref } } }]);
        });
    });
    it('does not invent another Project anchor when an accepted exact checkout is ambiguous', async () => {
        const rows = ['one', 'two'].map((id): ProjectAccountRowV1 => {
            const key = { kind: 'workspace-ref' as const, serverId: 'home', id };
            return { key, revision: 0, content: { t: 'plain', v: { key, value: {
                id, projectKey: `project-${id}`, serverId: 'home', machineId: 'machine', rootPath: '/work/native', createdAtMs: 1,
            } } } };
        });
        const transport = accountBoundary(rows);
        await fixture(async resolve => {
            await expect(resolve({ rootPath: '/work/native' }, new AbortController().signal))
                .rejects.toMatchObject({ code: 'workspace_ref_ambiguous' });
            expect(transport.mock.calls.every(([url]) => url.endsWith('/list'))).toBe(true);
            expect(rows).toHaveLength(2);
        });
    });
    it('does not return publishable IDs for an invalid Account row acknowledgement', async () => {
        const transport = accountBoundary([]);
        const canonicalBoundary = transport.getMockImplementation()!;
        transport.mockImplementation(async (url, body, config) => {
            if (url.endsWith('/list')) return await canonicalBoundary(url, body, config);
            const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
            return { status: 200, data: { status: 'updated', cursor: 1,
                rows: request.mutations.map(mutation => ({ key: mutation.key, revision: 99, content: mutation.content })) } };
        });
        await fixture(async resolve => {
            await expect(resolve({ rootPath: '/work/native' }, new AbortController().signal))
                .rejects.toMatchObject({ code: 'project_account_row_outcome_unknown' });
        });
    });
    it('does not publish or mutate a Project when Account E2EE material is unavailable', async () => {
        const transport = accountBoundary([]);
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 0 } });
        await fixture(async resolve => {
            await expect(resolve({ rootPath: '/work/native' }, new AbortController().signal))
                .rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE' });
            expect(transport).not.toHaveBeenCalled();
        });
    });
    it('seals a native human label under actual Account E2EE material without uploading the cwd', async () => {
        const rows: ProjectAccountRowV1[] = [];
        const transport = accountBoundary(rows);
        const secret = new Uint8Array(32).fill(8);
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 0 } });
        await fixture(async resolve => {
            const result = await resolve({ rootPath: '/private/native', label: 'Private repository' }, new AbortController().signal);
            expect(rows).toHaveLength(1);
            expect(rows[0].content).toMatchObject({ t: 'encrypted', c: expect.any(String) });
            const cipher = createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret }, randomBytes: size => new Uint8Array(size) });
            expect(cipher.open(rows[0].key, rows[0].content!)).toEqual({
                key: { kind: 'project-organization', serverId: 'home', projectKey: result.projectKey }, value: { label: 'Private repository' },
            });
            const requests = JSON.stringify(transport.mock.calls.map(([, request]) => request));
            expect(requests).not.toContain('/private/native');
            expect(requests).not.toContain('Private repository');
        }, { type: 'legacy', secret });
    });
    it('keeps real Pi cwd facts sealed until canonical Account Project acceptance, then publishes opaque IDs only', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-project-capture-'));
        let collector: ReturnType<typeof createNativeUsageCollector> | undefined;
        try {
            const agentDir = join(directory, 'agent');
            const nativeDir = join(agentDir, 'sessions', '--project--');
            await mkdir(nativeDir, { recursive: true });
            await writeFile(join(nativeDir, 'session.jsonl'), JSON.stringify({ type: 'session', version: 3,
                id: 'native-session', cwd: '/work/native', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n'
                + JSON.stringify({ type: 'message', id: 'paid', parentId: null, timestamp: '2026-01-01T00:00:01.000Z',
                    message: { role: 'assistant', model: 'model', provider: 'provider', timestamp: 1767225601000,
                        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 }, content: [] } }) + '\n');
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const store = createNativeUsageCaptureStore({ path: join(directory, 'capture.sealed'), authority, storage });
            const contribution = createPiExternalSessionsContribution({ env: { NODE_ENV: 'test', PI_CODING_AGENT_DIR: agentDir } });
            const rows: ProjectAccountRowV1[] = [];
            const transport = accountBoundary(rows);
            vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 0 } });
            const published: unknown[] = [];
            const attempted: unknown[] = [];
            let ingestAvailable = false;
            const deps = { authority, storage, store,
                resolveProject: createNativeUsageProjectResolver({ authority, storage, serverHttpBaseUrl: 'https://home.test',
                    readCredentials: async () => ({ token, encryption: null }) }),
                budgetRegistry: new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null }),
                discoverSources: async () => [{ agent: { pluginId: 'happier.agent.pi', localId: 'pi' },
                    source: { kind: 'piAgentDir', agentDir }, sourceKey: agentDir, root: agentDir, supported: true }],
                resolveRoot: async () => { throw new Error('No root edit requested'); },
                readAccounting: async (source: NativeUsageCaptureSource, signal: AbortSignal) => {
                    if (!contribution.readAccounting) throw new Error('Accounting absent');
                    return contribution.readAccounting({ source: source.source, cursor: source.cursor, ...createExternalSessionsInvocationFixture(signal) });
                },
                // OS observer boundary; the real codec, store, collector and publisher remain beneath it.
                subscribeSource: async () => ({ dispose() {} }),
                publisher: createUsageObservationPublisher({ token, apiServerUrl: 'https://home.test',
                    emitLegacyUsageReport: () => false,
                    fetchServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                        features: {}, capabilities: { server: { usageAnalytics: { version: 1,
                            eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                            legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
                        } } } }) }),
                    postJson: async request => {
                        attempted.push(request.body);
                        if (!ingestAvailable) throw Object.assign(new Error('Usage transport unavailable'), { response: { status: 503 } });
                        published.push(request.body);
                        return { ok: true };
                    },
                }),
                deleteHistory: async () => ({ success: true as const, deletedEventCount: 0 }),
            };
            collector = createNativeUsageCollector(deps);
            const [source] = await collector.discover();
            await collector.setConsent(source.sourceId, true);
            await collector.flushPending();
            expect(attempted).toEqual([]);
            expect(published).toEqual([]);
            expect((await store.load()).sources[0]).toMatchObject({ cursor: expect.any(String),
                pending: [{ inferenceId: 'paid', project: { rootPath: '/work/native' } }] });
            await collector.dispose();
            collector = undefined;
            await rm(join(nativeDir, 'session.jsonl'));
            vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
            collector = createNativeUsageCollector(deps);
            await collector.initialize();
            await collector.flushPending();
            const accepted = rows.find(row => row.key.kind === 'project-organization');
            const projectKey = accepted?.key.kind === 'project-organization' ? accepted.key.projectKey : null;
            expect(projectKey).toEqual(expect.any(String));
            expect(attempted.length).toBeGreaterThan(0);
            expect(published).toEqual([]);
            const pending = (await store.load()).sources[0].pending;
            expect(pending).toEqual([expect.objectContaining({ inferenceId: 'paid', projectKey })]);
            expect(pending[0]).not.toHaveProperty('project');
            expect(JSON.stringify(pending)).not.toContain('/work/native');
            await collector.dispose();
            collector = undefined;
            vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 0 } });
            ingestAvailable = true;
            collector = createNativeUsageCollector(deps);
            await collector.initialize();
            await collector.flushPending();
            expect(published).toHaveLength(1);
            const body = UsageEventIngestRequestSchema.parse(published[0]);
            expect(body).toMatchObject({ projectKey: accepted?.key.kind === 'project-organization' ? accepted.key.projectKey : null,
                workspaceId: null });
            expect(JSON.stringify(body)).not.toContain('/work/native');
            expect(JSON.stringify(body)).not.toContain(agentDir);
            expect(JSON.stringify(transport.mock.calls.map(([, request]) => request))).not.toContain('/work/native');
            expect((await store.load()).sources[0].pending).toEqual([]);
        } finally { await collector?.dispose(); await rm(directory, { recursive: true, force: true }); }
    });
});
