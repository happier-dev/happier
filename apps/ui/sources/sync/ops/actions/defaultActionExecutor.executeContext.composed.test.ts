// Real Server event producer→UI consumer composition is not a package-local compiler root.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createScmCapabilities } from '@happier-dev/protocol/scm';
import { ApprovalRequestSchema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { projectLegacySessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createHydratedPlainMachineFixture, createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { buildUpdateArtifactUpdate } from '../../../../../server/sources/app/events/artifactEventPayloadBuilders';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel:
// the harness installs its network boundaries with `vi.doMock`, which only
// reaches modules imported afterwards (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    createHomeGovernanceHarness,
    createAccountTokenForTests,
    installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { DiscussionCreateRequestV1Schema, DiscussionCreateResponseV1Schema, type DiscussionCreateRequestV1 } from '@happier-dev/protocol/discussions/api';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import type { DataKeyAuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import tweetnacl from 'tweetnacl';
import type { PluginActionInputById } from '@happier-dev/plugin-sdk/actions';

installDisconnectedServerSocketBoundary();

/**
 * The Account context, its Artifact codec, the approval writer's
 * compare-and-set and the Home family transports all run for real. Only the
 * Home's network (including its stateful Artifact routes) and the device
 * credential store are replaced, by the Home governance harness.
 *
 * The one wrapper below observes — and does not replace — the real context's
 * lifetime: `withDefaultActionExecuteContext` owns releasing every captured
 * context, and a released context has no other observable surface.
 */
const lifetime = vi.hoisted(() => ({ disposed: 0, runPrepared: 0 }));

vi.mock('./actionAccountContext', async (importOriginal) => {
    const original = await importOriginal<typeof import('./actionAccountContext')>();
    return {
        ...original,
        captureLazyActionAccountContext: (async (...args: Parameters<typeof original.captureLazyActionAccountContext>) => {
            const context = await original.captureLazyActionAccountContext(...args);
            return {
                ...context,
                dispose: () => {
                    lifetime.disposed += 1;
                    context.dispose();
                },
                runPrepared: async <T>(run: () => Promise<T>, effectClass?: Parameters<typeof context.runPrepared>[1]): Promise<T> => {
                    lifetime.runPrepared += 1;
                    return await context.runPrepared(run, effectClass);
                },
            };
        }) as typeof original.captureLazyActionAccountContext,
    };
});

const follow = vi.hoisted(() => ({
    execute: vi.fn(),
    prepareSourceKey: vi.fn(),
}));

const rpc = vi.hoisted(() => ({
    machine: vi.fn(),
}));

vi.mock('@/sync/api/session/sessionFollowApi', () => ({
    sessionFollowAction: follow.execute,
}));

vi.mock('@/components/sessions/follow/prepareSessionFollowSourceKey', () => ({
    prepareSessionFollowSourceKey: follow.prepareSourceKey,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: rpc.machine,
}));

const harness = createHomeGovernanceHarness();
const httpBoundary = { ...harness, request: createSessionReadBatchFetchBoundary(harness.request) };
let ingressConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
installHomeGovernanceBoundaries(httpBoundary);
// Load the real executor after installing its environment boundaries. Cold graph
// transformation belongs to collection, rather than a single behavior test's timer.
const executorModule = await import('./defaultActionExecutor');
const { handleSocketUpdate } = await import('@/sync/engine/socket/socket');

const ACCOUNT_ID = 'account-a';
// A Home publishes its portable identity in the canonical `srv_` grammar; the
// profile owner rejects any other shape, so no other value can reach an origin.
const SERVER_IDENTITY_ID = 'srv_stable-home-a';

const APPROVAL_REQUIRED_ACTIONS_SETTINGS = {
    actionsSettingsV1: {
        v: 1,
        actions: {
            'review.walkthrough': {
                enabledPlacements: [],
                disabledSurfaces: [],
                disabledPlacements: [],
                approvalRequiredSurfaces: ['ui', 'plugin'],
            },
            'identity.providers.secret.replace': {
                enabledPlacements: [],
                disabledSurfaces: [],
                disabledPlacements: [],
                approvalRequiredSurfaces: ['ui'],
            },
            'session.access.context.set': {
                enabledPlacements: [],
                disabledSurfaces: [],
                disabledPlacements: [],
                approvalRequiredSurfaces: ['ui'],
            },
            'discussion.archive': {
                enabledPlacements: [],
                disabledSurfaces: [],
                disabledPlacements: [],
                approvalRequiredSurfaces: ['ui'],
            },
        },
    },
} as const;

/**
 * One Home holding `account-a`, whose persisted Account settings require
 * approval for the Actions these cases defer. The settings are served at the
 * Home's real settings route, which the captured Account context reads.
 */
async function addHome(options: Readonly<{ collaboration?: boolean; currentAccount?: boolean }> = {}): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        serverIdentityId: SERVER_IDENTITY_ID,
        accountId: ACCOUNT_ID,
        ...(options.currentAccount ? { currentAccount: true } : {}),
    });
    harness.answer(serverId, '/v2/account/settings', {
        body: { content: { t: 'plain', v: APPROVAL_REQUIRED_ACTIONS_SETTINGS }, version: 1 },
    });
    if (options.collaboration) {
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const features = createRootLayoutFeaturesResponse({
            features: {
                sharing: { session: { enabled: true } },
            } as never,
        });
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    }
    return serverId;
}

/** The approval request exactly as the Home persisted it. */
function storedApproval(serverId: string, artifactId: string): Readonly<{ json: string; request: unknown }> {
    const json = harness.artifacts(serverId).readPlainBody(artifactId);
    if (json === null) throw new Error(`approval_artifact_missing:${artifactId}`);
    return { json, request: JSON.parse(json) };
}

function createdArtifactId(result: unknown): string {
    const artifactId = (result as { result?: { artifactId?: unknown } } | null)?.result?.artifactId;
    if (typeof artifactId !== 'string') throw new Error('approval_artifact_not_created');
    return artifactId;
}

async function loadExecutor() {
    return executorModule;
}

