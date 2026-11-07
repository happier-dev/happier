import { projectExternalActionMachineRuntimeDemandV1 } from '../actionSpecs.js';
import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorContext } from '../actionExecutor.js';
import { listActionSpecsForSurface } from '../actionSpecs.js';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '../actionSettings.js';
import { projectDeploymentNativeAdmissionV1 } from '../../deployments/deploymentCandidatePublicationV1.js';
import type { DeploymentBackupActionIdV1, DeploymentBackupActionResultV1 } from '../../deployments/deploymentActionsV1.js';
import { ExternalActionExecutionAuthorizationV1Schema, projectExternalActionDeploymentNativeEnvelopeAdmissionV1 } from '../externalActionApi.js';
import { sealExternalActionRequestV2 } from '../externalActionEncryption.js';
import { computeExternalActionRequestEnvelopeDigestV1, isExternalActionAuthorizationBoundToEnvelope } from '../externalActionExecutionAuthorization.js';

const common = { serverId: 'srv_backup', environmentId: 'production', machineId: 'runtime', installationId: 'installed',
  targetLinkId: 'target', deploymentId: 'deployment', expectedRevision: 3, configRevision: 2 };
const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
  actionCaller: { kind: 'host' }, serverId: common.serverId, runtimeAccountId: 'owner', actionRequestId: 'backup' };
const snapshotId = 'a'.repeat(64);
const repositoryId = 'b'.repeat(64);
const snapshot = { snapshotId, treeId: 'c'.repeat(64), hostname: 'happier-env-production',
  time: '2026-11-04T10:00:00Z', paths: ['/dump'], tags: ['happier', 'env:production'] };
const manifest = { schemaVersion: 1, environmentId: common.environmentId, sourceId: 'postgres', kind: 'dump',
  configRevision: common.configRevision, repositoryId, snapshot, totalBytesProcessed: 42, totalFilesProcessed: 1,
  producerChecksumSha256: 'd'.repeat(64) };
const cases = [
  { actionId: 'deployments.backups.inventory', input: common, read: true,
    result: { kind: 'inventory', environmentId: common.environmentId, configRevision: 2, repositoryId,
      snapshots: [{ snapshot, totalBytesProcessed: 42, source: { sourceId: 'postgres', kind: 'dump' },
        verification: { kind: 'verified', backupOperationId: 'older-capture', configRevision: 1 } },
      { snapshot: { ...snapshot, snapshotId: 'e'.repeat(64) }, source: null,
        verification: { kind: 'unknown', reason: 'captureReceiptUnavailable' } }] } },
  { actionId: 'deployments.backups.run', input: common, read: false,
    result: { kind: 'verified', operationId: 'capture', manifests: [manifest] } },
  { actionId: 'deployments.backups.verify', input: { ...common, backupOperationId: 'capture', snapshotId, level: 'manifestReadBack' }, read: true,
    result: { kind: 'verified', operationId: 'verify', backupOperationId: 'capture', environmentId: common.environmentId,
      configRevision: 2, repositoryId, snapshotId, level: 'manifestReadBack', verified: true } },
  { actionId: 'deployments.backups.prune', input: { ...common, retention: { kind: 'keepEverything' } }, read: false,
    result: { kind: 'noop', environmentId: common.environmentId, configRevision: 2, forgottenSnapshotIds: [] } },
  { actionId: 'deployments.backups.history', input: common, read: true,
    result: { kind: 'history', environmentId: common.environmentId, configRevision: 2, history: { entries: [] } } },
] as const;

