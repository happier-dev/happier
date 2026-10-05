import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createAccountScopedCryptoMaterialSnapshotV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    materializeWorkflowAcceptedSnapshotV1,
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
    prepareWorkflowRunDataKeyV1, WorkflowRunRecipientCensusResponseV1Schema,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    AutomationTriggerIdSchema,
    ArtifactAccessRecipientCensusResponseV1Schema,
    validateWorkflowDefinition,
    WorkflowRunStartRequestV1Schema,
    SessionTriggerUpdateRequestV1Schema,
    ScmPullRequestListResponseSchema,
    PluginProjectionV2Schema,
    compilePluginJsonSchema,
    encodePluginCollectionLogicalValueV1,
    isValidPluginJsonSchemaValue,
    normalizePluginAccountCollectionContractV1,
    PluginAccountCollectionContributionV1Schema,
    sealEncryptedDataKeyEnvelopeV1,
    type AvailableAutomationAccountEncryptionV1,
    type AutomationDefinitionCreateRequest,
    type AutomationDefinitionDetail,
    type AutomationDefinitionListItem,
    type AutomationDefinitionReconcileRequest,
    type AutomationTriggerDefinitionInput,
} from '@happier-dev/protocol';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { storage } from '@/sync/domains/state/storage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import type { WorkflowActionTransport } from './workflowActionTransport';
import type { Artifact, ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { buildWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { buildWorkflowEditorDraftFromDefinition, validateWorkflowEditorDraft } from '@/sync/domains/workflows/workflowAuthoring';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SessionTriggersSection } from '@/components/workflows/triggers/SessionTriggersSection';
import { ConversationBindingV1Schema, SessionPullRequestBindingInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { listSessionTriggers } from '@/sync/domains/workflows/workflowTriggerActions';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { useSessionTriggers } from '@/components/workflows/triggers/useSessionTriggers';
import { publishActivePluginCollectionChanges } from '@/sync/api/plugins/data/pluginCollectionChangeWatch';
import { AUTOMATION_TEMPLATE_V02_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED } from '../../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';

// The native Markdown package is a rendering boundary, not part of trigger admission.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

// Home remains reachable while Machine daemons are offline. Keep the real
// connection supervisor and replace only its external Socket.IO transport.
installDisconnectedServerSocketBoundary((socket) => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});

// HTTP, native Machine transport, credentials and rendering adapters are boundaries;
// Account composition, feature decisions, content codecs and Action execution stay real.
const runtimeFetch = vi.hoisted(() => vi.fn());
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetch(...args),
    // Let the canonical Account connection harness configure this HTTP boundary.
    setRuntimeFetch: (request: NonNullable<Parameters<typeof import('@/utils/system/runtimeFetch').setRuntimeFetch>[0]>) => runtimeFetch.mockImplementation(request),
    resetRuntimeFetch: () => runtimeFetch.mockReset(),
}));
// The machine RPC is the network boundary; projection parsing and cache ownership stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// Metro's lazy module loader is a platform boundary unavailable in Vitest. Substitute
// only its module loading; the real default factory and Action front door still execute.
vi.mock('./frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('./frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute: (executor?: Parameters<typeof original.createFrontDoorActionExecute>[0]) => {
        if (executor) return original.createFrontDoorActionExecute(executor);
        let resolved: ReturnType<typeof original.createFrontDoorActionExecute> | null = null;
        const execute: ReturnType<typeof original.createFrontDoorActionExecute> = async (actionId, input, context) => {
            resolved ??= original.createFrontDoorActionExecute((await import('./defaultActionExecutor')).createDefaultActionExecutor());
            return resolved(actionId, input, context);
        };
        return execute;
    } };
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const accountId = 'workflow-account';
const runId = '00000000-0000-4000-8000-000000000001';
const definition = validateWorkflowDefinition({ version: 1,
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
    blocks: ['Do the thing'],
}).normalizedDefinition!;
const triggerSetRow = (id: string, workflowDefinitionId: string, scopeSessionId: string | null = null): AutomationDefinitionListItem => ({
    id, name: 'Workflow triggers', description: null, enabled: true, workflowDefinitionId, scopeSessionId,
    targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
    assignments: [{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }], triggers: [],
});
const scheduleTrigger = { kind: 'schedule' as const, enabled: true,
    schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null } };
// The server's Automation definition owner is the external persistent boundary.
// This in-memory stand-in applies only the stored row shape and CAS; trigger
// semantics, sealing and Account currentness run through the real UI host.
function storedTrigger(triggerId: string, trigger: AutomationTriggerDefinitionInput, revision = 0,
    scope?: Readonly<{ automationId: string; sourceSessionId: string | null }>): AutomationDefinitionDetail['triggers'][number] {
    if (trigger.kind === 'prComment' || trigger.kind === 'ciFailed') {
        if (!scope?.sourceSessionId) throw new Error('Pull-request fixture needs the serving Automation scope');
        const id = AutomationTriggerIdSchema.parse(triggerId);
        // Mirrors normalizeTriggerWrite + triggerProjection: plain is enveloped
        // by the server, while E2EE content is already sealed by the real host.
        const envelope = 'triggerDefinitionEnvelope' in trigger ? trigger.triggerDefinitionEnvelope
            : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, automationId: scope.automationId, triggerId: id, triggerRevision: revision, triggerKind: trigger.kind },
                definition: { kind: trigger.kind, pullRequest: trigger.pullRequest },
            });
        return { kind: trigger.kind, enabled: trigger.enabled, sourceSessionId: scope.sourceSessionId,
            id, revision, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: JSON.stringify(envelope) };
    }
    if (trigger.kind === 'runLifecycle') return { ...trigger, id: AutomationTriggerIdSchema.parse(triggerId), revision, createdAt: 1, updatedAt: 1,
        remainingOccurrences: 1, status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null };
    if (trigger.kind !== 'schedule') throw new Error('fixture_supports_schedule_triggers_only');
    return { ...trigger, id: triggerId as AutomationDefinitionDetail['triggers'][number]['id'], revision, createdAt: 1, updatedAt: 1, nextRunAt: 2, triggerDefinitionEnvelope: null };
}
function createdAutomation(input: AutomationDefinitionCreateRequest): AutomationDefinitionDetail {
    return { id: input.automationId, name: input.name, description: input.description ?? null, enabled: input.enabled,
        workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
        targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
        assignments: (input.assignments ?? []).map((value) => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })),
        triggers: input.triggers.map((value) => storedTrigger(value.triggerId, value.trigger, 0,
            { automationId: input.automationId, sourceSessionId: input.scopeSessionId ?? null })),
        ...(input.executionRecipe ? { executionRecipe: input.executionRecipe } : {}) } as AutomationDefinitionDetail;
}
function reconciledAutomation(row: AutomationDefinitionDetail, input: AutomationDefinitionReconcileRequest): AutomationDefinitionDetail {
    return { ...row, enabled: input.enabled, templateVersion: row.templateVersion + 1,
        ...(input.workflowDefinitionId === undefined ? {} : { workflowDefinitionId: input.workflowDefinitionId }),
        ...(input.executionRecipe ? { executionRecipe: input.executionRecipe, templateCiphertext: undefined, targetType: null, existingSessionId: null } : {}),
        assignments: input.assignments.map((value) => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 2 })),
        triggers: input.triggers.map((item) => {
            if (item.kind === 'new') return storedTrigger(item.triggerId, item.trigger, 0,
                { automationId: row.id, sourceSessionId: row.scopeSessionId ?? null });
            const current = row.triggers.find((trigger) => trigger.id === item.triggerId)!;
            const changed = item.enabled !== undefined || item.trigger !== undefined;
            return { ...current, ...(item.enabled === undefined ? {} : { enabled: item.enabled }), revision: changed ? current.revision + 1 : current.revision };
        }) };
}
function listedAutomation(row: AutomationDefinitionDetail): AutomationDefinitionListItem {
    const { executionRecipe: _recipe, templateCiphertext: _template, triggers, ...item } = row;
    return { ...item, triggers: triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger) } as AutomationDefinitionListItem;
}
afterEach(() => { runtimeFetch.mockReset(); machineRpc.mockReset(); clearDaemonMergedProjectionCacheForTests(); clearPluginAccountAvailabilityProjection(); vi.restoreAllMocks(); });

