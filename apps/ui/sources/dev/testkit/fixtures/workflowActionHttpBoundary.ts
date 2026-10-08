import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    AutomationDefinitionListResponseSchema, FeaturesResponseSchema, WorkflowDefinitionListResultV1Schema,
    WorkflowRunListResultV1Schema, WorkflowRunRecipientCensusResponseV1Schema,
    WorkflowAcceptedSnapshotV1Schema, encodePlainArtifactStoredContent, materializeWorkflowAcceptedSnapshotV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storageStore';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { createRootLayoutFeaturesResponse } from './featureFixtures';
import { createWorkflowDefinitionFixture } from './workflowRunFixtures';
import { installRealActionExecutorModuleLoader } from '../harness/actionHomesHttpHarness';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import {
    AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateRequestSchema, AccountSettingsV2UpdateResponseSchema,
} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { parseToken } from '@/utils/auth/parseToken';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected fixture object');
    // HTTP fixture JSON is untyped; narrow only its object boundary here.
    return value as Record<string, unknown>;
}

/**
 * Script UI read fixtures at the real HTTP boundary. The script's declared
 * projection supplies fixture facts only: Artifact codecs, trigger projection,
 * Run private-content opening and the default Action admission remain real.
 * Deliberately supports neither synthetic Artifact cursors nor plugin pages.
 */
