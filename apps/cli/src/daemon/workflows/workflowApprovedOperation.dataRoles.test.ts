import { describe, expect, it } from 'vitest';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { prepareWorkflowApprovedOperationSnapshot } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { prepareWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { PLUGIN_MANIFEST as neon } from '../../../../../packages/plugins/deployment-neon/src/manifest';
import { PLUGIN_MANIFEST as supabase } from '../../../../../packages/plugins/deployment-supabase/src/manifest';
import { createWorkflowApprovedOperationReader } from './workflowApprovedOperation';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';

const accountId = 'owner';
const runId = '52bd37c4-99c6-41cf-90a5-3a1be2b1e031';
const invocationId = 'data-child';
const actionRequestId = `${runId}/${invocationId}/0`;
const parent = { actionId: 'machines.setup.apply' as const, input: { homeId: 'home', machineId: 'host',
  targets: [{ homeId: 'home', machineId: 'host', desiredRevision: 0, recipePlans: [], sources: [{ kind: 'direct', setup: {} }] }] } };

describe('Workflow reviewed data-role child custody', () => {
  it.each(['neon', 'supabase'] as const)('reopens the actual %s declaration and issues only its exact child in Plain and E2EE Runs', async provider => {
    const pluginId = `happier.deploy.${provider}`;
    const action = { pluginId, localId: 'branches-create' };
    const qualified = `${pluginId}/actions/branches-create`;
    const declaration = (provider === 'neon' ? neon : supabase).contributes.actions?.find(action => action.id === 'branches-create');
    if (!declaration) throw new Error('fixture_action_missing');
    const credentialRef = { service: { pluginId, localId: provider }, accountId: 'connected-account' };
    const custody = DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ v: 1, serverId: 'home', environmentId: 'staging',
      expectedRevision: 1, targetLinkId: 'data-link', expectedTargetLinkRevision: 1, credentialRef,
      credentialPrincipal: { kind: 'account', accountId, purpose: { consumer: action, purpose: 'deploy-manage' },
        target: { kind: 'account', account: credentialRef } }, providerAccountId: 'organization',
      providerEnvironment: { kind: 'custom', id: 'parent-branch' }, providerIdentity: {
        providerAccountId: 'organization', providerResourceId: 'database-project', providerEnvironment: 'parent-branch' } });
    const input = { ...custody, ...(provider === 'neon' ? { id: 'database', purpose: 'data.connection', database: 'neondb', role: 'owner',
      labels: { DATABASE_URL: 'Application database', DIRECT_URL: 'Migration database' }, audience: { accountGrants: [accountId] },
      rolePasswordLabel: 'Generated password', initialization: 'parent-schema', correlation: {
        repository: { kind: 'gitlab', deployment: 'https://gitlab.example', repository: 'group/repo' }, pullRequestId: '17' } } : { withData: false }), name: 'Preview 17' };
    const definition = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'action', id: 'database', actionId: qualified,
      input: Object.fromEntries(Object.entries(input).map(([field, value]) => [field, { kind: 'literal', value }])) }] };
    const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition,
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'host', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'host', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
      effects: { resolveTargetAvailability: async () => true,
        readActionContract: async id => id === qualified ? freezeWorkflowActionContractV1({ ...declaration, outputSchema: declaration.resultSchema }) : null } });
    if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
    const approved = await prepareWorkflowApprovedOperationSnapshot({ snapshot: materialized.snapshot, parent,
      steps: [{ actionId: qualified, input }], context: { actionRequestId: 'parent-request',
        approvedActionReplay: { artifactId: 'approval' }, presentUserApproval: { artifactId: 'approval', actionId: parent.actionId,
          requestId: 'parent-request', inputDigest: computeActionInputApprovalDigestV1(parent.actionId, parent.input), decidingAccountId: accountId } } });
    for (const encrypted of [false, true]) {
      const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
      const encryption = { kind: 'available' as const, witness: { mode: 'e2ee' as const, version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) }, material };
      const randomBytes = (length: number) => new Uint8Array(length).fill(3);
      const key = encrypted ? prepareWorkflowRunDataKeyV1({ accountId, encryption, randomBytes }) : null;
      const mode = key ? { ...key.runCrypto, randomBytes } : { mode: 'plain' as const };
      const envelope = key?.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
      const plainCensus = createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
      const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'host', accountId, state: 'running', origin: { kind: 'direct' },
        acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...mode,
          binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: approved })),
        keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse(encrypted ? { ...plainCensus, encryptionMode: 'e2ee',
          ownerAccountCurrentness: encryption.witness, dataEncryptionKey: envelope, callerDataEncryptionKey: envelope } : plainCensus) });
      const progress = (admitted: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...mode,
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
          sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' }, progress: {
          kind: 'happier.workflow-progress.v1', blockKind: 'action', invocationPath: { blockId: 'database', scope: [] },
          attempt: '0', logicalInvocationRecordId: invocationId, ...(admitted ? { execution: {
            kind: 'action', actionId: qualified, actionRequestId, localInputId: 'input', input } } : {}) } }));
      await storage.execute({ operation: 'invocations.admit', runId, parentAttempt: 0, expectedRevision: 0,
        checkpointEnvelope: '{}', invocations: [{ id: invocationId, sequence: '1', parentRecordId: 'root',
          memberOrdinal: '0', contentEnvelope: progress(false) }] });
      const reader = createWorkflowApprovedOperationReader({ storage,
        resolveEncryption: async () => encrypted ? encryption : { witness: { mode: 'plain' } } });
      const context = { actionRequestId, runtimeAccountId: accountId, surface: 'agent' as const,
        authority: 'account_automation' as const, executionRunWorkflowRunId: runId,
        actionCaller: { kind: 'workflowRun' as const, runId, authorization: approved.authorization } };
      for (const phase of ['prepare', 'dispatch'] as const) {
        if (phase === 'dispatch') await storage.execute({ operation: 'invocations.fact', runId, invocationId,
          invocationAttempt: '0', expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'admitting', contentEnvelope: progress(true) });
        const envelope = { action, input };
        const admitted = await reader({ runId, actionId: 'action.invoke', input: envelope, context, phase });
        expect(admitted?.invokeReviewedChild).toBeTypeOf('function');
        expect(await admitted?.invokeReviewedChild?.(async issued => ({ ok: true,
          result: readHostReviewedChildOperationV1(issued, qualified, input)?.parent }))).toEqual({ ok: true, result: parent });
        expect(readHostReviewedChildOperationV1(context, qualified, input)).toBeNull();
        expect(await reader({ runId, actionId: 'action.invoke', input: { action, input: { ...input, name: 'Changed' } }, context, phase })).toBeNull();
        expect(await reader({ runId, actionId: 'action.invoke', input: envelope,
          context: { ...context, runtimeAccountId: 'another-recipient' }, phase })).toBeNull();
      }
    }
  });
});
