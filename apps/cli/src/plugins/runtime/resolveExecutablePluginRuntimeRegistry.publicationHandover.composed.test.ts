import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, type PluginServices } from '@happier-dev/plugin-sdk';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountProfileSchema, FeaturesResponseSchema, ApprovalRequestV2Schema } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DISCUSSION_HTTP_PATHS_V1, DiscussionPostResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { configuration } from '@/configuration';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

function response<T>(data: T): AxiosResponse<T> {
    return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

afterEach(() => vi.restoreAllMocks());

describe('native plugin publication approval handover', () => {
    it.each(['approve', 'reject'] as const)('keeps original consent across changed executable bytes through %s', async decision => {
        await handover({ decision });
    });

    it('keeps explicit caller withdrawal canceled', async () => {
        await handover({ withdraw: true });
    });

    it('asks again for changed canonical publication input', async () => {
        await handover({ changedInput: true });
    });

    it('cancels an attachment-bearing request on retirement and asks again with fresh paths', async () => {
        await handover({ attachments: true });
    });
});

type HandoverScenario = { decision?: 'approve' | 'reject'; withdraw?: boolean; changedInput?: boolean; attachments?: boolean };

async function handover(scenario: HandoverScenario) {
    return withConfiguredDaemonTestHome({ prefix: 'publication-handover-', env: {
        HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', HAPPIER_ACTIONS_SETTINGS_V1: undefined,
    } }, () => runHandover(scenario));
}

async function runHandover(scenario: HandoverScenario) {
    const socket = await createRequesterCurrentnessSocketHarness();
    const pluginId = 'happier.channels';
    const accountId = 'publication-owner';
    const machineId = 'publication-machine';
    const serverIdentityId = 'publication-home';
    const input = { discussionId: 'discussion', localId: 'retained-obligation', content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Retained inbound message' }] } };
    const artifacts = new Map<string, { id: string; header: string; body: string; headerVersion: number; bodyVersion: number;
        dataEncryptionKey: string; ownerAccountId: string; access: 'owner'; encryptionMode: 'plain'; seq: number; createdAt: number; updatedAt: number }>();
    const publications: unknown[] = [];
    const http: string[] = [];
    const coordinator = getSharedBlockingApprovalCoordinator();
    const accountSettings = accountSettingsParse({ actionsSettingsV1: { v: 1,
        actions: { 'discussion.post': { approvalRequiredSurfaces: ['plugin'] } } } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        http.push(`FETCH ${path}`);
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } },
            capabilities: { serverIdentity: { serverIdentityId } } }));
        if (path === '/v1/account/encryption/currentness') return Response.json(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
        throw new Error(`Unexpected fetch path ${path}`);
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        http.push(`GET ${path}`);
        if (path === '/v1/account/profile') return response(AccountProfileSchema.parse({ id: accountId }));
        if (path === '/v1/account/encryption') return response({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return response(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
        if (path === '/v2/changes') return response({ changes: [], nextCursor: 0 });
        if (path === '/v1/account/settings' || path === '/v2/account/settings') return response({ version: 1, content: { t: 'plain', v: accountSettings } });
        const artifact = artifacts.get(path.split('/').at(-1)!);
        if (artifact) return response(artifact);
        if (path.startsWith('/v1/artifacts/')) return { ...response({ error: 'not_found' }), status: 404 };
        throw new Error(`Unexpected GET path ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const path = new URL(String(url)).pathname;
        http.push(`POST ${path}`);
        if (path === '/v1/artifacts/read') return response(artifactReadResponse(body, id => artifacts.get(id) ?? null).data);
        if (path === '/v1/artifacts') {
            const value = body as { id: string; header: string; body: string };
            if (artifacts.has(value.id)) throw Object.assign(new Error('conflict'), { code: 'conflict' });
            artifacts.set(value.id, { ...value, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, ownerAccountId: accountId,
                access: 'owner', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return response({ id: value.id, headerVersion: 1, bodyVersion: 1 });
        }
        if (path.startsWith('/v1/artifacts/')) {
            const artifact = artifacts.get(path.split('/').at(-1)!);
            if (!artifact) throw new Error('Unknown approval');
            const value = body as { header: string; body: string; expectedHeaderVersion: number; expectedBodyVersion: number };
            expect(value.expectedHeaderVersion).toBe(artifact.headerVersion);
            expect(value.expectedBodyVersion).toBe(artifact.bodyVersion);
            Object.assign(artifact, { header: value.header, body: value.body, headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1 });
            return response({ success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion });
        }
        throw new Error(`Unexpected POST path ${path}`);
    });
    // Replace only Home HTTP. Native publication, encryption and result parsing stay real.
    vi.spyOn(axios, 'request').mockImplementation(async config => {
        const path = new URL(config.url!).pathname;
        http.push(`${config.method} ${path}`);
        if (config.method === 'GET' && path === DISCUSSION_HTTP_PATHS_V1.discussion.replace(':discussionId', input.discussionId)) {
            return response({ discussion: DiscussionSummaryV1Schema.parse({ id: input.discussionId, ownerAccountId: accountId,
                encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null,
                creationLocalId: 'creation', titleContent: { t: 'plain', v: { v: 1, title: 'Discussion' } },
                latestMessage: { id: 'root', localId: 'root', seq: 1, authorAccountId: accountId,
                    accountActor: { v: 1, accountId, profile: null }, producerV1: null, createdAt: 1 },
                messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [accountId], archivedAt: null,
                capabilities: { postMessages: true, rename: true, archive: true, restore: false,
                    askAgent: true, sendToSession: true, manageAccess: true, leave: false } }) });
        }
        if (config.method === 'POST' && path === DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', input.discussionId)) {
            publications.push(JSON.parse(config.data));
            return response(DiscussionPostResponseV1Schema.parse({ messageSeq: 2, message: {
                id: 'message', discussionId: input.discussionId, localId: input.localId, seq: 2, authorAccountId: accountId,
                accountActor: { v: 1, accountId, profile: null }, producerV1: null,
                content: { t: 'plain', v: input.content }, mentionedAccountIds: [], createdAt: 1,
            } }));
        }
        throw new Error(`Unexpected native publication path ${path}`);
    });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    const approvals = createCliApprovalsArtifactStore({ credentials });
    const decisionExecutor = createCliActionExecutorHarness({ credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
        serverId: configuration.activeServerId, serverHttpBaseUrl: configuration.apiServerUrl,
        actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettings, allowEnvironmentOverride: false }),
    }).executor;
    type Module = { state: { started?: number; result?: unknown; error?: unknown; actions?: PluginServices['actions'] }; withdraw(): void };
    const createOccurrence = async (generation: number, predecessor?: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>) => {
        const blobId = '11111111-1111-4111-8111-111111111111';
        const publication = scenario.attachments
            ? { ...input, content: { ...input.content, parts: [...input.content.parts, { t: 'attachment', attachment: {
                kind: 'file', id: blobId, name: 'inbound.txt', file: { blobId, mime: 'text/plain', sizeBytes: 1, sha256: 'a'.repeat(64) },
            } }] }, attachmentSources: [{ blobId, path: join(tmpdir(), `channel-attachments-${generation}`, '0') }] }
            : scenario.changedInput && generation === 2
                ? { ...input, content: { v: 1, parts: [{ t: 'text', text: 'Changed inbound message' }] } } : input;
        const plugin = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            backgroundServices: [{ declaration: { id: 'router', title: 'Channels router' }, runner: async () => {} }] });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            ...(predecessor ? { happyHomeDir: predecessor.happyHomeDir, controller: predecessor.controller } : {}),
            plugins: [{ manifest: plugin.manifest, replaceExisting: predecessor !== undefined,
                // Physical modules are loaded, admitted and retired by the production owners.
                // Changing the function's behavior ensures this is a genuine code update.
                files: { 'daemon.mjs': `export const state = {}; const caller = new AbortController();
export function withdraw() { caller.abort(); }
export function activate(api) { api.backgroundServices.register('router', async context => {
  state.started = ${generation}; state.actions = context.services.actions;
  try { state.result = await context.services.actions.execute('discussion.post', ${JSON.stringify(publication)},
    { signal: ${scenario.withdraw ? 'caller.signal' : 'context.signal'} }); }
  catch (error) { state.error = error; }
}); }` } }],
            async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })); },
            runtimeOptions: { scopedActionRuntime: { credentials,
                actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettings, allowEnvironmentOverride: false }) },
                resolveCurrentMachineId: () => machineId,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId, machineId }) },
        });
        return { fixture, module: fixture.modulesByPluginId.get(pluginId) as unknown as Module };
    };
    const incumbent = await createOccurrence(1);
    let successor: Awaited<ReturnType<typeof createOccurrence>> | undefined;
    try {
        incumbent.fixture.registry.startAdoptedBackgroundServices?.();
        await vi.waitFor(() => { if (incumbent.module.state.error) throw new Error(`Publication failed; HTTP paths: ${http.join(', ')}`, { cause: incumbent.module.state.error }); expect(artifacts.size).toBe(1); });
        const artifactId = [...artifacts.keys()][0]!;
        const readRequest = async () => ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId }));
        const original = await readRequest();
        await vi.waitFor(() => expect(coordinator.getLiveWaiterCount(artifactId)).toBe(1));
        expect(original.status).toBe('open');
        expect(publications).toHaveLength(0);
        if (scenario.withdraw) {
            incumbent.module.withdraw();
            await vi.waitFor(async () => expect((await readRequest()).status).toBe('canceled'));
            expect(publications).toHaveLength(0);
            return;
        }
        successor = await createOccurrence(2, incumbent.fixture);
        successor.fixture.registry.startAdoptedBackgroundServices?.();
        if (scenario.attachments || scenario.changedInput) {
            if (scenario.attachments) await vi.waitFor(async () => expect((await readRequest()).status).toBe('canceled'));
            await vi.waitFor(() => {
                if (successor!.module.state.error) throw successor!.module.state.error;
                expect(artifacts.size).toBe(2);
                expect(coordinator.getLiveWaiterCount([...artifacts.keys()][1]!)).toBe(1);
            });
            const nextArtifactId = [...artifacts.keys()][1]!;
            const nextRequest = ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId: nextArtifactId }));
            expect(nextRequest.status).toBe('open');
            if (scenario.attachments) {
                expect(nextRequest.actionArgs).toMatchObject({ attachmentSources: [{ path: join(tmpdir(), 'channel-attachments-2', '0') }] });
            } else {
                expect(nextRequest.actionArgs).toMatchObject({ content: { parts: [{ t: 'text', text: 'Changed inbound message' }] } });
            }
            expect(coordinator.getLiveWaiterCount(artifactId)).toBe(0);
            expect(publications).toHaveLength(0);
            return;
        }
        await vi.waitFor(() => { if (successor!.module.state.error) throw successor!.module.state.error;
            expect(successor!.module.state.started).toBe(2); expect(coordinator.getLiveWaiterCount(artifactId)).toBe(1); });
        expect(artifacts.size).toBe(1);
        expect(await readRequest()).toEqual(original);
        const result = await decisionExecutor.execute('approval.request.decide', { artifactId, decision: scenario.decision }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverIdentityId, runtimeAccountId: accountId,
        });
        expect(result.ok).toBe(true);
        await vi.waitFor(async () => {
            const current = await readRequest();
            if (current.status === 'failed') throw new Error(`Publication failed: ${current.execution?.errorCode}; HTTP paths: ${[...new Set(http)].join(', ')}`);
            expect(current.status).toBe(scenario.decision === 'approve' ? 'executed' : 'rejected');
        });
        expect(publications).toHaveLength(scenario.decision === 'approve' ? 1 : 0);
        const settled = await readRequest();
        expect(settled.createdAtMs).toBe(original.createdAtMs);
        expect(settled.executionOriginV1).toEqual(original.executionOriginV1);
        if (scenario.decision === 'approve') {
            expect(publications[0]).toMatchObject({ localId: input.localId, content: { t: 'plain', v: input.content } });
        }
        expect(publications).toHaveLength(scenario.decision === 'approve' ? 1 : 0);
        expect(artifacts.size).toBe(1);
    } finally {
        for (const artifactId of artifacts.keys()) coordinator.cancelApproval(artifactId);
        await successor?.fixture.dispose();
        await incumbent.fixture.dispose();
        await socket.close();
    }
}