async function installPullRequestProjection(h: Awaited<ReturnType<typeof createHarness>>, sessionId: string) {
    const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-channels/manifest');
    const contribution = PLUGIN_MANIFEST.contributes?.accountCollections?.find((entry) => entry.id === 'channel-state');
    if (!contribution) throw new Error('Missing canonical Channels collection');
    const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels',
        contribution: PluginAccountCollectionContributionV1Schema.parse(contribution) });
    const ref = { pluginId: contract.pluginId, collectionId: contract.collectionId,
        schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
    replacePluginAccountAvailabilityProjection({ scope: h.account.accountLifetime.scope, snapshot: {
        availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: contract.pluginId,
            response: { availabilityCursor: 1, packageAssets: [],
                hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                intent: { pluginId: contract.pluginId, desiredVersion: null, enabled: true, offlineUiHosting: 'enabled',
                    writableCollections: [ref], revision: 'intent-1' }, release: null, uiArtifacts: [] } }],
    } });
    const validate = compilePluginJsonSchema(contract.schema);
    let links: readonly Readonly<{ provider: 'github'; repository: string; number: number }>[] = [];
    let failure = false;
    const request = runtimeFetch.getMockImplementation();
    if (!request) throw new Error('Expected the Workflow HTTP boundary');
    runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/plugins/data/contract') return json({ access: 'readOnly', contract });
        if (path !== '/v1/plugins/data/query') return request(url, init);
        if (failure) throw new Error('Channels transport unavailable');
        const rows = links.map((link, index) => {
            const binding = ConversationBindingV1Schema.parse({
                v: 1, id: `binding-${index}`, connectionId: 'connection-1', createdAt: 1, updatedAt: 1,
                endpoint: { kind: 'githubPullRequest', audience: 'shared', id: `pr-${link.number}` },
                target: { kind: 'session', sessionId, pullRequestLink: { repository: link.repository, number: link.number },
                    policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
                allowedPrincipalIds: ['principal-1'], allowBotSenders: false, inputMode: 'directMentionsOnly', inboundDebounceMs: 0,
                linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: false, deletionState: 'none',
            });
            const { v, id, connectionId, createdAt, updatedAt, ...payload } = binding;
            const encoded = encodePluginCollectionLogicalValueV1({ contract,
                isValidLogicalValue: (value) => isValidPluginJsonSchemaValue(validate, value),
                value: { id, 'record-kind': 'binding', v, 'connection-id': connectionId, 'binding-id': id,
                    'created-at': createdAt, 'updated-at': updatedAt, payload }, encryptionMode: 'plain', material: null,
                randomBytes: (length) => new Uint8Array(length).fill(9) });
            if (encoded.status !== 'encoded') throw new Error(`Invalid Channels fixture: ${encoded.reason}`);
            return { rowId: encoded.rowId, revision: 1, projection: encoded.projection, content: encoded.content };
        });
        return json({ rows, changeCursor: 1 });
    });
    return { setLinks: (next: typeof links) => { links = next; }, fail: () => { failure = true; } };
}

