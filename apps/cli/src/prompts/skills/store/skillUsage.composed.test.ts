import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRecordV1Schema, buildPromptLibraryPhysicalKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import captured from '../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/__fixtures__/skillUsage.v1.json';
import { createClaudeSkillUsageWitness } from '../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/skillUsage';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { registerSessionListingRoutes } from '../../../../../server/sources/app/api/routes/session/registerSessionListingRoutes';
import { createPromptBundleInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { readSkillBundleContentV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import type { Fastify } from '../../../../../server/sources/app/api/types';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { db } from '../../../../../server/sources/storage/db';
import { eventRouter } from '../../../../../server/sources/app/events/connectionEventRouter';
import { getAccountStoredContentV3SocketRoom } from '../../../../../server/sources/app/api/socketRooms';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import * as persistence from '@/persistence';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { refreshActivePromptLibraryCatalog } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { createSkillUsageRecorder } from './skillUsage';

let database: LightSqliteHarness;
beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-p3f-seam-', initAuth: true, initEncrypt: true });
}, 120_000);
afterAll(async () => { await database?.close(); });

it('records captured vendor evidence through strict host projection, authenticated daemon HTTP and Server row CAS in SQLite', async () => {
    const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
    await db.session.create({ data: { id: captured.assistant.session_id, tag: 'skill-usage', accountId: account.id,
        encryptionMode: 'plain', metadata: '{}' } });
    for (const key of PromptLibraryCatalogKeyV1Schema.options) {
        await db.userKVStore.create({ data: { accountId: account.id, key: buildPromptLibraryPhysicalKeyV1(key), version: 0,
            value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: emptyPromptLibraryRecordV1(key) })) } });
    }
    const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    const server = createAuthenticatedTestApp({ authentication: 'real' }) as Fastify;
    let failRowReads = false;
    let rejectUsageWrite = false;
    let homeRequests = 0;
    const rowOutcomes: Array<{ method: string; status: string }> = [];
    let mutationParamsSchema: unknown;
    server.addHook('onRoute', route => {
        if (route.method === 'POST' && route.url === '/v1/account/entity-rows/prompt-library/:key') {
            mutationParamsSchema = route.schema?.params;
        }
    });
    server.addHook('onRequest', async (request, reply) => {
        homeRequests += 1;
        if (rejectUsageWrite && request.method === 'POST' && request.url === '/v1/account/entity-rows/prompt-library/skill-usage') {
            return reply.code(503).send({ error: 'fixture_no_write' });
        }
        // A lost Home response is a network boundary failure, not a fake row reader.
        if (failRowReads && request.method === 'GET' && request.url === '/v1/account/entity-rows/prompt-library') {
            return reply.code(503).send({ error: 'fixture_home_unavailable' });
        }
    });
    server.addHook('onSend', async (request, _reply, payload) => {
        if (request.url.endsWith('/prompt-library/skill-usage') && typeof payload === 'string') {
            const result: unknown = JSON.parse(payload);
            if (result && typeof result === 'object' && 'status' in result && typeof result.status === 'string') {
                rowOutcomes.push({ method: request.method, status: result.status });
            }
        }
        return payload;
    });
    accountRoutes(server);
    artifactsRoutes(server);
    registerSessionListingRoutes(server);
    const sockets = new Server(server.server, { path: '/v1/updates' });
    sockets.use((socket, next) => {
        const token: unknown = socket.handshake.auth.token;
        void (async () => {
            const verified = typeof token === 'string' ? await auth.verifyTokenForRoute(token) : null;
            if (!verified || verified.userId !== account.id) return next(new Error('Unauthorized'));
            await socket.join(getAccountStoredContentV3SocketRoom(verified.userId));
            next();
        })().catch(next);
    });
    eventRouter.setIo(sockets);
    const serverUrl = await server.listen({ port: 0, host: '127.0.0.1' });
    const observer = connect(serverUrl, { path: '/v1/updates', transports: ['websocket'],
        auth: { token: credentials.token }, reconnection: false });
    const wakes: unknown[] = [];
    observer.on('update', value => { wakes.push(value); });
    await new Promise<void>((resolve, reject) => {
        observer.once('connect', resolve); observer.once('connect_error', reject);
    });
    const releaseHome = publishServerHttpRuntimeOrigin(serverUrl, 'https');
    // Production constructs the recorder before warming the daemon's Account.
    resetActiveAccountSettingsSnapshotForTests();
    const recorder = createSkillUsageRecorder({ credentials });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const daemon = createDaemonControlApp({ getChildren: () => [], machineId: 'skill-seam-machine',
        stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'skill-seam-control', skillUsageRecorder: recorder });
    const daemonUrl = await daemon.listen({ port: 0, host: '127.0.0.1' });
    // The daemon state file is an OS boundary. Keep controlClient and its HTTP authentication real.
    vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: process.pid, httpPort: Number(new URL(daemonUrl).port),
        startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: 'skill-seam-control' });
    let now = Date.parse(captured.provenance.capturedAt);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const library = createCliApprovalsArtifactStore({ credentials });
    const created = await createPromptBundleInLibrary({ store: library.promptLibraryStore, request: {
        title: 'contract-skill', bundleSchemaId: 'skills.skill_md_v1', entries: [{ path: 'SKILL.md', contentKind: 'utf8',
            contentBase64: Buffer.from('---\nname: contract-skill\ndescription: Usage contract\n---\nRead this skill.\n').toString('base64') }],
    } });
    const skillId = created.artifactId;
    const content = readSkillBundleContentV1((await library.promptLibraryStore.read(skillId))!);
    if (!content) throw new Error('Created skill is unreadable');
    const actions = createSkillActionExecuteV1({ store: library.promptLibraryStore, skillRules: library.skillRules,
        randomId: () => { throw new Error('Read must not allocate an id'); },
        includeInSession: async () => { throw new Error('Read must not change selection'); } });
    const readList = async () => SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(
        await actions('skills.list', { query: 'contract-skill' }, { surface: 'cli' }));
    const delivery: AgentSessionSkillDelivery = { pluginRoot: join(database.baseDir, 'session-plugin'),
        skillsRoot: join(database.baseDir, 'session-plugin', 'skills'), nativeDisables: [],
        items: [{ name: 'contract-skill', skillId, digest: content.digest, directory: join(database.baseDir, 'session-plugin', 'skills', 'contract-skill') }] };
    let transcriptCommits = 0;
    const session = { sessionId: captured.assistant.session_id,
        enqueueAgentMessageCommitted: async () => { transcriptCommits += 1; return { persisted: true, delivered: true }; } };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        sessionId: session.sessionId, serverHttpBaseUrl: serverUrl, getCurrentSessionSkillItems: () => delivery.items }));
    // This is the successful Session-scoped skills.read path observed in native Codex QA.
    const readInSession = () => executor.execute('skills.read', { name: 'contract-skill', sessionId: session.sessionId },
        { surface: 'agent', defaultSessionId: session.sessionId });
    const projection = { session, skillDelivery: delivery, usageAccount: { accountId: account.id, serverHttpBaseUrl: serverUrl } };
    const witness = createClaudeSkillUsageWitness();
    witness.observe(captured.assistant);
    witness.observe(captured.toolResult);
    const event = AgentSessionRuntimeEventSchema.parse({ kind: 'skill-usage', sequence: 1,
        sessionId: session.sessionId, emittedAtMs: now, turnId: 'vendor-skill-turn', skills: witness.finish() });
    if (event.kind !== 'skill-usage') throw new Error('Expected producer skill usage');
    const readPersisted = async () => {
        const row = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: {
            accountId: account.id, key: buildPromptLibraryPhysicalKeyV1('skill-usage') } } });
        const envelope: unknown = JSON.parse(new TextDecoder().decode(row.value!));
        if (!envelope || typeof envelope !== 'object' || !('t' in envelope) || envelope.t !== 'plain' || !('v' in envelope)) {
            throw new Error('Expected persisted plain Account envelope');
        }
        const record = PromptLibraryRecordV1Schema.parse(envelope.v);
        if (record.key !== 'skill-usage') throw new Error('Wrong consumer row');
        return { revision: row.version, value: record.value };
    };
    try {
        const producerKey = emptyPromptLibraryRecordV1('skill-usage').key;
        if (!mutationParamsSchema || typeof mutationParamsSchema !== 'object') throw new Error('Missing registered row params');
        const parseParams: unknown = Reflect.get(mutationParamsSchema, 'parse');
        if (typeof parseParams !== 'function') throw new Error('Registered row params have no canonical parser');
        expect(Reflect.apply(parseParams, mutationParamsSchema, [{ key: producerKey }])).toEqual({ key: producerKey });
        expect(() => Reflect.apply(parseParams, mutationParamsSchema, [{ key: buildPromptLibraryPhysicalKeyV1(producerKey) }])).toThrow();
        expect(event.skills).toEqual([{ name: 'happier:contract-skill' }]);
        expect(await readList()).toMatchObject({ usageObservedSince: null, items: [{ skillId }] });
        expect(AgentSessionRuntimeEventSchema.safeParse({ ...event, unexpected: true }).success).toBe(false);
        rejectUsageWrite = true;
        expect(await projectRuntimeTranscriptEvent({ ...projection, event })).toEqual({ projected: true, kind: 'skill-usage' });
        expect(await readPersisted()).toEqual({ revision: 0, value: { v: 1, lastUsedAt: {} } });
        rejectUsageWrite = false;
        now += 100;
        // This is a fresh native use, never a queued replay of the rejected observation.
        expect(await projectRuntimeTranscriptEvent({ ...projection, event: { ...event, sequence: 2, emittedAtMs: now } }))
            .toEqual({ projected: true, kind: 'skill-usage' });
        expect(await readPersisted()).toEqual({ revision: 1, value: { v: 1, lastUsedAt: { [skillId]: now } } });
        expect(await readList()).toMatchObject({ usageObservedSince: now, items: [{ skillId, lastUsedAt: now }] });
        expect(rowOutcomes).toContainEqual({ method: 'POST', status: 'updated' });
        await vi.waitFor(() => expect(wakes).toContainEqual(expect.objectContaining({ body: expect.objectContaining({
            t: 'account-change', entityIds: [buildPromptLibraryPhysicalKeyV1('skill-usage')],
        }) })));
        await projectRuntimeTranscriptEvent({ ...projection, event: { ...event, sequence: 2 } });
        expect(await readInSession()).toMatchObject({ ok: true, result: { skillId, lastUsedAt: now } });
        expect((await readPersisted()).revision).toBe(1);

        const requestsBeforeForeignEvidence = homeRequests;
        await projectRuntimeTranscriptEvent({ ...projection, usageAccount: { ...projection.usageAccount, accountId: 'foreign-account' },
            event: { ...event, sequence: 3 } });
        expect(homeRequests).toBe(requestsBeforeForeignEvidence);
        expect((await readPersisted()).revision).toBe(1);

        // Explicit native paths override a coincidentally matching delivered name.
        const nativeEvent = AgentSessionRuntimeEventSchema.parse({ ...event, sequence: 4,
            skills: [{ name: 'happier:contract-skill', path: join(database.baseDir, 'native', 'contract-skill', 'SKILL.md') }] });
        expect(await projectRuntimeTranscriptEvent({ ...projection, event: nativeEvent })).toEqual({ projected: false, reason: 'unsupported_event' });
        expect((await readPersisted()).revision).toBe(1);

        now += 86_400_000;
        // A genuine competing row writer advances the Server CAS while the daemon retains revision 1.
        const competitor = createCliPromptLibraryStore({ credentials });
        expect(await competitor.writeRecord({ expectedRevision: 1, record: { key: 'skill-usage', value: {
            v: 1, lastUsedAt: { [skillId]: now - 86_400_000, 'other-skill': now } } } })).toMatchObject({ status: 'updated', revision: 2 });
        await projectRuntimeTranscriptEvent({ ...projection, event: { ...event, sequence: 5, emittedAtMs: now } });
        expect(rowOutcomes).toContainEqual({ method: 'POST', status: 'conflict' });
        expect(await readPersisted()).toEqual({ revision: 2, value: { v: 1, lastUsedAt: {
            [skillId]: now - 86_400_000, 'other-skill': now } } });

        failRowReads = true;
        expect((await refreshActivePromptLibraryCatalog({ credentials })).status).toBe('unavailable');
        const mutationsBeforeFailure = rowOutcomes.filter(row => row.method === 'POST').length;
        await projectRuntimeTranscriptEvent({ ...projection, event: { ...event, sequence: 6, emittedAtMs: now } });
        expect((await readPersisted()).revision).toBe(2);
        expect(rowOutcomes.filter(row => row.method === 'POST')).toHaveLength(mutationsBeforeFailure);
        failRowReads = false;
        expect(await readInSession()).toMatchObject({ ok: true, result: { skillId } });
        expect(await readPersisted()).toEqual({ revision: 3, value: { v: 1, lastUsedAt: { [skillId]: now, 'other-skill': now } } });
        expect(await readList()).toMatchObject({ usageObservedSince: now, items: [{ skillId, lastUsedAt: now }] });
        expect(transcriptCommits).toBe(0);
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
        expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
    } finally {
        vi.restoreAllMocks();
        resetActiveAccountSettingsSnapshotForTests();
        releaseHome();
        await daemon.close();
        observer.disconnect();
        eventRouter.clearIo();
        await sockets.close();
        await server.close();
    }
});
