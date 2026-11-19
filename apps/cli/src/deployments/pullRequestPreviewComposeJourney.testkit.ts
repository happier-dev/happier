import { DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { WorkflowApprovedOperationV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { isJsonObject, StrictJsonValueSchema, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { prepareWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, openWorkflowProgressStoredEnvelopeV1,
    parseWorkflowStoredContentEnvelopeV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 }
    from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as supabase from '../../../../packages/plugins/deployment-supabase/src/index';
import { createWorkflowApprovedOperationReader, prepareWorkflowApprovedOperationSnapshot }
    from '@/daemon/workflows/workflowApprovedOperation';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit }
    from '@/daemon/workflows/workflowRunStorage.testkit';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { prepareWorkflowDataCreationResultCapture } from './targets/workflowDataCreationResult';
import { createWorkflowRunActionOwner } from '@/session/actions/workflowRunActions';
import { DeploymentPreviewProvenanceV1Schema, type DeploymentEnvironmentContentV1 } from '@happier-dev/deployments/contracts/v1';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';

/** Shared fixture content for the accepted PR's reviewed Environment-create. */
export function createPullRequestPreviewEnvironmentContent(request: Readonly<{
    baseContent: DeploymentEnvironmentContentV1;
    input: ReturnType<typeof DeploymentEnvironmentCreateInputV1Schema.parse>;
    acceptedInputs: Readonly<Record<string, JsonValue>>;
}>): DeploymentEnvironmentContentV1 {
    const pr = request.acceptedInputs.pullRequest;
    if (!isJsonObject(pr)) throw new Error('accepted_pr_required');
    if (!request.input.preview) throw new Error('preview_relation_required');
    if (request.baseContent.definition.kind !== 'repository' || typeof pr.headSha !== 'string')
        throw new Error('repository_preview_required');
    return { ...request.baseContent,
        previewProvenance: DeploymentPreviewProvenanceV1Schema.parse({ v: 1,
            templateEnvironmentId: request.input.preview.templateEnvironmentId,
            runtimeTargetLinkId: request.input.preview.runtimeTargetLinkId,
            pullRequestId: request.input.preview.pullRequestId, pullRequestNumber: 17,
            repository: pr.repository, headRepository: pr.headRepository ?? pr.repository, author: { id: 'author', login: 'contributor' },
        }),
        definition: { ...request.baseContent.definition, ref: pr.headSha },
    };
}

/** Actual accepted/reviewed child and sealed storage, replacing only opaque Home
 * storage and provider HTTP. This does not stand in for the SCM event producer. */
export async function createPullRequestPreviewDataCreationJourneyFixture(options: Readonly<{
    contributes: ResolvedExecutablePluginRuntimeRegistry['contributes'];
    encrypted?: boolean;
    accountId?: string;
    createOutcome?: 'provisioned' | 'outcome_unknown';
    headRepository?: ScmHostingRepositoryIdentityV1;
    readableByAccountIds?: readonly string[];
    createEnvironment?(input: ReturnType<typeof DeploymentEnvironmentCreateInputV1Schema.parse>,
        context: ActionExecutorContext, acceptedInputs: Readonly<Record<string, JsonValue>>): Promise<unknown>;
}>) {
    const accountId = options.accountId ?? 'account-A', runId = 'ca00a439-791a-4bde-b332-d310c218799e';
    const invocationId = 'preview-data-create', actionRequestId = `${runId}/${invocationId}/0`;
    const action = { pluginId: supabase.manifest.id, localId: 'branches-create' };
    const qualified = `${action.pluginId}/actions/${action.localId}`;
    const declaration = supabase.manifest.contributes.actions?.find(item => item.id === action.localId);
    if (!declaration) throw new Error('supabase_branch_create_declaration_required');
    const pullRequest = { repository: { kind: 'github', deployment: 'https://forge.example/enterprise', repository: 'owner/app' },
        pullRequestId: '17', headSha: 'a'.repeat(40), branchName: 'pr-17',
        ...(options.headRepository ? { headRepository: options.headRepository } : {}) };
    const credentialRef = { service: { pluginId: supabase.manifest.id, localId: 'supabase' }, accountId: 'connected-A' };
    const custody = DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ v: 1, serverId: 'home',
        environmentId: 'environment-A', expectedRevision: 1, targetLinkId: 'data-link', expectedTargetLinkRevision: 1,
        credentialRef, credentialPrincipal: { kind: 'account', accountId,
            purpose: { consumer: action, purpose: 'deploy-manage' }, target: { kind: 'account', account: credentialRef } },
        providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'parent-project-A', providerEnvironment: 'parent-project-A' },
        providerEnvironment: { kind: 'custom', id: 'parent-project-A' } });
    const input = WorkflowApprovedOperationV1Schema.shape.parent.shape.input.parse({ ...custody,
        name: pullRequest.branchName, gitBranch: pullRequest.headSha, withData: false });
    const parent = { actionId: 'deployments.environments.create' as const,
        input: WorkflowApprovedOperationV1Schema.shape.parent.shape.input.parse(DeploymentEnvironmentCreateInputV1Schema.parse({
            serverId: 'home', requestKey: 'preview-create', contentArtifactId: 'preview-content',
            contentHeaderVersion: 1, contentBodyVersion: 1, projectSourceId: 'repository-source',
            protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers', controllerMachineId: 'host',
            preview: { templateEnvironmentId: 'template-A', expectedTemplateRevision: 1,
                pullRequestId: pullRequest.pullRequestId, runtimeTargetLinkId: 'template-runtime' },
        })) };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, defaults: {},
        inputs: [{ name: 'pullRequest', valueType: 'json', required: true }], blocks: [
            ...(options.createEnvironment ? [{ kind: 'action' as const, id: 'create-environment', actionId: parent.actionId,
                input: Object.fromEntries(Object.entries(parent.input).map(([field, value]) => [field, { kind: 'literal' as const, value }])) }] : []),
            { kind: 'action', id: 'data', actionId: qualified,
            input: { ...Object.fromEntries(Object.entries(custody).map(([field, value]) => [field, { kind: 'literal', value }])),
                withData: { kind: 'literal', value: false }, name: { kind: 'input', name: 'pullRequest', path: ['branchName'] },
                gitBranch: { kind: 'input', name: 'pullRequest', path: ['headSha'] } } }] },
        context: { source: { kind: 'inline' }, inputs: { pullRequest }, machineId: 'host', executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: 'host', directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
        effects: { resolveTargetAvailability: async () => true, readActionContract: async id => id === qualified
            ? freezeWorkflowActionContractV1({ ...declaration, outputSchema: declaration.resultSchema })
            : id === parent.actionId ? freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(parent.actionId))) : null } });
    if (!accepted.ok) throw new Error(`preview_workflow_materialization_failed:${accepted.error.code}`);
    const approved = await prepareWorkflowApprovedOperationSnapshot({ snapshot: accepted.snapshot, parent,
        steps: [...(options.createEnvironment ? [parent] : []), { actionId: qualified, input }], context: { actionRequestId: 'preview-parent-request',
            approvedActionReplay: { artifactId: 'preview-approval' }, presentUserApproval: { artifactId: 'preview-approval',
                actionId: parent.actionId, requestId: 'preview-parent-request', decidingAccountId: accountId,
                inputDigest: computeActionInputApprovalDigestV1(parent.actionId, parent.input) } } });
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
    const encryption = { kind: 'available' as const, witness: { mode: 'e2ee' as const, version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) }, material };
    const randomBytes = (length: number) => new Uint8Array(length).fill(3);
    const key = options.encrypted ? prepareWorkflowRunDataKeyV1({ accountId, encryption, randomBytes }) : null;
    const mode = key ? { ...key.runCrypto, randomBytes } : { mode: 'plain' as const };
    const envelope = key?.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
    const plainCensus = createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
    const acceptedBinding = { v: 1 as const, purpose: 'accepted_snapshot' as const, accountId, runId };
    const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'host', accountId, state: 'running', origin: { kind: 'direct' },
        acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...mode,
            binding: acceptedBinding, acceptedSnapshot: approved })),
        keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse(key ? { ...plainCensus, encryptionMode: 'e2ee',
            ownerAccountCurrentness: encryption.witness, dataEncryptionKey: envelope, callerDataEncryptionKey: envelope } : plainCensus) });
    const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId: invocationId,
        sequence: options.createEnvironment ? '2' : '1', parentRecordId: 'root', memberOrdinal: options.createEnvironment ? '1' : '0', attempt: '0' };
    const progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'action',
        invocationPath: { blockId: 'data', scope: [] }, attempt: '0', logicalInvocationRecordId: invocationId };
    const seal = (content: WorkflowProgressEnvelopeV1) => serializeWorkflowStoredContentEnvelopeV1(
        sealWorkflowProgressStoredEnvelopeV1({ ...mode, binding, progress: content }));
    const rootProgress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'root',
        invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: 'root' };
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...mode,
        binding: { ...binding, recordId: 'root', sequence: '0', parentRecordId: null, memberOrdinal: '0' }, progress: rootProgress }));
    const environmentInvocationId = 'preview-environment-create';
    const environmentProgress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'action',
        invocationPath: { blockId: 'create-environment', scope: [] }, attempt: '0', logicalInvocationRecordId: environmentInvocationId };
    const sealEnvironment = (progress: WorkflowProgressEnvelopeV1) => serializeWorkflowStoredContentEnvelopeV1(
        sealWorkflowProgressStoredEnvelopeV1({ ...mode, binding: { ...binding, recordId: environmentInvocationId,
            sequence: '1', memberOrdinal: '0' }, progress }));
    await storage.execute({ operation: 'invocations.admit', runId, parentAttempt: 0, expectedRevision: 0,
        checkpointEnvelope: '{}', invocations: [{ id: 'root', sequence: '0', parentRecordId: null,
            memberOrdinal: '0', contentEnvelope: rootEnvelope },
            ...(options.createEnvironment ? [{ id: environmentInvocationId, sequence: '1', parentRecordId: 'root', memberOrdinal: '0',
                contentEnvelope: sealEnvironment(environmentProgress) }] : []),
            { id: invocationId, sequence: binding.sequence, parentRecordId: 'root', memberOrdinal: binding.memberOrdinal,
            contentEnvelope: seal(progress) }] });
    await storage.execute({ operation: 'invocations.fact', runId, invocationId: 'root', invocationAttempt: '0',
        expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'running', contentEnvelope: rootEnvelope });
    const execution = { kind: 'action' as const, actionId: qualified, actionRequestId, localInputId: 'preview-data-input', input };
    await storage.execute({ operation: 'invocations.fact', runId, invocationId, invocationAttempt: '0',
        expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'admitting', contentEnvelope: seal({ ...progress, execution }) });
    const reader = createWorkflowApprovedOperationReader({ storage,
        resolveEncryption: async () => key ? encryption : { witness: { mode: 'plain' } } });
    const context: ActionExecutorContext = { actionRequestId, runtimeAccountId: accountId, surface: 'agent',
        authority: 'account_automation', executionRunWorkflowRunId: runId,
        actionCaller: { kind: 'workflowRun', runId, authorization: approved.authorization } };
    const readAdmission = (candidateInput = input, candidateContext = context) => reader({ runId, actionId: 'action.invoke',
        input: { action, input: candidateInput }, context: candidateContext, phase: 'dispatch' });
    let environmentResult: unknown;
    if (options.createEnvironment) {
        const createContext = { ...context, actionRequestId: `${runId}/${environmentInvocationId}/0` };
        const createExecution = { kind: 'action' as const, actionId: parent.actionId,
            actionRequestId: createContext.actionRequestId, localInputId: 'preview-environment-input', input: parent.input };
        await storage.execute({ operation: 'invocations.fact', runId, invocationId: environmentInvocationId, invocationAttempt: '0',
            expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'admitting',
            contentEnvelope: sealEnvironment({ ...environmentProgress, execution: createExecution }) });
        const creation = await reader({ runId, ...parent, context: createContext, phase: 'dispatch' });
        if (!creation?.invokeReviewedChild) throw new Error('preview_environment_reviewed_child_unavailable');
        const result = await creation.invokeReviewedChild(async issued => {
            if (!readHostReviewedChildOperationV1(issued, parent.actionId, parent.input)) throw new Error('preview_environment_child_issue_missing');
            environmentResult = await options.createEnvironment!(DeploymentEnvironmentCreateInputV1Schema.parse(parent.input), issued, approved.inputs);
            const created = DeploymentEnvironmentCreateResultV1Schema.safeParse(environmentResult);
            if (!created.success || !created.data.ok || created.data.environmentId !== input.environmentId)
                throw new Error('preview_environment_creation_failed');
            return { ok: true, result: StrictJsonValueSchema.parse(environmentResult) };
        });
        if (!result.ok) throw new Error('errorCode' in result ? result.errorCode : 'reviewed_child_failed');
        await storage.execute({ operation: 'invocations.fact', runId, invocationId: environmentInvocationId, invocationAttempt: '0',
            expectedContentRevision: '1', expectedLifecycle: 'admitting', lifecycle: 'completed',
            contentEnvelope: sealEnvironment({ ...environmentProgress, execution: createExecution, result: result.result }) });
    }
    const admitted = await readAdmission();
    if (!admitted?.invokeReviewedChild) throw new Error('preview_reviewed_child_unavailable');
    // Exercise refusals while the exact positive invocation is still active.
    const admissionChecks = {
        changedCommit: await readAdmission({ ...input, gitBranch: 'b'.repeat(40) }),
        changedPullRequest: await readAdmission({ ...input, name: 'pr-18' }),
        wrongActor: await readAdmission(input, { ...context, runtimeAccountId: 'other-account' }),
        wrongInvocation: await readAdmission(input, { ...context, actionRequestId: `${runId}/unrelated-invocation/0` }),
    };
    const requests: { method?: string; pathname: string; body: unknown }[] = [];
    const kit = await createPluginTestkit({ manifest: supabase.manifest, module: supabase, services: {
        http: createPluginHttpFixture({ async request(request) {
            requests.push({ method: request.method, pathname: new URL(request.url).pathname,
                body: request.body ? JSON.parse(new TextDecoder().decode(request.body)) : null });
            if (options.createOutcome === 'outcome_unknown') return { status: 503, headers: {},
                body: new TextEncoder().encode(JSON.stringify({ message: 'Provider unavailable after mutation issue' })) };
            return { status: 201, headers: {}, body: new TextEncoder().encode(JSON.stringify({
                id: 'e242cf8e-9562-4e0b-9082-a10ae56879c6', project_ref: 'child-project-A',
                parent_project_ref: 'parent-project-A', name: pullRequest.branchName, persistent: false,
                with_data: false, status: 'CREATING', db_pass: 'provider-private-echo',
            })) };
        } }),
    } });
    try {
        const executed = await admitted.invokeReviewedChild(async issued => {
            if (!readHostReviewedChildOperationV1(issued, qualified, input)) throw new Error('preview_child_issue_missing');
            return { ok: true, result: await kit.invokeAction('branches-create', input,
                { ...(issued.signal ? { signal: issued.signal } : {}) }) };
        });
        if (!executed.ok) throw new Error('errorCode' in executed ? executed.errorCode : 'reviewed_child_failed');
        const capture = prepareWorkflowDataCreationResultCapture(qualified, options.contributes);
        const captured = capture?.(executed.result);
        if (captured === undefined && options.createOutcome !== 'outcome_unknown') throw new Error('preview_data_creation_capture_required');
        await storage.execute({ operation: 'invocations.fact', runId, invocationId, invocationAttempt: '0',
            expectedContentRevision: '1', expectedLifecycle: 'admitting', lifecycle: 'completed',
            contentEnvelope: seal({ ...progress, execution: { ...execution, ...(captured === undefined ? {} : { output: captured }) }, result: executed.result }) });
        const row = storage.rowById(invocationId);
        if (!row) throw new Error('preview_retained_invocation_required');
        const reopened = openWorkflowProgressStoredEnvelopeV1({ ...mode, binding,
            envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) });
        const acceptedEnvelope = storage.acceptedEnvelope();
        if (!acceptedEnvelope) throw new Error('preview_retained_snapshot_required');
        const reopenedAccepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...mode, binding: acceptedBinding,
            envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope) });
        if (reopened.kind !== 'available' || reopenedAccepted.kind !== 'available') throw new Error('preview_storage_reopen_failed');
        const reference = { runId, invocationId };
        const readWorkflowInvocation = (requested = reference, readContext: ActionExecutorContext = {}) => {
            const callerAccountId = readContext.runtimeAccountId ?? readContext.machineAdmission?.actorAccountId ?? accountId;
            const owner = createWorkflowRunActionOwner({
                // The genuine Home HTTP/storage boundary authorizes the caller's
                // Account; this fixture has no cross-Account Run grant.
                storage: { execute: async (operation, transportOptions) => {
                    const sharedPlainRead = !key && options.readableByAccountIds?.includes(callerAccountId) === true;
                    if (callerAccountId !== accountId && !sharedPlainRead) throw Object.assign(new Error('run_not_found'), {
                        response: { status: 404, data: { error: 'run_not_found' } },
                    });
                    const response = await storage.execute(operation, transportOptions);
                    if (sharedPlainRead && operation.operation === 'get' && response && typeof response === 'object') {
                        // A plain Team Run has no recipient key to fabricate. Its
                        // authorized Home response exposes the canonical view census.
                        return { ...response, keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({
                            ...plainCensus, access: 'view', visibleTeamId: 'shared-team-fixture',
                        }) };
                    }
                    return response;
                } }, resolveAccountId: async () => callerAccountId,
                definitions: { get: async () => { throw new Error('inline_preview_has_no_saved_definition'); } },
                resolveEncryption: async () => key ? encryption : { kind: 'available',
                    witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } },
            });
            return owner.execute({ actionId: 'workflow.run.invocations.get', input: requested,
                context: { surface: 'cli', authority: 'present_user', runtimeAccountId: callerAccountId,
                    actionCaller: { kind: 'host' }, externalActionTarget: { kind: 'machine', machineId: 'host' }, ...readContext } });
        };
        return { accountId, pullRequest, parent, input, qualified, context, admissionChecks, requests, storage,
            accepted: reopenedAccepted.content, output: executed.result, captured, environmentResult,
            reference, readWorkflowInvocation,
            invocation: { index: row.index, progress: reopened.content, parentRevision: storage.run().revision } };
    } finally { await kit.dispose(); }
}