async function createHarness(mode: 'plain' | 'e2ee' = 'plain', options: Readonly<{ malformed?: boolean; locked?: boolean; identity?: boolean; historicalSecret?: Uint8Array; credentialKind?: 'account_directory' | 'ephemeral_session_runner'; automations?: readonly AutomationDefinitionListItem[]; cleanupFailure?: boolean; beforeAutomationDeleteResponse?: () => Promise<void>; beforeAutomationListResponse?: () => Promise<void> }> = {}) {
    const home = await upsertAndActivateServer({ serverUrl: `https://workflow-${mode}-${crypto.randomUUID()}.test`, scope: 'tab' });
    if (options.identity) await setServerProfileIdentityForUrl(home.serverUrl, `srv_workflow-${crypto.randomUUID()}`);
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: accountId,
        ...(options.credentialKind ? { provenance: { v: 1, kind: options.credentialKind,
            authority: options.credentialKind === 'account_directory' ? 'present_user' : 'session_runtime' } } : {}),
    })), 'base64url')}.signature`;
    const secret = new Uint8Array(32).fill(24);
    const credentials: AuthCredentials = options.historicalSecret
        ? { token, secret: encodeBase64(options.historicalSecret, 'base64url') }
        : mode === 'plain' || options.locked ? { token } : { token, secret: encodeBase64(secret, 'base64url') };
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
    const material = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }) : undefined;
    // Stored Run content has its own key even when the current reader is locked.
    // The real Account key seals only the owner's recipient envelope.
    const encryption: AvailableAutomationAccountEncryptionV1 = material ? {
        kind: 'available', material, witness: { mode: 'e2ee', version: 1,
            contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) },
    } : { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } };
    const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));
    const preparedKey = prepareWorkflowRunDataKeyV1({ accountId, encryption, randomBytes });
    const ownerEnvelope = preparedKey.recipientKeyEnvelopes.find((entry) => entry.recipientAccountId === accountId)?.encryptedDataKey ?? null;
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: accountId, access: 'owner',
        encryptionMode: mode, dataEncryptionKey: ownerEnvelope, callerDataEncryptionKey: ownerEnvelope,
        recipients: [], visibleTeamId: null, ownerAccountCurrentness: encryption.witness,
    });
    const run = createWorkflowRunSummaryFixture({ id: runId, origin: { kind: 'direct' }, machineId: 'machine-a' });
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition,
        admission: { kind: 'user' },
        // Exact-Machine availability is an external boundary; frozen facts stay real.
        effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    if (!materialized.ok) throw new Error(`workflow_fixture_not_materialized:${materialized.error.code}`);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        ...(preparedKey.runCrypto.mode === 'e2ee'
            ? { ...preparedKey.runCrypto, randomBytes }
            : preparedKey.runCrypto),
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        acceptedSnapshot: materialized.snapshot,
    }));
    const operations: Readonly<Record<string, unknown>>[] = [];
    const deletedResources: string[] = [];
    const artifacts = new Map<string, Artifact>();
    const automationRows = new Map<string, AutomationDefinitionDetail>();
    const automationWrites: string[] = [];
    runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const target = new URL(String(url));
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
        if (target.pathname === '/v1/features' || target.pathname === '/v1/features/authenticated') {
            const features = createRootLayoutFeaturesResponse();
            return json({ ...features, capabilities: { ...features.capabilities, accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2,
                currentProtocolVersion: ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1' } },
            });
        }
        expect(target.origin).toBe(home.serverUrl);
        if (target.pathname === '/v1/account/encryption') return json({ mode, updatedAt: 0 });
        if (target.pathname === '/v1/account/profile') return json({ ...profileDefaults, id: accountId });
        if (target.pathname === '/v1/account/authoring-memory') return json({ rows: [] });
        if (target.pathname === '/v2/changes') return json({ changes: [], nextCursor: 0 });
        if (target.pathname === '/v2/sessions' || target.pathname === '/v2/sessions/active') {
            return json({ sessions: [], nextCursor: null, hasNext: false });
        }
        if (target.pathname === '/v1/machines') return json([]);
        if (target.pathname === '/v1/push-tokens') return json({ success: true });
        if (target.pathname === '/v2/account/settings') return json({ content: null, version: 0 });
        if (target.pathname === '/v1/account/encryption/currentness') return json({ mode, version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) : null, updatedAt: 0,
            recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' } });
        if (target.pathname === '/v1/artifacts') {
            if (init?.method !== 'POST') return json([...artifacts.values()]);
            const input = JSON.parse(String(init.body)) as ArtifactCreateRequest;
            const row: Artifact = { ...input, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
            artifacts.set(input.id, row);
            return json(row);
        }
        if (target.pathname.startsWith('/v1/artifacts/') && target.pathname.endsWith('/access/grants')) {
            const artifactId = decodeURIComponent(target.pathname.slice('/v1/artifacts/'.length, -'/access/grants'.length));
            return json({ artifactId, ownerAccountId: accountId, access: 'owner', grants: [] });
        }
        if (target.pathname.startsWith('/v1/artifacts/') && target.pathname.endsWith('/access/recipients')) {
            const artifactId = decodeURIComponent(target.pathname.slice('/v1/artifacts/'.length, -'/access/recipients'.length));
            const artifact = artifacts.get(artifactId);
            if (!artifact) return json({ error: 'not-found' }, 404);
            // The real E2EE open prepares the current audience; this transport
            // has no additional recipients, but echoes the exact stored key.
            return json(ArtifactAccessRecipientCensusResponseV1Schema.parse({
                artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
                dataEncryptionKey: mode === 'plain' ? null : artifact.dataEncryptionKey,
                callerDataEncryptionKey: mode === 'plain' ? null : artifact.dataEncryptionKey,
                recipients: [],
            }));
        }
        if (target.pathname.startsWith('/v1/artifacts/')) {
            const artifactId = target.pathname.slice('/v1/artifacts/'.length);
            if (init?.method === 'DELETE') {
                deletedResources.push(artifactId);
                artifacts.delete(artifactId);
                return new Response(null, { status: 204 });
            }
            return json(artifacts.get(artifactId) ?? { error: 'not-found' }, artifacts.has(artifactId) ? 200 : 404);
        }
        if (target.pathname === '/v3/automations') {
            if (init?.method === 'POST') {
                const row = createdAutomation(JSON.parse(String(init.body)) as AutomationDefinitionCreateRequest);
                automationWrites.push(`create:${row.id}`);
                automationRows.set(row.id, row);
                return json(row);
            }
            await options.beforeAutomationListResponse?.();
            const workflowFilter = target.searchParams.get('workflowDefinitionId');
            const sessionFilter = target.searchParams.get('scopeSessionId');
            const accountInline = target.searchParams.get('scope') === 'account_inline';
            const listed = [...(options.automations ?? []), ...[...automationRows.values()].map(listedAutomation)].filter((row) => (
                (workflowFilter === null || row.workflowDefinitionId === workflowFilter)
                && (sessionFilter === null || row.scopeSessionId === sessionFilter)
                && (!accountInline || (row.workflowDefinitionId == null && row.scopeSessionId == null))
            ));
            return json({ automations: listed, nextCursor: null });
        }
        if (target.pathname.startsWith('/v3/automations/') && init?.method === 'DELETE') {
            if (options.cleanupFailure) return json({ error: 'cleanup_unavailable' }, 503);
            deletedResources.push(target.pathname.slice('/v3/automations/'.length));
            await options.beforeAutomationDeleteResponse?.();
            return json({ ok: true });
        }
        const automationId = target.pathname.startsWith('/v3/automations/') && target.pathname !== '/v3/automations/runs/workflow-storage'
            ? decodeURIComponent(target.pathname.slice('/v3/automations/'.length)) : null;
        if (automationId !== null && init?.method === 'PUT') {
            const row = automationRows.get(automationId);
            const input = JSON.parse(String(init.body)) as AutomationDefinitionReconcileRequest;
            if (!row) return json({ error: 'automation_not_found' }, 404);
            if (row.templateVersion !== input.expectedTemplateVersion) return json({ error: 'currentness_conflict' }, 409);
            const next = reconciledAutomation(row, input);
            automationWrites.push(`reconcile:${automationId}`);
            automationRows.set(automationId, next);
            return json(next);
        }
        if (automationId !== null) {
            const row = automationRows.get(automationId);
            return row ? json(row) : json({ error: 'automation_not_found' }, 404);
        }
        // Unserved background reads are HTTP refusals, not a transport outage:
        // throwing here would make the real supervisor mark reachable Home offline.
        if (target.pathname !== '/v3/automations/runs/workflow-storage') return json({ error: 'route_not_found' }, 404);
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        const operation = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        expect(operation).not.toHaveProperty('publisherMachineId');
        operations.push(operation);
        if (operation.operation === 'get') return json({ run, acceptedEnvelope: options.malformed ? '{"t":"plain","v":"bad"}' : acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null, keyCensus });
        if (operation.operation === 'run-key.census') return json(keyCensus);
        if (operation.operation === 'invocations.list') return json({ invocations: [], parentRevision: run.revision });
        if (operation.operation === 'pause') return json({ run: { ...run, state: 'pause_requested', revision: 2 }, intent: 'pause_requested' });
        if (operation.operation === 'cancel') return json({ run: { ...run, state: 'cancelled', revision: 2 }, intent: 'cancel_requested' });
        throw new Error(`unexpected_operation:${String(operation.operation)}`);
    });
    await upsertAndActivateServer({ serverUrl: `https://focused-${crypto.randomUUID()}.test`, scope: 'tab' });
    const account = await captureLazyActionAccountContext(home.id);
    // Capture follows the app's Account bootstrap; family construction happens
    // afterwards, so its real machine relay cannot re-enter storage creation.
    const { createUiWorkflowAction } = await import('./workflowActionDeps');
    const transport = vi.fn<WorkflowActionTransport>(async () => ({ run, admission: 'created' }));
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
    // The mounted family's captured lifetime is real; the default factory still
    // owns settings policy, approval and every other Action dependency.
    const execute = createFrontDoorActionExecute(createDefaultActionExecutor({ workflowAction: createUiWorkflowAction({ account, transport }) }));
    const executeDefault = createFrontDoorActionExecute(createDefaultActionExecutor());
    const context = { surface: 'ui' as const, serverId: account.serverId, runtimeAccountId: accountId, authority: 'present_user' as const };
    return { account, execute, executeDefault, context, transport, operations, home, createUiWorkflowAction, deletedResources, artifacts, automationRows, automationWrites };
}

