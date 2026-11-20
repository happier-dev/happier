import { describe, expect, it } from 'vitest';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { prepareWorkflowRunDataKeyV1, type WorkflowRunReadEncryptionV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { WorkflowAcceptedSnapshotV1Schema, type WorkflowApprovedOperationV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1, openWorkflowAcceptedSnapshotStoredEnvelopeV1, openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { createWorkflowApprovedOperationReader, prepareWorkflowApprovedOperationSnapshot } from './workflowApprovedOperation';
import { createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { prepareWorkflowApprovedOperation } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { AutomationDefinitionDetailSchema, AutomationRunCauseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { bindApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import { ApprovalProfileV1Schema } from '@happier-dev/protocol/actions/approvalProfiles';
import { createActionExecutor, readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploymentDeployInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { WorkflowAuthoredResultReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1, AutomationTriggerIdSchema, AutomationSourceSelectorIdV1Schema, PluginJsonValueV2Schema } from '@happier-dev/protocol';
import { StrictJsonValueSchema, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createPromptDocInLibrary, type PromptLibraryArtifactStore, type PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createActionExecutorBoundaryFixture } from '../../../../../packages/tests/src/testkit/actionExecutorBoundary';
import { createScheduledMachineUpdatesRolloutWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/machineUpdatesV1';
import { createMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { materializeWorkflowTriggerActionDefinition, projectWorkflowTriggerConsentSteps, readWorkflowTriggerActionConsent } from '@happier-dev/protocol/actions/executor/workflowTriggerConsent';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowTriggerEventValuesV1 } from '@happier-dev/protocol/workflows/workflowTriggerEventReferenceV1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';

import { WORKFLOW_TRIGGER_ADD_ACTION_ID } from '@happier-dev/protocol/actions/workflowTriggerActionIds';

const runId = '52bd37c4-99c6-41cf-90a5-3a1be2b1e031';
const invocationId = 'exact-child';
const accountId = 'owner';
const setupSources: JsonValue[] = [
  { kind: 'accountPresetOpaque', presetId: 'preset', presetRevision: 0, contentEncryptionMode: 'plain' },
  { kind: 'direct', setup: { scripts: [{ body: 'echo reviewed', affects: 'none' }] } },
];
const parent = { actionId: 'machines.setup.apply' as const,
  input: { homeId: 'home', machineId: 'host', targets: [{ homeId: 'home', machineId: 'host', desiredRevision: 0, recipePlans: [], sources: setupSources }] } };
const steps = [{ actionId: 'machines.setup.apply', input: { ...parent.input, machineId: 'target',
  targets: parent.input.targets.map(target => ({ ...target, machineId: 'target' })) } }];
const actionRequestId = `${runId}/${invocationId}/0`;
const definition = { version: 1, inputs: [], defaults: {}, blocks: [
  { kind: 'action', id: 'apply', actionId: 'machines.setup.apply', input: {} },
] };

function snapshot() {
  return WorkflowAcceptedSnapshotV1Schema.parse({ startedBy: 'user', authoredDefinition: definition, definition,
    materializedLeaves: [{ sourceKey: '$root', blockId: 'apply', kind: 'action', selection: {}, authoredWorkspace: { kind: 'inherit' },
      executionTarget: { kind: 'session' }, actionId: 'machines.setup.apply', actionInput: steps[0]!.input,
      actionContract: { inputSchema: { type: 'object' }, outputSchema: {} } }],
    frozenChildren: {}, workDepth: 0, metadata: null, inputs: {}, machineId: 'host', executionTarget: { kind: 'session' },
    workspaceTarget: { project: { machineId: 'host', directory: '/repo', checkoutRootPath: '/repo' } },
    source: { kind: 'inline' }, origin: { kind: 'direct', actionPolicy: { surface: 'ui', authority: 'present_user' } },
    authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } } });
}

function approvedContext(): ActionExecutorContext {
  return { actionRequestId: 'parent-request', approvedActionReplay: { artifactId: 'approval' },
    presentUserApproval: { artifactId: 'approval', actionId: parent.actionId, requestId: 'parent-request',
      inputDigest: computeActionInputApprovalDigestV1(parent.actionId, parent.input), decidingAccountId: accountId } };
}

async function fixture(withApproval = true, encrypted = false, initial = snapshot(), withRoot = false) {
  const approved = withApproval
    ? await prepareWorkflowApprovedOperationSnapshot({ snapshot: initial, parent, steps, context: approvedContext() }) : initial;
  const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
    material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
  const accountEncryption = { kind: 'available' as const, witness: { mode: 'e2ee' as const, version: 1,
    contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) }, material };
  const randomBytes = (length: number) => new Uint8Array(length).fill(3);
  const preparedKey = encrypted ? prepareWorkflowRunDataKeyV1({ accountId, encryption: accountEncryption, randomBytes }) : null;
  const mode = preparedKey ? { ...preparedKey.runCrypto, randomBytes } : { mode: 'plain' as const };
  const keyCensus = createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
  const encryption: WorkflowRunReadEncryptionV1 = encrypted ? accountEncryption : { witness: { mode: 'plain' } };
  const envelope = preparedKey?.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    ...mode, binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: approved }));
  const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'host', accountId,
    state: 'running', origin: { kind: 'direct' }, acceptedEnvelope,
    keyCensus: encrypted ? { ...keyCensus, encryptionMode: 'e2ee', ownerAccountCurrentness: accountEncryption.witness,
      dataEncryptionKey: envelope, callerDataEncryptionKey: envelope } : keyCensus });
  const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId,
    recordId: invocationId, sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' };
  const progress = { kind: 'happier.workflow-progress.v1' as const, blockKind: 'action' as const,
    invocationPath: { blockId: 'apply', scope: [] }, attempt: '0', logicalInvocationRecordId: invocationId };
  const content = (execution?: { kind: 'action'; actionId: string; actionRequestId: string; localInputId: string; input: Readonly<Record<string, JsonValue>> }) =>
    serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...mode, binding,
      progress: { ...progress, ...(execution ? { execution } : {}) } }));
  if (withRoot) await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: '{}', rootInvocation: {
    id: 'root', contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...mode,
      binding: { ...binding, recordId: 'root', sequence: '0', parentRecordId: null },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
        attempt: '0', logicalInvocationRecordId: 'root' } })) } });
  await storage.execute({ operation: 'invocations.admit', runId, parentAttempt: 0,
    expectedRevision: withRoot ? 1 : 0, checkpointEnvelope: '{}', invocations: [{ id: invocationId, sequence: '1', parentRecordId: 'root',
      memberOrdinal: '0', contentEnvelope: content() }] });
  const context: ActionExecutorContext = { actionRequestId, executionRunWorkflowRunId: runId, runtimeAccountId: accountId,
    actionCaller: { kind: 'workflowRun', runId, authorization: approved.authorization } };
  const reader = createWorkflowApprovedOperationReader({ storage,
    resolveEncryption: async () => encryption });
  const admit = async (input: Readonly<Record<string, JsonValue>> = initial.materializedLeaves[0]!.actionInput!) => storage.execute({ operation: 'invocations.fact', runId,
    invocationId, invocationAttempt: '0', expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'admitting',
    contentEnvelope: content({ kind: 'action', actionId: initial.materializedLeaves[0]!.actionId!, actionRequestId, localInputId: 'local', input }) });
  return { approved, storage, context, reader, admit, encryption, mode };
}