describe('withDefaultActionExecuteContext', () => {
    it.each(['detached', 'attached'] as const)('keeps a direct %s PR Review on the selected Home Machine when access is unavailable', async placement => {
        const serverId = await addHome({ collaboration: placement === 'attached' });
        const { createDefaultActionExecutor } = await loadExecutor();
        harness.answer(serverId, 'POST /v1/machines/read-batch', {
            body: { results: [{ machineId: 'review-machine', status: 'not_found' }] },
        });
        if (placement === 'attached') {
            harness.answer(serverId, '/v2/sessions/review-session?accessProjectionVersion=1', { body: { session: {
                id: 'review-session', createdAt: 1, updatedAt: 2, seq: 1, active: false, activeAt: 2,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1,
                metadata: JSON.stringify({ machineId: 'review-machine', path: '/workspace', host: 'review-host' }),
                agentStateVersion: 1, agentState: null, share: null,
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                    capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
                responsibleAccountId: null, responsibleAccount: null,
            } } });
        }

        const result = await createDefaultActionExecutor().execute('review.start', {
            ...(placement === 'detached' ? { target: { kind: 'detached' } } : {}), cwd: '/workspace',
            reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review the pull request.',
            source: { kind: 'pullRequest', locator: { providerId: 'github', repository: 'org/repo', number: 42 } },
        }, { serverId, surface: 'ui', authority: 'present_user', ...(placement === 'detached'
            ? { executionRunTargetMachineId: 'review-machine' } : { defaultSessionId: 'review-session' }) });

        expect(result).toMatchObject({ ok: false, errorCode: 'access_denied', effectAttempted: false });
        expect(harness.requestsFor('/v1/machines/read-batch')).toHaveLength(1);
    });

    it('sends a direct PR Review with the captured Account and Machine to the requester daemon', async () => {
        const serverId = await addHome({ currentAccount: true });
        const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const locator = { providerId: 'github', repository: 'org/repo', number: 42 };
        const rejected = { errorCode: 'fixture_receipt', error: 'fixture_receipt', effectAttempted: false };
        await answerExternalActionAccountForHome(harness, serverId, {
            actionId: 'review.start', machineId: 'review-machine', tokenEpoch: 0, requesterInvocation: 'required',
            execute(input, context) {
                expect(input).toMatchObject({ target: { kind: 'detached' }, cwd: '/workspace', source: { kind: 'pullRequest', locator } });
                expect(context.invocation).toMatchObject({ surface: 'ui', authority: 'present_user' });
                expect(context.authorization.binding).toMatchObject({ accountId: ACCOUNT_ID, machineId: 'review-machine' });
                return rejected;
            },
            failure: () => rejected,
        });

        const { createDefaultActionExecutor } = await loadExecutor();
        expect(await createDefaultActionExecutor().execute('review.start', {
            target: { kind: 'detached' }, cwd: '/workspace',
            reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review the pull request.',
            source: { kind: 'pullRequest', locator },
        }, { serverId, surface: 'ui', authority: 'present_user', externalActionTarget: { kind: 'machine', machineId: 'review-machine' } }))
            .toMatchObject({ ok: false, ...rejected });
        expect(harness.requestsFor('/v1/actions/review.start').filter(request => request.method === 'POST')).toHaveLength(1);
    });

    beforeEach(async () => {
        await harness.reset();
        installHomeGovernanceBoundaries(httpBoundary);
        lifetime.disposed = 0;
        lifetime.runPrepared = 0;
        follow.execute.mockReset();
        follow.prepareSourceKey.mockReset();
        rpc.machine.mockReset();
    });

    afterEach(async () => {
        standardCleanup();
        if (ingressConnection) {
            try { await ingressConnection.dispose(); }
            finally {
                ingressConnection = null;
                installHomeGovernanceBoundaries(httpBoundary);
            }
        }
    });

    it.each(['board.item.reveal', 'chat.item.show'] as const)('admits mounted Session %s through its Action and refuses disabled or mismatched targets', async kind => {
        const serverId = await addHome();
        let disabled = true;
        harness.answer(serverId, '/v2/account/settings', { select: () => ({ body: { version: 1,
            content: { t: 'plain', v: { actionsSettingsV1: { v: 1, actions: {
                'session.presentation.apply': { disabledSurfaces: disabled ? ['ui'] : [] },
            } } } } } }) });
        let panel: string | null = null;
        let mounted = true;
        // The mounted navigation destination is the UI platform boundary; Account admission stays real.
        const executor = executorModule.createDefaultActionExecutor({
            currentSessionPresentationApply: { serverId, accountId: ACCOUNT_ID, sessionId: 'session-a',
                isCurrent: () => mounted,
                apply: async ({ input }) => {
                    if (input.intent.kind !== kind) throw new Error('unexpected presentation intent');
                    if (input.intent.kind === 'chat.item.show') expect(input.intent.occurrenceId).toBe('reply-second');
                    panel = input.intent.widgetId;
                    return { status: 'applied', revision: 'mounted-revision' };
                },
            },
        });
        const context = { surface: 'ui', authority: 'present_user', serverId,
            expectedAccountId: ACCOUNT_ID, defaultSessionId: 'session-a' } as const;
        const input = { intent: { kind, widgetId: 'visual-a', ...(kind === 'chat.item.show' ? { occurrenceId: 'reply-second' } : {}) } } as const;
        expect(await executor.execute('session.presentation.apply', input, context)).toMatchObject({ ok: false });
        expect(panel).toBeNull();
        disabled = false;
        expect(await executor.execute('session.presentation.apply', input, context))
            .toEqual({ ok: true, result: { status: 'applied', revision: 'mounted-revision' } });
        expect(panel).toBe('visual-a');
        panel = null;
        expect(await executor.execute('session.presentation.apply', input, { ...context, defaultSessionId: 'session-b' }))
            .toMatchObject({ ok: false, errorCode: 'session_not_selected' });
        expect(panel).toBeNull();
        expect(await executor.execute('session.presentation.apply', input, { ...context, expectedAccountId: 'foreign-account' }))
            .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(panel).toBeNull();
        const otherHome = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other-home.example', accountId: ACCOUNT_ID });
        harness.answer(otherHome, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {} } } });
        expect(await executor.execute('session.presentation.apply', input, { ...context, serverId: otherHome }))
            .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(panel).toBeNull();
        mounted = false;
        expect(await executor.execute('session.presentation.apply', input, context))
            .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(panel).toBeNull();
    });

    it.each(['execute', 'prepare'] as const)('reports a Home that cannot answer admission settings before %s dispatch', async (entry) => {
        const serverId = await addHome();
        harness.answer(serverId, '/v2/account/settings', { dispatchThenFail: true });
        const executor = executorModule.createDefaultActionExecutor();
        const input = { intent: { kind: 'reorder' as const, sectionIds: ['attention', 'sessions'] } };
        const context = { surface: 'ui' as const, serverId, expectedAccountId: ACCOUNT_ID };
        const result = entry === 'execute'
            ? await executor.execute('home.hub.layout.update', input, context)
            : await executor.prepare('home.hub.layout.update', input, context);
        expect(result).toMatchObject(entry === 'execute'
            ? { ok: false, errorCode: 'server_unreachable', error: 'server_unreachable' }
            : { kind: 'settled', result: { ok: false, errorCode: 'server_unreachable', error: 'server_unreachable' } });
        expect(harness.requestsFor('/v1/artifacts')).toHaveLength(0);
    });

    it('executes storage reads and sizing through the captured Home and Account family', async () => {
        const serverId = await addHome();
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const capturedServerId = resolveServerProfileScopeIdForIdentifier(serverId);
        const summary = { revision: 1, sizedAt: 100, volumes: [], categories: [], suggestionsTop: [],
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 },
            wholeDisk: { enabled: false, scans: [] } };
        const category = { revision: 1, sizedAt: 100, categoryId: 'logs', items: [] };
        rpc.machine.mockImplementation(async ({ method }) => method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST ? category : summary);
        for (const [actionId, input, expected, method] of [
            ['machines.storage.summary.get', { serverId, machineId: 'one' }, summary, RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET],
            ['machines.storage.category.list', { serverId, machineId: 'one', categoryId: 'logs' }, category, RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST],
            ['machines.storage.size.refresh', { serverId, machineId: 'one' }, summary, RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH],
        ] as const) {
            expect(await executorModule.createDefaultActionExecutor().execute(actionId, input, { surface: 'ui', expectedAccountId: ACCOUNT_ID }))
                .toEqual({ ok: true, result: expected });
            expect(rpc.machine).toHaveBeenLastCalledWith(expect.objectContaining({ serverId: capturedServerId,
                accountId: ACCOUNT_ID, machineId: 'one', method, payload: { ...input, serverId: capturedServerId }, preferScoped: true }));
        }
    });

    it('reads the machine guard and its Activity through the captured Home and Account family', async () => {
        const serverId = await addHome();
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const { createMachineGuardViewFixture } = await import('@/sync/domains/machines/guard/guardViewFixtures');
        const capturedServerId = resolveServerProfileScopeIdForIdentifier(serverId);
        const view = createMachineGuardViewFixture();
        const activity = { entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 100 };
        rpc.machine.mockImplementation(async ({ method }) => method === 'machines.guard.activity.list' ? activity : view);
        for (const [actionId, input, expected, method] of [
            ['machines.guard.get', { serverId, machineId: 'one' }, view, RPC_METHODS.MACHINES_GUARD_GET],
            ['machines.guard.activity.list', { serverId, machineId: 'one', range: '7d', filter: 'all' }, activity, RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST],
        ] as const) {
            expect(await executorModule.createDefaultActionExecutor().execute(actionId, input, { surface: 'ui', expectedAccountId: ACCOUNT_ID }))
                .toEqual({ ok: true, result: expected });
            expect(rpc.machine).toHaveBeenLastCalledWith(expect.objectContaining({ serverId: capturedServerId,
                accountId: ACCOUNT_ID, machineId: 'one', method, payload: { ...input, serverId: capturedServerId }, preferScoped: true }));
        }
    });

    it('reads machine resources through the captured Home and Account without a Session', async () => {
        const serverId = await addHome();
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const capturedServerId = resolveServerProfileScopeIdForIdentifier(serverId);
        const { createDefaultActionExecutor } = await loadExecutor();
        const snapshot = { state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
        const history = { range: '24h', bucketMs: 300_000, points: [], today: { rxBytes: 0, txBytes: 0 } };
        rpc.machine.mockImplementation(async ({ method }) => method === RPC_METHODS.MACHINES_VITALS_GET ? snapshot : history);
        for (const [actionId, input, result] of [
            ['machines.vitals.get', { serverId, machineId: 'one', view: 'overview' }, snapshot],
            ['machines.vitals.history.get', { serverId, machineId: 'one', range: '24h' }, history],
        ] as const) {
            expect(await createDefaultActionExecutor().execute(actionId, input, { surface: 'ui' })).toEqual({ ok: true, result });
            expect(rpc.machine).toHaveBeenLastCalledWith(expect.objectContaining({
                serverId: capturedServerId, accountId: ACCOUNT_ID, machineId: 'one', method: actionId,
                payload: { ...input, serverId: capturedServerId }, preferScoped: true,
            }));
        }
        const { storage } = await import('@/sync/domains/state/storage');
        // The published-content producer is VU3; this boundary fixture carries its narrow share-safe read projection.
        const daemonState = { status: 'running', resources: { vitals: { state: 'reporting' }, attention: { level: 'look', reasons: [] } } };
        storage.getState().applyMachines([
            createMachineFixture({ id: 'one', activeAt: Date.now(), daemonState }),
            createMachineFixture({ id: 'older', activeAt: Date.now() }),
            createMachineFixture({ id: 'offline', active: false, activeAt: 0, daemonState }),
        ], true, { sourceServerId: serverId });
        rpc.machine.mockClear();
        expect(await createDefaultActionExecutor().execute('machines.vitals.summaries.list', { serverId }, { surface: 'ui' }))
            .toMatchObject({ ok: true, result: expect.arrayContaining([
                expect.objectContaining({ machineId: 'one', state: 'reporting', attention: { level: 'look', reasons: [] } }),
                expect.objectContaining({ machineId: 'older', state: 'not_reporting' }),
                expect.objectContaining({ machineId: 'offline', state: 'offline' }),
            ]) });
        expect(rpc.machine).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            serverId: capturedServerId, accountId: ACCOUNT_ID, machineId: 'one', method: RPC_METHODS.MACHINES_VITALS_GET,
            payload: { serverId: capturedServerId, machineId: 'one', view: 'summary' },
        }));
    });

    it('returns merged conversation JSON through the mounted client Action', async () => {
        await loadSyncSingletonForTests();
        const serverId = await addHome();
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            ...APPROVAL_REQUIRED_ACTIONS_SETTINGS, featureToggles: { 'memory.search': true },
        } }, version: 1 } });
        harness.answer(serverId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: 'one', accountId: ACCOUNT_ID }),
            { ...createPlainMachineRowFixture({ id: 'offline', accountId: ACCOUNT_ID }), active: false, activeAt: 0 }] });
        const { DEFAULT_MEMORY_SETTINGS } = await import('@happier-dev/protocol/memory/memorySettings');
        rpc.machine.mockImplementation(async (call) => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS,
                conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch, indexExternal: {
                    ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: ['pi'],
                } } };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return { v: 1, enabled: true,
                indexMode: 'deep', hintsIndexReady: true, deepIndexReady: true, activeIndexReady: true,
                activeIndexSearchable: true, embeddingsEnabled: false, embeddingsMode: 'disabled',
                embeddingsPresetId: null, embeddingsProviderKind: null, embeddingsModelId: null,
                embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
                tier1DbPath: null, deepDbPath: null, tier1DbBytes: null, deepDbBytes: null };
            return { v: 1, ok: true, hits: [{ type: 'external_transcript', source: {
                type: 'external_transcript', agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native',
            }, sourceItemId: call.payload.cursor ? 'next-message' : 'message', createdAtFromMs: 10, createdAtToMs: 20, summary: 'quartz', score: 0.5 }],
                ...(!call.payload.cursor ? { hasMore: true, nextCursor: 'next' } : {}) };
        });
        const result = await executorModule.createDefaultActionExecutor().execute('search.conversations', {
            machineIds: ['one', 'offline'], mode: 'indexed',
            query: { v: 1, query: 'quartz', scope: { type: 'global' }, mode: 'auto', corpora: ['external_transcripts'] },
        }, { serverId, surface: 'agent', authority: 'account_automation', bypassApprovals: true });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
            hits: [{ machineId: 'one', mode: 'indexed', hit: { sourceItemId: 'message' } }],
            machines: [{ machineId: 'one', status: 'partial' }, { machineId: 'offline', status: 'offline' }],
        } });
        const next = await executorModule.createDefaultActionExecutor().execute('search.conversations', {
            mode: 'indexed', query: { v: 1, query: 'quartz', scope: { type: 'global' }, mode: 'auto',
                corpora: ['external_transcripts'], cursor: JSON.stringify({ machineId: 'one', cursor: 'next' }) },
        }, { serverId, surface: 'agent', authority: 'account_automation', bypassApprovals: true });
        expect(next, JSON.stringify(next)).toMatchObject({ ok: true, result: {
            hits: [{ machineId: 'one', hit: { sourceItemId: 'next-message' } }], machines: [{ machineId: 'one', status: 'partial' }],
        } });
        expect(rpc.machine.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_MEMORY_SEARCH).at(-1)?.[0])
            .toMatchObject({ machineId: 'one', payload: { cursor: 'next' } });
        expect(rpc.machine.mock.calls.every(([call]) => call.accountId === ACCOUNT_ID)).toBe(true);
    });

    it('opens a native memory window on the captured Home and Account without a Session projection', async () => {
        await loadSyncSingletonForTests();
        const serverId = await addHome();
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            ...APPROVAL_REQUIRED_ACTIONS_SETTINGS, featureToggles: { 'memory.search': true },
        } }, version: 1 } });
        const source = { type: 'external_transcript', agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' } as const;
        rpc.machine.mockResolvedValue({ v: 1, snippets: [], citations: [], externalSnippets: [
            { source, sourceItemId: 'message', createdAtMs: 10, text: 'quartz' },
        ] });
        const result = await executorModule.createDefaultActionExecutor().execute('memory.get_window', {
            machineId: 'one', source, sourceItemId: 'message', cursor: 'opaque',
        }, { serverId, surface: 'agent', authority: 'account_automation', bypassApprovals: true });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
            externalSnippets: [{ source, sourceItemId: 'message', text: 'quartz' }],
        } });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'one', serverId, accountId: ACCOUNT_ID, preferScoped: true,
            method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
            payload: { v: 1, source, sourceItemId: 'message', cursor: 'opaque' },
        }));
    });

    it('returns typed unavailability for native navigation on a sidecar-only Home', async () => {
        const serverId = await addHome();
        const { FeaturesResponseSchema} = await import('@happier-dev/protocol/features/payload/featuresResponseSchema');
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const prime = (enabled: boolean) => primeServerFeaturesSnapshot({ serverId, snapshot: {
            status: 'ready', features: FeaturesResponseSchema.parse({ features: { browser: {
                enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true }, automation: { enabled },
            } } }),
        } });
        prime(false);
        const executor = executorModule.createDefaultActionExecutor();
        const context = { serverId, surface: 'agent' as const, authority: 'account_automation' as const, bypassApprovals: true };
        for (const kind of ['navigate', 'goBack', 'goForward', 'reload', 'stop'] as const) {
            expect(await executor.execute(`browser.${kind}`, { kind, commandId: kind, browserSessionId: 'browser', viewId: 'view',
                ...(kind === 'navigate' ? { url: 'https://example.test/' } : {}) }, context))
                .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_automation_unavailable' });
        }
        prime(true);
        // Enabled admission reaches the real browser owner, which has no mounted view here.
        expect(await executor.execute('browser.reload', { kind: 'reload', commandId: 'enabled', browserSessionId: 'browser', viewId: 'view' }, context))
            .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_control_unavailable' });
    });

    it('refuses preparation for another captured Account before creating an approval or machine effect', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await loadExecutor();
        expect(await createDefaultActionExecutor().prepare('scm.diffSummary.result.clear', { results: [] }, {
            serverId, expectedAccountId: 'replacement-account', surface: 'ui', authority: 'present_user',
            externalActionTarget: { kind: 'machine', machineId: 'machine-scm' },
        })).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_account_scope_changed' } });
        expect(harness.artifacts(serverId).list()).toEqual([]);
        expect(rpc.machine).not.toHaveBeenCalled();
    });

    it('keeps a prepared Review on its daemon admission path when another client Action was admitted', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await loadExecutor();
        harness.answer(serverId, 'POST /v1/machines/read-batch', {
            body: { results: [{ machineId: 'review-machine', status: 'not_found' }] },
        });
        const executor = createDefaultActionExecutor({ admittedClientActionId: 'ui.find' });
        const prepared = await executor.prepare('review.start', {
            target: { kind: 'detached' }, cwd: '/workspace',
            reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review this change.',
        }, { serverId, surface: 'ui', authority: 'account_automation', bypassApprovals: true,
            actionRequestId: 'child-review', executionRunTargetMachineId: 'review-machine' });
        expect(prepared.kind).toBe('ready');
        if (prepared.kind !== 'ready') throw new Error('Review did not reach daemon preparation');
        expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'access_denied', effectAttempted: false });
        expect(harness.artifacts(serverId).list()).toEqual([]);
    });

    it('keeps composer ingress effects inside the invocation Home and Account, not the active input scope', async () => {
        await addHome();
        const otherServerId = await harness.addHome({
            name: 'Home B', serverUrl: 'https://home-b.example', serverIdentityId: 'srv_stable-home-b',
            accountId: 'account-b', active: false,
        });
        await loadSyncSingletonForTests();
        ingressConnection = await restoreServerAccountForTest({ serverUrl: 'https://home-a.example', accountId: ACCOUNT_ID });
        // Restore uses a single-Home credential boundary; the Action front door
        // must keep the governance harness's real credentials for both Homes.
        installHomeGovernanceBoundaries(httpBoundary);
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('The real Sync Account scope was not restored');
        expect(scope.accountId).toBe(ACCOUNT_ID);
        const { createEphemeralComposerDocumentOwner } = await import('@/components/sessions/composer/composerDocumentOwner');
        const { projectComposerDocumentSnapshot } = await import('@/components/sessions/composer/composerSnapshotProjection');
        const { registerComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
        const { registerRepositoryUploadTarget } = await import('@/components/workspaces/files/repositoryTree/repositoryUploadActionRuntime');
        const ref = { kind: 'newSession', instanceId: 'invocation-scoped-composer' } as const;
        const owner = createEphemeralComposerDocumentOwner({
            ref, capabilities: { text: true, references: true, attachments: true, submit: true },
            initialDocument: { text: 'draft', structuredInputMentions: [], composerAttachments: [] },
        });
        let attachmentPickerOpened = false;
        const uploadDestinations: string[] = [];
        // Mounted controls and OS picker requests are the UI boundary. Document
        // projection, transactions, Account capture and Action dispatch stay real.
        const releaseComposer = registerComposerPresentationTarget(ref, {
            readScope: () => scope,
            readRevision: () => owner.read().revision,
            replace: (text) => owner.replaceDocument({ ...owner.read().document, text }),
            readSnapshot: () => projectComposerDocumentSnapshot({
                owner, attachmentCatalog: { entriesById: null },
                presentation: { layout: 'wrap', focused: false, editable: true, submittable: true,
                    submitting: false, running: false },
            }),
            commitDocument: ({ expectedRevision, mutation }) => owner.apply(expectedRevision, mutation),
            openAttachmentPicker: () => { attachmentPickerOpened = true; return true; },
        });
        const workspace = { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/repo' };
        const releaseRepository = registerRepositoryUploadTarget({
            scope, workspaceScope: workspace, isCurrent: () => true,
            pick: async ({ destinationDir }) => { uploadDestinations.push(destinationDir); return { status: 'requested' }; },
        });
        try {
            const { createDefaultActionExecutor } = await loadExecutor();
            const executor = createDefaultActionExecutor();
            const transaction = { scope, ref, transaction: { expectedRevision: 0,
                operations: [{ kind: 'text.insert', position: { offset: 5 }, text: ' context' }] } };
            const upload = { scope, workspace, destinationDir: 'src', kind: 'files' };
            const otherContext = { serverId: otherServerId, expectedAccountId: 'account-b',
                surface: 'ui', authority: 'present_user', bypassApprovals: true } as const;
            expect(await executor.execute('composer.transaction.apply', transaction, otherContext))
                .toEqual({ ok: true, result: { status: 'composerUnavailable' } });
            expect(await executor.execute('composer.attachments.pick', { scope, ref }, otherContext))
                .toEqual({ ok: true, result: { status: 'unavailable' } });
            expect(await executor.execute('repository.upload.pick', upload, otherContext))
                .toEqual({ ok: true, result: { status: 'unavailable' } });
            expect(owner.read().document.text).toBe('draft');
            expect(attachmentPickerOpened).toBe(false);
            expect(uploadDestinations).toEqual([]);

            const context = { ...otherContext, serverId: scope.serverId, expectedAccountId: ACCOUNT_ID };
            expect(await executor.execute('composer.transaction.apply', transaction, context))
                .toEqual({ ok: true, result: { status: 'applied', revision: 1 } });
            expect(await executor.execute('composer.attachments.pick', { scope, ref }, context))
                .toEqual({ ok: true, result: { status: 'opened' } });
            expect(await executor.execute('repository.upload.pick', upload, context))
                .toEqual({ ok: true, result: { status: 'requested' } });
            expect(owner.read().document.text).toBe('draft context');
            expect(attachmentPickerOpened).toBe(true);
            expect(uploadDestinations).toEqual(['src']);
        } finally {
            releaseRepository();
            releaseComposer();
        }
    });

    it('executes approved undo on the selected machine with the exact observed HEAD', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await loadExecutor();
        const expectedHeadOid = 'a'.repeat(40);
        rpc.machine.mockImplementation(async ({ method }: { method: string }) => method === RPC_METHODS.SCM_BACKEND_DESCRIBE
            ? { success: true, capabilities: createScmCapabilities({ writeCommitUndoLast: true }) }
            : { success: true, undoneCommitSha: expectedHeadOid, headOid: 'b'.repeat(40) });
        const result = await createDefaultActionExecutor().execute('scm.commit.undoLast', { cwd: '/repo', expectedHeadOid }, {
            serverId, surface: 'ui', authority: 'present_user', bypassApprovals: true,
            externalActionTarget: { kind: 'machine', machineId: 'machine-scm' },
        });
        expect(result).toMatchObject({ ok: true, result: { success: true, undoneCommitSha: expectedHeadOid } });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-scm', serverId: SERVER_IDENTITY_ID, accountId: ACCOUNT_ID, method: 'scm.commit.undoLast',
            payload: { cwd: '/repo', expectedHeadOid, outcomeVersion: 1 },
        }));
    });

    it('settles a blocking approval from its captured Home after an Artifact socket receipt', async () => {
        const serverId = await addHome();
        harness.answer(serverId, '/v2/account/settings', {
            body: { content: { t: 'plain', v: { actionsSettingsV1: { v: 1, actions: {
                'action.spec.get': { approvalRequiredSurfaces: ['voice'] },
            } } } }, version: 2 },
        });
        const { createDefaultActionExecutor } = await loadExecutor();
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const abort = new AbortController();
        const outcome: { result?: unknown } = {};
        const pending = createDefaultActionExecutor().execute('action.spec.get', { id: 'review.start' }, {
            serverId, surface: 'voice', authority: 'present_user', signal: abort.signal, actionRequestId: 'blocking-observation-1',
        }).then((result) => { outcome.result = result; return result; });
        try {
            await vi.waitFor(() => {
                expect(outcome.result, JSON.stringify(outcome.result)).toBeUndefined();
                expect(harness.artifacts(serverId).list()).toHaveLength(1);
            });
            const row = harness.artifacts(serverId).list()[0]!;
            const path = `/v1/artifacts/${row.id}`;
            await vi.waitFor(() => expect(harness.requestsFor(path)).toHaveLength(1));
            const rejected = ApprovalRequestSchema.parse({
                ...ApprovalRequestSchema.parse(storedApproval(serverId, row.id).request),
                status: 'rejected', decision: { kind: 'reject', decidedAtMs: Date.now() },
            });
            // Model another device's write with the canonical Account codec, including
            // revision-bound private provenance, not the local approval notifier/cache.
            const bodyVersion = row.bodyVersion;
            if (bodyVersion === undefined) throw new Error('Expected approval body revision');
            const written = await executorModule.withDefaultActionExecuteContext(undefined, { serverId },
                (_executor, account) => account.updateArtifactDocument({ artifactId: row.id,
                    header: buildApprovalRequestArtifactHeaderV1(rejected), body: JSON.stringify(rejected),
                    expectedRevision: { headerVersion: row.headerVersion, bodyVersion } }));
            expect(written).toMatchObject({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } });
            const readsBeforeWake = harness.requestsFor(path).length;
            publishHomeAccountChange('unrelated-home', [row.id]);
            publishHomeAccountChange(serverId, ['unrelated-artifact']);
            await Promise.resolve();
            expect(harness.requestsFor(path)).toHaveLength(readsBeforeWake);
            // Another device's durable receipt goes through the real socket
            // consumer; no caller-side notification repairs its wake path.
            await handleSocketUpdate({
                update: buildUpdateArtifactUpdate(row.id, 2, 'approval-rejected', {
                    value: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(rejected)), version: 2,
                }, { value: encodePlainArtifactStoredContent({ body: JSON.stringify(rejected) }), version: 2 }),
                sourceServerId: serverId, encryption: null, artifactDataKeys: new Map(),
                applySessions: () => {}, fetchSessions: () => {}, applyMessages: () => {},
                onSessionVisible: () => {}, isSessionMessagesLoaded: () => false,
                getSessionMaterializedMaxSeq: () => 0, markSessionMaterializedMaxSeq: () => {},
                onMessageGapDetected: () => {}, assumeUsers: async () => {}, applyTodoSocketUpdates: async () => {},
                invalidateMachines: () => {}, invalidateSessions: () => {}, invalidateArtifacts: () => {},
                invalidateFriends: () => {}, invalidateFeed: () => {},
                invalidateAutomations: () => {}, invalidateTodos: () => {}, log: { log: () => {} },
            });
            await vi.waitFor(() => expect(outcome.result).toMatchObject({ ok: false, errorCode: 'approval_rejected' }));
            await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'approval_rejected' });
            publishHomeAccountChange(serverId);
            await Promise.resolve();
            expect(harness.requestsFor(path)).toHaveLength(readsBeforeWake + 1);
        } finally {
            abort.abort();
            await pending.catch(() => undefined);
        }
    });

    it('retires a blocking approval when its captured Home Account is replaced', async () => {
        const serverId = await addHome();
        harness.answer(serverId, '/v2/account/settings', {
            body: { content: { t: 'plain', v: { actionsSettingsV1: { v: 1, actions: {
                'action.spec.get': { approvalRequiredSurfaces: ['voice'] },
            } } } }, version: 2 },
        });
        const { createDefaultActionExecutor } = await loadExecutor();
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const abort = new AbortController();
        const outcome: { result?: unknown } = {};
        const pending = createDefaultActionExecutor().execute('action.spec.get', { id: 'review.start' }, {
            serverId, surface: 'voice', authority: 'present_user', signal: abort.signal, actionRequestId: 'blocking-retirement-1',
        }).then((result) => { outcome.result = result; return result; });
        try {
            await vi.waitFor(() => {
                expect(outcome.result, JSON.stringify(outcome.result)).toBeUndefined();
                expect(harness.artifacts(serverId).list()).toHaveLength(1);
            });
            const row = harness.artifacts(serverId).list()[0]!;
            const path = `/v1/artifacts/${row.id}`;
            await vi.waitFor(() => expect(harness.requestsFor(path)).toHaveLength(1));
            await harness.switchAccount(serverId, 'replacement-account');
            await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
            publishHomeAccountChange(serverId, [row.id]);
            await Promise.resolve();
            expect(harness.requestsFor(path)).toHaveLength(1);
        } finally {
            abort.abort();
            await pending.catch(() => undefined);
        }
    });

    it('replays an approved Home-family mutation from the Inbox through the captured Home scope', async () => {
        const provider = {
            v: 1,
            owner: { kind: 'home' },
            id: 'provider-1',
            kind: 'oidc',
            displayName: 'Corporate OIDC',
            enabled: false,
            firstEnabledAt: null,
            securityRevision: 1,
            revision: 4,
            lastSuccessfulTest: null,
            createdByAccountId: 'account-a',
            createdAt: 1,
            updatedAt: 4,
            config: {
                v: 1,
                kind: 'oidc',
                issuer: 'https://id.example',
                clientId: 'client',
                clientAuthenticationMethod: 'client_secret_post',
                scopes: 'openid',
                httpTimeoutSeconds: 15,
                claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
                allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                fetchUserInfo: true,
                storeRefreshToken: false,
                ui: { buttonColor: null, iconHint: null },
            },
            secret: { configured: true, health: 'configured' },
        };
        const serverId = await addHome();
        const replacePath = '/v1/identity/providers/secret/replace';
        harness.answer(serverId, replacePath, { body: provider });
        const input = { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3, clientSecret: 'rotated-client-secret' };
        const { createDefaultActionExecutor } = await loadExecutor();
        const { createHomeDomainActionExecutorForScope } = await import('@/sync/api/home/homeDomainActions');
        // The mounted provider editor owns its Home family port.
        const mounted = createDefaultActionExecutor({
            homeDomainAction: createHomeDomainActionExecutorForScope({ serverId, accountId: ACCOUNT_ID }),
        });
        const created = await mounted.execute('identity.providers.secret.replace', input, {
            serverId,
            surface: 'ui',
            authority: 'present_user',
            actionRequestId: 'provider-secret-request-1',
        });
        expect(created).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const artifactId = createdArtifactId(created);
        expect(harness.requestsFor(replacePath)).toHaveLength(0);

        // Approval Detail / Inbox decides through a generic executor with no mounted port.
        const inbox = createDefaultActionExecutor();
        await expect(inbox.execute(
            'approval.request.decide',
            { artifactId, decision: 'approve' },
            { serverId, surface: 'ui', authority: 'present_user' },
        )).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });

        expect(harness.requestsFor(replacePath)).toHaveLength(1);
        expect(harness.requestsFor(replacePath)[0]).toMatchObject({
            serverId,
            input: { id: 'provider-1', expectedRevision: 3, clientSecret: 'rotated-client-secret' },
        });
        const stored = storedApproval(serverId, artifactId);
        expect(stored.request).toMatchObject({
            status: 'executed',
            actionArgs: { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3 },
        });
        expect(stored.json).not.toContain('rotated-client-secret');
    });

    it('replays an approved Session-access mutation from the Inbox through the captured Home scope', async () => {
        const serverId = await addHome({ collaboration: true });
        const contextPath = '/v2/sessions/access-context/set';
        const input = { sessionId: 'session-1', primaryTeamId: null };
        const result = { changed: true, primaryTeamId: null, teamGrants: [{ teamId: 'team-1', name: 'Engineering', accessLevel: 'edit' }] };
        harness.answer(serverId, contextPath, { body: result });
        const { createDefaultActionExecutor } = await loadExecutor();
        const { executeSessionAccessHttpAction } = await import('@/sync/api/session/sessionAccessApi');
        // The mounted Session access editor owns its family port.
        const mounted = createDefaultActionExecutor({
            sessionAccessAction: async (args) => await executeSessionAccessHttpAction({
                scope: { serverId, accountId: ACCOUNT_ID },
                availability: 'available',
                actionId: args.actionId,
                input: args.input,
            }),
        });
        const created = await mounted.execute('session.access.context.set', input, {
            serverId,
            surface: 'ui',
            authority: 'account_automation',
            defaultSessionId: 'session-1',
            actionRequestId: 'session-context-request-1',
        });
        expect(created).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const artifactId = createdArtifactId(created);
        expect(harness.requestsFor(contextPath)).toHaveLength(0);

        // Approval Detail / Inbox decides through a generic executor with no mounted port.
        const inbox = createDefaultActionExecutor();
        await expect(inbox.execute(
            'approval.request.decide',
            { artifactId, decision: 'approve' },
            { serverId, surface: 'ui', authority: 'present_user' },
        )).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });

        expect(harness.requestsFor(contextPath)).toHaveLength(1);
        expect(harness.requestsFor(contextPath)[0]).toMatchObject({ serverId, input });
        expect(storedApproval(serverId, artifactId).request).toMatchObject({
            status: 'executed',
            execution: { ok: true, result },
        });
    });

    it('creates an encrypted Discussion with the captured UI data-key credential public key', async () => {
        const machineKey = new Uint8Array(32).fill(19);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
        const credentials: DataKeyAuthCredentials = { token: createAccountTokenForTests(ACCOUNT_ID), encryption: {
            machineKey: encodeBase64(machineKey, 'base64'), publicKey: encodeBase64(publicKey, 'base64'),
        } };
        const serverId = await harness.addHome({ name: 'Data-key Home', serverUrl: 'https://data-key-home.example',
            accountId: ACCOUNT_ID, credentials, accountEncryptionMode: 'e2ee' });
        const sent: DiscussionCreateRequestV1[] = [];
        harness.answer(serverId, '/v1/discussions', { select: (input, request) => {
            if (request.init?.method === 'GET') return { body: { discussions: [], nextCursor: null } };
            const body = DiscussionCreateRequestV1Schema.parse(input);
            sent.push(body);
            const firstMessage = { id: 'encrypted-first-message', discussionId: 'encrypted-discussion', localId: body.firstMessage.localId,
                seq: 1, authorAccountId: ACCOUNT_ID, accountActor: { v: 1, accountId: ACCOUNT_ID, profile: null }, producerV1: null,
                content: body.firstMessage.content, mentionedAccountIds: body.firstMessage.mentionedAccountIds, createdAt: 1 };
            const { content: _content, mentionedAccountIds: _mentions, discussionId: _discussion, ...latestMessage } = firstMessage;
            return { body: DiscussionCreateResponseV1Schema.parse({ discussion: {
                id: firstMessage.discussionId, ownerAccountId: ACCOUNT_ID, encryptionMode: 'e2ee', anchor: null,
                access: 'owner', keyReadiness: true, dataEncryptionKey: body.dataEncryptionKey,
                creationLocalId: body.creationLocalId, titleContent: body.titleContent, latestMessage,
                messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0,
                recentAuthorAccountIds: [ACCOUNT_ID], archivedAt: null,
                capabilities: { postMessages: true, rename: true, archive: true, restore: false,
                    askAgent: true, sendToSession: true, manageAccess: true, leave: false },
            }, firstMessage }) };
        } });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { executeDiscussionActionInAccountContext } = await import('@/sync/api/discussions/discussionActions');
        const account = await captureLazyActionAccountContext(serverId);
        const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Data-key credentials work' }] };
        try {
            await expect(executeDiscussionActionInAccountContext(account, 'available', { actionId: 'discussion.create',
                input: { creationLocalId: 'data-key-create', title: 'Encrypted', firstMessage: { localId: 'data-key-first-message', content } },
                context: { surface: 'ui', serverId } })).resolves.toMatchObject({
                discussion: { id: 'encrypted-discussion', title: 'Encrypted' }, firstMessage: { content },
            });
            expect(sent).toHaveLength(1);
            expect(sent[0]?.expectedOwnerContentPublicKeyFingerprint).toBe(computeContentPublicKeyFingerprint(publicKey));
        } finally { account.dispose(); }
    });

    it('revokes only the denied Discussion while an unrelated Home read is in flight', async () => {
        const serverId = await addHome({ collaboration: true });
        const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
        const { createDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepository');
        const row = (id: string) => DiscussionSummaryV1Schema.parse({
            id, ownerAccountId: ACCOUNT_ID, encryptionMode: 'plain', anchor: null, access: 'owner',
            keyReadiness: true, dataEncryptionKey: null, creationLocalId: null,
            titleContent: { t: 'plain', v: { v: 1, title: id } }, latestMessage: {
                id: `${id}-message-1`, localId: null, seq: 1, authorAccountId: ACCOUNT_ID,
                accountActor: { v: 1, accountId: ACCOUNT_ID, profile: null }, producerV1: null, createdAt: 1,
            },
            messageSeq: 2, lastReadSeq: 0, unreadCount: 2, unreadMentionCount: 0,
            recentAuthorAccountIds: [ACCOUNT_ID], archivedAt: null,
            capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
        });
        const readBody = (discussionId: string, seq: number) => ({ messages: [{
            id: `${discussionId}-message-${seq}`, discussionId, localId: null, seq,
            authorAccountId: ACCOUNT_ID, accountActor: { v: 1, accountId: ACCOUNT_ID, profile: null },
            producerV1: null, content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: `${discussionId}:${seq}` }] } },
            mentionedAccountIds: [], createdAt: seq,
        }], hasMoreOlder: false, messageSeq: seq });
        harness.answer(serverId, '/v1/discussions', { select: (_input, request) => ({ body: {
            discussions: new URL(request.url).searchParams.get('state') === 'archived' ? [] : [row('discussion-a'), row('discussion-b')],
            nextCursor: null,
        } }) });
        const oldA = createDeferred<void>();
        const currentB = createDeferred<void>();
        const aArrived = createDeferred<void>();
        const bArrived = createDeferred<void>();
        let pendingReads = false;
        let denied = false;
        for (const id of ['discussion-a', 'discussion-b']) {
            harness.answer(serverId, `/v1/discussions/${id}`, { body: { discussion: row(id) } });
            harness.answer(serverId, `/v1/discussions/${id}/messages`, { select: () => {
                if (id === 'discussion-a' && denied) return { status: 403, body: { error: 'discussion_read_denied' } };
                if (!pendingReads) return { body: readBody(id, 1) };
                (id === 'discussion-a' ? aArrived : bArrived).resolve();
                return { body: readBody(id, 2), respondAfter: id === 'discussion-a' ? oldA.promise : currentB.promise };
            } });
        }
        const repository = createDiscussionRepository({ scope: { serverId, accountId: ACCOUNT_ID }, address: { serverId },
            client: createDiscussionClient({ scope: { serverId, accountId: ACCOUNT_ID }, availability: 'available' }) });
        await repository.refreshList('active');
        const requestsBeforeWrongAccount = harness.requestsFor('/v1/discussions').length;
        const wrongAccount = createDiscussionClient({ scope: { serverId, accountId: 'another-account' }, availability: 'available' });
        expect(await wrongAccount.list()).toMatchObject({ kind: 'failed' });
        expect(harness.requestsFor('/v1/discussions')).toHaveLength(requestsBeforeWrongAccount);
        await repository.refreshMessages('discussion-a');
        await repository.refreshMessages('discussion-b');
        expect(repository.getSnapshot().threads['discussion-b']?.messages).toHaveLength(1);
        pendingReads = true;
        const staleRead = repository.refreshMessages('discussion-a');
        const neighborRead = repository.refreshMessages('discussion-b');
        await Promise.all([aArrived.promise, bArrived.promise]);
        denied = true;
        await repository.refreshMessages('discussion-a');
        oldA.resolve();
        currentB.resolve();
        await Promise.all([staleRead, neighborRead]);
        const snapshot = repository.getSnapshot();
        expect(snapshot.lists.active.items.map(item => item.id)).toEqual(['discussion-b']);
        expect(snapshot.threads['discussion-a']?.messages ?? []).toEqual([]);
        expect(snapshot.threads['discussion-b']).toMatchObject({ status: 'ready', messageSeq: 2 });
        expect(snapshot.threads['discussion-b']?.messages.map(message => message.seq)).toEqual([1, 2]);
    });

    it('replays an approved Discussion mutation from the Inbox through the captured Home without a Session', async () => {
        const serverId = await addHome({ collaboration: true });
        const { createDefaultActionExecutor } = await loadExecutor();
        const archivedDiscussion = {
            id: 'discussion-a',
            ownerAccountId: ACCOUNT_ID,
            encryptionMode: 'plain',
            anchor: null,
            access: 'owner',
            keyReadiness: true,
            dataEncryptionKey: null,
            creationLocalId: 'create-local-a',
            titleContent: { t: 'plain', v: { v: 1, title: 'Release readiness' } },
            latestMessage: {
                id: 'message-a',
                localId: 'message-local-a',
                seq: 1,
                authorAccountId: 'account-a',
                accountActor: { v: 1, accountId: 'account-a', profile: null },
                producerV1: null,
                createdAt: 10,
            },
            messageSeq: 1,
            lastReadSeq: 1,
            unreadCount: 0,
            unreadMentionCount: 0,
            recentAuthorAccountIds: ['account-a'],
            archivedAt: 20,
            capabilities: {
                postMessages: false,
                rename: false,
                archive: false,
                restore: true,
                askAgent: false,
                sendToSession: false,
                manageAccess: true,
                leave: false,
            },
        };
        const discussionPath = '/v1/discussions/discussion-a/archive';
        harness.answer(serverId, discussionPath, { body: { discussion: archivedDiscussion } });
        const input = { discussionId: 'discussion-a' };
        // The mounted Discussion surface owns its family port; approval defers it.
        const mountedPort = vi.fn();
        const mounted = createDefaultActionExecutor({ discussionAction: mountedPort });
        const created = await mounted.execute('discussion.archive', input, {
            serverId,
            surface: 'ui',
            authority: 'present_user',
            actionRequestId: 'discussion-archive-request-1',
        });
        expect(created).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const artifactId = createdArtifactId(created);
        expect(mountedPort).not.toHaveBeenCalled();
        expect(harness.requestsFor(discussionPath)).toHaveLength(0);

        // Approval Detail / Inbox decides through a generic executor with no mounted port.
        const inbox = createDefaultActionExecutor();
        const decided = await inbox.execute(
            'approval.request.decide',
            { artifactId, decision: 'approve' },
            { serverId, surface: 'ui', authority: 'present_user' },
        );
        expect(decided, storedApproval(serverId, artifactId).json).toMatchObject({ ok: true, result: { status: 'executed' } });

        expect(harness.requestsFor(discussionPath)).toHaveLength(1);
        expect(storedApproval(serverId, artifactId).request).toMatchObject({
            status: 'executed',
            execution: {
                ok: true,
                result: { discussion: { id: 'discussion-a', archivedAt: 20 } },
            },
        });
    });

    it('stamps the captured stable Home identity into a prepared UI approval artifact', async () => {
        const serverId = await addHome({ collaboration: true });
        const { createDefaultActionExecutor } = await loadExecutor();
        const prepared = await createDefaultActionExecutor().prepare(
            'session.access.context.set',
            { sessionId: 'session-1', primaryTeamId: null },
            {
                serverId,
                surface: 'ui',
                authority: 'account_automation',
                actionRequestId: 'access-request-1',
            },
        );

        expect(prepared).toMatchObject({
            kind: 'settled',
            result: { ok: true, result: { kind: 'approval_request_created' } },
        });
        const artifactId = createdArtifactId(prepared.kind === 'settled' ? prepared.result : null);
        expect(storedApproval(serverId, artifactId).request).toMatchObject({
            v: 2,
            executionOriginV1: {
                serverId,
                serverIdentityId: SERVER_IDENTITY_ID,
                accountId: ACCOUNT_ID,
            },
        });
    });

    it('routes a created trusted-plugin approval to exact-daemon generation validation without local fallback', async () => {
        const serverId = await addHome({ currentAccount: true });
        const { createDefaultActionExecutor } = await loadExecutor();
        const executor = createDefaultActionExecutor();
        const machine = createPlainMachineRowFixture({ id: 'machine-1', accountId: ACCOUNT_ID });
        harness.answer(serverId, '/v1/machines', { body: [machine] });
        harness.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, id => id === machine.id ? machine : null).json(),
        }) });
        // The approving app enters through the authenticated Home Action route;
        // the Home forwards the original plugin custody to its exact daemon.
        harness.answer(serverId, 'POST /v1/actions/approval.request.decide', { select: (input) => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
            return { body: { v: 1, actionId: 'approval.request.decide', requestId: envelope.requestId,
                execution: { ok: false, errorCode: 'approval_stale', error: 'approval_stale' } } };
        } });
        const created = await executor.execute(
            'review.walkthrough',
            { sessionId: 'session-1', runId: 'review-run', comparisonId: 'comparison-1' },
            {
                serverId,
                serverIdentityId: 'caller-supplied-identity-is-not-authority',
                surface: 'plugin',
                authority: 'account_automation',
                actionRequestId: 'plugin-review-request-1',
                externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
                // What the host stamps on a trusted plugin's Action edge: its
                // live occurrence plus the durable source custody an approval
                // freezes as replay provenance. Without custody the approval
                // origin fails closed (`approval_origin_unavailable`).
                actionCaller: {
                    kind: 'plugin',
                    pluginId: 'acme.reviewer',
                    contributionLocalId: 'review',
                    occurrenceId: 'occurrence-1',
                    sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'npm' },
                },
            },
        );
        expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const artifactId = createdArtifactId(created);
        // The durable origin keeps the plugin's source custody, never its
        // process-local occurrence, so replay can revalidate the exact generation.
        expect(storedApproval(serverId, artifactId).request).toMatchObject({
            executionOriginV1: {
                caller: {
                    kind: 'plugin',
                    pluginId: 'acme.reviewer',
                    contributionLocalId: 'review',
                    sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'npm' },
                },
                machineId: 'machine-1',
            },
        });

        await expect(executor.execute(
            'approval.request.decide',
            { artifactId, decision: 'approve' },
            { serverId, surface: 'ui', authority: 'present_user' },
        )).resolves.toMatchObject({ ok: false, errorCode: 'approval_stale' });

        expect(harness.requestsFor('/v1/actions/approval.request.decide')).toEqual([expect.objectContaining({
            serverId,
            input: expect.objectContaining({
                target: { kind: 'machine', machineId: 'machine-1' },
                input: { artifactId, decision: 'approve', serverIdentityId: SERVER_IDENTITY_ID, originServerId: serverId },
            }),
        })]);
        expect(rpc.machine).not.toHaveBeenCalled();
    });

    it('prepares an E2EE Runner source key after the shared UI Action commits an edge', async () => {
        follow.execute.mockResolvedValue({
            changed: true,
            source: {
                sourceSessionId: 'source-session',
                destinationSessionId: 'destination-session',
                policy: { preset: 'important' },
                deliveryState: 'eligible',
                hasPendingUpdates: true,
            },
        });
        follow.prepareSourceKey.mockResolvedValue({ kind: 'prepared' });
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await loadExecutor();

        const result = await createDefaultActionExecutor().execute(
            'follow.set',
            {
                source: { kind: 'session', sessionId: 'source-session' },
                receiver: { kind: 'session', sessionId: 'destination-session' },
                policy: { preset: 'important' },
            },
            {
                serverId,
                surface: 'ui',
                authority: 'present_user',
                presentUserConfirmation: { actionId: 'follow.set' },
            },
        );

        expect(result).toMatchObject({ ok: true });
        expect(follow.prepareSourceKey).toHaveBeenCalledWith({
            serverId,
            sourceSessionId: 'source-session',
            destinationSessionId: 'destination-session',
        });
    });

    it('reports a committed edge as waiting when scoped Runner key preparation is unavailable', async () => {
        follow.execute.mockResolvedValue({
            changed: true,
            source: {
                sourceSessionId: 'source-session',
                destinationSessionId: 'destination-session',
                policy: { preset: 'important' },
                deliveryState: 'eligible',
                hasPendingUpdates: false,
            },
        });
        follow.prepareSourceKey.mockResolvedValue({
            kind: 'waiting',
            reason: 'runner_key_unavailable',
        });
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await loadExecutor();

        await expect(createDefaultActionExecutor().execute(
            'follow.set',
            {
                source: { kind: 'session', sessionId: 'source-session' },
                receiver: { kind: 'session', sessionId: 'destination-session' },
                policy: { preset: 'important' },
            },
            {
                serverId,
                surface: 'ui',
                authority: 'present_user',
                presentUserConfirmation: { actionId: 'follow.set' },
            },
        )).resolves.toMatchObject({
            ok: false,
            errorCode: 'session_follow_source_key_preparation_waiting',
            details: {
                status: 'waiting',
                reason: 'runner_key_unavailable',
                edgeCommitted: true,
                source: {
                    sourceSessionId: 'source-session',
                    destinationSessionId: 'destination-session',
                },
            },
        });
    });

    it('keeps the captured Action Account context alive through synchronous result publication', async () => {
        const serverId = await addHome();
        const { withDefaultActionExecuteContext } = await loadExecutor();
        let published = false;
        await expect(withDefaultActionExecuteContext(
            undefined,
            { serverId },
            async (_executor, account) => {
                account.assertCurrent();
                published = true;
                expect(lifetime.disposed).toBe(0);
                return 'published';
            },
        )).resolves.toBe('published');

        expect(published).toBe(true);
        expect(lifetime.disposed).toBe(1);
    });

    it('rejects an Account-owned projection before admission when its credential Account changed', async () => {
        const serverId = await addHome();
        const { withDefaultActionExecuteContext } = await loadExecutor();
        const work = vi.fn();

        await expect(withDefaultActionExecuteContext(
            undefined,
            { serverId, expectedAccountId: 'account-before' },
            work,
        )).rejects.toMatchObject({ code: 'action_account_scope_changed' });

        expect(work).not.toHaveBeenCalled();
        expect(lifetime.disposed).toBe(1);
    });

    it('asserts currentness again after the scoped callback and always disposes', async () => {
        const serverId = await addHome();
        const { withDefaultActionExecuteContext } = await loadExecutor();
        // A projection stays delivery-cancellable when its surface goes away.
        const caller = new AbortController();
        await expect(withDefaultActionExecuteContext(
            undefined,
            { serverId, signal: caller.signal },
            async () => {
                caller.abort();
                return 'stale';
            },
        )).rejects.toMatchObject({ name: 'AbortError' });

        expect(lifetime.disposed).toBe(1);
    });

    it('retains a completed effect result after caller cancellation without retiring its Account', async () => {
        const serverId = await addHome();
        const { withDefaultActionExecuteContext } = await loadExecutor();
        const caller = new AbortController();
        const completed = { ok: true, result: { status: 'accepted', localId: 'accepted-input' } };
        await expect(withDefaultActionExecuteContext(undefined, { serverId, signal: caller.signal }, async () => {
            caller.abort();
            return completed;
        }, 'session.message.send')).resolves.toBe(completed);
        expect(lifetime.disposed).toBe(1);
    });

    it('retains a completed effect result for its invoker when the captured Account was replaced', async () => {
        const serverId = await addHome();
        const { withDefaultActionExecuteContext } = await loadExecutor();
        const caller = new AbortController();
        const completed = { ok: true, result: { status: 'accepted' } };
        await expect(withDefaultActionExecuteContext(undefined, { serverId, signal: caller.signal }, async () => {
            await harness.switchAccount(serverId, 'replacement-account');
            caller.abort();
            return completed;
        }, 'session.message.send')).resolves.toBe(completed);
        expect(lifetime.disposed).toBe(1);
    });

    it('does not disclose a completed read after its Account was replaced', async () => {
        const serverId = await addHome();
        const { withDefaultActionExecuteContext } = await loadExecutor();
        await expect(withDefaultActionExecuteContext(undefined, { serverId }, async () => {
            await harness.switchAccount(serverId, 'replacement-account');
            return { ok: true, result: { id: 'action.spec.get' } };
        }, 'action.spec.get')).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        expect(lifetime.disposed).toBe(1);
    });

    it.each(['effect', 'read'] as const)('keeps prepared %s disposition distinct from retired Account disclosure', async kind => {
        const serverId = await addHome();
        const { withDefaultActionExecuteContext } = await loadExecutor();
        let account: Awaited<ReturnType<typeof import('./actionAccountContext')['captureLazyActionAccountContext']>> | undefined;
        await withDefaultActionExecuteContext(undefined, { serverId }, async (_executor, captured) => { account = captured; });
        if (!account) throw new Error('Expected captured Account');
        const completed = { ok: true, result: { status: 'accepted' } };
        const pending = account.runPrepared(async () => {
            await harness.switchAccount(serverId, 'replacement-account');
            return completed;
        }, kind === 'effect' ? 'write' : 'read');
        if (kind === 'effect') await expect(pending).resolves.toBe(completed);
        else await expect(pending).rejects.toMatchObject({ code: 'action_account_scope_changed' });
    });

    it('does not return a cancelled read as a completed effect result', async () => {
        const serverId = await addHome();
        const { withDefaultActionExecuteContext } = await loadExecutor();
        const caller = new AbortController();
        await expect(withDefaultActionExecuteContext(undefined, { serverId, signal: caller.signal }, async () => {
            caller.abort();
            return { ok: true, result: { id: 'session.message.send' } };
        }, 'action.spec.get')).rejects.toMatchObject({ name: 'AbortError' });
        expect(lifetime.disposed).toBe(1);
    });

    it('publishes a current failure before the captured Account lifetime is disposed', async () => {
        const serverId = await addHome();
        const { withDefaultActionExecuteContext } = await loadExecutor();
        const onCurrentError = vi.fn((error: unknown) => {
            expect(error).toMatchObject({ message: 'transport_failed' });
            expect(lifetime.disposed).toBe(0);
        });

        await expect(withDefaultActionExecuteContext(
            undefined,
            { serverId, onCurrentError },
            async () => { throw new Error('transport_failed'); },
        )).rejects.toThrow('transport_failed');

        expect(onCurrentError).toHaveBeenCalledOnce();
        expect(lifetime.disposed).toBe(1);
    });

    it('keeps ordinary non-Pool immediate execution on the shared context path', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await loadExecutor();
        const openSession = vi.fn();

        await expect(createDefaultActionExecutor({ openSession }).execute(
            'session.open',
            { sessionId: 'session-a' },
            { serverId },
        )).resolves.toMatchObject({ ok: true });

        expect(openSession).toHaveBeenCalledWith('session-a', { serverId });
        expect(lifetime.disposed).toBe(1);
    });

    it.each([true, false])('opens Files Explain=%s through the real executor and shared pane target', async (explain) => {
        const serverId = await addHome();
        const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
        const { parseSessionPaneUrlState, createSessionPaneDetailsTab } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
        const opened: string[] = [];
        const release = registerMountedWorkspaceAction(async ({ actionId, input }) => {
            if (actionId !== 'workspace.tabs.open') throw new Error('Unexpected workspace request');
            opened.push((input as { href: string }).href);
            return { ok: true };
        });
        try {
            const { createDefaultActionExecutor } = await loadExecutor();
            await expect(createDefaultActionExecutor().execute('session.open', {
                sessionId: 'session-a', destination: { kind: 'scmReview', comparison: { kind: 'workingTree' }, view: 'files', explain },
            }, { serverId })).resolves.toMatchObject({ ok: true });
            const href = new URL(opened[0]!, 'https://app.example');
            const state = parseSessionPaneUrlState(Object.fromEntries(href.searchParams));
            expect(state?.details).toMatchObject({ kind: 'scmReview', explain });
            expect(createSessionPaneDetailsTab(state!.details!)?.resource).toMatchObject({ explain });
        } finally {
            release();
        }
    });

    it.each(['agent', 'plugin'] as const)('opens pending Commits from a public %s request through the mounted adapter', async (surface) => {
        const serverId = await addHome();
        const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
        const { parseSessionPaneUrlState, createSessionPaneDetailsTab } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
        const opened: string[] = [];
        const release = registerMountedWorkspaceAction(async ({ actionId, input }) => {
            if (actionId !== 'workspace.tabs.open') throw new Error('Unexpected workspace request');
            opened.push((input as { href: string }).href);
            return { ok: true };
        });
        try {
            const input = {
                sessionId: 'session-a', destination: { kind: 'scmReview', comparison: { kind: 'workingTree' }, view: 'commits' },
            } satisfies PluginActionInputById['session.open'];
            const { createDefaultActionExecutor } = await loadExecutor();
            const outcome = await createDefaultActionExecutor().execute('session.open', input, {
                serverId, surface, defaultSessionId: 'session-a',
                ...(surface === 'plugin' ? {
                    authority: 'account_automation' as const,
                    actionCaller: { kind: 'plugin' as const, pluginId: 'acme.reviewer', contributionLocalId: 'review',
                        occurrenceId: 'occurrence-1',
                        sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'generation-1', installSource: 'npm' as const } },
                } : {}),
            });
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
            expect(opened).toHaveLength(1);
            const href = new URL(opened[0]!, 'https://app.example');
            expect(href.pathname).toBe('/session/session-a');
            expect(href.searchParams.get('serverId')).toBe(serverId);
            const state = parseSessionPaneUrlState(Object.fromEntries(href.searchParams));
            expect(createSessionPaneDetailsTab(state!.details!)?.resource).toMatchObject({
                kind: 'scmReview', comparison: { kind: 'workingTree' }, view: 'commits',
            });
        } finally {
            release();
        }
    });

    it.each([
        { kind: 'session', sessionId: 'session-a' },
        { kind: 'turnCheckpoint', turnId: 'turn-a' },
        { kind: 'branch', head: 'feature', base: 'main' },
        { kind: 'commit', commit: 'a'.repeat(40) },
        { kind: 'pullRequest', locator: { providerId: 'hosting-source', repository: 'owner/repo', number: 17 } },
    ] as const)('refuses Commits for a $kind source before mounted navigation', async (comparison) => {
        const serverId = await addHome();
        const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
        const opened: unknown[] = [];
        const release = registerMountedWorkspaceAction(async request => {
            opened.push(request);
            return { ok: true };
        });
        try {
            const input = {
                sessionId: 'session-a', destination: { kind: 'scmReview', comparison, view: 'commits' },
            } satisfies PluginActionInputById['session.open'];
            const { createDefaultActionExecutor } = await loadExecutor();
            const outcome = await createDefaultActionExecutor().execute('session.open', input, {
                serverId, surface: 'agent', defaultSessionId: 'session-a',
            });
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: false, errorCode: 'commits_require_working_tree' });
            expect(opened).toEqual([]);
        } finally {
            release();
        }
    });

    it('opens a semantic PR destination in the host workspace with its pinned comparison', async () => {
        const serverId = await addHome();
        const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
        const { parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
        const opened: string[] = [];
        const release = registerMountedWorkspaceAction(async ({ actionId, input }) => {
            if (actionId !== 'workspace.tabs.open') throw new Error('Unexpected workspace request');
            const href = (input as { href: string }).href;
            opened.push(href);
            return { ok: true };
        });
        try {
            const { createDefaultActionExecutor } = await loadExecutor();
            const comparison = { kind: 'pullRequest', locator: {
                providerId: 'hosting-source', repository: 'owner/repo', number: 17,
                baseOid: 'b'.repeat(40), headOid: 'c'.repeat(40),
                sourceAction: { action: { pluginId: 'acme.source', localId: 'pr-detail' }, input: { id: 'pr-17' } },
            } } as const;
            const comparisonId = 'a'.repeat(64);
            await expect(createDefaultActionExecutor().execute('session.open', {
                sessionId: 'session-a', destination: { kind: 'scmReview', comparison, view: 'walkthrough', comparisonId },
            }, { serverId })).resolves.toMatchObject({ ok: true });
            expect(opened).toHaveLength(1);
            const href = new URL(opened[0]!, 'https://app.example');
            expect(href.pathname).toBe('/session/session-a');
            expect(href.searchParams.get('serverId')).toBe(serverId);
            expect(parseSessionPaneUrlState(Object.fromEntries(href.searchParams))).toMatchObject({
                details: { kind: 'scmReview', comparison: { ...comparison, comparisonId }, view: 'walkthrough' },
            });
        } finally {
            release();
        }
    });

    it('resumes fresh-folder consent from the exact Home snapshot before navigating', async () => {
        // The detail reader requests accessProjectionVersion=1 only after this
        // Home enables Session sharing; the answer below is that current shape.
        const serverId = await addHome({ collaboration: true });
        harness.answer(serverId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: 'machine-a', accountId: ACCOUNT_ID })] });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        harness.answer(serverId, '/v2/sessions/session-a?accessProjectionVersion=1', { body: { session: {
            id: 'session-a', createdAt: 1, updatedAt: 2, seq: 1, active: false, activeAt: 2,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1,
            metadata: JSON.stringify({ machineId: 'machine-a', path: '/managed/session-a', host: 'host-a',
                runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }),
            agentStateVersion: 1, agentState: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
            responsibleAccountId: null, responsibleAccount: null,
        } } });
        rpc.machine.mockResolvedValue({ type: 'error', errorCode: 'SESSION_DIRECTORY_MISSING', errorMessage: 'Missing folder' });
        const { createDefaultActionExecutor } = await loadExecutor();
        const openSession = vi.fn();

        const resumed = await createDefaultActionExecutor({ openSession }).execute('session.open', {
            sessionId: 'session-a', approvedNewDirectoryCreation: true,
        }, { serverId });
        expect(resumed, JSON.stringify({ resumed, paths: harness.requests.map(({ path }) => path) }))
            .toMatchObject({ ok: false, errorCode: 'SESSION_DIRECTORY_MISSING' });
        expect(harness.requestsFor('/v2/sessions/session-a?accessProjectionVersion=1'))
            .toEqual([expect.objectContaining({ serverId })]);
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a', preferScoped: true, accountId: ACCOUNT_ID,
            payload: expect.objectContaining({ directory: '/managed/session-a', approvedNewDirectoryCreation: true }),
        }));
        expect(openSession).not.toHaveBeenCalled();
    });

    it.each([true, false])('resumes configured ACP only when the owning catalog declares load support (%s)', async (supportsLoadSession) => {
        await loadSyncSingletonForTests();
        const serverId = await addHome({ collaboration: true });
        const backendId = 'resume-stub';
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
            id: backendId, name: backendId, title: 'Resume stub', createdAt: 1, updatedAt: 1,
            launch: { kind: 'command', command: 'acp-stub', args: [] },
            capabilities: { supportsLoadSession },
        }] });
        harness.answer(serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: {
            status: 'present', revision: 1, content: { t: 'plain', v: record },
        } });
        const machine = createHydratedPlainMachineFixture({ id: 'machine-a', accountId: ACCOUNT_ID,
            machine: { activeAt: Date.now(), managedMachineRef: null } });
        await publishMachineInventoryForTest({ serverId, accountId: ACCOUNT_ID }, [machine]);
        const row = createPlainMachineRowFixture({ id: machine.id, accountId: ACCOUNT_ID, machine });
        harness.answer(serverId, '/v1/machines', { body: [row] });
        harness.answer(serverId, '/v1/machines/machine-a', { body: { machine: row } });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        harness.answer(serverId, '/v2/sessions/session-a?accessProjectionVersion=1', { body: { session: {
            id: 'session-a', createdAt: 1, updatedAt: 2, seq: 1, active: false, activeAt: 2,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1,
            metadata: JSON.stringify({ machineId: 'machine-a', path: '/managed/session-a', host: 'host-a',
                acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId, title: 'Resume stub' } }),
            agentStateVersion: 1, agentState: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
            responsibleAccountId: null, responsibleAccount: null,
        } } });
        rpc.machine.mockResolvedValue({ type: 'success', sessionId: 'session-a' });
        const { createDefaultActionExecutor } = await loadExecutor();

        const outcome = await createDefaultActionExecutor().execute('session.open', {
            sessionId: 'session-a', intent: 'resume',
        }, { serverId, surface: 'ui' });
        const spawns = rpc.machine.mock.calls.map(([call]) => call).filter(call =>
            call.method === RPC_METHODS.SPAWN_HAPPY_SESSION || call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);

        if (supportsLoadSession) {
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { status: 'opened', sessionId: 'session-a' } });
            expect(spawns).toEqual([expect.objectContaining({
                machineId: 'machine-a', payload: expect.objectContaining({
                    sessionId: 'session-a', backendTarget: { kind: 'backend', backendId, configuredBackendId: backendId, sourceKind: 'configured' },
                }),
            })]);
        } else {
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
            expect(spawns).toEqual([]);
        }
    });

    it('lets a mounted host supply one complete-corpus resolver and carries its exact address to open', async () => {
        const { createDefaultActionExecutor } = await loadExecutor();
        const openSession = vi.fn();
        const resolveSessionReference = vi.fn(async () => ({
            kind: 'unique' as const,
            address: { serverId: 'home-b', sessionId: 'session-b' },
        }));

        await expect(createDefaultActionExecutor({ openSession, resolveSessionReference }).execute(
            'session.open',
            { sessionTitle: 'Release prep' },
            { surface: 'voice' },
        )).resolves.toMatchObject({ ok: true });

        expect(resolveSessionReference).toHaveBeenCalledOnce();
        expect(openSession).toHaveBeenCalledWith('session-b', { serverId: 'home-b' });
    });

    it('retains deferred prepare/runPrepared custody outside the immediate callback lifetime', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await loadExecutor();
        const openSession = vi.fn();
        const prepared = await createDefaultActionExecutor({ openSession }).prepare(
            'session.open',
            { sessionId: 'session-a' },
            { serverId },
        );

        expect(prepared.kind).toBe('ready');
        expect(lifetime.disposed).toBe(1);
        if (prepared.kind !== 'ready') return;

        await prepared.invocation.run();

        expect(lifetime.runPrepared).toBe(1);
        expect(openSession).toHaveBeenCalledWith('session-a', { serverId });
    });
});