export async function installWorkflowActionHttpBoundary(params: Readonly<{
    fixtureResponse: (actionId: string, input: Record<string, unknown>) => Promise<unknown>;
    accountId?: () => string;
    automationRuns?: (url: URL, init?: RequestInit) => Promise<Response>;
}>) {
    const restoreExecutorLoader = await installRealActionExecutorModuleLoader();
    const accountId = params.accountId ?? (() => storage.getState().profileScope?.accountId ?? 'account-a');
    const home = getActiveServerSnapshot();
    const webLocks = typeof globalThis.navigator?.locks?.request === 'function' ? null : installWebLockManagerMock();
    const writes: Array<NonNullable<Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>>> = [];
    let credentials = { token: '' };
    let disposed = false;
    const settingsByAccount = new Map<string, ReturnType<typeof AccountSettingsV2GetResponseSchema.parse>>();
    const base = createRootLayoutFeaturesResponse();
    const features = FeaturesResponseSchema.parse({ ...base,
        features: { ...base.features, workflows: { enabled: true }, automations: { ...base.features.automations, enabled: true } },
        capabilities: { ...base.capabilities, accountStoredContentCompatibility: { v: 1,
            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1' } },
    });
    let automations: ReturnType<typeof AutomationDefinitionListResponseSchema.parse> = { automations: [], nextCursor: null };
    const reply = async (actionId: string, input: Record<string, unknown>) => {
        const response = record(await params.fixtureResponse(actionId, input));
        if (response.ok !== true) throw new Error(String(response.errorCode ?? 'fixture_request_failed'));
        return response.result;
    };
    const request: RuntimeFetch = async (url, init) => {
        if (disposed) throw new Error('Workflow HTTP boundary is disposed');
        const target = new URL(String(url));
        if (target.origin !== new URL(home.serverUrl).origin) throw new Error(`Unexpected Workflow Home: ${target.origin}`);
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
        if (target.pathname === '/v1/features' || target.pathname === '/v1/features/authenticated') return json(features);
        const authorization = new Headers(init?.headers).get('authorization');
        let requestAccountId: string | null = null;
        try { requestAccountId = authorization?.startsWith('Bearer ') ? parseToken(authorization.slice(7)) : null; } catch { /* Invalid bearer remains unauthenticated. */ }
        if (!requestAccountId) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
        if (target.pathname === '/v1/account/profile') return json(AccountProfileSchema.parse({ id: requestAccountId }));
        if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (target.pathname === '/v2/account/settings') {
            let settings = settingsByAccount.get(requestAccountId);
            if (!settings) {
                settings = AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 });
                settingsByAccount.set(requestAccountId, settings);
            }
            if (init?.method !== 'POST') return json(settings);
            const update = AccountSettingsV2UpdateRequestSchema.safeParse(JSON.parse(String(init.body)));
            if (!update.success || update.data.content?.t !== 'plain') return new Response('{}', { status: 400 });
            if (update.data.expectedVersion !== settings.version) return json(AccountSettingsV2UpdateResponseSchema.parse({
                success: false, error: 'version-mismatch', currentVersion: settings.version, currentContent: settings.content,
            }));
            settings = { content: update.data.content, version: settings.version + 1 };
            settingsByAccount.set(requestAccountId, settings);
            return json(AccountSettingsV2UpdateResponseSchema.parse({ success: true, version: settings.version }));
        }
        if (target.pathname === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
        if (target.pathname === '/v1/artifacts') {
            const page = WorkflowDefinitionListResultV1Schema.parse(await reply('workflow.definition.list', {}));
            if (page.nextCursor || page.pluginWorkflows?.length) throw new Error('HTTP fixture requires real Artifact pagination/plugin transport');
            const definition = createWorkflowDefinitionFixture({
                defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
            });
            const rows: Artifact[] = page.definitions.map((item, index) => ({
                id: item.definitionId, ownerAccountId: item.ownerAccountId ?? requestAccountId, access: item.access ?? 'owner', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent('contentUnavailableReason' in item && item.contentUnavailableReason === 'invalid_header'
                    ? { kind: item.kind } : { kind: item.kind, definitionId: item.definitionId,
                        revision: item.revision, metadata: item.metadata, previewSteps: [] }),
                body: encodePlainArtifactStoredContent({ body: item.contentStatus === 'available'
                    ? JSON.stringify({ kind: 'workflow-definition.v1', definition }) : 'invalid stored body' }),
                headerVersion: item.revision?.headerVersion ?? 1, bodyVersion: item.revision?.bodyVersion ?? 1,
                seq: 1, createdAt: 1, updatedAt: page.definitions.length - index,
            }));
            automations = AutomationDefinitionListResponseSchema.parse({ automations: page.definitions.filter(item => item.triggers.length).map(item => ({
                id: `automation-${item.definitionId}`, name: 'Fixture triggers', description: null, enabled: true,
                workflowDefinitionId: item.definitionId, scopeSessionId: null, targetType: null, existingSessionId: null,
                templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
                triggers: item.triggers.map((trigger, index) => ({ ...trigger, id: `trigger-${index}`, enabled: true,
                    revision: 0, createdAt: 1, updatedAt: 1, nextRunAt: item.nextRunAt })),
            })), nextCursor: null });
            return json(rows);
        }
        if (target.pathname === '/v3/automations') return json(automations);
        if (target.pathname === '/v3/automations/runs' && params.automationRuns) return params.automationRuns(target, init);
        if (target.pathname === '/v3/automations/runs/workflow-storage') {
            const operation = record(JSON.parse(String(init?.body)));
            const input = record(operation.request);
            if (operation.operation === 'summaries') return json(await reply('workflow.run.summaries', input));
            if (operation.operation !== 'list') throw new Error(`Unexpected Run storage operation ${operation.operation}`);
            const page = WorkflowRunListResultV1Schema.parse(await reply('workflow.run.list', input));
            const acceptedEnvelopesByRunId: Record<string, string> = {};
            const keyCensusByRunId: Record<string, unknown> = {};
            for (const run of page.runs) {
                const metadata = page.metadataByRunId?.[run.id];
                const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: createWorkflowDefinitionFixture({
                    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
                }),
                    admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
                    context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId ?? 'machine-1',
                        executionTarget: { kind: 'session' }, origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } },
                        workspaceTarget: { project: { machineId: run.machineId ?? 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } },
                });
                if (!materialized.ok) throw new Error(`Invalid accepted fixture: ${materialized.error.code}`);
                const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...materialized.snapshot,
                    ...(run.startedBy ? { startedBy: run.startedBy } : {}),
                    ...(metadata?.kind === 'available' ? { metadata: metadata.value } : {}),
                });
                if (metadata?.kind !== 'unavailable') acceptedEnvelopesByRunId[run.id] = serializeWorkflowStoredContentEnvelopeV1(
                    sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                        binding: { v: 1, purpose: 'accepted_snapshot', accountId: requestAccountId, runId: run.id }, acceptedSnapshot: accepted }));
                keyCensusByRunId[run.id] = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: requestAccountId,
                    access: 'owner', encryptionMode: 'plain', visibleTeamId: null,
                    dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
                    ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
            }
            return json({ runs: page.runs.map(run => ({ ...run, ownerAccountId: requestAccountId })),
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), acceptedEnvelopesByRunId, keyCensusByRunId });
        }
        throw new Error(`Unexpected HTTP fixture route ${target.pathname}`);
    };
    setRuntimeFetch(request);
    const refreshAccount = async () => {
        if (disposed) throw new Error('Workflow HTTP boundary is disposed');
        const nextAccountId = accountId();
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const isAppliedHome = getActiveServerAccountScope()?.serverId === home.serverId;
        const { disconnectActiveServerConnection, restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        if (isAppliedHome) await disconnectActiveServerConnection();
        const next = { token: `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: nextAccountId })), 'base64url')}.signature` };
        const write = await TokenStorage.setCredentialsForServerUrlWithRollback(home.serverUrl, { serverId: home.serverId }, next);
        if (!write) throw new Error('Workflow Home credentials could not be persisted');
        writes.push(write);
        credentials = next;
        if (isAppliedHome) await restoreConnectionToActiveServer(next);
    };
    await refreshAccount();
    return {
        request,
        serverId: home.serverId,
        serverUrl: home.serverUrl,
        get credentials() { return credentials; },
        refreshAccount,
        prime() { primeServerFeaturesSnapshot({ serverId: home.serverId, snapshot: { status: 'ready', features } }); },
        async dispose() {
            if (disposed) return;
            disposed = true;
            try {
                const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
                if (getActiveServerAccountScope()?.serverId === home.serverId) {
                    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
                    await disconnectActiveServerConnection();
                }
            } finally {
                restoreExecutorLoader();
                resetRuntimeFetch();
                deleteServerFeaturesSnapshot({ serverId: home.serverId });
                try { for (const write of writes.splice(0).reverse()) await write.rollback(); }
                finally { webLocks?.restore(); }
            }
        },
    };
}