describe('Workflow approved operation private custody', () => {
  it.each([false, true])('retains scheduled rollout identity after ordinary root policy (Require=%s)', async requireApproval => {
    const h = await fixture(false);
    const actionId = 'machines.setup.updates.rollout' as const;
    const target = { homeId: 'home', machineId: 'target', scope: 'security' as const,
      plan: createMachineSetupEffectPlan({ basis: { kind: 'updates', machineId: 'target', scope: 'security' }, steps: [], nativeFacts: [] }) };
    const input = { homeId: 'home', machineId: 'host', batches: [[target]], failurePolicy: 'fail_stop' as const };
    const definition = createScheduledMachineUpdatesRolloutWorkflowV1(input);
    const triggerId = 'scheduled-rollout';
    const automationId = 'fleet-updates';
    const operation: WorkflowApprovedOperationV1 = { parent: { actionId: 'workflow.trigger.add', input: {
      target: { kind: 'inline', definition: StrictJsonValueSchema.parse(definition) }, project: { machineId: 'host', directory: '/repo' },
      trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } },
      inputs: {}, actionApproval: 'automatic',
    } }, approvedBy: { accountId }, steps: [{ actionId, input }] };
    // The persisted Account trigger and Run are transport/storage boundaries;
    // their real consent reader, exact invocation reader and Action policy run.
    const row = AutomationDefinitionDetailSchema.parse({ id: automationId, name: 'Fleet updates', description: null,
      enabled: true, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
      assignments: [{ machineId: 'host', enabled: true, priority: 0, updatedAt: 1 }],
      triggers: [{ id: triggerId, revision: 0, kind: 'schedule', enabled: true, createdAt: 1, updatedAt: 1,
        schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null }, nextRunAt: 2, triggerDefinitionEnvelope: null }],
      executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: definition,
        inputs: {}, actionApprovals: [{ triggerId, operation }],
      } } },
    });
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected Automation mutation'); };
    const triggers = createAccountWorkflowTriggerActions({ automations: { get: async () => row,
      list: unavailable, listDetails: unavailable, create: unavailable, reconcile: unavailable, delete: unavailable },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      resolveWorkflow: unavailable, randomBytes: size => new Uint8Array(size), newId: () => 'unused' });
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'schedule', triggerId, triggerRevision: 0,
      occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: { v: 1, kind: 'schedule', scheduledFor: 1 } }),
      occurredAt: 1, evidence: { scheduledFor: 1 } });
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...h.approved, definition, authoredDefinition: definition,
      approvedOperation: operation, materializedLeaves: [{ ...h.approved.materializedLeaves[0], blockId: 'rollout', actionId, actionInput: input }] });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      ...h.mode, binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    const storage = createWorkflowRunStorageTestkit({ runId, accountId, machineId: 'host', state: 'running',
      origin: { kind: 'automation', automationId, cause }, acceptedEnvelope,
      keyCensus: createPlainWorkflowRunKeyCensusFixture({ runId, accountId }) });
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...h.mode,
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId, sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'action', invocationPath: { blockId: 'rollout', scope: [] },
        attempt: '0', logicalInvocationRecordId: invocationId } }));
    await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 0, parentAttempt: 0, checkpointEnvelope: '{}',
      invocations: [{ id: invocationId, sequence: '1', parentRecordId: 'root', memberOrdinal: '0', contentEnvelope }] });
    const reader = createWorkflowApprovedOperationReader({ storage, resolveEncryption: async () => h.encryption,
      readSavedTriggerConsent: request => triggers.readSavedConsent(request, request.context) });
    let produced: WorkflowApprovedOperationV1 | undefined;
    let starts = 0;
    const executor = createActionExecutor({ readApprovedOperation: request => request.runId ? reader({ ...request, runId: request.runId }) : Promise.resolve(null),
      // The opened Artifact is the profile boundary; admission uses its real binding.
      readApprovalProfile: id => bindApprovalProfileV1([{ id: 'ask-rollout',
        profile: ApprovalProfileV1Schema.parse({ id: 'ask-rollout', name: 'Ask before rollout',
          actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } }),
        access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 } }], id),
      machineSetupUpdatesRollout: async ({ context }) => {
        starts++;
        // This is the same root consent producer used by combined Run start.
        produced = await prepareWorkflowApprovedOperation({ parent: { actionId, input },
          steps: [{ actionId: 'machines.setup.updates.apply', input: target }], context });
        return { operationId: 'rollout', runId: 'native-updates' };
      } });
    const result = await executor.execute(actionId, input, { ...h.context, serverId: 'home', surface: 'agent',
      authority: 'account_automation', approvalProfileId: requireApproval ? 'ask-rollout' : null });
    expect(starts).toBe(requireApproval ? 0 : 1);
    expect(result.ok, JSON.stringify(result)).toBe(!requireApproval);
    if (requireApproval) expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(produced).toEqual(requireApproval ? undefined : { parent: { actionId, input }, approvedBy: { accountId },
      steps: [{ actionId: 'machines.setup.updates.apply', input: target }] });
  });
  it('spends saved Nightly consent on the current capture and holds changed Environment or destination policy', async () => {
    const h = await fixture(false);
    const policy = { destinationRef: { pluginId: 'example.backups', localId: 'repository' }, occurrenceId: 'installed',
      config: { path: '/backups/app' }, credentialBindings: [],
      sources: [{ kind: 'volume', sourceId: 'data', service: 'app', volume: 'data', consistency: 'stopDuringCopy' }],
      ownership: { environmentId: 'environment', prefix: 'app' }, retention: { kind: 'keepEverything' } };
    const address = { serverId: 'home', environmentId: 'environment' };
    const references: Record<string, WorkflowAuthoredResultReference> = Object.fromEntries(
      ['serverId', 'environmentId', 'expectedRevision', 'configRevision', 'machineId', 'installationId', 'targetLinkId', 'deploymentId']
        .map(field => [field, { kind: 'result', producer: { blockId: 'current', scope: { kind: 'current' } },
          path: ['backupTarget', field] } satisfies WorkflowAuthoredResultReference]));
    const currentDefinition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, inputs: [
      { name: 'backupEnvironment', valueType: 'json', required: true }, { name: 'backupPolicy', valueType: 'json', required: true },
    ], blocks: [
      { kind: 'action', id: 'current', actionId: 'deployments.environments.get', input: {
        serverId: { kind: 'input', name: 'backupEnvironment', path: ['serverId'] },
        environmentId: { kind: 'input', name: 'backupEnvironment', path: ['environmentId'] },
        backupPolicy: { kind: 'input', name: 'backupPolicy' },
      } },
      { kind: 'action', id: 'backup', actionId: 'deployments.backups.run', input: references },
    ] });
    const triggerId = 'nightly';
    const automationId = 'nightly-backups';
    // Persisted consent, accepted Run and invocation rows are storage boundary
    // fixtures. Their real private readers, crypto, binding and approval route run.
    const operation: WorkflowApprovedOperationV1 = { parent: { actionId: 'workflow.trigger.add', input: {
      target: { kind: 'inline', definition: StrictJsonValueSchema.parse(currentDefinition) }, project: { machineId: 'host', directory: '/repo' },
      trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } },
      inputs: { backupEnvironment: address, backupPolicy: policy }, actionApproval: 'automatic',
    } }, approvedBy: { accountId }, steps: [
      { actionId: 'deployments.environments.get', input: { ...address, backupPolicy: policy } },
      { actionId: 'deployments.backups.run', input: {}, binding: { kind: 'producer_result', references } },
    ] };
    const row = AutomationDefinitionDetailSchema.parse({ id: automationId, name: 'Nightly backups', description: null,
      enabled: true, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
      assignments: [{ machineId: 'host', enabled: true, priority: 0, updatedAt: 1 }],
      triggers: [{ id: triggerId, revision: 0, kind: 'schedule', enabled: true, createdAt: 1, updatedAt: 1,
        schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null }, nextRunAt: 2, triggerDefinitionEnvelope: null }],
      executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: currentDefinition,
        inputs: { backupEnvironment: address, backupPolicy: policy }, actionApprovals: [{ triggerId, operation }],
      } } },
    });
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected Automation mutation or inventory'); };
    const triggers = createAccountWorkflowTriggerActions({ automations: { get: async () => row,
      list: unavailable, listDetails: unavailable, create: unavailable, reconcile: unavailable, delete: unavailable },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      resolveWorkflow: unavailable, randomBytes: size => new Uint8Array(size), newId: () => 'unused' });
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'schedule', triggerId, triggerRevision: 0,
      occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: { v: 1, kind: 'schedule', scheduledFor: 1 } }),
      occurredAt: 1, evidence: { scheduledFor: 1 } });
    const { actionInput: _input, ...leaf } = h.approved.materializedLeaves[0]!;
    for (const scenario of ['capture-a', 'capture-b', 'configRevision', 'environment', 'destination', 'home', 'account', 'actions'] as const) {
      const actualPolicy = scenario === 'destination' ? { ...policy, config: { path: '/backups/changed' } } : policy;
      const inputs = { backupEnvironment: scenario === 'environment' ? { ...address, environmentId: 'other' }
        : scenario === 'home' ? { ...address, serverId: 'other-home' } : address, backupPolicy: policy };
      const target = { ...inputs.backupEnvironment, expectedRevision: scenario === 'capture-a' ? 4 : 5,
        configRevision: scenario === 'configRevision' ? 3 : 2,
        machineId: 'machine', installationId: 'installation', targetLinkId: 'target', deploymentId: scenario };
      const definition = scenario === 'actions' ? WorkflowDefinitionV1Schema.parse({ ...currentDefinition,
        blocks: [...currentDefinition.blocks, { kind: 'action', id: 'added', actionId: 'machines.setup.apply',
          input: Object.fromEntries(Object.entries(steps[0]!.input).map(([key, value]) => [key, { kind: 'literal', value }])) }] }) : currentDefinition;
      const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...h.approved, definition,
        authoredDefinition: definition, inputs, approvedOperation: operation,
        materializedLeaves: [
          { ...leaf, blockId: 'current', actionId: 'deployments.environments.get', actionInput: { ...inputs.backupEnvironment, backupPolicy: policy } },
          { ...leaf, blockId: 'backup', actionId: 'deployments.backups.run', actionInput: {} },
          ...(scenario === 'actions' ? [{ ...leaf, blockId: 'added', actionId: 'machines.setup.apply', actionInput: steps[0]!.input }] : []),
        ] });
      const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        ...h.mode, binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
      const storage = createWorkflowRunStorageTestkit({ runId, accountId, machineId: 'host', state: 'running',
        origin: { kind: 'automation', automationId, cause }, acceptedEnvelope,
        keyCensus: createPlainWorkflowRunKeyCensusFixture({ runId, accountId }) });
      const seal = (id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string,
        progress: Parameters<typeof sealWorkflowProgressStoredEnvelopeV1>[0]['progress']) =>
        serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...h.mode,
          binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence, parentRecordId, memberOrdinal, attempt: '0' }, progress }));
      await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: '{}', rootInvocation: {
        id: 'root', contentEnvelope: seal('root', '0', null, '0', { kind: 'happier.workflow-progress.v1', blockKind: 'root',
          invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: 'root' }) } });
      await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, parentAttempt: 0, checkpointEnvelope: '{}', invocations: [
        { id: 'producer', sequence: '1', parentRecordId: 'root', memberOrdinal: '0', lifecycle: 'completed',
          contentEnvelope: seal('producer', '1', 'root', '0', { kind: 'happier.workflow-progress.v1', blockKind: 'action',
            invocationPath: { blockId: 'current', scope: [] }, attempt: '0', logicalInvocationRecordId: 'producer',
            result: { ok: true, backupTarget: target, backupPolicy: actualPolicy } }) },
        { id: invocationId, sequence: '2', parentRecordId: 'root', memberOrdinal: '1',
          contentEnvelope: seal(invocationId, '2', 'root', '1', { kind: 'happier.workflow-progress.v1', blockKind: 'action',
            invocationPath: { blockId: 'backup', scope: [] }, attempt: '0', logicalInvocationRecordId: invocationId }) },
      ] });
      const reader = createWorkflowApprovedOperationReader({ storage, resolveEncryption: async () => h.encryption,
        readSavedTriggerConsent: input => triggers.readSavedConsent(input, input.context) });
      const proof = await reader({ runId, actionId: 'deployments.backups.run', input: target,
        context: { ...h.context, ...(scenario === 'account' ? { runtimeAccountId: 'other-account' } : {}) }, phase: 'prepare' });
      const changed = scenario !== 'capture-a' && scenario !== 'capture-b' && scenario !== 'configRevision';
      expect.soft(proof?.steps ?? null, scenario).toEqual(changed ? null : [{ actionId: 'deployments.backups.run', input: target }]);
      expect.soft(resolveActionApprovalRouting({ actionId: 'deployments.backups.run', spec: getActionSpec('deployments.backups.run'), input: target,
        context: { surface: 'agent', authority: 'account_automation' }, approvedOperation: proof }).required, scenario).toBe(changed);
      expect(storage.operations()).not.toContain('invocations.list');
    }
  });
  it.each(['covered', 'other-workflow', 'recurring', 'edited-step', 'other-step'] as const)(
    'uses Automatic consent only for the saved native once-schedule declaration (%s)', async scenario => {
      const actionId = WORKFLOW_TRIGGER_ADD_ACTION_ID;
      const workflow = 'bd7ee83d-32c2-4eb1-9d35-efcf5212ef98';
      const project = { machineId: 'host', directory: '/repo' };
      const triggerId = 'deploy-observer';
      const automationId = 'deployment-regression-check';
      const parentTrigger = { kind: 'schedule', enabled: true,
        schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } } as const;
      const once = { kind: 'schedule', enabled: true,
        schedule: { kind: 'once', scheduledAt: Date.UTC(2099, 0, 1) } } as const;
      const schedule = { kind: 'action', id: 'schedule', actionId, input: {
        workflow: { kind: 'literal', value: workflow }, project: { kind: 'literal', value: project },
        trigger: { kind: 'result', producer: { blockId: 'receipt', scope: { kind: 'current' } }, path: ['trigger'] },
      } };
      const original = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [
        { kind: 'action', id: 'receipt', actionId: 'workflow.starters.list', input: {} }, schedule,
      ] });
      const definition = WorkflowDefinitionV1Schema.parse({ ...original, blocks: [
        original.blocks[0], { ...schedule, ...(scenario === 'edited-step' ? { name: 'Edited schedule' } : {}),
          ...(scenario === 'other-step' ? { id: 'replacement' } : {}),
          ...(scenario === 'other-workflow' ? { input: { ...schedule.input,
            workflow: { kind: 'literal', value: 'b897bf71-5d73-4649-935e-a0cbd6b22f04' } } } : {}) },
      ] });
      const unavailable = async (): Promise<never> => { throw new Error('Unexpected Automation mutation or inventory'); };
      const context = { workspace: { directory: project.directory }, executionTarget: { kind: 'session' as const } };
      const saved = await readWorkflowTriggerActionConsent({ definition: original, context, project, triggerId,
        workflowRef: workflow, resolveWorkflow: unavailable });
      const operation = await prepareWorkflowApprovedOperation({ parent: { actionId,
        input: { workflow, project, trigger: parentTrigger, actionApproval: 'automatic' } },
        ...saved, context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
          runtimeAccountId: accountId, serverId: 'home', actionRequestId: 'arm-f16' },
        nativeAccount: { accountId, serverId: 'home', isCurrent: async () => true } });
      const row = AutomationDefinitionDetailSchema.parse({ id: automationId, workflowDefinitionId: workflow,
        name: 'Check deployment regressions', description: null, enabled: true, targetType: null, existingSessionId: null,
        templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
        assignments: [{ machineId: 'host', enabled: true, priority: 0, updatedAt: 1 }],
        triggers: [{ ...parentTrigger, id: triggerId, revision: 0, createdAt: 1, updatedAt: 1,
          nextRunAt: 2, triggerDefinitionEnvelope: null }],
        executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
          ...context, actionApprovals: [{ triggerId, operation }],
        } } },
      });
      const triggers = createAccountWorkflowTriggerActions({ automations: { get: async () => row,
        list: unavailable, listDetails: unavailable, create: unavailable, reconcile: unavailable, delete: unavailable },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        resolveWorkflow: unavailable, randomBytes: size => new Uint8Array(size), newId: () => 'unused' });
      const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'schedule', triggerId, triggerRevision: 0,
        occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: { v: 1, kind: 'schedule', scheduledFor: 1 } }),
        occurredAt: 1, evidence: { scheduledFor: 1 } });
      // Run acceptance freezes concrete execution fields into its definition;
      // the saved declaration stays the authored block.
      const source = { kind: 'automation', automationId, definitionId: workflow,
        revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null } as const;
      const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition, context: { source, inputs: {},
        machineId: project.machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { ...project, checkoutRootPath: project.directory } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
        effects: { resolveTargetAvailability: async () => true,
          readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
        admission: { kind: 'trigger', workDepth: 0, admitLeaf: unavailable } });
      if (!materialized.ok) throw new Error(materialized.error.code);
      const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...snapshot(), definition: materialized.snapshot.definition,
        authoredDefinition: materialized.snapshot.authoredDefinition, source,
        materializedLeaves: materialized.snapshot.materializedLeaves, approvedOperation: operation });
      const storage = createWorkflowRunStorageTestkit({ runId, accountId, machineId: 'host', state: 'running',
        origin: { kind: 'automation', automationId, cause }, keyCensus: createPlainWorkflowRunKeyCensusFixture({ runId, accountId }),
        acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
          mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted })) });
      const seal = (id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string,
        progress: Parameters<typeof sealWorkflowProgressStoredEnvelopeV1>[0]['progress']) =>
        serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
          binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence, parentRecordId, memberOrdinal, attempt: '0' },
          progress }));
      await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: '{}', rootInvocation: {
        id: 'root', contentEnvelope: seal('root', '0', null, '0', { kind: 'happier.workflow-progress.v1', blockKind: 'root',
          invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: 'root' }) } });
      const produced = scenario === 'recurring' ? parentTrigger : once;
      const stepProgress = { kind: 'happier.workflow-progress.v1', blockKind: 'action',
        invocationPath: { blockId: definition.blocks[1]!.id, scope: [] }, attempt: '0', logicalInvocationRecordId: invocationId } satisfies Parameters<typeof seal>[4];
      await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, parentAttempt: 0, checkpointEnvelope: '{}', invocations: [
        { id: 'producer', sequence: '1', parentRecordId: 'root', memberOrdinal: '0', lifecycle: 'completed',
          contentEnvelope: seal('producer', '1', 'root', '0', { kind: 'happier.workflow-progress.v1', blockKind: 'action',
            invocationPath: { blockId: 'receipt', scope: [] }, attempt: '0', logicalInvocationRecordId: 'producer', result: { trigger: produced } }) },
        { id: invocationId, sequence: '2', parentRecordId: 'root', memberOrdinal: '1',
          contentEnvelope: seal(invocationId, '2', 'root', '1', stepProgress) },
      ] });
      const reader = createWorkflowApprovedOperationReader({ storage, resolveEncryption: async () => ({ witness: { mode: 'plain' } }),
        readSavedTriggerConsent: input => triggers.readSavedConsent(input, input.context) });
      const input = { workflow: scenario === 'other-workflow' ? 'b897bf71-5d73-4649-935e-a0cbd6b22f04' : workflow, project, trigger: produced };
      const caller: ActionExecutorContext = { actionRequestId, runtimeAccountId: accountId, executionRunWorkflowRunId: runId,
        actionCaller: { kind: 'workflowRun', runId, authorization: accepted.authorization } };
      const approvalContext = { surface: 'agent', authority: 'account_automation' } as const;
      for (const phase of ['prepare', 'dispatch'] as const) {
        if (phase === 'dispatch') await storage.execute({ operation: 'invocations.fact', runId, invocationId,
          invocationAttempt: '0', expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'admitting',
          contentEnvelope: seal(invocationId, '2', 'root', '1', { ...stepProgress,
            execution: { kind: 'action', actionId, actionRequestId, localInputId: 'f16-step', input } }) });
        const proof = await reader({ runId, actionId, input, context: caller, phase });
        expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), input,
          context: approvalContext, approvedOperation: proof }).required).toBe(scenario !== 'covered');
        if (scenario === 'covered') {
          expect(proof?.steps).toEqual([{ actionId, input }]);
          const settings = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } });
          expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), input,
            context: approvalContext, settings, approvedOperation: proof }).required).toBe(true);
        }
      }
      expect(storage.operations()).not.toContain('invocations.list');
    });

  it('continues an exact reviewed child with demanded work and holds a changed child', async () => {
    const h = await fixture(false);
    const actionId = 'prompt_doc.create' as const;
    const input = { title: 'Reviewed document', markdown: 'Reviewed text', folderId: 'new-folder',
      createFolder: { id: 'new-folder', name: 'Reviewed folder', expectedRevision: 3 } };
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'action', id: 'apply', actionId,
        input: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { kind: 'literal', value }])) },
    ] });
    const child = { actionId, input };
    const accepted = await prepareWorkflowApprovedOperationSnapshot({
      snapshot: WorkflowAcceptedSnapshotV1Schema.parse({ ...h.approved, definition, authoredDefinition: definition,
        materializedLeaves: [{ ...h.approved.materializedLeaves[0], actionId, actionInput: input }] }),
      parent, steps: [child], context: approvedContext() });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    // Run storage is the boundary; retain the real custody and exact-input reader.
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (request, options) => {
      const result = await h.storage.execute(request, options);
      return request.operation === 'get' && result && typeof result === 'object' ? { ...result, acceptedEnvelope } : result;
    } }, resolveEncryption: async () => h.encryption });
    const context: ActionExecutorContext = { ...h.context, surface: 'agent', authority: 'account_automation',
      serverId: 'home', interactivePresentation: 'unavailable', actionsSettings: normalizeActionsSettingsV1({ v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] },
          'artifact.folders.create': { approvalRequiredSurfaces: ['agent'] } } }) };
    const read = (candidate = input) => reader({ runId, actionId, input: candidate, semanticInput: candidate,
      context, phase: 'prepare' });
    const admission = await read();
    expect(await admission?.invokeReviewedChild?.(async issued =>
      readHostReviewedChildOperationV1(issued, actionId, input)?.parent)).toEqual(parent);
    // Persistence is the boundary; keep the real folder and document owners.
    let record: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1, folders: [] } };
    let revision = 3;
    const artifacts = new Map<string, PromptLibraryStoredArtifact>();
    const organization: NonNullable<ActionExecutorDeps['artifactFolders']> = { serverId: 'home', assertCurrent: () => {},
      ...{ listArtifactHeaders: async () => ({ items: [...artifacts.values()].flatMap(artifact => artifact.header
        ? [{ artifactId: artifact.id, header: artifact.header, owned: true }] : []), coverage: 'complete' as const }) },
      readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record, revision }], tombstones: [], diagnostics: [] } }),
      writeRecord: async request => {
        if (request.expectedRevision !== revision) return { status: 'conflict', revision };
        record = request.record; revision++;
        return { status: 'updated', revision, cursor: revision };
      },
      readArtifactHeader: async id => {
        const header = artifacts.get(id)?.header;
        return header ? { header, owned: true } : null;
      },
    };
    const store: PromptLibraryArtifactStore = { organization, read: async id => artifacts.get(id) ?? null,
      update: async () => { throw new Error('unexpected artifact update'); },
      create: async request => { artifacts.set('saved', { id: 'saved', ...request,
        revision: { headerVersion: 1, bodyVersion: 1 } }); return 'saved'; } };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      readApprovedOperation: request => request.runId ? reader({ ...request, runId: request.runId }) : Promise.resolve(null),
      artifactFolders: organization,
      promptDocCreate: ({ signal, ...request }) => {
        if ('starter' in request) throw new Error('Unexpected starter outside the reviewed manual document fixture');
        return createPromptDocInLibrary({ store, request, signal });
      },
    }));
    const prepared = await executor.prepare(actionId, input, context);
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ kind: 'ready' });
    const changed = { ...input, markdown: 'Outside reviewed plan' };
    expect(await read(changed)).toBeNull();
    expect(await executor.prepare(actionId, changed, context)).toMatchObject({ kind: 'settled',
      result: { ok: false, errorCode: 'action_interactive_review_required' } });
    expect(record.value).toMatchObject({ folders: [] });
    expect(artifacts.size).toBe(0);
    if (prepared.kind !== 'ready') throw new Error('Expected reviewed child admission');
    expect(await prepared.invocation.run()).toMatchObject({ ok: true, result: { artifactId: 'saved' } });
    expect(record.value).toMatchObject({ folders: [{ id: 'new-folder', name: 'Reviewed folder' }] });
    expect(artifacts.get('saved')?.body).toContain('Reviewed text');
  });

  it.each([false, true])('resolves reviewed producer operands from the same persisted Run (encrypted=%s)', async encrypted => {
    const h = await fixture(false, encrypted);
    const fixed = { serverId: 'home', expectedTargetLinkRevision: 1, requestKey: 'catalog-deploy',
      contentArtifactId: 'catalog-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const concrete = DeploymentDeployInputV1Schema.parse({ ...fixed, environmentId: 'created-environment', targetLinkId: 'created-target', expectedRevision: 2 });
    const preparedConcrete = DeploymentDeployInputV1Schema.parse({ ...concrete, contentArtifactId: 'prepared-catalog-content' });
    const references: Record<string, WorkflowAuthoredResultReference> = Object.fromEntries(['environmentId', 'targetLinkId', 'expectedRevision'].map(name => [name, {
      kind: 'result', producer: { blockId: 'instantiate', scope: { kind: 'current' } },
      path: [name === 'expectedRevision' ? 'revision' : name],
    } satisfies WorkflowAuthoredResultReference]));
    const deferred = { actionId: 'deployments.deploy', input: fixed, binding: { kind: 'producer_result' as const, references } };
    const childDefinition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'action', id: 'instantiate', actionId: 'deployments.templates.instantiate', input: {} },
      { kind: 'action', id: 'apply', actionId: 'deployments.deploy', input: {
        ...Object.fromEntries(Object.entries(fixed).map(([name, value]) => [name, { kind: 'literal', value }])), ...references,
      } },
    ] });
    const { actionInput: _actionInput, ...materialized } = h.approved.materializedLeaves[0]!;
    const accepted = await prepareWorkflowApprovedOperationSnapshot({
      snapshot: WorkflowAcceptedSnapshotV1Schema.parse({ ...h.approved, definition: childDefinition, authoredDefinition: childDefinition,
        materializedLeaves: [{ ...materialized, actionId: 'deployments.deploy' }] }),
      parent, steps: [deferred], context: approvedContext(),
    });
    const operation = accepted.approvedOperation!;
    expect(operation.steps[0]?.binding).toEqual(deferred.binding);
    expect(resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'), input: concrete,
      context: { surface: 'agent', authority: 'account_automation' }, approvedOperation: operation }).required).toBe(true);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      ...h.mode, binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    const reopened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...h.mode,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope) });
    expect(reopened.kind).toBe('available');
    if (reopened.kind === 'available') expect(reopened.content.approvedOperation).toEqual(operation);
    const storage = createWorkflowRunStorageTestkit({ runId, accountId, machineId: 'host', state: 'running',
      origin: { kind: 'direct' }, acceptedEnvelope,
      keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse((await h.storage.execute({ operation: 'get', runId }) as {
        keyCensus: unknown }).keyCensus) });
    const seal = (id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string,
      progress: Parameters<typeof sealWorkflowProgressStoredEnvelopeV1>[0]['progress'], owner = accountId, sourceRun = runId) =>
      serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...h.mode,
        binding: { v: 1, purpose: 'invocation_progress', accountId: owner, runId: sourceRun,
          recordId: id, sequence, parentRecordId, memberOrdinal, attempt: '0' }, progress }));
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: '{}',
      rootInvocation: { id: 'root', contentEnvelope: seal('root', '0', null, '0', {
        kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
        attempt: '0', logicalInvocationRecordId: 'root' }) } });
    const producerResult = DeploymentActionOutputSchemasV1['deployments.templates.instantiate'].parse({ kind: 'applied', environmentId: concrete.environmentId,
      targetLinkId: concrete.targetLinkId, revision: concrete.expectedRevision,
      definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, savedSecrets: [] });
    if (producerResult.kind !== 'applied') throw new Error('Expected an applied deployment fixture');
    const producerProgress = { kind: 'happier.workflow-progress.v1' as const, blockKind: 'action' as const,
      invocationPath: { blockId: 'instantiate', scope: [] }, attempt: '0', logicalInvocationRecordId: 'producer', result: producerResult };
    const childProgress = { kind: 'happier.workflow-progress.v1' as const, blockKind: 'action' as const,
      invocationPath: { blockId: 'apply', scope: [] }, attempt: '0', logicalInvocationRecordId: invocationId };
    await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, parentAttempt: 0, checkpointEnvelope: '{}', invocations: [
      { id: 'producer', sequence: '1', parentRecordId: 'root', memberOrdinal: '0', lifecycle: 'completed',
        contentEnvelope: seal('producer', '1', 'root', '0', producerProgress) },
      { id: invocationId, sequence: '2', parentRecordId: 'root', memberOrdinal: '1',
        contentEnvelope: seal(invocationId, '2', 'root', '1', childProgress) },
    ] });
    const storedProducer = storage.rowById('producer')!;
    expect(storedProducer.index.lifecycle).toBe('completed');
    expect(openWorkflowProgressStoredEnvelopeV1({ ...h.mode,
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: 'producer',
        sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' },
      envelope: parseWorkflowStoredContentEnvelopeV1(storedProducer.contentEnvelope) }))
      .toMatchObject({ kind: 'available', content: { result: producerProgress.result } });
    let changed: 'input' | 'producer' | 'run' | 'account' | 'unfinished' | null = null;
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (request, options) => {
      const response = await storage.execute(request, options);
      if (!changed || !['invocations.current', 'invocations.get'].includes(request.operation)
        || !response || typeof response !== 'object' || !('invocation' in response)) return response;
      const row = response.invocation as { index: Record<string, unknown>; contentEnvelope: string } | null;
      if (row?.index.id !== 'producer') return response;
      return { ...response, invocation: { ...row,
        index: { ...row.index, ...(changed === 'unfinished' ? { lifecycle: 'running' } : {}) },
        contentEnvelope: seal('producer', '1', 'root', '0', { ...producerProgress,
          ...(changed === 'producer' ? { result: { ...producerProgress.result, targetLinkId: 'different-target' } } : {}) },
          changed === 'account' ? 'another-owner' : accountId, changed === 'run' ? '62bd37c4-99c6-41cf-90a5-3a1be2b1e031' : runId) } };
    } }, resolveEncryption: async () => h.encryption });
    const read = (phase: 'prepare' | 'dispatch') => reader({ runId, actionId: 'deployments.deploy', input: preparedConcrete,
      semanticInput: changed === 'input' ? { ...concrete, serverId: 'another-home' } : concrete, context: h.context, phase });
    const proof = await read('prepare');
    expect(proof?.steps, storage.operations().join(',')).toEqual([{ actionId: 'deployments.deploy', input: preparedConcrete }]);
    const producerReads = storage.calls.filter(call => call.operation === 'invocations.current' && call.memberOrdinal === '0');
    expect(producerReads).toHaveLength(1); // Three operands share one exact producer read, never an inventory scan.
    expect(storage.operations()).not.toContain('invocations.list');
    let effects = 0;
    const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['deployments.deploy'] },
      targets: { sessions: [], machines: [], environments: [concrete.environmentId] } });
    // The signed Home authorization is an authenticated transport boundary.
    // Its canonical schema retains the independently admitted child-only grant.
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-workflow-child', binding: {
      accountId, principalId: accountId, credentialId: 'workflow-child', grant,
      serverIdentityId: 'home', custodianAccountId: accountId, machineId: 'host', installationId: 'installation',
      actionId: 'deployments.deploy', requestId: actionRequestId, requestEnvelopeDigest: 'A'.repeat(43),
      environmentId: concrete.environmentId, target: { kind: 'machine', machineId: 'host' },
      workflowActionOrigin: { runId, requestId: actionRequestId },
    } });
    const deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, input, context) => {
      if (actionId === 'deployments.deploy') {
        effects++;
        expect(readHostReviewedChildOperationV1(context, actionId, input)?.parent).toEqual(parent);
        expect(context.externalActionExecutionAuthorization).toBe(authorization);
        expect(context.externalActionExecutionAuthorization?.binding.actionId).toBe('deployments.deploy');
        expect(context.externalActionCredential?.grant).toEqual(grant);
        return { ok: true, environmentId: concrete.environmentId, revision: concrete.expectedRevision,
          deploymentId: 'created-deployment', deploymentRevision: 1, state: 'queued' };
      }
      return { ok: true,
        environment: createDeploymentEnvironmentHeaderV1({ id: concrete.environmentId, serverId: 'home' }), targetLinks: [] };
    };
    const executor = createActionExecutor({ deploymentAction,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction),
      readApprovedOperation: async request => request.runId ? reader({ ...request, runId: request.runId }) : null });
    const executionContext: ActionExecutorContext = { ...h.context, surface: 'agent', authority: 'account_automation',
      serverId: 'home', serverIdentityId: 'home', runtimeAccountId: accountId,
      externalActionCredential: { accountId, principalId: accountId, credentialId: 'workflow-child', grant },
      externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
      interactivePresentation: 'unavailable', actionsSettings: normalizeActionsSettingsV1({ v: 1,
        actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent'] } } }) };
    expect(resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
      input: preparedConcrete, context: executionContext, settings: executionContext.actionsSettings,
      approvedOperation: proof }).required).toBe(true);
    const beforePrepare = storage.calls.length;
    const prepared = await executor.prepare('deployments.deploy', concrete, executionContext);
    expect(prepared.kind).toBe('ready');
    expect(effects).toBe(0);
    expect(storage.calls.slice(beforePrepare).map(call => call.operation))
      .toEqual(['get', 'invocations.get', 'invocations.get', 'invocations.current']);
    for (const control of ['input', 'producer', 'run', 'account', 'unfinished'] as const) {
      changed = control;
      expect(await read('prepare'), control).toBeNull();
    }
    changed = null;
    await storage.execute({ operation: 'invocations.fact', runId, invocationId, invocationAttempt: '0',
      expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'admitting',
      contentEnvelope: seal(invocationId, '2', 'root', '1', { ...childProgress, execution: {
        kind: 'action', actionId: 'deployments.deploy', actionRequestId, localInputId: 'local', input: concrete,
      } }) });
    expect((await read('dispatch'))?.steps).toEqual([{ actionId: 'deployments.deploy', input: preparedConcrete }]);
    const beforeDispatch = storage.calls.length;
    if (prepared.kind === 'ready') expect(await prepared.invocation.run()).toMatchObject({ ok: true });
    // The exact prepared child spends its retained admission without reopening Run custody.
    expect(storage.calls.slice(beforeDispatch)).toHaveLength(0);
    expect(effects).toBe(1);
    const setupOnlyGrant = ApiTokenGrantV1Schema.parse({ ...grant, actions: { families: [], ids: [parent.actionId] } });
    const setupOnlyContext: ActionExecutorContext = { ...executionContext,
      externalActionCredential: { ...executionContext.externalActionCredential!, grant: setupOnlyGrant },
      externalActionExecutionAuthorization: { ...authorization, binding: { ...authorization.binding, grant: setupOnlyGrant } } };
    expect(await executor.execute('deployments.deploy', concrete, setupOnlyContext))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(effects).toBe(1);
    let directEffects = 0;
    const directTransport: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, input, context) => {
      if (actionId !== 'deployments.deploy') return deploymentAction(actionId, input, context);
      directEffects++;
      expect(readHostReviewedChildOperationV1(context, actionId, input)?.parent).toEqual(parent);
      expect(context.externalActionExecutionAuthorization).toBe(authorization);
      return { ok: true, environmentId: concrete.environmentId, revision: concrete.expectedRevision,
        deploymentId: 'direct-created-deployment', deploymentRevision: 1, state: 'queued' };
    };
    const directExecutor = createActionExecutor({ deploymentAction: directTransport,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(directTransport) });
    const executeIssued = async (context: ActionExecutorContext) => {
      const admission = await reader({ runId, actionId: 'deployments.deploy', input: concrete,
        semanticInput: concrete, context, phase: 'dispatch' });
      expect(typeof admission?.invokeReviewedChild).toBe('function');
      return admission?.invokeReviewedChild?.(issued => directExecutor.execute('deployments.deploy', concrete, issued));
    };
    expect(await executeIssued(executionContext)).toMatchObject({ ok: true });
    expect(await executeIssued(setupOnlyContext)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(directEffects).toBe(1);
    changed = 'producer';
    expect(await read('dispatch')).toBeNull();
  });

  it.each(['canonical', 'legacy'] as const)('binds %s selected trigger consent to prepared effects and checks the actual post-hook semantic input', async storedShape => {
    const h = await fixture(false);
    const triggerId = 'selected-deployment';
    const automationId = 'deployment-automation';
    const fixed = { serverId: 'home', environmentId: 'staging', targetLinkId: 'runtime', whenBusy: 'supersede' as const };
    const semanticInput = { ...fixed, sha: 'a'.repeat(40), requestKey: 'push-one' };
    const deployDefinition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [
      { name: 'sha', valueType: 'string', required: true }, { name: 'requestKey', valueType: 'string', required: true },
    ], defaults: {}, blocks: [
      { kind: 'action', id: 'apply', actionId: 'deployments.deploy',
        input: { ...Object.fromEntries(Object.entries(fixed).map(([name, value]) => [name, { kind: 'literal', value }])),
          sha: { kind: 'input', name: 'sha' }, requestKey: { kind: 'input', name: 'requestKey' } } },
    ] });
    const preparedInput = DeploymentDeployInputV1Schema.parse({ ...fixed, expectedRevision: 3,
      expectedTargetLinkRevision: 2, requestKey: semanticInput.requestKey,
      contentArtifactId: 'reviewed-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 });
    let row: ReturnType<typeof AutomationDefinitionDetailSchema.parse> | undefined;
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected mutation or inventory'); };
    const triggerReads: string[] = [];
    const triggers = createAccountWorkflowTriggerActions({ automations: {
      get: async id => { triggerReads.push(id); return id === automationId ? row ?? null : null; },
      list: async () => ({ automations: [], nextCursor: null }), listDetails: async () => ({ automations: [], nextCursor: null }),
      create: async request => {
        const selected = request.triggers[0];
        if (!selected || selected.trigger.kind !== 'pluginEvent') throw new Error('Expected Event');
        const sourceSelectorId = 'sourceSelectorId' in selected.trigger ? selected.trigger.sourceSelectorId : AutomationSourceSelectorIdV1Schema.parse('00000000-0000-4000-8000-000000000001');
        const triggerDefinitionEnvelope = 'triggerDefinitionEnvelope' in selected.trigger ? selected.trigger.triggerDefinitionEnvelope
          : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, automationId: request.automationId,
            triggerId: AutomationTriggerIdSchema.parse(selected.triggerId), triggerRevision: 0, triggerKind: 'pluginEvent',
            eventRef: selected.trigger.eventRef, sourceSelectorId }, definition: {
            v: 1, sourceInstanceId: selected.trigger.sourceInstanceId, sourceConfig: selected.trigger.sourceConfig,
            displayLabel: selected.trigger.displayLabel, filter: selected.trigger.filter, maximumObservationAgeMs: selected.trigger.maximumObservationAgeMs } });
        row = AutomationDefinitionDetailSchema.parse({ id: request.automationId, name: request.name, description: null,
          enabled: request.enabled, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null,
          createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null,
          assignments: request.assignments?.map(assignment => ({ ...assignment, enabled: assignment.enabled ?? true,
            priority: assignment.priority ?? 0, updatedAt: 1 })), executionRecipe: request.executionRecipe,
          triggers: [{ kind: 'pluginEvent', id: selected.triggerId, revision: 0, createdAt: 1, updatedAt: 1,
            enabled: selected.trigger.enabled, eventRef: selected.trigger.eventRef, sourceSelectorId,
            sourceContractVersion: selected.trigger.sourceContractVersion, observation: { kind: 'checkpointedPull', watcher: null },
            sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope: JSON.stringify(triggerDefinitionEnvelope) }] });
        return row;
      }, reconcile: unavailable, delete: unavailable },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      resolveWorkflow: unavailable, randomBytes: size => new Uint8Array(size),
      newId: (() => { let id = 0; return () => ++id === 1 ? triggerId : automationId; })(),
      nativeAccount: { accountId, serverId: 'home', isCurrent: async () => true } });
    const saved = await triggers.add({ target: { kind: 'inline', definition: deployDefinition },
      project: { machineId: 'host', directory: '/repo' }, deployment: {}, actionApproval: 'automatic',
      trigger: { kind: 'pluginEvent', enabled: true,
        eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-pushed-v1' },
        sourceInstanceId: 'repository', sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'Repository',
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
          machineId: 'host', materializationId: 'github-install', pluginId: 'happier.scm.forge.github' } },
        filter: null, maximumObservationAgeMs: null },
    }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: accountId,
      actionRequestId: 'real-trigger-save' });
    const savedOperation = saved.set.context?.actionApprovals?.[0]?.operation;
    if (!savedOperation || !row || !saved.set.context) throw new Error('Real Save must produce exact consent');
    let operation = savedOperation;
    if (storedShape === 'legacy') {
      // Provenance: the current-dev workflowDeploymentConsent writer before O4
      // emitted this exact private person/save/program shape with empty steps.
      const { actionApproval: _choice, ...legacySave } = savedOperation.parent.input;
      operation = { ...savedOperation, parent: { ...savedOperation.parent,
        input: { ...legacySave, deployApproval: 'automatic' } }, steps: [] };
      const { actionApprovals: _current, ...legacyContext } = saved.set.context;
      if (row.executionRecipe?.v !== 2) throw new Error('Expected Workflow recipe');
      row = { ...row, executionRecipe: { ...row.executionRecipe, workflow: { t: 'plain', v: PluginJsonValueV2Schema.parse({
        ...legacyContext, deploymentTriggers: [{ triggerId, approval: { savedFor: { automationId, triggerId },
          savedBy: { kind: 'person', accountId }, operation, basis: { variables: { LOG_LEVEL: 'before-change' }, protection: 'nonProduction' },
          program: { definition: deployDefinition, children: {} } } }],
      }) } } };
    }
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...h.approved, approvedOperation: operation,
      definition: deployDefinition, authoredDefinition: deployDefinition,
      inputs: { sha: semanticInput.sha, requestKey: semanticInput.requestKey },
      materializedLeaves: [{ ...h.approved.materializedLeaves[0], actionId: 'deployments.deploy', actionInput: semanticInput }] });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    if (!row) throw new Error('Stored trigger required');
    const event = row.triggers[0];
    if (event?.kind !== 'pluginEvent') throw new Error('Stored Event required');
    const evidence = { v: 1 as const, kind: 'pluginEvent' as const, eventRef: event.eventRef,
      sourceSelectorId: event.sourceSelectorId, occurrenceId: 'delivery-one', occurredAt: 1, payload: { after: semanticInput.sha } };
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'pluginEvent', triggerId,
      triggerRevision: event.revision, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence }), occurredAt: 1,
      evidence: { eventRef: event.eventRef, sourceSelectorId: event.sourceSelectorId } });
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (request, options) => {
      const result = await h.storage.execute(request, options);
      return request.operation === 'get' && result && typeof result === 'object' && 'run' in result ? {
        ...result, acceptedEnvelope, run: { ...WorkflowRunSummaryV1Schema.parse(result.run),
          origin: { kind: 'automation', automationId, cause } },
      } : result;
    } }, resolveEncryption: async () => h.encryption,
      readSavedTriggerConsent: input => triggers.readSavedConsent(input, input.context) });
    const context: ActionExecutorContext = { ...h.context, surface: 'agent', authority: 'account_automation', serverId: 'home',
      interactivePresentation: 'unavailable' };
    const read = (actualSemanticInput: unknown, input: unknown = preparedInput) => reader({ runId,
      actionId: 'deployments.deploy', input, semanticInput: actualSemanticInput, context, phase: 'prepare' });
    const proof = await read(semanticInput);
    expect(proof?.steps).toEqual([{ actionId: 'deployments.deploy', input: preparedInput }]);
    for (const changed of [{ whenBusy: 'refuse' }, { targetLinkId: 'foreign' }, { environmentId: 'foreign' },
      { sourceMethod: 'upload' }]) expect(await read({ ...semanticInput, ...changed })).toBeNull();
    expect(await read(undefined)).toBeNull();
    const deploymentAction = async () => ({ ok: true as const,
      environment: createDeploymentEnvironmentHeaderV1({ id: 'staging', serverId: 'home' }), targetLinks: [] });
    for (const changed of [null, { whenBusy: 'refuse' }, { targetLinkId: 'foreign' }, { sourceMethod: 'upload' }]) {
      // The plugin interception is an external extension boundary; the real
      // executor, private reader, codecs and selected trigger owner stay live.
      const executor = createActionExecutor({
        deploymentAction, resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction),
        interceptActionExecution: async () => ({ status: 'continue', input: { ...semanticInput, ...changed } }),
        readApprovedOperation: async request => request.runId ? reader({ ...request, runId: request.runId }) : null,
      });
      const result = await executor.prepare('deployments.deploy', semanticInput, context);
      if (changed === null) expect(result.kind).toBe('ready');
      else expect(result).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_interactive_review_required' } });
    }
    expect(triggerReads.every(id => id === automationId)).toBe(true);
    await h.storage.execute({ operation: 'invocations.fact', runId, invocationId, invocationAttempt: '0',
      expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'admitting',
      contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
          sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', blockKind: 'action', invocationPath: { blockId: 'apply', scope: [] },
          attempt: '0', logicalInvocationRecordId: invocationId,
          execution: { kind: 'action', actionId: 'deployments.deploy', actionRequestId, localInputId: 'local', input: semanticInput } },
      })),
    });
    const dispatch = () => reader({ runId, actionId: 'deployments.deploy', input: preparedInput,
      semanticInput, context, phase: 'dispatch' });
    expect((await dispatch())?.steps).toEqual([{ actionId: 'deployments.deploy', input: preparedInput }]);
    let effects = 0;
    const childTransport: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, input, issued) => {
      if (actionId !== 'deployments.deploy') return deploymentAction();
      effects++;
      expect(input).toEqual(preparedInput);
      expect(readHostReviewedChildOperationV1(issued, actionId, input)?.parent).toEqual(operation.parent);
      return { ok: true, environmentId: 'staging', revision: 3, deploymentId: 'saved-trigger-deploy',
        deploymentRevision: 1, state: 'queued' };
    };
    const childExecutor = createActionExecutor({ deploymentAction: childTransport,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(childTransport) });
    const required = await reader({ runId, actionId: 'deployments.deploy', input: preparedInput, semanticInput,
      context: { ...context, actionsSettings: normalizeActionsSettingsV1({ v: 1,
        actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent'] } } }) }, phase: 'dispatch' });
    expect(typeof required?.invokeReviewedChild).toBe('function');
    expect(await required?.invokeReviewedChild?.(issued => childExecutor.execute('deployments.deploy', preparedInput, issued)))
      .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(effects).toBe(0);
    const automatic = await dispatch();
    expect(await automatic?.invokeReviewedChild?.(issued => childExecutor.execute('deployments.deploy', preparedInput, issued)))
      .toMatchObject({ ok: true });
    expect(effects).toBe(1);
    if (!row) throw new Error('Stored Save required');
    row = { ...row, enabled: false };
    expect(await dispatch()).toBeNull();
  });

  it('requires exact completed parent approval rather than frozen Workflow policy or an approval bypass', async () => {
    await expect(prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent, steps,
      context: { runtimeAccountId: accountId, surface: 'ui', authority: 'present_user', bypassApprovals: true } }))
      .rejects.toMatchObject({ code: 'approval_required' });
    await expect(prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent: { ...parent,
      input: { ...parent.input, machineId: 'changed' } }, steps, context: approvedContext() }))
      .rejects.toMatchObject({ code: 'approval_required' });
    const review = approvedContext();
    await expect(prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent, steps,
      context: { ...review, presentUserApproval: { ...review.presentUserApproval!, decidingAccountId: undefined } } }))
      .rejects.toMatchObject({ code: 'approval_required' });
    const mutableParent = { ...parent, input: { ...parent.input } };
    const prepared = await prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent: mutableParent, steps, context: approvedContext() });
    expect(prepared.approvedOperation).toEqual({ parent, approvedBy: { accountId }, steps });
    mutableParent.input.machineId = 'changed-after-preparation';
    expect(prepared.approvedOperation?.parent.input.machineId).toBe('host');
  });

  it('reopens stored approval for each exact pending/admitting invocation and withdraws it on cancellation', async () => {
    const h = await fixture();
    expect(await h.reader({ runId, context: h.context, phase: 'prepare' })).toEqual(h.approved.approvedOperation);
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
    await h.admit();
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toEqual(h.approved.approvedOperation);
    const reads = h.storage.calls.filter(call => call.operation === 'get');
    expect(reads).toHaveLength(3);
    expect(h.storage.operations()).not.toContain('list');
    h.storage.requestControl('cancelled');
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
  });

  it('refuses changed durable child input and arbitrary matching-run callers', async () => {
    const h = await fixture();
    await h.admit({ ...steps[0]!.input, machineId: 'different-target' });
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
    expect(await h.reader({ runId, context: { actionRequestId }, phase: 'prepare' })).toBeNull();
    expect(await h.reader({ runId, context: { ...h.context, actionRequestId: `${runId}/another/0` }, phase: 'prepare' })).toBeNull();
  });

  it('does not treat an ordinary Workflow start or its frozen present-user policy as approval for children', async () => {
    const h = await fixture(false);
    await h.admit();
    expect(await h.reader({ runId, context: h.context, phase: 'prepare' })).toBeNull();
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
  });

  it('does not spend copied trigger Save proof without its live selected private trigger', async () => {
    const h = await fixture(false);
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...h.approved,
      approvedOperation: { approvedBy: { accountId }, steps,
        parent: { actionId: 'workflow.trigger.update', input: { automationId: 'deployment-automation', triggerId: 'deployment-trigger' } } } });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    // Run storage is the external boundary; the real reader must not interpret
    // a copied person Save as ordinary parent consent or assume a current row.
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (operation, options) => {
      const result = await h.storage.execute(operation, options);
      return operation.operation === 'get' && result && typeof result === 'object' ? { ...result, acceptedEnvelope } : result;
    } }, resolveEncryption: async () => h.encryption });
    expect(await reader({ runId, context: h.context, phase: 'prepare' })).toBeNull();
    await h.admit();
    expect(await reader({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
  });

  it.each(['setup', 'app-command'] as const)('reopens exact scheduled %s consent and holds edited operands or stricter Ask', async kind => {
    const actionId = kind === 'setup' ? 'machines.setup.apply' : 'machines.services.exec';
    const input: Record<string, JsonValue> = kind === 'setup' ? steps[0]!.input : {
      serverId: 'home', machineId: 'host', target: { kind: 'current', serviceId: 'environment/app', expectedGeneration: 'generation-a' },
      mode: 'exec', argv: ['app', 'jobs:run'],
    };
    const currentSteps = [{ actionId, input }];
    const currentDefinition = WorkflowDefinitionV1Schema.parse({ ...definition, blocks: [{ kind: 'action', id: 'apply', actionId,
      input: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { kind: 'literal', value }])) }] });
    const initial = snapshot();
    const h = await fixture(false, false, { ...initial, definition: currentDefinition, authoredDefinition: currentDefinition,
      materializedLeaves: initial.materializedLeaves.map(leaf => ({ ...leaf, actionId, actionInput: input })) });
    const triggerId = 'exact-schedule';
    const automationId = 'exact-command-automation';
    const operation = await prepareWorkflowApprovedOperation({ parent: { actionId: 'workflow.trigger.add', input: {
      target: { kind: 'inline', definition: currentDefinition }, project: { machineId: 'host', directory: '/repo' },
      trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } },
      actionApproval: 'automatic',
    } }, steps: currentSteps, context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: accountId, serverId: 'home', actionRequestId: 'save-schedule' },
      nativeAccount: { accountId, serverId: 'home', isCurrent: async () => true } });
    const accepted = { ...h.approved, approvedOperation: operation };
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    let row = AutomationDefinitionDetailSchema.parse({ id: automationId, name: 'Scheduled command', description: null,
      enabled: true, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null,
      createdAt: 1, updatedAt: 1, assignments: [{ machineId: 'host', enabled: true, priority: 0, updatedAt: 1 }],
      triggers: [{ id: triggerId, revision: 0, kind: 'schedule', enabled: true, createdAt: 1, updatedAt: 1,
        schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null }, nextRunAt: 2, triggerDefinitionEnvelope: null }],
      executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: currentDefinition,
        actionApprovals: [{ triggerId, operation }],
      } } },
    });
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected Automation mutation or inventory'); };
    const triggerReads: string[] = [];
    const triggers = createAccountWorkflowTriggerActions({
      automations: { get: async id => { triggerReads.push(id); return id === automationId ? row : null; },
        list: unavailable, listDetails: unavailable, create: unavailable, reconcile: unavailable, delete: unavailable },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      resolveWorkflow: unavailable, randomBytes: size => new Uint8Array(size), newId: () => 'unused',
    });
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'schedule', triggerId,
      triggerRevision: 0, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId,
        evidence: { v: 1, kind: 'schedule', scheduledFor: 1 } }), occurredAt: 1, evidence: { scheduledFor: 1 } });
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (request, options) => {
      const result = await h.storage.execute(request, options);
      return request.operation === 'get' && result && typeof result === 'object' && 'run' in result ? {
        ...result, acceptedEnvelope, run: { ...WorkflowRunSummaryV1Schema.parse(result.run),
          origin: { kind: 'automation', automationId, cause } },
      } : result;
    } }, resolveEncryption: async () => h.encryption,
      readSavedTriggerConsent: input => triggers.readSavedConsent(input, input.context) });
    for (const phase of ['prepare', 'dispatch'] as const) {
      if (kind === 'app-command') expect(await reader({ runId, actionId,
        input: { ...input, argv: ['app', 'jobs:delete'] }, context: h.context, phase })).toBeNull();
      if (phase === 'dispatch') await h.admit();
      const proof = await reader({ runId, actionId, input: input, context: h.context, phase });
      expect(proof?.steps).toEqual(currentSteps);
      expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
        input: input, context: { surface: 'agent', authority: 'account_automation' }, approvedOperation: proof }).required).toBe(false);
      expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
        input: { ...input, machineId: 'changed' }, context: { surface: 'agent', authority: 'account_automation' },
        approvedOperation: proof }).required).toBe(true);
      expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
        input: input, context: { surface: 'agent', authority: 'account_automation' }, approvedOperation: proof,
        settings: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } }) }).required).toBe(true);
    }
    if (kind === 'app-command') {
      let effects = 0;
      const context: ActionExecutorContext = { ...h.context, surface: 'agent', authority: 'account_automation', serverId: 'home' };
      // Native exec and storage are boundaries; exact consent and Action admission stay real.
      const executor = createActionExecutor({
        machineServiceScope: async () => ({ kind: 'environment', environmentId: 'environment' }),
        machineServiceExec: async () => { effects++; return { exitCode: 0, stdout: 'completed', stderr: '' }; },
        readApprovedOperation: async request => request.runId ? reader({ ...request, runId: request.runId }) : null,
      });
      for (const changed of [
        { ...input, argv: ['app', 'jobs:delete'] }, { ...input, mode: 'run' },
        { ...input, target: { kind: 'current', serviceId: 'environment/worker', expectedGeneration: 'generation-a' } },
        { ...input, target: { kind: 'current', serviceId: 'environment/app', expectedGeneration: 'generation-b' } },
        { ...input, machineId: 'other-machine' }, { ...input, serverId: 'other-home' },
      ]) {
        expect(await reader({ runId, actionId, input: changed, context: h.context, phase: 'dispatch' })).toBeNull();
        expect(await executor.execute(actionId, changed, context)).toMatchObject({ ok: false });
        expect(effects).toBe(0);
      }
      expect(await executor.execute(actionId, input, { ...context,
        actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } }),
      })).toMatchObject({ ok: false });
      expect(effects).toBe(0);
      expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: true, result: { exitCode: 0 } });
      expect(effects).toBe(1);
    }
    expect(triggerReads.every(id => id === automationId)).toBe(true);
    row = { ...row, enabled: false };
    expect(await reader({ runId, actionId, input: input, context: h.context, phase: 'dispatch' })).toBeNull();
  });

  it.each(['deploy-request-a', 'deploy-request-b'])('spends saved structured Action-event consent only on the exact accepted shell invocation (%s)', async requestId => {
    const actionId = 'machines.command.run';
    const event = { kind: 'action', phase: 'before' } as const;
    const literal = '$(touch injected); "quoted" & literal\nnext line';
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], blocks: [{
      kind: 'action', id: 'apply', actionId, input: {
        command: { kind: 'literal', value: 'cat; exit 7' },
        stdin: { kind: 'object', fields: { actionId: { kind: 'trigger_event', event, path: ['actionId'] },
          requestId: { kind: 'trigger_event', event, path: ['requestId'] },
          literal: { kind: 'literal', value: literal } } },
        env: { kind: 'object', fields: { HAPPIER_PHASE: { kind: 'trigger_event', event, path: ['phase'] } } },
      },
    }] });
    const materialized = await materializeWorkflowTriggerActionDefinition({ definition, inputs: {},
      project: { machineId: 'host', directory: '/repo' }, resolveWorkflow: async () => { throw new Error('No child Workflow'); } });
    if (!materialized.materialized.ok) throw new Error(materialized.materialized.error.code);
    const consentSteps = projectWorkflowTriggerConsentSteps({ definition, children: {},
      materializedLeaves: materialized.materialized.materializedLeaves, deployment: false });
    const trigger = { kind: 'action', enabled: true, phase: 'before', mode: 'wait', onFailure: 'refuse',
      actionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1] } as const;
    const operation = await prepareWorkflowApprovedOperation({ parent: { actionId: 'workflow.trigger.add', input: {
      target: { kind: 'inline', definition: StrictJsonValueSchema.parse(definition) },
      project: { machineId: 'host', directory: '/repo' }, trigger: StrictJsonValueSchema.parse(trigger), actionApproval: 'automatic',
    } }, steps: consentSteps, context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: accountId, serverId: 'home', actionRequestId: 'save-event-check' },
      nativeAccount: { accountId, serverId: 'home', isCurrent: async () => true } });
    const evidence = { actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, requestId, phase: 'before' } as const;
    const initial = WorkflowAcceptedSnapshotV1Schema.parse({ ...snapshot(), definition, authoredDefinition: definition,
      materializedLeaves: materialized.materialized.materializedLeaves,
      triggerEventValues: sealWorkflowTriggerEventValuesV1([definition], { event, payload: evidence }), approvedOperation: operation });
    const h = await fixture(false, false, initial, true);
    const triggerId = 'event-shell-check';
    const automationId = 'event-shell-automation';
    const { enabled: _enabled, ...triggerDefinition } = trigger;
    const row = AutomationDefinitionDetailSchema.parse({ id: automationId, name: 'Shell check', description: null,
      enabled: true, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
      assignments: [{ machineId: 'host', enabled: true, priority: 0, updatedAt: 1 }],
      triggers: [{ ...trigger, id: triggerId, revision: 0, createdAt: 1, updatedAt: 1,
        triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
          binding: { v: 1, automationId, triggerId: AutomationTriggerIdSchema.parse(triggerId), triggerRevision: 0, triggerKind: 'action' },
          definition: StrictJsonValueSchema.parse(triggerDefinition) })) }],
      executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: definition,
        actionApprovals: [{ triggerId, operation }],
      } } },
    });
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected Automation mutation or inventory'); };
    const triggers = createAccountWorkflowTriggerActions({ automations: { get: async () => row,
      list: unavailable, listDetails: unavailable, create: unavailable, reconcile: unavailable, delete: unavailable },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      resolveWorkflow: unavailable, randomBytes: size => new Uint8Array(size), newId: () => 'unused' });
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'action', triggerId, triggerRevision: 0,
      occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: { v: 1, kind: 'action', occurredAt: 1,
        subjects: [], ...evidence } }), occurredAt: 1, evidence });
    let accepted = initial;
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (request, options) => {
      const result = await h.storage.execute(request, options);
      return request.operation === 'get' && result && typeof result === 'object' && 'run' in result ? { ...result,
        acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
          ...h.mode, binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted })),
        run: { ...WorkflowRunSummaryV1Schema.parse(result.run), origin: { kind: 'automation', automationId, cause } },
      } : result;
    } }, resolveEncryption: async () => h.encryption,
      readSavedTriggerConsent: request => triggers.readSavedConsent(request, request.context) });
    const input = { command: 'cat; exit 7', stdin: { actionId: evidence.actionId, requestId, literal }, env: { HAPPIER_PHASE: 'before' } };
    for (const phase of ['prepare', 'dispatch'] as const) {
      if (phase === 'dispatch') await h.admit(input);
      expect((await reader({ runId, actionId, input, context: h.context, phase }))?.steps).toEqual([{ actionId, input }]);
      for (const changed of [{ ...input, command: 'delete files' }, { ...input, stdin: { ...input.stdin, literal: 'changed' } },
        { ...input, env: { HAPPIER_PHASE: 'after' } }]) {
        expect(await reader({ runId, actionId, input: changed, context: h.context, phase })).toBeNull();
      }
      expect(await reader({ runId, actionId, input, context: { ...h.context, actionRequestId: `${runId}/foreign/0` }, phase })).toBeNull();
      expect(await reader({ runId: 'foreign-run', actionId, input, context: h.context, phase })).toBeNull();
    }
    let effects = 0;
    const executor = createActionExecutor({
      readApprovedOperation: request => request.runId ? reader({ ...request, runId: request.runId }) : Promise.resolve(null),
      machineCommandRun: async (actual, context) => {
        expect(actual).toEqual(input);
        expect(context.authority).toBe('account_automation');
        effects++;
        return { ok: false, errorCode: 'command_failed', error: 'Command failed',
          details: { exitCode: 7, stdout: '', stderr: 'check failed' } };
      },
    });
    expect(await executor.execute(actionId, input, { ...h.context, serverId: 'home', surface: 'agent', authority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'command_failed' });
    expect(effects).toBe(1);
    const changedDefinition = WorkflowDefinitionV1Schema.parse({ ...definition, blocks: [{ kind: 'action', id: 'apply', actionId,
      input: { command: { kind: 'literal', value: 'cat; exit 7' }, stdin: { kind: 'trigger_event', event, path: ['requestId'] } } }] });
    accepted = { ...initial, definition: changedDefinition };
    expect(await reader({ runId, actionId, input, context: h.context, phase: 'dispatch' })).toBeNull();
  });

  it('keeps transient input and undiscovered contributed input out of durable parent approval', async () => {
    const confidentialSteps: WorkflowApprovedOperationV1['steps'] = [
      { actionId: 'bugreport.submit', input: { pastedCliDoctorSnapshotJson: 'private diagnostic' } },
      { actionId: 'machines.setup.apply', input: { setup: { value: { _isSecretValue: true, value: 'transient' } } } },
      { actionId: 'plugin.acme.install', input: { password: 'transient' } },
    ];
    for (const step of confidentialSteps) {
      await expect(prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent,
        steps: [step], context: approvedContext() })).rejects.toMatchObject({ code: 'approval_required' });
    }
  });

  it('does no storage work for an unbound caller and reads only its selected Run and invocation when bound', async () => {
    const h = await fixture();
    const before = h.storage.calls.length;
    expect(await h.reader({ runId, context: {}, phase: 'prepare' })).toBeNull();
    expect(h.storage.calls.slice(before)).toEqual([]);
    expect(await h.reader({ runId, context: h.context, phase: 'prepare' })).toEqual(h.approved.approvedOperation);
    expect(h.storage.calls.slice(before)).toEqual([
      { operation: 'get', runId }, { operation: 'invocations.get', runId, invocationId },
    ]);
  });

  it('cannot spend one admitting invocation request on a different approved child', async () => {
    const h = await fixture();
    const multiple = await prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent,
      steps: [...steps, { actionId: steps[0]!.actionId, input: { ...steps[0]!.input, machineId: 'another-approved-target' } }],
      context: approvedContext() });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: multiple }));
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (operation, options) => {
      const result = await h.storage.execute(operation, options);
      return operation.operation === 'get' && result && typeof result === 'object' ? { ...result, acceptedEnvelope } : result;
    } }, resolveEncryption: async () => ({ witness: { mode: 'plain' } }) });
    expect((await reader({ runId, context: h.context, phase: 'prepare' }))?.steps).toEqual(steps);
    await h.admit();
    expect((await reader({ runId, context: h.context, phase: 'dispatch' }))?.steps).toEqual(steps);
    const context: ActionExecutorContext = { ...h.context, surface: 'agent', authority: 'account_automation' };
    const admission = await reader({ runId, context, phase: 'dispatch', actionId: 'machines.setup.apply', input: steps[0]!.input });
    expect(await admission?.invokeReviewedChild?.(async issued =>
      readHostReviewedChildOperationV1(issued, 'machines.setup.apply', steps[0]!.input)?.parent)).toEqual(parent);
    expect(await reader({ runId, context, phase: 'dispatch', actionId: 'machines.setup.apply',
      input: steps[0]!.input, semanticInput: { ...steps[0]!.input, machineId: 'another-approved-target' } })).toBeNull();
    expect(await reader({ runId, context, phase: 'dispatch', actionId: 'deployments.deploy', input: steps[0]!.input })).toBeNull();
  });

  it('fails closed on revoked reads and unavailable/mode-inconsistent private content', async () => {
    const h = await fixture();
    const revoked = createWorkflowApprovedOperationReader({ storage: { execute: async () => { throw new Error('run_not_found'); } },
      resolveEncryption: async () => ({ witness: { mode: 'plain' } }) });
    expect(await revoked({ runId, context: h.context, phase: 'prepare' })).toBeNull();
    const noKeys = createWorkflowApprovedOperationReader({ storage: h.storage, resolveEncryption: async () => null });
    expect(await noKeys({ runId, context: h.context, phase: 'prepare' })).toBeNull();
    const corrupt = createWorkflowApprovedOperationReader({ storage: { execute: async (operation, options) => {
      const result = await h.storage.execute(operation, options);
      return operation.operation === 'get' && result && typeof result === 'object'
        ? { ...result, acceptedEnvelope: JSON.stringify({ t: 'encrypted', c: 'not-plain' }) } : result;
    } }, resolveEncryption: async () => ({ witness: { mode: 'plain' } }) });
    expect(await corrupt({ runId, context: h.context, phase: 'prepare' })).toBeNull();
  });

  it('opens existing E2EE Run keys and declines unreadable Team-shared approval without preparing grants', async () => {
    const h = await fixture(true, true);
    await h.admit();
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toEqual(h.approved.approvedOperation);
    const unreadable = createWorkflowApprovedOperationReader({ storage: { execute: async (operation, options) => {
      const result = await h.storage.execute(operation, options);
      if (operation.operation !== 'get' || !result || typeof result !== 'object' || !('keyCensus' in result)) return result;
      return { ...result, keyCensus: { ...WorkflowRunRecipientCensusResponseV1Schema.parse(result.keyCensus),
        access: 'view', callerDataEncryptionKey: null } };
    } }, resolveEncryption: async () => h.encryption });
    expect(await unreadable({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
    expect(h.storage.operations()).not.toContain('run-key.commit');
  });
});
