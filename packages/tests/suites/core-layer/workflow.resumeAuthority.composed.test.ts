import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
    materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1, WorkflowActionOutputSchemasV1,
    type AutomationAccountCurrentnessWitnessV1, type WorkflowDefinitionV1,
} from '@happier-dev/protocol';
import { SessionInputCausalPermissionAuthorityV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createWorkflowRunActionOwner } from '../../../../apps/cli/src/session/actions/workflowRunActions';
import { createWorkflowRunStorageClient } from '../../../../apps/cli/src/daemon/workflows/workflowRunStorageClient';
import { createProductionWorkflowRunCoordinator } from '../../../../apps/cli/src/daemon/workflows/production';
import { createWorkflowActionContextResolver } from '../../../../apps/cli/src/daemon/workflows/workflowActionContext';
import { createCredentialedWorkflowMaterializationHostV1 } from '../../../../apps/cli/src/session/actions/workflowMaterializationHost';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '../../../../apps/cli/src/testkit/actionTransportDeps';
import { createWorkflowAcceptedAuthorizationCurrentness } from '../../../../apps/cli/src/daemon/workflows/daemonRuntime';

// Keep the server's alias/compiler behind its existing cross-app boundary.
const serverTestkitPath = '../../../../apps/server/sources/testkit/workflowApprovedOperationServer.testkit';
interface ServerBoundary {
    accountId: string; token: string; homeId: string; baseUrl: string;
    currentness: AutomationAccountCurrentnessWitnessV1;
    machines: readonly { id: string }[];
    publisherHeader(input: { machineId: string; path: string; body: unknown }): string;
    claim(machineId: string): Promise<{ runId: string; attempt: number; revision: number; workflowResumeRequestedRevision?: number }>;
    close(): Promise<void>;
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each(['narrower-agent', 'same-agent', 'person', 'revoked-source'] as const)(
    'enforces boundary Resume through installed composition (%s)', async scenario => {
    const module = await import(serverTestkitPath) as { startWorkflowApprovedOperationServer(): Promise<ServerBoundary> };
    const server = await module.startWorkflowApprovedOperationServer();
    cleanups.push(() => server.close());
    const machineId = server.machines[0]!.id;
    const runId = randomUUID();
    const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' };
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { permissionMode: 'safe-yolo' }, blocks: [
        { kind: 'wait', id: 'after-resume', document: { text: 'New review', references: [], attachments: [] } },
    ] };
    const sourceAuthority = scenario === 'revoked-source' ? { mediatorPluginId: 'com.happier.resume-source',
        sourceRef: 'message-1', sourceRevisionOrEpoch: '1', remoteApprovalMaxScope: 'request' as const } : undefined;
    const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition, context: {
        source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'detached_run' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' },
        authorization: { principal: { kind: 'host' }, ...(sourceAuthority ? { sourceAuthority } : {}) },
    }, admission: { kind: 'user' },
    effects: { resolveTargetAvailability: async () => true } });
    if (!materialized.ok) throw new Error(materialized.error.code);
    expect(materialized.snapshot.authorization.admittedPermissionCeiling).toBe('safe-yolo');
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId },
        acceptedSnapshot: materialized.snapshot,
    }));
    const storage = createWorkflowRunStorageClient({ token: server.token, machineId, serverHttpBaseUrl: server.baseUrl,
        createPublisherHeader: async ({ path, body }) => server.publisherHeader({ machineId, path, body }) });
    await storage.execute({ operation: 'admit', runId, machineId, origin: { kind: 'direct' },
        accountCurrentness: server.currentness, acceptedEnvelope, sourceArtifactId: null, recipientKeyEnvelopes: [] });
    const paused = WorkflowActionOutputSchemasV1['workflow.run.pause'].parse(
        await storage.execute({ operation: 'pause', runId, expectedRevision: 0 }));
    let sourceCurrent = true;
    let authorityReads = 0;
    const currentness = createWorkflowAcceptedAuthorizationCurrentness({ accountId: server.accountId,
        listAccountApiTokens: async () => { throw new Error('host_has_no_API_credential'); },
        // Plugin occurrence and external-source lookup are runtime/service boundaries.
        resolveCurrentPluginOccurrenceId: async () => 'installed-source',
        isMediatedSourceCurrent: async () => sourceCurrent,
    });
    const owner = createWorkflowRunActionOwner({ storage, resolveAccountId: async () => server.accountId,
        resolveEncryption: async () => ({ kind: 'available', witness: server.currentness }),
        definitions: { get: async () => { throw new Error('inline_source_has_no_definition'); } },
        isAcceptedAuthorizationCurrent: currentness,
    });
    const resolveContext = createWorkflowActionContextResolver(createCredentialedWorkflowMaterializationHostV1({
        credentials: { token: server.token, encryption: null }, accountId: server.accountId,
        serverId: server.homeId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
        callMachineAction: async () => { throw new Error('wait_has_no_machine_effect'); },
        readWorkflowDefinition: async () => { throw new Error('inline_source_has_no_definition'); },
    }));
    let releasedEffects = 0;
    const coordinate = createProductionWorkflowRunCoordinator({ token: server.token, accountId: server.accountId,
        machineId, storage, resolveAccountEncryption: async () => ({ kind: 'available', witness: server.currentness }),
        resolveControllerContext: ({ accepted, signal }) => resolveContext({ runId, authorization: accepted.authorization,
            workspace: accepted.workspaceTarget.project, workDepth: accepted.workDepth, origin: accepted.origin, signal }),
        isAcceptedAuthorizationCurrent: async input => { authorityReads++; return await currentness(input); },
        onCommittedTransition: async () => {}, onReviewEntered: async () => { releasedEffects++; },
        execution: { credentials: { token: server.token, encryption: null }, serverId: server.homeId,
            machineAdmissionTransport: async () => { throw new Error('wait_has_no_session_effect'); },
            resolveExistingSessionConversation: async () => null,
            detachedRun: { actionExecutor: createActionExecutor(createUnavailableActionTransportDeps()),
                buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) } },
    });
    let refusal: unknown;
    let claim: Awaited<ReturnType<ServerBoundary['claim']>> | undefined;
    sourceCurrent = scenario !== 'revoked-source';
    try {
        await owner.execute({ actionId: 'workflow.run.resume', input: { mode: 'boundary', runId, expectedRevision: paused.run.revision },
            context: { surface: scenario === 'person' || scenario === 'revoked-source' ? 'ui' : 'agent',
                authority: scenario === 'person' || scenario === 'revoked-source' ? 'present_user' : 'account_automation', actionCaller: { kind: 'host' },
                callerPermissionMode: scenario === 'person' ? 'default' : 'safe-yolo', causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1Schema.parse({
                    kind: 'admittedSessionInputV1', admittedPermissionCeiling: scenario === 'narrower-agent' ? 'default' : 'safe-yolo',
                }) } });
        claim = await server.claim(machineId);
        expect(claim.workflowResumeRequestedRevision).toBeDefined();
        const outcome = await coordinate({ ...claim, expectedRevision: claim.revision, acceptedEnvelope, accountCurrentness: server.currentness });
        refusal = 'reason' in outcome ? { code: outcome.reason } : outcome;
    } catch (error) { refusal = error; }
    if (scenario === 'narrower-agent' || scenario === 'revoked-source') {
        expect({ refusal, releasedEffects }).toMatchObject({ refusal: { code: 'run_access_denied' }, releasedEffects: 0 });
    } else {
        expect(refusal).toMatchObject({ state: 'waiting_for_review' });
        expect(releasedEffects).toBe(1);
        if (!claim) throw new Error('permitted_resume_has_no_claim');
        const snapshot = WorkflowActionOutputSchemasV1['workflow.run.get'].parse(await owner.execute({
            actionId: 'workflow.run.get', input: { runId }, context: { surface: 'ui', authority: 'present_user' },
        }));
        // Ordinary review wake is admitted work: even later source withdrawal
        // must neither repeat admission nor release the held effect twice.
        sourceCurrent = false;
        const { workflowResumeRequestedRevision: _consumed, ...ordinaryClaim } = claim;
        expect(await coordinate({ ...ordinaryClaim, expectedRevision: snapshot.run.revision, acceptedEnvelope,
            accountCurrentness: server.currentness })).toMatchObject({ state: 'waiting_for_review' });
        expect(releasedEffects).toBe(1);
        expect(authorityReads).toBe(1);
    }
});
