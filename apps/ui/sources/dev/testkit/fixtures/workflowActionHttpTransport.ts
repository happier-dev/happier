import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    AutomationDefinitionListResponseSchema, FeaturesResponseSchema, WorkflowDefinitionListResultV1Schema, WorkflowDefinitionGetResultV1Schema,
    WorkflowRunListResultV1Schema, WorkflowRunRecipientCensusResponseV1Schema,
    WorkflowAcceptedSnapshotV1Schema, encodePlainArtifactStoredContent, materializeWorkflowAcceptedSnapshotV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { createPlainAccountEncryptionCurrentnessFixture } from './accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from './featureFixtures';
import { createWorkflowDefinitionFixture } from './workflowRunFixtures';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected fixture object');
    // HTTP fixture JSON is untyped; narrow only its object boundary here.
    return value as Record<string, unknown>;
}

/** External HTTP facts only; the real Artifact codec and Action admission run above this transport. */
export function createWorkflowActionHttpTransport(params: Readonly<{
    fixtureResponse: (actionId: string, input: Record<string, unknown>) => Promise<unknown>;
    accountId: () => string;
    automationDefinitions?: (url: URL, init?: RequestInit) => Promise<Response | undefined>;
    automationRuns?: (url: URL, init?: RequestInit) => Promise<Response>;
}>) {
    const base = createRootLayoutFeaturesResponse();
    const features = FeaturesResponseSchema.parse({ ...base,
        features: { ...base.features, workflows: { enabled: true }, automations: { ...base.features.automations, enabled: true } },
        capabilities: { ...base.capabilities, accountStoredContentCompatibility: { v: 1,
            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1' } },
    });
    let artifacts: readonly Artifact[] = [];
    let automations: ReturnType<typeof AutomationDefinitionListResponseSchema.parse> = { automations: [], nextCursor: null };
    const reply = async (actionId: string, input: Record<string, unknown>) => {
        const response = record(await params.fixtureResponse(actionId, input));
        if (response.ok !== true) throw new Error(String(response.errorCode ?? 'fixture_request_failed'));
        return response.result;
    };
    const fetch: RuntimeFetch = async (url, init) => {
        const target = new URL(String(url));
        const requestAccountId = params.accountId();
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
        if (target.pathname === '/v1/features' || target.pathname === '/v1/features/authenticated') return json(features);
        if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (target.pathname === '/v2/account/settings') return json({ content: { t: 'plain', v: {} }, version: 1 });
        if (target.pathname === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture({ updatedAt: 0 }));
        if (target.pathname.startsWith('/v1/machines/')) return json({ machine: {
            id: decodeURIComponent(target.pathname.slice('/v1/machines/'.length)), dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } });
        if (target.pathname === '/v1/artifacts') {
            const page = WorkflowDefinitionListResultV1Schema.parse(await reply('workflow.definition.list', {}));
            if (page.nextCursor || page.pluginWorkflows?.length) throw new Error('HTTP fixture requires real Artifact pagination/plugin transport');
            const seed = createWorkflowDefinitionFixture({ defaults: { agentTarget: {
                kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' },
            } } });
            artifacts = page.definitions.map((item, index) => {
                const definition = createWorkflowDefinitionFixture({ ...seed, blocks: Array.from(
                    { length: item.contentStatus === 'available' ? item.stepCount : 1 },
                    (_, ordinal) => ({ ...seed.blocks[0]!, id: `fixture-step-${ordinal}` }),
                ) });
                return {
                    id: item.definitionId, ownerAccountId: item.ownerAccountId, access: item.access, encryptionMode: 'plain', publicAudience: 'none',
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    header: encodePlainArtifactStoredContent('contentUnavailableReason' in item && item.contentUnavailableReason === 'invalid_header'
                        ? { kind: item.kind } : { kind: item.kind, definitionId: item.definitionId,
                            revision: item.revision, metadata: item.metadata, previewSteps: [] }),
                    body: encodePlainArtifactStoredContent({ body: item.contentStatus === 'available'
                        ? JSON.stringify({ kind: 'workflow-definition.v1', definition }) : 'invalid stored body' }),
                    headerVersion: item.revision?.headerVersion ?? 1, bodyVersion: item.revision?.bodyVersion ?? 1,
                    seq: 1, createdAt: 1, updatedAt: page.definitions.length - index,
                } satisfies Artifact;
            });
            automations = AutomationDefinitionListResponseSchema.parse({ automations: page.definitions.filter(item => item.triggers.length).map(item => ({
                id: `automation-${item.definitionId}`, name: 'Fixture triggers', description: null, enabled: true,
                workflowDefinitionId: item.definitionId, scopeSessionId: null, targetType: null, existingSessionId: null,
                templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
                triggers: item.triggers.map((trigger, index) => ({ ...trigger, id: `trigger-${index}`, enabled: true,
                    revision: 0, createdAt: 1, updatedAt: 1, nextRunAt: item.nextRunAt })),
            })), nextCursor: null });
            return json(artifacts);
        }
        const artifactId = /^\/v1\/artifacts\/([^/]+)(?:\/revision\/\d+\/\d+)?$/.exec(target.pathname)?.[1];
        if (artifactId) {
            const id = decodeURIComponent(artifactId);
            if (init?.method === 'DELETE') {
                const response = record(await params.fixtureResponse('workflow.definition.delete', { definitionId: id }));
                if (response.ok !== true) return json({ error: response.error ?? 'Artifact not found' }, 404);
                artifacts = artifacts.filter(row => row.id !== id);
                return json({ success: true });
            }
            const artifact = artifacts.find(row => row.id === id);
            if (artifact) return json(artifact);
            // A direct editor URL reads its Artifact without first listing the library.
            const response = record(await params.fixtureResponse('workflow.definition.get', { definitionId: id }));
            if (response.ok !== true) return json({ error: 'Artifact not found' }, 404);
            const saved = WorkflowDefinitionGetResultV1Schema.parse(response.result);
            const directArtifact = {
                id, ownerAccountId: requestAccountId, access: saved.access, encryptionMode: 'plain', publicAudience: 'none',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId: id,
                    revision: saved.revision, metadata: saved.metadata, previewSteps: [] }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1', definition: saved.definition }) }),
                headerVersion: saved.revision.headerVersion, bodyVersion: saved.revision.bodyVersion,
                seq: 1, createdAt: 1, updatedAt: 1,
            } satisfies Artifact;
            artifacts = [...artifacts, directArtifact];
            return json(directArtifact);
        }
        if (target.pathname === '/v3/automations' || /^\/v3\/automations\/[^/]+$/.test(target.pathname)) {
            const custom = await params.automationDefinitions?.(target, init);
            if (custom) return custom;
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
                }), admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
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
    return { fetch, features };
}