describe('configured deployment backup Actions', () => {
  it.each(cases)('binds $actionId to exact native operands for plain and encrypted Accounts', entry => {
    const actionId = entry.actionId;
    const target = { kind: 'machine', machineId: common.machineId } as const;
    for (const mode of ['plain', 'e2ee'] as const) {
      const envelope = mode === 'plain' ? { v: 1, requestId: 'backup', target, input: entry.input } as const
        : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: common.serverId, accountId: 'owner', actionId,
          requestId: 'backup', target, authentication: { kind: 'account', tokenEpoch: 1 } }, input: entry.input,
          material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
      const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
      const { binding } = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'proof', binding: {
        accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
        serverIdentityId: common.serverId, machineId: common.machineId, installationId: common.installationId,
        actionId, requestId: envelope.requestId, target, accountEncryptionMode: mode, environmentId: common.environmentId,
        deploymentNativeAdmission: native, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      expect(isExternalActionAuthorizationBoundToEnvelope(binding, { actionId, machineId: common.machineId, envelope })).toBe(true);
      const changed = projectDeploymentNativeAdmissionV1(actionId, { ...entry.input, configRevision: 3 });
      expect(isExternalActionAuthorizationBoundToEnvelope({ ...binding, deploymentNativeAdmission: changed },
        { actionId, machineId: common.machineId, envelope })).toBe(false);
      expect(isExternalActionAuthorizationBoundToEnvelope({ ...binding, environmentId: 'foreign' },
        { actionId, machineId: common.machineId, envelope })).toBe(false);
      if (envelope.v === 2) expect(() => projectExternalActionDeploymentNativeEnvelopeAdmissionV1({
        actionId: actionId === 'deployments.backups.run' ? 'deployments.backups.prune' : 'deployments.backups.run', envelope,
      })).toThrow();
    }
  });
  it.each(cases)('admits $actionId through one shared contract and native effect boundary', async entry => {
    const spec = listActionSpecsForSurface('agent').find(candidate => String(candidate.id) === entry.actionId);
    expect(spec, 'Configured backup operations must be public Actions').toBeDefined();
    if (!spec) return;
    expect(spec).toMatchObject({ safety: entry.read ? 'safe' : 'danger', sideEffectClass: entry.read ? 'read' : 'write',
      executionPlacement: 'machine', approvalScope: 'environment' });
    expect(spec.serverTransport).toBeUndefined();
    expect(spec.inputSchema.parse(entry.input)).toEqual(entry.input);
    expect(spec.inputSchema.safeParse({ ...entry.input, configRevision: undefined }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...entry.input, verificationOperationId: 'changing-proof' }).success).toBe(false);
    expect(spec.outputSchema.parse(entry.result)).toEqual(entry.result);
    let nativeEffects = 0;
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: common.environmentId } }),
      // Installed daemon process/storage effects are the system boundary.
      deploymentBackupAction: async <TId extends DeploymentBackupActionIdV1>() => {
        nativeEffects++; return entry.result as DeploymentBackupActionResultV1<TId>;
      },
      approvalsCreate: async () => ({ artifactId: 'backup-review' }),
    });
    let admittedContext = context;
    const first = await executor.execute(spec.id, entry.input, context);
    if (entry.read) {
      expect(first).toEqual({ ok: true, result: entry.result });
      expect(nativeEffects).toBe(1);
    } else {
      expect(first).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'backup-review' } });
      expect(nativeEffects).toBe(0);
      const actionsSettings = setScopedActionApprovalPreference({ actionId: spec.id,
        scope: { kind: 'environment', environmentId: common.environmentId }, surface: 'agent', mode: 'waived',
        settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
      admittedContext = { ...context, actionsSettings };
      expect(await executor.execute(spec.id, entry.input, admittedContext)).toEqual({ ok: true, result: entry.result });
      expect(nativeEffects).toBe(1);
    }
    expect(await executor.execute(spec.id, { ...entry.input, serverId: 'other-home' }, admittedContext)).toMatchObject({ ok: false });
    expect(nativeEffects).toBe(1);
    const admission = projectDeploymentNativeAdmissionV1(entry.actionId, entry.input);
    expect(admission).toMatchObject({ kind: 'backup', actionId: entry.actionId, environmentId: common.environmentId,
      machineId: common.machineId, installationId: common.installationId, configRevision: common.configRevision });
    expect(admission).not.toHaveProperty('serverId');
  });

  it('requires an explicit retention choice and honours a person-selected Ask preference before prune', async () => {
    const entry = cases[3];
    const spec = listActionSpecsForSurface('ui').find(candidate => String(candidate.id) === entry.actionId);
    expect(spec).toBeDefined();
    if (!spec) return;
    expect(spec).toMatchObject({ irreversible: true, approvalPolicy: { uiConfirmation: 'policy' } });
    expect(spec.inputSchema.safeParse(common).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...common, retention: { kind: 'keep' } }).success).toBe(false);
    let effects = 0;
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: common.environmentId } }),
      deploymentBackupAction: async <TId extends DeploymentBackupActionIdV1>() => {
        effects++; return entry.result as DeploymentBackupActionResultV1<TId>;
      },
      // Approval Artifact persistence is the external host boundary.
      approvalsCreate: async () => ({ artifactId: 'prune-review' }),
    });
    const actionsSettings = setScopedActionApprovalPreference({ actionId: spec.id,
      scope: { kind: 'environment', environmentId: common.environmentId }, surface: 'ui', mode: 'required',
      settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
    const user = { ...context, surface: 'ui', authority: 'present_user', actionsSettings } as const;
    expect(await executor.execute(spec.id, entry.input, user)).toMatchObject({
      ok: true, result: { kind: 'approval_request_created', artifactId: 'prune-review' },
    });
    expect(effects).toBe(0);
    const waived = setScopedActionApprovalPreference({ actionId: spec.id,
      scope: { kind: 'environment', environmentId: common.environmentId }, surface: 'ui', mode: 'waived',
      settings: actionsSettings });
    expect(await executor.execute(spec.id, entry.input, { ...user, actionsSettings: waived }))
      .toEqual({ ok: true, result: entry.result });
    expect(effects).toBe(1);
  });
});
