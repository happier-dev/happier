import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorContext } from '../actionExecutor.js';
import { listActionSpecsForSurface } from '../actionSpecs.js';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '../actionSettings.js';
import { DeploymentNativeAdmissionV1Schema, projectDeploymentNativeAdmissionV1 } from '../../deployments/deploymentCandidatePublicationV1.js';
import { describeApprovalActionFields } from '../actionApprovalPresentation.js';
import { ExternalActionRequestEnvelopeV2Schema, projectExternalActionDeploymentNativeEnvelopeAdmissionV1 } from '../externalActionApi.js';

const actionId = 'deployments.backups.restore';
const common = { serverId: 'home', environmentId: 'production', machineId: 'runtime', installationId: 'installed',
  targetLinkId: 'target', deploymentId: 'capture-receipt', restoreBackupId: 'backup', expectedRevision: 3 };

describe('deployment backup restore Action', () => {
  it('resolves the native admission union before any public restore input is parsed', () => {
    const { serverId: _serverId, ...target } = common;
    const native = { ...target, kind: 'restore', actionId, mode: 'prepare', inputDigest: 'a'.repeat(43) };
    expect(DeploymentNativeAdmissionV1Schema.parse(native)).toEqual(native);
    expect(DeploymentNativeAdmissionV1Schema.safeParse({}).success).toBe(false);
    expect(DeploymentNativeAdmissionV1Schema.parse({ kind: 'restart', actionId: 'deployments.restart',
      environmentId: common.environmentId, deploymentId: common.deploymentId, targetLinkId: common.targetLinkId,
      machineId: common.machineId, installationId: common.installationId })).toMatchObject({ kind: 'restart' });
  });

  it.each(['prepare', 'confirm'] as const)('admits %s through scoped Ask and the semantic native port', async mode => {
    const spec = listActionSpecsForSurface('agent').find(candidate => String(candidate.id) === actionId);
    expect(spec, 'Restore must have its own public Action and independent approval policy').toBeDefined();
    if (!spec) return;
    const input = { ...common, mode, ...(mode === 'confirm' ? { prepareOperationId: 'prepare-operation' } : {}) };
    expect(spec).toMatchObject({ safety: 'danger', sideEffectClass: 'write', executionPlacement: 'machine',
      approvalScope: 'environment', irreversible: true, approvalPolicy: { uiConfirmation: 'policy' } });
    expect(spec.serverTransport).toBeUndefined();
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, evidence: {} }).success).toBe(false);
    expect(spec.inputSchema.safeParse(mode === 'prepare' ? { ...input, prepareOperationId: 'unexpected' } : { ...common, mode }).success).toBe(false);
    let nativeEffects = 0;
    let confirmations = 0;
    let confirmationAllowed = false;
    const result = mode === 'prepare' ? { kind: 'prepared', operationId: 'prepare-operation', evidence: { backup: 'backup' } } as const
      : { kind: 'restored', verified: true, nextAction: 'none', evidence: { backup: 'backup' } } as const;
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: common.environmentId } }),
      // The installed daemon's native storage/process operation is the external effect boundary.
      deploymentRestore: async () => { nativeEffects++; return result; },
      approvalsCreate: async () => ({ artifactId: 'restore-review' }),
      presentUserActionConfirmation: async () => { confirmations++; return confirmationAllowed; },
    });
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
      actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner', actionRequestId: 'restore' };
    expect(await executor.execute(spec.id, input, context)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', artifactId: 'restore-review' } });
    expect(nativeEffects).toBe(0);
    const actionsSettings = setScopedActionApprovalPreference({ actionId: spec.id,
      scope: { kind: 'environment', environmentId: common.environmentId }, surface: 'agent', mode: 'waived',
      settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
    expect(await executor.execute(spec.id, input, { ...context, actionsSettings })).toEqual({ ok: true, result });
    expect(nativeEffects).toBe(1);
    expect(await executor.execute(spec.id, input, { ...context, surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false });
    expect(nativeEffects).toBe(1);
    confirmationAllowed = true;
    expect(await executor.execute(spec.id, input, { ...context, surface: 'ui', authority: 'present_user' })).toEqual({ ok: true, result });
    expect(confirmations).toBe(2);
    expect(nativeEffects).toBe(2);
    expect(spec.outputSchema.safeParse({ ...result, unexpected: true }).success).toBe(false);
    if (mode === 'confirm') expect(spec.outputSchema.safeParse({ ...result, verified: false }).success).toBe(false);
  });

  it('binds the exact restore mode and receipt in native admission without treating it as rollback', () => {
    const input = { ...common, mode: 'confirm', prepareOperationId: 'prepare-operation' };
    const admission = projectDeploymentNativeAdmissionV1(actionId, input);
    expect(admission).toMatchObject({ kind: 'restore', actionId, mode: 'confirm', deploymentId: 'capture-receipt',
      targetLinkId: 'target', prepareOperationId: 'prepare-operation', expectedRevision: 3 });
    expect(admission).not.toHaveProperty('serverId');
    const envelope = ExternalActionRequestEnvelopeV2Schema.parse({ v: 2, requestId: 'restore',
      target: { kind: 'machine', machineId: 'runtime' }, payload: { t: 'encrypted', c: 'ciphertext' },
      deploymentNativeAdmission: admission });
    expect(projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope })).toEqual(admission);
    expect(() => projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId: 'deployments.restart',
      envelope })).toThrow();
  });
  it.each(['prepare', 'confirm'] as const)('reads a %s approval by what it does, with its routing ids under Technical details', mode => {
    const spec = listActionSpecsForSurface('agent').find(candidate => String(candidate.id) === actionId);
    const input = { ...common, mode, ...(mode === 'confirm' ? { prepareOperationId: 'prepare-operation' } : {}) };
    // The summary says the consequence a person approves: prepare replaces nothing, confirm replaces data, code stays.
    const summary = spec?.approvalPresentation?.summary(input);
    expect(summary).toBeTruthy();
    expect(summary).not.toBe(spec?.approvalPresentation?.summary({ ...common, mode: mode === 'prepare' ? 'confirm' : 'prepare' }));
    const fields = describeApprovalActionFields({ actionId, actionArgs: input });
    const readable = fields.rows.filter(row => !(row.kind === 'value' && row.technical)).map(row => row.path);
    // The runtime Machine is named by the shared reader; every opaque id only correlates the request.
    expect(readable).toEqual(['machineId']);
    for (const path of ['serverId', 'environmentId', 'installationId', 'targetLinkId', 'deploymentId', 'restoreBackupId',
      'expectedRevision', 'mode', ...(mode === 'confirm' ? ['prepareOperationId'] : [])]) {
      expect(fields.rows.find(row => row.path === path)).toMatchObject({ technical: true });
    }
  });
});