describe('UI Workflow Action front door', () => {
    it.each(['held', 'forgotten', 'wrong-envelope'] as const)('lists retained E2EE Session templates with %s custody and allows locked deletion', async (custody) => {
        const h = await createHarness('plain', custody === 'forgotten' ? {} : { historicalSecret: new Uint8Array(32).fill(7) });
        try {
            h.automationRows.set('automation-retained', {
                ...triggerSetRow('automation-retained', ''), workflowDefinitionId: null,
                name: 'Old encrypted trigger', targetType: 'existingSession', existingSessionId: 'session-old',
                templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
                triggers: [storedTrigger('scheduled', scheduleTrigger)],
            });
            const encryption = await createEncryptionFromAuthCredentials({ token: h.account.credentials.token,
                secret: encodeBase64(new Uint8Array(32).fill(custody === 'wrong-envelope' ? 8 : 7), 'base64url') });
            const encryptedKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(9),
                recipientPublicKey: encryption.contentDataKey, randomBytes: (length) => new Uint8Array(length).fill(3) }), 'base64');
            const request = runtimeFetch.getMockImplementation()!;
            runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
                if (new URL(String(url)).pathname === '/v2/sessions/session-old') return json({ session: {
                    id: 'session-old', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
                    encryptionMode: 'e2ee', metadata: 'encrypted-metadata', metadataVersion: 1,
                    agentState: null, agentStateVersion: 1, dataEncryptionKey: encryptedKey, share: null,
                } });
                return request(url, init);
            });
            const listed = await h.execute('workflow.trigger.list', { scope: 'account_inline' }, h.context);
            expect(listed).toMatchObject({ ok: true, result: { sets: [{ automationId: 'automation-retained',
                ...(custody === 'held'
                    ? { health: 'available', target: { kind: 'inline' }, legacy: { editable: false } }
                    : { health: 'source_unavailable', legacy: { lockedReason: 'session_key_required' } }),
            }] } });
            if (custody !== 'held') {
                const removed = await h.execute('workflow.trigger.remove', { automationId: 'automation-retained', triggerId: 'scheduled' }, h.context);
                expect(removed).toMatchObject({ ok: true });
                expect(h.automationRows.get('automation-retained')?.triggers).toEqual([]);
            }
        } finally { h.account.dispose(); }
    });
    it.each(['absent', 'bound', 'unknown'] as const)('converts predecessor rows only with authoritative Channels absence (%s)', async (association) => {
        const h = await createHarness();
        try {
            h.automationRows.set('automation-old', { id: 'automation-old', name: 'Old', description: null, enabled: true,
                targetType: 'newSession', existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
                workflowDefinitionId: null, scopeSessionId: null, templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN,
                assignments: [{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }], triggers: [] });
            h.transport.mockImplementation(async () => association === 'unknown'
                ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }
                : { kind: 'automationAssociation', automationId: 'automation-old', association });
            const result = await h.execute('workflow.trigger.update', { automationId: 'automation-old', expectedRevision: 1, patch: { enabled: false } },
                { ...h.context, externalActionTarget: { kind: 'machine', machineId: 'machine-a' } });
            if (association === 'absent') {
                expect(result).toMatchObject({ ok: true, result: { set: { revision: 2, health: 'available' } } });
                expect(h.automationRows.get('automation-old')?.executionRecipe).toMatchObject({ v: 2 });
            } else {
                expect(result).toMatchObject({ ok: false, errorCode: 'legacy_conversion_unsupported', details: {
                    reason: association === 'bound' ? 'channel_reply_handoff' : 'channel_association_unknown' } });
                expect(h.automationWrites).toEqual([]);
            }
        } finally { h.account.dispose(); }
    });
    it('converts an existing-Session predecessor using its current Agent and placement, not stale template defaults', async () => {
        const previousState = storage.getState();
        const h = await createHarness();
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await restoreServerAccountForTest({ serverUrl: h.home.serverUrl, accountId, request });
            runtimeFetch.mockImplementation(request);
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId }, sessions: {
                'session-old': createSessionFixture({ id: 'session-old', active: false, metadata: {
                    path: '/current-session-path', host: 'host', homeDir: '/home', machineId: 'machine-a', agent: 'codex', permissionMode: 'read-only' } }),
            } });
            h.automationRows.set('automation-old', { id: 'automation-old', name: 'Old', description: null, enabled: true,
                targetType: 'existingSession', existingSessionId: 'session-old', templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
                workflowDefinitionId: null, scopeSessionId: null, templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN,
                assignments: [{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }], triggers: [] });
            h.transport.mockResolvedValue({ kind: 'automationAssociation', automationId: 'automation-old', association: 'absent' });
            const result = await h.execute('workflow.trigger.update', { automationId: 'automation-old', expectedRevision: 1, patch: { enabled: false } },
                { ...h.context, externalActionTarget: { kind: 'machine', machineId: 'machine-a' } });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { set: { context: { workspace: { directory: '/current-session-path' },
                inlineDefinition: { defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                    permissionMode: 'read-only', conversation: { kind: 'existing_session', sessionId: 'session-old', machineId: 'machine-a' } } } } } } });
        } finally { h.account.dispose(); await connection?.dispose(); storage.setState(previousState); }
    });
    it('refreshes a mounted session\'s PR links when its Channel binding changes without a trigger write', async () => {
        const previousState = storage.getState();
        const h = await createHarness();
        const sessionId = 'session-pr-links';
        const pullRequest = { provider: 'github' as const, repository: 'happier-dev/happier', number: 42 };
        let pullRequestLinks: typeof pullRequest[] = [];
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSessionTriggers>>>> | null = null;
        const changed = () => publishActivePluginCollectionChanges([{
            cursor: 1, kind: 'pluginDomain', entityId: 'pluginDomain/happier.channels/data-collection/channel-state', changedAt: 1,
            hint: { pluginDomain: 'dataCollection', pluginId: 'happier.channels', collectionId: 'channel-state',
                contractDigest: 'a'.repeat(43), revision: 1, full: true },
        }]);
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await restoreServerAccountForTest({ serverUrl: h.home.serverUrl, accountId, request });
            runtimeFetch.mockImplementation(request);
            // Only Machine daemons are absent; this fixture's Home HTTP is reachable.
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId }, sessions: {
                [sessionId]: createSessionFixture({ id: sessionId, active: false,
                    metadata: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a' } }),
            }, machines: {}, machineListByServerId: {} });
            const projection = await installPullRequestProjection(h, sessionId);
            projection.setLinks(pullRequestLinks);
            hook = await renderHook(() => useSessionTriggers(sessionId));
            expect(hook.getCurrent(), JSON.stringify(hook.getCurrent())).toMatchObject({ status: 'ready', sets: [], pullRequestLinks: [] });
            pullRequestLinks = [pullRequest];
            projection.setLinks(pullRequestLinks);
            await act(async () => changed());
            await flushHookEffects();
            expect(hook.getCurrent().pullRequestLinks).toEqual([pullRequest]);
            expect(h.automationWrites).toEqual([]);
            await hook.unmount();
            hook = null;
            const readsBeforeUnmountedChange = runtimeFetch.mock.calls.length;
            await act(async () => changed());
            await flushHookEffects();
            expect(runtimeFetch.mock.calls.length).toBe(readsBeforeUnmountedChange);
        } finally {
            await hook?.unmount();
            await act(async () => { h.account.dispose(); await connection?.dispose(); storage.setState(previousState); });
        }
    });
    it.each(['prComment', 'ciFailed'] as const)('creates a scoped %s trigger from the session form and selected pull request', async (kind) => {
        const previousState = storage.getState();
        const h = await createHarness();
        const sessionId = 'session-pr-form';
        const pullRequest = { repository: 'happier-dev/happier', number: 42 };
        const pullRequestLinks = kind === 'ciFailed' ? [{ provider: 'github' as const, ...pullRequest }] : [];
        const attachments: ReturnType<typeof SessionPullRequestBindingInputV1Schema.parse>[] = [];
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await restoreServerAccountForTest({ serverUrl: h.home.serverUrl, accountId, request });
            runtimeFetch.mockImplementation(request);
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId }, sessions: {
                [sessionId]: createSessionFixture({ id: sessionId, active: false,
                    metadata: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a' } }),
            }, machines: {}, machineListByServerId: {} });
            (await installPullRequestProjection(h, sessionId)).setLinks(pullRequestLinks);
            machineRpc.mockImplementation(async (request: Parameters<WorkflowActionTransport>[0]) => {
                if (request.method === 'scm.pullRequest.list') return ScmPullRequestListResponseSchema.parse({ success: true,
                    pullRequests: [{ provider: { kind: 'github', id: 'github', displayName: 'GitHub', baseUrl: 'https://github.com',
                        nameWithOwner: pullRequest.repository }, number: pullRequest.number, title: 'Fix CI',
                        url: 'https://github.com/happier-dev/happier/pull/42', baseBranch: 'main', headBranch: 'fix', state: 'open' }] });
                const envelope = request.payload as { input: { input: unknown } };
                const input = SessionPullRequestBindingInputV1Schema.parse(envelope.input.input);
                if (input.kind === 'attach') {
                    attachments.push(input);
                    return { kind: 'attached', bindingId: 'binding-pr-form' };
                }
                return { kind: 'removed' };
            });
            const listed = await listSessionTriggers({ sessionId }, { context: { externalActionTarget: { kind: 'machine', machineId: 'machine-a' } } });
            expect(listed.pullRequestLinks).toEqual(pullRequestLinks);
            screen = await renderScreen(React.createElement(SessionTriggersSection, { sessionId }));
            await flushHookEffects();
            await screen.pressByTestIdAsync('session-work-triggers-add');
            const when = screen.findAllByType(DropdownMenu).find((node) => node.props.testID === 'session-work-trigger-popover-when');
            expect(when?.props.items.find((item: { id: string }) => item.id === kind)).not.toMatchObject({ disabled: true });
            await act(async () => when?.props.onSelect(kind));
            if (pullRequestLinks.length === 0) {
                expect(screen.findByTestId('session-work-trigger-popover-submit')?.props.disabled).toBe(true);
                const picker = () => screen?.findAllByType(DropdownMenu).find((node) => node.props.testID === 'session-work-trigger-popover-pull-request');
                await act(async () => picker()?.props.onOpenChange(true));
                await flushHookEffects();
                await act(async () => picker()?.props.onSelect('happier-dev/happier#42'));
            }
            expect(screen.getTextContent()).toContain('#42');
            await act(async () => screen?.changeTextByTestId('session-work-trigger-popover-prompt', 'Review this pull request'));
            expect(screen.findByTestId('session-work-trigger-popover-submit')?.props.disabled).toBe(false);
            await screen.pressByTestIdAsync('session-work-trigger-popover-submit');
            await flushHookEffects();
            expect([...h.automationRows.values()]).toEqual([expect.objectContaining({
                scopeSessionId: sessionId, triggers: [expect.objectContaining({ kind, sourceSessionId: sessionId, enabled: true })],
            })]);
            expect(attachments).toEqual([expect.objectContaining({ kind: 'attach', sessionId, pullRequest,
                target: expect.objectContaining({ triggerKind: kind }) })]);
            expect(screen.findByTestId('session-work-trigger-popover')).toBeNull();
        } finally {
            await act(async () => { screen?.unmount(); h.account.dispose(); await connection?.dispose(); storage.setState(previousState); });
        }
    });
    it('reads an execution notification source from its exact captured-Home machine, not the focused Home relay', async () => {
        const h = await createHarness();
        try {
            const source = { kind: 'execution_run' as const, machineId: 'machine-a', runId: 'execution-source' };
            h.transport.mockResolvedValue({ run: { runId: source.runId, callId: 'call-source', sidechainId: 'sidechain-source', intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'test' },
                permissionMode: 'read-only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
                startedAtMs: 1, status: 'running' } });
            const added = await h.execute('workflow.trigger.add', {
                project: { machineId: 'machine-a', directory: '/repo' },
                target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'action', id: 'notify',
                    actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Finished' } } }] } },
                trigger: { kind: 'runLifecycle', source, condition: 'terminal', enabled: true },
            }, h.context);
            expect(h.transport, JSON.stringify(added)).toHaveBeenCalledWith(expect.objectContaining({
                serverId: h.account.serverId, accountId, machineId: source.machineId, method: 'execution.run.get',
            }));
            expect(added, JSON.stringify(added)).toMatchObject({ ok: true, result: { set: { triggers: [{ source }] } } });
            expect(h.automationRows.size).toBe(1);
        } finally { h.account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('authorizes the exact %s workflow Run before registering its notification source', async (mode) => {
        const h = await createHarness(mode);
        try {
            const added = await h.execute('workflow.trigger.add', {
                project: { machineId: 'machine-a', directory: '/repo' },
                target: { kind: 'inline', definition: { version: 1, blocks: [{
                    kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Finished' } },
                }] } },
                trigger: { kind: 'runLifecycle', source: { kind: 'workflow_run', runId }, condition: 'terminal', enabled: true },
            }, h.context);
            expect(added, JSON.stringify(added)).toMatchObject({ ok: true, result: { set: { health: 'available', triggers: [{
                kind: 'runLifecycle', source: { kind: 'workflow_run', runId }, condition: 'terminal', remainingOccurrences: 1,
            }] } } });
            expect(h.operations).toContainEqual(expect.objectContaining({ operation: 'get', runId }));
            expect(h.automationRows.size).toBe(1);
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });
    it('lists the serving machine plugin projection alongside Account workflows and keeps saved reads available without it', async () => {
        const previousState = storage.getState();
        const h = await createHarness();
        try {
            // Native tests have no browser tab storage; select the serving Home
            // through its real device-scoped owner instead of a discarded tab id.
            await upsertAndActivateServer({ serverUrl: h.home.serverUrl, scope: 'device' });
            const machine = createMachineFixture({ id: 'workflow-plugin-machine', activeAt: Date.now() });
            storage.setState({ profileScope: { serverId: h.account.serverId, accountId }, machines: { [machine.id]: machine },
                machineListByServerId: { [h.account.serverId]: [machine] } });
            machineRpc.mockResolvedValue({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: { 'example.recipe': { id: 'example.recipe', displayName: 'Example recipe', version: '1.2.3',
                    enabled: true, source: { kind: 'path', locator: '/plugins/example.recipe' } } },
                familiesById: { workflows: { family: 'workflows', entriesById: {
                    'example.recipe/review': { id: 'example.recipe/review', pluginId: 'example.recipe', pluginVersion: '1.2.3',
                        definition: { id: 'review', title: 'Plugin review', definition } },
                } } },
            }) });
            const definitionId = '00000000-0000-4000-8000-000000000013';
            await h.execute('workflow.definition.create', { definitionId, definition, metadata: { title: 'Saved review' } }, h.context);
            const listed = await h.execute('workflow.definition.list', {}, h.context);
            expect(listed).toMatchObject({ ok: true, result: {
                definitions: [expect.objectContaining({ definitionId })], pluginWorkflows: [{
                    workflow: 'plugin:example.recipe/review', pluginId: 'example.recipe', version: '1.2.3', title: 'Plugin review', definition,
                }],
            } });
            expect(h.artifacts.size).toBe(1);
            expect(h.transport).not.toHaveBeenCalled();
            // A replaced daemon invalidates the ready projection. Its failed
            // refresh must not promote retained inputs to a current source.
            const replacedMachine = { ...machine, daemonStateVersion: machine.daemonStateVersion + 1 };
            storage.setState({ machines: { [machine.id]: replacedMachine },
                machineListByServerId: { [h.account.serverId]: [replacedMachine] } });
            machineRpc.mockRejectedValueOnce(new Error('machine_unreachable'));
            const unavailable = await h.execute('workflow.definition.list', {}, h.context);
            expect(unavailable).toMatchObject({ ok: true, result: { definitions: [expect.objectContaining({ definitionId })] } });
            expect(unavailable).not.toHaveProperty('result.pluginWorkflows');
            storage.setState({ machines: {}, machineListByServerId: { [h.account.serverId]: [] } });
            await expect(h.execute('workflow.definition.list', {}, h.context)).resolves.toMatchObject({ ok: true,
                result: { definitions: [expect.objectContaining({ definitionId })] } });
        } finally { h.account.dispose(); storage.setState(previousState); }
    });
    it.each(['plain', 'e2ee'] as const)('saves a reviewed Run copy as one portable %s Artifact only on explicit create', async (mode) => {
        const h = await createHarness(mode);
        try {
            const acceptedDefinition = validateWorkflowDefinition({ ...definition,
                inputs: [{ name: 'topic', valueType: 'string', required: true }],
            }).normalizedDefinition!;
            const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: acceptedDefinition,
                admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
                context: {
                    source: { kind: 'inline' }, metadata: { title: 'Accepted title', description: 'Accepted description' },
                    inputs: { topic: 'private accepted input' }, machineId: 'machine-a', executionTarget: { kind: 'detached_run' },
                    workspaceTarget: { project: { machineId: 'machine-a', directory: '/private/repo', checkoutRootPath: '/private/repo' } },
                    origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } },
                },
            });
            if (!accepted.ok) throw new Error(`reviewed_run_fixture_not_materialized:${accepted.error.code}`);
            const seed = buildWorkflowReviewedRunSeed({
                run: createWorkflowRunSummaryFixture({ id: runId, origin: { kind: 'direct' }, machineId: 'machine-a' }),
                definition: accepted.snapshot.definition,
                acceptedContext: { ...accepted.snapshot, metadata: accepted.snapshot.metadata ?? undefined },
            });
            const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'reviewed-copy', name: seed.name, definition: seed.definition });
            expect(h.artifacts.size).toBe(0);
            const reviewed = validateWorkflowEditorDraft({ ...draft, name: 'Edited title' });
            expect(reviewed.valid).toBe(true);
            const definitionId = '00000000-0000-4000-8000-000000000003';
            await expect(h.executeDefault('workflow.definition.create', {
                definitionId, definition: reviewed.normalizedDefinition!, metadata: { title: 'Edited title', description: 'Edited description' },
            }, h.context)).resolves.toMatchObject({ ok: true, result: { definitionId, metadata: { title: 'Edited title', description: 'Edited description' } } });
            expect(h.artifacts.size).toBe(1);
            const artifact = await h.account.workflowArtifacts.read(definitionId);
            expect(artifact?.header).toMatchObject({ metadata: { title: 'Edited title', description: 'Edited description' } });
            if (typeof artifact?.body !== 'string') throw new Error('expected a text Workflow definition');
            expect(JSON.parse(artifact.body)).toEqual({ kind: 'workflow-definition.v1', definition: reviewed.normalizedDefinition });
            expect(h.operations).toEqual([]);
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });
    it.each([false, true])('settles workflow trigger cleanup before deleting the Artifact (cleanup failure: %s)', async (cleanupFailure) => {
        const definitionId = '00000000-0000-4000-8000-000000000002';
        const h = await createHarness('plain', { cleanupFailure, automations: [triggerSetRow('own-trigger-set', definitionId),
            triggerSetRow('session-trigger-set', definitionId, 'session-id'), triggerSetRow('other-workflow-set', runId)] });
        try {
            await expect(h.execute('workflow.definition.create', { definitionId, definition, metadata: { title: 'Workflow' } }, h.context))
                .resolves.toMatchObject({ ok: true, result: { definitionId } });
            const deletion = await h.execute('workflow.definition.delete', { definitionId }, h.context);
            if (cleanupFailure) {
                expect(deletion).toMatchObject({ ok: false });
                expect(h.artifacts.has(definitionId)).toBe(true);
                expect(h.deletedResources).toEqual([]);
            } else {
                expect(deletion).toEqual({ ok: true, result: { deleted: true, definitionId } });
                expect(h.deletedResources).toEqual(['own-trigger-set', 'session-trigger-set', definitionId]);
            }
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });
    it('refuses the Artifact delete if credentials retire while trigger cleanup settles', async () => {
        const definitionId = '00000000-0000-4000-8000-000000000004';
        const h = await createHarness('plain', { automations: [triggerSetRow('own-trigger-set', definitionId)],
            beforeAutomationDeleteResponse: async () => {
                expect(await TokenStorage.setCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId }, { token: 'replacement-account' })).toBe(true);
            },
        });
        try {
            await expect(h.execute('workflow.definition.create', { definitionId, definition, metadata: { title: 'Workflow' } }, h.context))
                .resolves.toMatchObject({ ok: true, result: { definitionId } });
            await expect(h.execute('workflow.definition.delete', { definitionId }, h.context)).resolves.toMatchObject({ ok: false });
            expect(h.deletedResources).toEqual(['own-trigger-set']);
            expect(h.artifacts.has(definitionId)).toBe(true);
            expect(h.transport).not.toHaveBeenCalled();
        } finally {
            h.account.dispose();
            await TokenStorage.removeCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId });
        }
    });
    it('accepts the captured Home through its equivalent local profile id', async () => {
        const h = await createHarness('plain', { identity: true });
        try {
            expect(h.account.serverId).not.toBe(h.home.id);
            await expect(h.execute('workflow.definition.list', {}, { ...h.context, serverId: h.home.id }))
                .resolves.toEqual({ ok: true, result: { definitions: [] } });
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });

    it('retains host authorization for a non-present-user definition delete', async () => {
        const h = await createHarness();
        try {
            const { authority: _authority, ...context } = h.context;
            await h.createUiWorkflowAction({ account: h.account, transport: h.transport })({
                actionId: 'workflow.definition.delete', input: { definitionId: runId },
                context: { ...context, surface: 'agent', externalActionTarget: { kind: 'machine', machineId: 'relay-a' } },
            });
            expect(h.transport).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'relay-a', method: 'workflow.definition.delete' }));
            expect(h.deletedResources).toEqual([]);
            expect(h.operations).toEqual([]);
        } finally { h.account.dispose(); }
    });

    it.each(['account_directory', 'ephemeral_session_runner'] as const)('keeps %s credentials on their authorized host relay', async (credentialKind) => {
        const h = await createHarness('plain', { credentialKind });
        try {
            await h.createUiWorkflowAction({ account: h.account, transport: h.transport })({ actionId: 'workflow.definition.list', input: {},
                context: { ...h.context, externalActionTarget: { kind: 'machine', machineId: 'relay-a' } } });
            expect(h.transport).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'relay-a', method: 'workflow.definition.list' }));
            expect(h.operations).toEqual([]);
        } finally { h.account.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('opens %s retained content and records controls on the captured Home with all daemons offline', async (mode) => {
        const h = await createHarness(mode);
        try {
            await expect(h.execute('workflow.definition.list', {}, h.context)).resolves.toEqual({ ok: true, result: { definitions: [] } });
            await expect(h.execute('workflow.run.get', { runId }, h.context)).resolves.toMatchObject({ ok: true, result: { definition } });
            await expect(h.execute('workflow.run.pause', { runId, expectedRevision: 1 }, h.context)).resolves.toMatchObject({ ok: true, result: { intent: 'pause_requested' } });
            await expect(h.execute('workflow.run.cancel', { runId, expectedRevision: 1 }, h.context)).resolves.toMatchObject({ ok: true, result: { intent: 'cancel_requested' } });
            expect(h.transport).not.toHaveBeenCalled();
            expect(h.operations.map((operation) => operation.operation)).toContain('get');
        } finally { h.account.dispose(); }
    });

    it('keeps starts on the exact Machine relay', async () => {
        const h = await createHarness();
        try {
            const target = { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } };
            await expect(h.execute('workflow.run.start', { runId, source: { kind: 'inline', definition } }, { ...h.context, externalActionTarget: target }))
                .resolves.toMatchObject({ ok: true, result: { admission: 'created' } });
            expect(h.transport).toHaveBeenCalledWith(expect.objectContaining({ serverId: h.account.serverId, accountId, machineId: 'machine-a',
                payload: { v: 1, kind: 'targeted_action_rpc', target, input: { runId, source: { kind: 'inline', definition } } } }));
            expect(h.operations).toEqual([]);
        } finally { h.account.dispose(); }
    });

    it('uses an online relay when the first visible Machine has stale presence', async () => {
        const h = await createHarness();
        try {
            await upsertAndActivateServer({ serverUrl: h.home.serverUrl, scope: 'device' });
            const machines = [
                createMachineFixture({ id: 'stale', active: true, activeAt: 1, createdAt: 2 }),
                createMachineFixture({ id: 'online', active: true, activeAt: Date.now(), createdAt: 1 }),
            ];
            storage.setState({ machineListByServerId: { [h.home.id]: machines } });
            await h.createUiWorkflowAction({ account: h.account, transport: h.transport })({
                actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition } }), context: h.context,
            });
            expect(h.transport.mock.calls[0]?.[0].machineId).toBe('online');
        } finally {
            storage.setState({ machineListByServerId: {} });
            h.account.dispose();
        }
    });

    it.each(['plain', 'e2ee'] as const)('lists, adds, updates and removes %s Account triggers with no Machine', async (mode) => {
        const h = await createHarness(mode);
        try {
            const definitionId = '00000000-0000-4000-8000-000000000005';
            const project = { machineId: 'machine-a', directory: '/repo' };
            const created = await h.execute('workflow.definition.create', { definitionId, definition, metadata: { title: 'Workflow' } }, h.context);
            expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
            const added = await h.execute('workflow.trigger.add', { workflow: definitionId, project, trigger: scheduleTrigger }, h.context);
            expect(added).toMatchObject({ ok: true, result: { set: { health: 'available', project, target: { kind: 'workflow', ref: definitionId } } } });
            const automationId = (added as { result: { set: { automationId: string } } }).result.set.automationId;
            const triggerId = (added as { result: { triggerId: string } }).result.triggerId;
            const stored = h.automationRows.get(automationId)!;
            // The set context is sealed with the caller Account's current material.
            expect(stored.executionRecipe).toMatchObject({ v: 2, workflow: { t: mode === 'plain' ? 'plain' : 'encrypted' } });
            await expect(h.execute('workflow.trigger.list', { workflow: definitionId }, h.context)).resolves.toMatchObject({ ok: true,
                result: { sets: [{ automationId, health: 'available', triggers: [{ id: triggerId, enabled: true }] }] } });
            await expect(h.execute('workflow.trigger.update', { automationId, triggerId, expectedRevision: 1, patch: { enabled: false } }, h.context))
                .resolves.toMatchObject({ ok: true, result: { set: { automationId, triggers: [{ id: triggerId, enabled: false }] } } });
            await expect(h.execute('workflow.trigger.remove', { automationId, triggerId }, h.context))
                .resolves.toMatchObject({ ok: true, result: { set: { automationId, triggers: [] } } });
            expect(h.automationWrites).toEqual([`create:${automationId}`, `reconcile:${automationId}`, `reconcile:${automationId}`]);
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });

    it('refuses trigger reads and writes when the captured Account retires mid-operation', async () => {
        const definitionId = '00000000-0000-4000-8000-000000000006';
        const h = await createHarness('plain', { beforeAutomationListResponse: async () => {
            expect(await TokenStorage.setCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId }, { token: 'replacement-account' })).toBe(true);
        } });
        try {
            await expect(h.execute('workflow.trigger.list', { scope: 'account_inline' }, h.context)).resolves.toMatchObject({ ok: false });
            await expect(h.execute('workflow.trigger.add', { workflow: definitionId, project: { machineId: 'machine-a', directory: '/repo' },
                trigger: scheduleTrigger }, h.context)).resolves.toMatchObject({ ok: false });
            expect(h.automationWrites).toEqual([]);
            expect(h.transport).not.toHaveBeenCalled();
        } finally {
            h.account.dispose();
            await TokenStorage.removeCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId });
        }
    });

    it('lists session triggers through Account Channels with every daemon offline and preserves a failed link read', async () => {
        const previousState = storage.getState();
        const h = await createHarness();
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await restoreServerAccountForTest({ serverUrl: h.home.serverUrl, accountId, request });
            runtimeFetch.mockImplementation(request);
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId } });
            storage.getState().applySessions([createSessionFixture({ id: 'session-closed', active: false,
                metadata: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a' } as ReturnType<typeof createSessionFixture>['metadata'] })]);
            storage.setState({ machines: {}, machineListByServerId: {} });
            h.transport.mockResolvedValue({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
            machineRpc.mockRejectedValue(new Error('Daemon offline'));
            const projection = await installPullRequestProjection(h, 'session-closed');
            const target = { kind: 'inline' as const, definition };
            const added = await h.execute('session.trigger.add', { sessionId: 'session-closed', target,
                trigger: scheduleTrigger }, h.context);
            expect(added).toMatchObject({ ok: true });
            const pullRequestLinks = [{ provider: 'github' as const, repository: 'happier-dev/happier', number: 42 }];
            projection.setLinks(pullRequestLinks);
            h.account.assertCurrent();
            const listed = await h.execute('session.trigger.list', { sessionId: 'session-closed' }, h.context);
            expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true, result: { sessionId: 'session-closed', sets: [expect.objectContaining({ triggers: [expect.objectContaining({ kind: 'schedule' })] })], pullRequestLinks } });
            projection.setLinks([]);
            await expect(h.execute('session.trigger.list', { sessionId: 'session-closed' }, h.context))
                .resolves.toMatchObject({ ok: true, result: { pullRequestLinks: [] } });
            projection.fail();
            await expect(h.execute('session.trigger.list', { sessionId: 'session-closed' }, h.context))
                .resolves.toMatchObject({ ok: true, result: { sets: [expect.objectContaining({ triggers: [expect.objectContaining({ kind: 'schedule' })] })],
                    pullRequestLinks: { status: 'unavailable', code: 'target_unavailable' } } });
            expect(h.transport).not.toHaveBeenCalled();
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { h.account.dispose(); await connection?.dispose(); storage.setState(previousState); }
    });

    it('routes agent trigger writes to the host that owns agent policy, and refuses typed with no Machine', async () => {
        const h = await createHarness();
        try {
            const { authority: _authority, ...context } = h.context;
            const executeCaptured = h.createUiWorkflowAction({ account: h.account, transport: h.transport });
            await executeCaptured({ actionId: 'session.trigger.update', input: SessionTriggerUpdateRequestV1Schema.parse({
                sessionId: 'session-a', triggerId: 'trigger-a', expectedRevision: 3, patch: { enabled: false },
            }), context: { ...context, surface: 'agent', externalActionTarget: { kind: 'machine', machineId: 'machine-a' } } });
            expect(h.transport).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-a', method: 'session.trigger.update' }));
            await expect(executeCaptured({ actionId: 'workflow.trigger.add', input: {
                workflow: '00000000-0000-4000-8000-000000000007', project: { machineId: 'machine-a', directory: '/repo' }, trigger: scheduleTrigger,
            }, context: { ...context, surface: 'agent' } })).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            expect(h.automationWrites).toEqual([]);
            expect(h.transport).toHaveBeenCalledTimes(1);
        } finally { h.account.dispose(); }
    });

    it('refuses malformed content and mismatched Account scope before disclosure', async () => {
        const h = await createHarness('e2ee', { malformed: true });
        try {
            await expect(h.execute('workflow.run.get', { runId }, h.context)).resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            // The mounted family owns this captured lifetime. The default factory
            // intentionally captures the caller's explicit Home afresh instead.
            const executeCaptured = h.createUiWorkflowAction({ account: h.account, transport: h.transport });
            await expect(executeCaptured({ actionId: 'workflow.definition.list', input: {}, context: { ...h.context, serverId: 'other-home' } }))
                .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            await expect(executeCaptured({ actionId: 'workflow.run.cancel', input: { runId, expectedRevision: 1 }, context: { ...h.context, runtimeAccountId: 'other-account' } }))
                .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            expect(h.operations).toEqual([
                { operation: 'get', runId },
                { operation: 'run-key.census', runId },
            ]);
        } finally { h.account.dispose(); }
    });

    it('fails locked E2EE material closed after an opaque Run read without private disclosure or mutation', async () => {
        const h = await createHarness('e2ee', { locked: true });
        try {
            await expect(h.createUiWorkflowAction({ account: h.account, transport: h.transport })({
                actionId: 'workflow.run.get', input: { runId }, context: h.context,
            })).resolves.toEqual({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' });
            // The authorized read supplies the Run owner's mode and opaque
            // envelopes. Locked material must prevent opening or returning them,
            // and must stop before recipient census/preparation or mutation.
            expect(h.operations).toEqual([{ operation: 'get', runId }]);
            // Default settings bootstrap precedes Workflow dispatch. Its missing
            // material rejection is fail-closed, not a Workflow typed result.
            await expect(h.executeDefault('workflow.run.get', { runId }, h.context)).rejects.toBeInstanceOf(Error);
            expect(h.operations).toEqual([{ operation: 'get', runId }]);
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });

    it('retires captured credentials before later mutation', async () => {
        const h = await createHarness();
        try {
            expect(await TokenStorage.setCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId }, {
                token: `${h.account.credentials.token}changed`,
            })).toBe(true);
            await expect(h.execute('workflow.run.cancel', { runId, expectedRevision: 1 }, h.context))
                .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            expect(h.operations).toEqual([]);
            expect(h.transport).not.toHaveBeenCalled();
        } finally {
            h.account.dispose();
            await TokenStorage.removeCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId });
        }
    });
});
