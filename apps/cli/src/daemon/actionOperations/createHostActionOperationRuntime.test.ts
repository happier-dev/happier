import { describe, expect, it, vi } from 'vitest';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getActionSpec, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess } from '@/terminal/pty/provider';
import { executeProjectFiniteProcess } from '@/workspaces/projectSetup/projectSetupExecution';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';

import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { ManagedNativeOperationSettlement } from '@/machines/managed/managedIntentReconciler';
import { ManagedResourceV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { registerActionOperationRpcHandlers } from './actionOperationRpcHandlers';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { normalizeSessionCreateSpawnRequest } from '@/cli/commands/session/create/normalizeSessionCreateSpawnRequest';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { computeDaemonSpawnRequestKey, createSpawnRequestCoalescer } from '@/daemon/spawn/spawnRequestCoalescer';
import { readDeploymentEnvironmentOperationRequestIdV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentChildRpcV1Schema, DeploymentDeployInputV1Schema, projectDeploymentChildRoutingV1, type DeploymentTeardownInputV1 } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { createDeploymentChildExecutionProofV1, computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionSpawnNewResultV1Schema as preObservationSpawnResult } from '../../../../../packages/protocol/src/sessions/creation/testFixtures/sessionSpawnResultBeforeCommitObservation';

describe('finite host operation custody', () => {

  it('keeps an unconfirmed restore snapshot on the same receipt through exact replay and reviewed skip', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'machine', serverId: 'home',
      resolveAccountId: async () => 'account', generateOperationId: () => 'held-restore' });
    const snapshot = { kind: 'unknown' as const, code: 'provider_outcome_unknown' };
    const input = { mode: 'confirm' as const, serverId: 'home', environmentId: 'environment', machineId: 'machine',
      installationId: 'installation', targetLinkId: 'link', deploymentId: 'capture', expectedRevision: 1,
      source: { kind: 'repository' as const, snapshotId: 'b'.repeat(64) }, prepareOperationId: 'prepared', snapshot: true };
    const context = { surface: 'agent' as const, actionCaller: { kind: 'host' as const }, serverId: 'home',
      runtimeAccountId: 'account', actionRequestId: 'restore-request' };
    let effects = 0;
    const held = { ok: false as const, errorCode: 'restore_snapshot_not_confirmed', error: 'restore_snapshot_not_confirmed',
      details: { steps: [], snapshot } };
    // This owner test substitutes the external effect result; receipt admission and continuation remain real.
    const first = { actionId: 'deployments.backups.restore', input, context,
      execute: async (effectContext: Parameters<Parameters<typeof runtime.runActionOperation>[0]['execute']>[0]) => {
        effects++;
        effectContext.operationOwnerUpdate!.update({ domainRef: { kind: 'deployment', serverId: 'home',
          environmentId: 'environment', deploymentId: 'capture' },
          observation: { kind: 'review_required', code: 'restore_snapshot_not_confirmed', snapshot } });
        return held;
      } };
    expect(await runtime.runActionOperation(first)).toEqual(held);
    expect(await runtime.runActionOperation(first)).toEqual(held);
    expect(effects).toBe(1);
    const continued = { ...first, input: { ...input, snapshot: false }, execute: async (
      effectContext: Parameters<Parameters<typeof runtime.runActionOperation>[0]['execute']>[0]) => {
      effects++;
      expect(effectContext.operationAcceptance).toMatchObject({ operationId: 'held-restore', previousRestoreSnapshot: snapshot });
      return { ok: true as const, result: { kind: 'restored', verified: true, nextAction: 'none', evidence: { snapshot } } };
    } };
    expect(await runtime.runActionOperation({ ...continued, input: { ...continued.input, expectedRevision: 2 } }))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    const restored = await runtime.runActionOperation(continued);
    expect(restored).toMatchObject({ ok: true, result: { evidence: { snapshot } } });
    expect(await runtime.runActionOperation(continued)).toEqual(restored);
    expect(effects).toBe(2);
    expect(await runtime.handlers.getV2({ operationId: 'held-restore' })).toMatchObject({ kind: 'found',
      operation: { state: 'succeeded', result: { evidence: { snapshot } } } });
  });

  it.each(['immediate', 'deferred', 'cancelled'] as const)('retains only public contributed refusal facts after %s settlement', async settlement => {
    const { PluginError } = await import('@happier-dev/plugin-sdk');
    const { contributedActionFailureResult, projectStructuredMessageActionFailure } = await import('@/plugins/runtime/invocation/actions/contributedActionFailure');
    const { DaemonPluginStructuredMessageActionExecuteResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
    const error = new PluginError({ code: settlement === 'cancelled' ? 'cancelled' : 'channels_connection_required',
      message: 'Set up Channels first', retryable: false,
      details: { privateProviderFact: 'must-not-cross' },
      remediation: { kind: 'openSettings', path: '/settings/plugins/happier.channels/connections' } });
    const failure = { ok: false as const, errorCode: error.code, error: error.message,
      retryable: error.retryable, data: error.data };
    const direct = projectStructuredMessageActionFailure(failure);
    const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'contributed-refusal' });
    let release!: () => void;
    const boundary = new Promise<void>(resolve => { release = resolve; });
    const request = { actionId: 'acme.review/prepare', title: 'Prepare review', requestId: 'source-request', input: {},
      operation: { version: 1 as const, visibility: 'activity' as const, progress: 'indeterminate' as const,
        presentation: { onStart: 'activity' as const } },
      failureResult: contributedActionFailureResult,
      execute: async (context: Parameters<Parameters<typeof runtime.observePluginExecution>[0]['execute']>[0]) => {
        if (settlement !== 'immediate') {
          context.operationAcceptance?.accept({ kind: 'approval_request_created', artifactId: 'native-approval', actionId: 'workspace.materialize' });
          await boundary;
        }
        return failure;
      } };
    try {
      const result = await runtime.observePluginExecution(request);
      if (settlement !== 'immediate') {
        expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        release();
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(projectStructuredMessageActionFailure(result)).toEqual(direct);
      }
      const receipt = await runtime.handlers.getV2({ operationId: 'contributed-refusal', waitForTerminal: true });
      expect(receipt.kind).toBe('found');
      if (receipt.kind !== 'found') throw new Error('Expected contributed operation');
      expect(receipt.operation.state).toBe(settlement === 'cancelled' ? 'cancelled' : 'failed');
      if (settlement === 'cancelled') expect(receipt.operation).not.toHaveProperty('result');
      else {
        expect(DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(receipt.operation.result)).toEqual(direct);
        const replay = await runtime.observePluginExecution(request);
        expect(replay.ok).toBe(false);
        if (!replay.ok) expect(projectStructuredMessageActionFailure(replay)).toEqual(direct);
      }
      expect(direct).toMatchObject({ retryable: false, remediation: { kind: 'openSettings' } });
      expect(JSON.stringify(receipt.operation)).not.toContain('must-not-cross');
    } finally { release(); }
  });

  it.each([
    { actionId: 'deployments.backups.restore', errorCode: 'backup_failed', facts: { steps: [
      { id: 'safety', status: 'completed' }, { id: 'restore', status: 'failed' },
    ] } },
    { actionId: 'deployments.backups.prune', errorCode: 'backup_failed', facts: { step: 'prune', code: 'backup_failed',
      removedSnapshotIds: ['a'.repeat(64)], uncertainSnapshotIds: [] } },
    { actionId: 'deployments.backups.prune', errorCode: 'backup_failed', facts: { step: 'forget', code: 'backup_failed',
      removedSnapshotIds: [], uncertainSnapshotIds: ['b'.repeat(64)] } },
    { actionId: 'deployments.backups.prune', errorCode: 'cancelled', facts: { step: 'prune', code: 'cancelled',
      removedSnapshotIds: ['c'.repeat(64)], uncertainSnapshotIds: [] } },
    { actionId: 'deployments.backups.restore', errorCode: 'cancelled', facts: { steps: [
      { id: 'safety', status: 'completed' }, { id: 'restore', status: 'failed' },
    ] } },
  ])('retains safe $actionId failure evidence through receipt reads and request replay ($errorCode)', async ({ actionId, errorCode, facts }) => {
    const runtime = createHostActionOperationRuntime({ machineId: 'machine',
      resolveAccountId: async () => 'account', generateOperationId: () => 'backup-failure' });
    const target = { serverId: 'home', environmentId: 'environment', machineId: 'machine',
      installationId: 'installation', targetLinkId: 'link', deploymentId: 'capture', expectedRevision: 1 };
    const input = actionId === 'deployments.backups.restore'
      ? { ...target, mode: 'prepare', restoreBackupId: 'backup' }
      : { ...target, configRevision: 1, retention: { kind: 'keepEverything' } };
    let executions = 0;
    const request = { actionId, input, context: { surface: 'agent' as const,
      actionCaller: { kind: 'host' as const }, serverId: 'home', runtimeAccountId: 'account', actionRequestId: 'backup-failure' },
      execute: async () => {
        executions++;
        return { ok: false as const, errorCode, error: errorCode,
          details: { ...facts, credential: 'private-native-diagnostic' } };
      } };
    expect(await runtime.runActionOperation(request)).toMatchObject({ ok: false, errorCode });
    const receipt = await runtime.handlers.getV2({ operationId: 'backup-failure' });
    expect(receipt).toMatchObject({ kind: 'found', operation: { state: errorCode === 'cancelled' ? 'cancelled' : 'failed', result: facts } });
    if (receipt.kind === 'found') expect(receipt.operation.result).toEqual(facts);
    expect(await runtime.runActionOperation(request)).toEqual({ ok: false, errorCode, error: errorCode, details: facts });
    expect(executions).toBe(1);
  });

  it('retains native recovery for an unclassified Domain result through operation settlement', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', serverId: 'home',
      resolveAccountId: async () => 'owner', generateOperationId: () => 'domain-result' });
    const result = await runtime.observeExecution({ actionId: 'deployments.domains.remove',
      input: { serverId: 'home', environmentId: 'environment', domainId: 'domain',
        expectedRevision: 1, expectedDomainRevision: 1, requestKey: 'remove-domain' },
      execute: async () => ({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }) });
    expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown', details: {
      environmentId: 'environment', domainId: 'domain', requiredFact: 'nativeExecutionResult', remedy: expect.stringMatching(/\S/) } });
    const operation = await runtime.handlers.getV2({ operationId: 'domain-result' });
    expect(operation).toMatchObject({ kind: 'found', operation: { state: 'failed', error: {
      errorCode: 'outcome_unknown', details: { requiredFact: 'nativeExecutionResult', remedy: expect.stringMatching(/\S/) } } } });
  });

  it.each([false, true, undefined] as const)('retries a no-effect deployment with a regenerated candidate, preserving authored-input conflicts and settled effects (%s)', async effectAttempted => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', serverId: 'home', resolveAccountId: async () => 'owner' });
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target', expectedRevision: 2,
      expectedTargetLinkRevision: 1, requestKey: 'retry-deploy', contentArtifactId: 'first-candidate',
      contentHeaderVersion: 3, contentBodyVersion: 3 };
    const request = { actionId: 'deployments.deploy', input, context: { actionRequestId: 'first-request' },
      execute: async () => ({ ok: false as const, errorCode: 'database_transaction_conflict_exhausted',
        error: 'database_transaction_conflict_exhausted', ...(effectAttempted === undefined ? {} : { effectAttempted }) }) };
    expect(await runtime.runActionOperation(request)).toMatchObject({ ok: false, errorCode: 'database_transaction_conflict_exhausted' });
    let effects = 0;
    const retry = { ...request, input: { ...input, contentArtifactId: 'regenerated-candidate', contentHeaderVersion: 4, contentBodyVersion: 4 },
      context: { actionRequestId: 'newly-approved-request' },
      execute: async () => { effects++; return { ok: true as const, result: { deploymentId: 'receipt' } }; } };
    expect(await runtime.runActionOperation({ ...retry, input: { ...retry.input, expectedRevision: input.expectedRevision + 1 } }))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    if (effectAttempted !== false) {
      expect(await runtime.runActionOperation(retry)).toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
      expect(await runtime.runActionOperation({ ...retry, input })).toMatchObject({ ok: false, errorCode: 'database_transaction_conflict_exhausted' });
      expect(effects).toBe(0);
      return;
    }
    expect(await runtime.runActionOperation(retry)).toMatchObject({ ok: true, result: { deploymentId: 'receipt' } });
    expect(await runtime.runActionOperation(retry)).toMatchObject({ ok: true, result: { deploymentId: 'receipt' } });
    expect(await runtime.runActionOperation({ ...retry, input: { ...retry.input, contentArtifactId: 'third-candidate' } }))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(effects).toBe(1);
  });

  it('rejoins teardown when signed receipt head versions advance, preserving intent conflicts', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner' });
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target',
      expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'cleanup', reason: 'manual',
      contentArtifactId: 'receipt', contentHeaderVersion: 1, contentBodyVersion: 1 };
    let effects = 0;
    const invoke = (value = input) => runtime.runActionOperation({ actionId: 'deployments.teardown', input: value,
      context: { actionRequestId: crypto.randomUUID() }, execute: async () => {
        effects++;
        return { ok: true, result: { ok: true, state: 'succeeded' } };
      } });
    expect(await invoke()).toMatchObject({ ok: true });
    const requestId = readDeploymentEnvironmentOperationRequestIdV1(input)!;
    const retained = await runtime.handlers.listV2({ requestIdentity: { actionId: 'deployments.teardown', requestId } });
    expect(retained.items).toMatchObject([{ actionId: 'deployments.teardown', requestId, state: 'succeeded' }]);
    expect(await runtime.handlers.getV2({ operationId: retained.items[0]!.operationId, waitForTerminal: true }))
      .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
    expect(await invoke({ ...input, contentHeaderVersion: 8, contentBodyVersion: 8 })).toMatchObject({ ok: true });
    expect(effects).toBe(1);
    expect(await invoke({ ...input, contentArtifactId: 'another-receipt' }))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(await invoke({ ...input, reason: 'previewClosed' }))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
  });

  it('retries an unproved teardown under its original operation and retained removal choices', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
      generateOperationId: () => 'original-teardown-operation' });
    const input: DeploymentTeardownInputV1 = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target',
      expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'retry-cleanup', reason: 'manual',
      removeEnvironment: true as const,
      volumes: [{ name: 'app_data', disposition: 'delete' as const, confirmation: 'app_data' },
        { name: 'app_logs', disposition: 'keep' as const }],
      contentArtifactId: 'original-receipt', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const operationIds: string[] = [];
    const invoke = (value: DeploymentTeardownInputV1 = input) => runtime.runActionOperation({ actionId: 'deployments.teardown', input: value,
      context: { actionRequestId: crypto.randomUUID() }, execute: async context => {
        operationIds.push(context.operationAcceptance!.operationId);
        context.operationOwnerUpdate?.update({ domainRef: { kind: 'deployment', serverId: 'home',
          environmentId: 'environment', deploymentId: 'original-receipt' } });
        return operationIds.length === 1
          ? { ok: false, errorCode: 'outcome_unknown', error: 'removeTarget: outcome_unknown',
              details: { step: 'removeTarget', reason: 'removal_unproved' } }
          : { ok: true, result: { ok: true, state: 'succeeded', environmentRemoved: true } };
      } });
    expect(await invoke()).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    const { removeEnvironment: _removeEnvironment, ...withoutEnvironmentRemoval } = input;
    expect(await invoke(withoutEnvironmentRemoval))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(await invoke({ ...input, volumes: [{ name: 'app_logs', disposition: 'keep' }] }))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(await invoke({ ...input, reason: 'previewClosed' }))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      runActionOperation: runtime.runActionOperation,
      prepareDeploymentTeardown: async () => { throw new Error('Retry must continue the retained admitted input'); } });
    expect(await executor.execute('deployments.teardown', {
      serverId: input.serverId, environmentId: input.environmentId, targetLinkId: input.targetLinkId,
      requestKey: input.requestKey, reason: input.reason,
    }, { surface: 'ui', actionCaller: { kind: 'host' }, runtimeAccountId: 'owner', actionRequestId: 'retry-transport' }))
      .toMatchObject({ ok: true, result: { state: 'succeeded', environmentRemoved: true } });
    expect(await invoke({ ...input, contentHeaderVersion: 8, contentBodyVersion: 8 }))
      .toMatchObject({ ok: true, result: { state: 'succeeded', environmentRemoved: true } });
    expect(operationIds).toEqual(['original-teardown-operation', 'original-teardown-operation']);
    expect(await runtime.handlers.getV2({ operationId: 'original-teardown-operation' }))
      .toMatchObject({ kind: 'found', operation: { state: 'succeeded', result: { state: 'succeeded' } } });
    expect(await invoke()).toMatchObject({ ok: true, result: { state: 'succeeded' } });
    expect(operationIds).toHaveLength(2);
  });

  it('continues a partial Compose adoption under the same request key across transport retries', async () => {
    let sequence = 0;
    const runtime = createHostActionOperationRuntime({ machineId: 'target', resolveAccountId: async () => 'owner',
      generateOperationId: () => `adopt-operation-${++sequence}` });
    const input = { mode: 'apply', serverId: 'home', machineId: 'target', serviceId: 'watch', expectedGeneration: 'generation',
      requestKey: 'adopt-once', profiles: [], reviewedDigest: `sha256:${'a'.repeat(64)}`, bindingsConfirmed: true, bindings: [],
      destination: { name: 'Imported', projectSourceId: 'source', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers' } };
    const preparedCreate = { serverId: 'home', projectSourceId: 'source', requestKey: 'adopt-once', protection: 'nonProduction',
      purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'target', contentArtifactId: 'stored-definition',
      contentHeaderVersion: 1, contentBodyVersion: 1 };
    const operationIds: string[] = [];
    const invoke = (actionRequestId: string) => runtime.runActionOperation({ actionId: 'machines.services.adopt', input,
      context: { actionRequestId }, execute: async context => {
        operationIds.push(context.operationAcceptance!.operationId);
        return operationIds.length === 1 ? { ok: true, result: { kind: 'partial', environmentId: 'retained-environment',
          revision: 1, errorCode: 'transport_error', preparedCreate } }
          : { ok: true, result: { kind: 'adopted', environmentId: 'retained-environment', revision: 2, targetLinkId: 'retained-link' } };
      } });
    expect(await invoke('transport-one')).toMatchObject({ ok: true, result: { kind: 'partial' } });
    expect(await invoke('transport-two')).toMatchObject({ ok: true, result: { kind: 'adopted', environmentId: 'retained-environment' } });
    expect(await invoke('transport-three')).toMatchObject({ ok: true, result: { kind: 'adopted' } });
    expect(operationIds).toEqual(['adopt-operation-1', 'adopt-operation-1']);
    expect(await runtime.runActionOperation({ actionId: 'machines.services.adopt', input: { ...input, profiles: ['changed'] },
      context: { actionRequestId: 'changed-transport' }, execute: async () => { throw new Error('must not execute'); } }))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
  });
  it('retains restore preparation in requester custody and rejoins confirmation without repeating the database swap', async () => {
    let sequence = 0;
    let effects = 0;
    const runtime = createHostActionOperationRuntime({ machineId: 'target', resolveAccountId: async () => 'owner',
      generateOperationId: () => `restore-operation-${++sequence}` });
    const input = { mode: 'prepare' as const, serverId: 'home', environmentId: 'environment',
      machineId: 'target', installationId: 'installation', targetLinkId: 'link', deploymentId: 'capture',
      restoreBackupId: 'backup', expectedRevision: 1 };
    const prepared = { kind: 'prepared', operationId: 'restore-operation-1', evidence: { capture: 'backup' } };
    await runtime.observeExecution({ actionId: 'deployments.backups.restore', input,
      execute: async () => ({ ok: true, result: prepared }) });
    expect(await runtime.readRestorePreparation({ operationId: prepared.operationId }))
      .toMatchObject({ actionId: 'deployments.backups.restore', state: 'succeeded', result: prepared });
    const foreign = { machineAdmission: { actorAccountId: 'other-person', custodianAccountId: 'other-person',
      machineId: 'target', installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const } };
    expect(await runtime.readRestorePreparation({ operationId: prepared.operationId, context: foreign })).toBeNull();
    const confirm = { ...input, mode: 'confirm' as const, prepareOperationId: prepared.operationId };
    const invoke = (value: typeof confirm, requestId: string) => runtime.observeExecution({
      actionId: 'deployments.backups.restore', input: value, actionRequestId: requestId,
      execute: async () => { effects++; return { ok: true, result: { kind: 'restored', verified: true } }; },
    });
    const first = await invoke(confirm, 'transport-one');
    expect(await invoke(confirm, 'transport-two')).toEqual(first);
    expect(effects).toBe(1);
    expect(await invoke({ ...confirm, restoreBackupId: 'substituted-backup' }, 'transport-three'))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(effects).toBe(1);
  });
  it.each(['scope unavailable', 'native project receiver', 'native launcher receiver'] as const)(
    'refuses carried native confirmation where the existing request owner is unavailable (%s)', async direction => {
      const actionId = direction === 'native project receiver' ? 'projects.open'
        : direction === 'native launcher receiver' ? 'localServices.launcher.start'
          : 'machines.setup.apply';
      const runtime = createHostActionOperationRuntime({ machineId: 'native-target',
        resolveAccountId: async () => null });
      const target = { kind: 'machine' as const, machineId: 'native-target' };
      const context = { surface: 'ui' as const, authority: 'present_user' as const,
        actionRequestId: 'original-native-request', externalActionTarget: target,
        externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted',
          binding: { accountId: 'alice', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 },
            accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId, requestId: 'original-native-request',
            machineId: target.machineId, installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43) } }),
        presentUserConfirmation: { actionId, requestId: 'original-native-request', accountId: 'alice', serverId: 'home',
          inputDigest: 'a'.repeat(43), target } as const,
      };
      let effects = 0;
      const execute = async () => { effects++; return { ok: true as const, result: { completed: true } }; };
      expect(await runtime.runActionOperation({ actionId, input: {}, context, execute }))
        .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
      expect(effects).toBe(0);
      // This unsupported private-carrier direction does not change ordinary
      // native receiver routing or require a new receipt for local execution.
      expect(await runtime.runActionOperation({ actionId, input: {}, context: { ...context, presentUserConfirmation: undefined }, execute }))
        .toEqual({ ok: true, result: { completed: true } });
      expect(effects).toBe(1);
    },
  );
  it.each((['approved-first', 'ordinary-first'] as const).flatMap(order =>
    (['succeeded', 'failed', 'thrown'] as const).map(outcome => ({ order, outcome }))))(
    'observes the terminal approved deployment while ordinary callers retain acceptance ($order, $outcome)', async ({ order, outcome }) => {
      const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
        generateOperationId: () => 'approved-deployment' });
      let release!: () => void;
      const completion = new Promise<void>(resolve => { release = resolve; });
      let accepted!: () => void;
      const acceptance = new Promise<void>(resolve => { accepted = resolve; });
      let effects = 0;
      const terminal = outcome === 'succeeded'
        ? { ok: true as const, result: { completed: true, receiptId: 'receipt' } }
        : { ok: false as const, errorCode: 'deployment_image_unavailable', error: 'Deployment image is unavailable.',
          ...(outcome === 'thrown' ? { failureCause: { phase: 'deployments.deploy', errorCode: 'deployment_image_unavailable',
            errorClass: 'Error', httpStatus: null } } : {}) };
      const execute: Parameters<typeof runtime.runActionOperation>[0]['execute'] = async context => {
        effects++;
        context.operationAcceptance?.accept({ kind: 'admitted', receiptId: 'receipt' });
        accepted();
        await completion;
        if (outcome === 'thrown') throw Object.assign(new Error('Deployment image is unavailable.'), { code: 'deployment_image_unavailable' });
        return terminal;
      };
      const invoke = (approved: boolean) => runtime.runActionOperation({ actionId: 'deployments.deploy', input: {
        serverId: 'home', environmentId: 'environment', sha: 'a'.repeat(40), requestKey: 'approved-deployment',
      }, context: { actionRequestId: 'original-request',
        ...(approved ? { approvedActionReplay: { artifactId: 'approval' } } : {}) }, execute });
      const first = invoke(order === 'approved-first');
      await acceptance;
      const joined = invoke(order !== 'approved-first');
      const ordinary = order === 'approved-first' ? joined : first;
      const approved = order === 'approved-first' ? first : joined;
      try {
        expect(await ordinary).toEqual({ ok: true, result: { kind: 'admitted', receiptId: 'receipt' } });
        expect(runtime.store.get({ accountId: 'owner', machineId: 'controller' }, 'approved-deployment'))
          .toMatchObject({ state: 'running' });
        release();
        expect(await approved).toEqual(terminal);
        expect(effects).toBe(1);
      } finally {
        release();
        await runtime.runner.waitForTerminal({ accountId: 'owner', machineId: 'controller' }, 'approved-deployment');
      }
    });
  it('cancels the accepted deployment controller through its existing operation signal', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
      generateOperationId: () => 'deployment-controller' });
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let receiverSignal: AbortSignal | undefined;
    let effects = 0;
    await runtime.observeExecution({ actionId: 'deployments.deploy', input: {
      serverId: 'home', environmentId: 'environment', sha: 'a'.repeat(40), requestKey: 'cancel-deployment',
    }, execute: async ({ signal, operationAcceptance }) => {
      receiverSignal = signal;
      operationAcceptance?.accept({ kind: 'waitingApproval' });
      await waiting;
      if (signal.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      effects++;
      return { ok: true, result: {} };
    } });
    try {
      expect(await runtime.handlers.cancel({ operationId: 'deployment-controller' })).toEqual({ kind: 'requested' });
      expect(receiverSignal?.aborted).toBe(true);
      release();
      expect(await runtime.handlers.getV2({ operationId: 'deployment-controller', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
      expect(effects).toBe(0);
    } finally {
      release();
      await runtime.runner.waitForTerminal({ accountId: 'owner', machineId: 'controller' }, 'deployment-controller');
    }
  });
  it.each(['get', 'getV2'] as const)('keeps %s pre-receipt observation private to the originating deployment token and Environment', async readMethod => {
    const machineId = 'original-controller';
    const environmentId = 'staging';
    const grant = { v: 1, actions: { families: [], ids: ['deployments.deploy', 'action.operations.get'] },
      targets: { sessions: [], machines: [], environments: [environmentId] }, approve: false,
      origins: [], models: null, permissionModes: null, create: null };
    const authorization = (actionId: 'deployments.deploy' | 'action.operations.get', credentialId = 'token-one', selectedEnvironment = environmentId) =>
      ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-root', binding: {
        accountId: 'owner', principalId: 'owner', credentialId, grant,
        custodianAccountId: 'owner', serverIdentityId: 'home', machineId, installationId: 'installation',
        actionId, requestId: 'original-root', requestEnvelopeDigest: 'a'.repeat(43),
        environmentId: selectedEnvironment, target: { kind: 'machine', machineId },
      } });
    const context = (actionId: 'deployments.deploy' | 'action.operations.get', credentialId?: string, selectedEnvironment?: string) => ({
      callerInputAuthorization: authorization(actionId, credentialId, selectedEnvironment),
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId,
        installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const },
      verifyMachineAdmissionCurrent: async () => true,
    });
    const runtime = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => 'owner',
      custodyBinding: { serverId: 'home', installationId: 'installation' }, generateOperationId: () => 'pre-receipt-operation' });
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const input = { serverId: 'home', environmentId, sha: 'a'.repeat(40), requestKey: 'ci-run' };
    const execution = runtime.observeExecution({ actionId: 'deployments.deploy', input,
      rpcContext: context('deployments.deploy'), execute: async operation => {
        operation.operationAcceptance?.accept({ kind: 'waitingApproval' });
        await held;
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      } });
    try {
      await execution;
      const request = { operationId: 'pre-receipt-operation' };
      const own = await runtime.handlers[readMethod](request, context('action.operations.get'));
      expect(own).toMatchObject({ kind: 'found', operation: { scope: { machineId }, actionId: 'deployments.deploy' } });
      if (own.kind === 'found') {
        expect(own.operation.domainRef).toBeUndefined();
        expect(JSON.stringify(own.operation)).not.toContain('token-one');
      }
      await expect(runtime.handlers[readMethod](request, context('action.operations.get', 'token-two')))
        .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
      await expect(runtime.handlers[readMethod](request, context('action.operations.get', 'token-one', 'production')))
        .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
      let currentnessChecks = 0;
      await expect(runtime.handlers[readMethod](request, { ...context('action.operations.get'),
        verifyMachineAdmissionCurrent: async () => ++currentnessChecks === 1,
      })).resolves.toMatchObject({ kind: 'found' });
      expect(currentnessChecks).toBe(0);
      await expect(runtime.handlers[readMethod](request, { ...context('action.operations.get'),
        signal: AbortSignal.abort(),
      })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(await runtime.observeExecution({ actionId: 'deployments.deploy', input,
        rpcContext: context('deployments.deploy', 'token-two'),
        execute: async () => { throw new Error('A foreign token cannot execute or rejoin the original request'); },
      })).toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
      const fullGrantContext = (actionId: 'deployments.deploy' | 'action.operations.get') => ({ ...context(actionId),
        callerInputAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization(actionId),
          binding: { ...authorization(actionId).binding, grant: API_TOKEN_FULL_GRANT_V1,
            ...(actionId === 'action.operations.get' ? { environmentId: undefined } : {}) },
        }),
      });
      expect(await runtime.observeExecution({ actionId: 'deployments.deploy', input,
        rpcContext: fullGrantContext('deployments.deploy'),
        execute: async () => { throw new Error('The same token must rejoin even if its current grant is unrestricted'); },
      })).toEqual(await execution);
      expect(await runtime.handlers[readMethod](request, fullGrantContext('action.operations.get')))
        .toMatchObject({ kind: 'found' });
      expect(await runtime.handlers[readMethod](request)).toMatchObject({ kind: 'found' });
    } finally {
      finish();
      await runtime.runner.waitForTerminal({ accountId: 'owner', machineId }, 'pre-receipt-operation');
    }
  });
  it.each(['person', 'agent'] as const)('keeps %s invocation provenance distinct from observed operation attribution', async caller => {
    const attribution = { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' };
    const context = {
      surface: 'ui' as const, authority: 'present_user' as const, actionRequestId: `recording-${caller}`,
      actionCaller: caller === 'person' ? { kind: 'host' as const }
        : { kind: 'session' as const, sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 },
      ...(caller === 'agent' ? { requesterWorkAttributionV1: attribution } : {}),
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const },
      verifyMachineAdmissionCurrent: async () => true,
    };
    const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'owner',
      custodyBinding: { serverId: 'home', installationId: 'installation' }, generateOperationId: () => `operation-${caller}` });
    const admission = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' });
    const result = await runtime.runActionOperation({ actionId: 'daemon.filesystem.download', input: {}, context,
      execute: async admitted => {
        expect(admitted.requesterWorkAttributionV1).toBe(context.requesterWorkAttributionV1);
        const failure = await admission.action(admitted);
        return failure ? { ok: false, ...failure } : { ok: true, result: { admitted: true } };
      } });
    expect(result).toMatchObject(caller === 'person' ? { ok: true, result: { admitted: true } }
      : { ok: false, errorCode: 'filesystem_identity_custody_unavailable' });
    expect(runtime.store.readRequesterWorkAttribution(`operation-${caller}`)).toEqual(attribution);
    expect(runtime.store.get({ accountId: 'owner', machineId: 'machine' }, `operation-${caller}`))
      .toMatchObject({ state: caller === 'person' ? 'succeeded' : 'failed' });
  });
  it.each((['acknowledged-content', 'unknown-secret'] as const).flatMap(phase =>
    (['existing', 'new'] as const).map(project => ({ phase, project }))))(
    'retains a template partial result ($phase, $project Project) and rejoins its creation intent without repeating generated-secret effects', async ({ phase, project }) => {
    let sequence = 0;
    let effects = 0;
    const runtime = createHostActionOperationRuntime({ machineId: 'target', resolveAccountId: async () => 'owner',
      generateOperationId: () => `template-operation-${++sequence}` });
    const input = { mode: 'apply', serverId: 'home', machineId: 'target',
      ...(project === 'existing' ? { projectSourceId: 'project' }
        : { newProject: { name: 'New Project', requestKey: 'create-project', owner: { kind: 'account' as const, accountId: 'owner' } } }),
      templateRef: { sourceId: 'builtin:apps', itemId: 'app', version: '1',
        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      environment: { kind: 'create', name: 'App', requestKey: 'create-app', protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'target' },
      target: { kind: 'new', installationId: 'installation' }, destination: { kind: 'stored' }, bindings: [] };
    const retained = { kind: 'partial', phase: phase === 'unknown-secret' ? 'generation' : 'bindings', errorCode: 'deployment_conflict',
      ...(phase === 'unknown-secret' ? { unknownSecret: { name: 'SECOND_PASSWORD', phase: 'runtime', ref: 'happier:shared-secret:v1:candidate' } }
        : { environmentId: 'created-environment', revision: 2, definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` } }),
      savedSecrets: [{ name: 'DB_PASSWORD', phase: 'runtime', source: { kind: 'secret', ref: 'happier:shared-secret:v1:saved-secret', resourceRevision: 1 } }],
    };
    const invoke = (value: typeof input, requestId: string) => runtime.observeExecution({ actionId: 'deployments.templates.instantiate',
      input: value, actionRequestId: requestId, execute: async () => {
        effects += 1;
        return { ok: false, errorCode: retained.errorCode, error: retained.errorCode, details: retained };
      } });
    const first = await invoke(input, 'transport-one');
    expect(first).toMatchObject({ ok: false, details: retained });
    expect(await invoke(input, 'transport-two')).toEqual(first);
    expect(effects, 'A transport retry must observe the existing operation, preserving acknowledged refs').toBe(1);
    expect(await runtime.handlers.getV2({ operationId: 'template-operation-1' })).toMatchObject({ kind: 'found', operation: {
      state: 'failed', error: { errorCode: 'deployment_conflict', details: retained },
    } });
    expect(await invoke({ ...input, environment: { ...input.environment, name: 'Changed' } }, 'transport-three'))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(effects).toBe(1);
    expect(await invoke({ ...input, machineId: 'another-target' }, 'transport-four')).toMatchObject({ ok: false, details: retained });
    expect(effects).toBe(2);
    await invoke({ ...input, mode: 'preview' }, 'preview-request');
    await invoke({ ...input, mode: 'preview' }, 'preview-request');
    expect(effects).toBe(4);
    expect((await runtime.handlers.listV2({})).items).toHaveLength(2);
    expect(await invoke({ ...input, environment: { ...input.environment, requestKey: 'independent-create' } }, 'transport-five'))
      .toMatchObject({ ok: false, details: retained });
    expect(effects).toBe(5);
  });
  it('binds finite archive operation observation to its admitted parent proof before any domain lookup', async () => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'deployment-root', binding: {
      accountId: 'bob', custodianAccountId: 'controller-owner', authentication: { kind: 'terminal', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'controller', installationId: 'controller-install',
      actionId: 'deployments.deploy', requestId: 'root-request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'controller' },
    } });
    const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.deploy',
      machineId: 'receiver', installationId: 'receiver-install', phase: 'activate', deploymentId: 'deployment',
      selectedDeploymentId: 'deployment', actionOperationId: 'parent-operation',
      input: { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1,
        expectedTargetLinkRevision: 1, requestKey: 'request', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } });
    const originalActionEnvelope = { v: 1, requestId: root.binding.requestId, target: root.binding.target, input: job.input } as const;
    root.binding.requestEnvelopeDigest = computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope);
    const proof = createDeploymentChildExecutionProofV1({ method: `receiver:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, originalActionEnvelope,
      requestId: 'member-request', params: job, externalActionExecution: { v: 1, authorization: root,
        effectActionId: 'deployments.deploy', target: root.binding.target, installationId: 'controller-install',
        machineSignature: 'a'.repeat(86), deploymentChildRouting: projectDeploymentChildRoutingV1(job) } },
      { environmentId: 'environment', deploymentId: 'deployment', holderMachineId: 'holder', holderInstallationId: 'holder-install' });
    const packet = { method: `holder:${RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD}`, requestId: 'download-request', params: {},
      externalActionExecution: { v: 1 as const, authorization: root, effectActionId: 'daemon.filesystem.download' as const,
        target: root.binding.target, installationId: 'receiver-install', machineSignature: 'a'.repeat(86), deploymentChildExecution: proof } };
    const context = { callerInputAuthorization: root, workspaceSyncSourceExecution: packet,
      machineAdmission: { actorAccountId: 'ann', custodianAccountId: 'holder-owner', machineId: 'holder',
        installationId: 'holder-install', role: 'use' as const, encryptionMode: 'plain' as const },
      verifyMachineAdmissionCurrent: async () => true };
    let id = 0;
    const runtime = createHostActionOperationRuntime({ machineId: 'holder', resolveAccountId: async () => 'holder-owner',
      custodyBinding: { serverId: 'home', installationId: 'holder-install' }, generateOperationId: () => `archive-${++id}` });
    const execute = async () => ({ ok: true as const, result: { descriptor: 'source' } });
    await runtime.observeExecution({ actionId: 'daemon.filesystem.download', input: {}, actionRequestId: 'download', rpcContext: context, execute });
    await runtime.observeExecution({ actionId: 'daemon.filesystem.download', input: {}, actionRequestId: 'unrelated',
      rpcContext: { ...context, workspaceSyncSourceExecution: undefined }, execute });
    const readContext = { ...context, workspaceSyncSourceExecution: { ...packet,
      method: 'holder:actionOperation.get.v2', externalActionExecution: { ...packet.externalActionExecution, effectActionId: 'action.operations.get' as const } } };
    const keys = tweetnacl.sign.keyPair();
    // Only the authenticated Home HTTP verifier is substituted. The RPC
    // dispatcher, child-proof binding and retained operation lookup stay real.
    const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true },
      statusText: '', headers: {}, config: { headers: new AxiosHeaders() } });
    const admissionPredicates: unknown[] = [];
    try {
      const rpc = new RpcHandlerManager({ scopePrefix: 'holder', localMachineId: 'holder', encryptionMode: 'plain',
        logger: (_message, data) => {
          if (data && typeof data === 'object' && 'admissionPredicate' in data) admissionPredicates.push(data.admissionPredicate);
        },
        authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'holder',
          resolveCustodianAccountId: async () => 'holder-owner', resolveInstallationId: () => 'holder-install',
          verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
            privateKey: keys.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }) }),
      });
      registerActionOperationRpcHandlers(rpc, runtime.handlers);
      // Archive transport consumes the V2 observation contract only.
      const method = ACTION_OPERATION_RPC_METHODS_V2.get;
      const params = { operationId: 'archive-1', waitForTerminal: true };
      const before = network.mock.calls.length;
      const response = await rpc.handleRequest({ method: `holder:${method}`, params, machineAdmission: context.machineAdmission,
        callerAuthority: 'present_user', callerInputAuthorization: root,
        workspaceSyncSourceExecution: { ...readContext.workspaceSyncSourceExecution, method: `holder:${method}`, params },
      });
      expect(response, JSON.stringify({ admissionPredicates, homeRequests: network.mock.calls.length - before })).toMatchObject({ kind: 'found' });
      expect(network.mock.calls.length - before).toBe(1);
    } finally { network.mockRestore(); }
    expect(await runtime.handlers.getV2({ operationId: 'archive-1', waitForTerminal: true }, readContext)).toMatchObject({ kind: 'found' });
    await expect(runtime.handlers.getV2({ operationId: 'archive-2' }, readContext)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    const ordinary = { ...context, workspaceSyncSourceExecution: undefined };
    expect.soft((await runtime.handlers.list({}, ordinary)).items.map(operation => operation.operationId)).toEqual(['archive-2']);
    expect.soft((await runtime.handlers.listV2({}, ordinary)).items.map(operation => operation.operationId)).toEqual(['archive-2']);
    expect.soft((await runtime.handlers.listV2({ requestIdentity: { actionId: 'daemon.filesystem.download', requestId: 'download' } }, ordinary)).items).toEqual([]);
    expect(await runtime.handlers.getV2({ operationId: 'archive-2' }, ordinary)).toMatchObject({ kind: 'found' });
    await expect.soft(runtime.handlers.get({ operationId: 'archive-1' }, ordinary))
      .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    await expect.soft(runtime.handlers.getV2({ operationId: 'archive-1' }, ordinary))
      .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    const otherProof = { ...proof, requestId: 'another-member-request' };
    await expect(runtime.handlers.getV2({ operationId: 'archive-1' }, { ...readContext, workspaceSyncSourceExecution: {
      ...readContext.workspaceSyncSourceExecution, externalActionExecution: { ...readContext.workspaceSyncSourceExecution.externalActionExecution,
        deploymentChildExecution: otherProof } } })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    await expect(runtime.handlers.getV2({ operationId: 'archive-1' }, { ...readContext, workspaceSyncSourceExecution: {
      ...readContext.workspaceSyncSourceExecution, externalActionExecution: { ...readContext.workspaceSyncSourceExecution.externalActionExecution,
        deploymentChildExecution: { ...proof, archiveOrigin: { ...proof.archiveOrigin!, deploymentId: 'other-origin' } } } } }))
      .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
  });
  it('rejoins one Environment requestKey across fresh transport requests without replaying its admitted effect', async () => {
    let sequence = 0;
    let accountId = 'owner';
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => accountId,
      generateOperationId: () => `deployment-operation-${++sequence}` });
    const effects: string[] = [];
    const rootRequests: (string | null | undefined)[] = [];
    const input = { serverId: 'home', environmentId: 'staging', expectedRevision: 1, requestKey: 'deploy-a',
      targetLinkId: 'runtime', expectedTargetLinkRevision: 1,
      contentArtifactId: 'candidate-a', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      runActionOperation: runtime.runActionOperation,
      // The authenticated Environment read is a storage boundary; admission and policy stay real.
      resolveEnvironmentApprovalScope: async ({ input: value }) => ({ scope: {
        kind: 'environment', environmentId: DeploymentDeployInputV1Schema.parse(value).environmentId,
      } }),
      deploymentAction: async (_id, request, context) => {
        const operationId = context.operationAcceptance?.operationId;
        if (!operationId || !('environmentId' in request) || typeof request.environmentId !== 'string') throw new Error('Missing admitted deployment operation');
        effects.push(operationId);
        rootRequests.push(context.actionRequestId);
        return { ok: true, environmentId: request.environmentId, revision: 2,
          deploymentId: 'receipt-a', deploymentRevision: 2, state: 'succeeded' };
      },
    });
    const invoke = (request: typeof input, actionRequestId: string) => executor.execute('deployments.deploy', request,
      { surface: 'ui', authority: 'present_user', actionRequestId });
    const first = await invoke(input, 'transport-1');
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, result: { deploymentId: 'receipt-a' } });
    expect(await invoke(input, 'transport-2')).toEqual(first);
    expect(effects).toEqual(['deployment-operation-1']);
    expect(await invoke({ ...input, contentArtifactId: 'changed-candidate' }, 'transport-3'))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(effects).toEqual(['deployment-operation-1']);
    expect(await invoke({ ...input, environmentId: 'production' }, 'transport-4')).toMatchObject({ ok: true });
    expect(effects).toEqual(['deployment-operation-1', 'deployment-operation-2']);
    accountId = 'another-owner';
    expect(await invoke(input, 'transport-5')).toMatchObject({ ok: true });
    expect(effects).toEqual(['deployment-operation-1', 'deployment-operation-2', 'deployment-operation-3']);
    accountId = 'owner';
    expect(await invoke(input, 'transport-6')).toEqual(first);
    const fullLengthKey = { ...input, requestKey: 'k'.repeat(2_000) };
    expect(await invoke(fullLengthKey, 'transport-7')).toMatchObject({ ok: true });
    expect(await invoke(fullLengthKey, 'transport-8')).toMatchObject({ ok: true });
    expect(effects).toEqual(['deployment-operation-1', 'deployment-operation-2', 'deployment-operation-3', 'deployment-operation-4']);
    expect(rootRequests).toEqual(['transport-1', 'transport-4', 'transport-5', 'transport-7']);
  });
  it.each(['request', 'managed-id', 'controller', 'resource', 'account', 'terminal'] as const)(
    'does not settle another retained Delete through a mismatched %s', async mismatch => {
      let accountId = 'owner';
      const controller = { machineId: 'controller', installationId: 'installation' };
      const resource = { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'exact' } };
      const runtime = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => accountId,
        generateOperationId: () => 'uncertain-delete' });
      await runtime.observeExecution({ actionId: 'machines.managed.delete', input: {}, actionRequestId: 'submitted-delete',
        execute: async ({ operationOwnerUpdate }) => {
          operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: 'managed', controller, resource } });
          return mismatch === 'terminal' ? { ok: false, errorCode: 'native_denied', error: 'native_denied' }
            : { ok: false, errorCode: 'action_outcome_unknown', error: 'action_outcome_unknown' };
        } });
      const before = await runtime.handlers.getV2({ operationId: 'uncertain-delete' });
      const settlement: ManagedNativeOperationSettlement = { managedId: mismatch === 'managed-id' ? 'other' : 'managed',
        controller: mismatch === 'controller' ? { ...controller, installationId: 'other' } : controller,
        resource: mismatch === 'resource' ? { ...resource, value: { id: 'other' } } : resource,
        requestId: mismatch === 'request' ? 'other' : 'submitted-delete', intentRevision: 1, intent: 'delete', succeeded: true };
      if (mismatch === 'account') accountId = 'other-account';
      await runtime.observeExecution({ actionId: 'machines.managed.inspect', input: {},
        execute: async context => { context.settleManagedNativeOperation?.(settlement); return { ok: true, result: {} }; } });
      accountId = 'owner';
      expect(await runtime.handlers.getV2({ operationId: 'uncertain-delete' })).toEqual(before);
    });

  it.each(['linked', 'account-owned', 'id-only', 'managed-id', 'controller', 'resource', 'account', 'session', 'terminal', 'other-action'] as const)(
    'confirmed Delete selects only its live scoped acquisition (%s)', async scenario => {
      let accountId = 'owner';
      const controller = { machineId: 'controller', installationId: 'installation' };
      const resource = ManagedResourceV1Schema.parse({ contributionRef: { pluginId: 'acme.compute', localId: 'vm' },
        schemaVersion: 1, value: { id: 'exact' } });
      const runtime = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => accountId,
        generateOperationId: () => 'acquiring' });
      let signal: AbortSignal | undefined;
      let release!: () => void;
      const nativeCompletion = new Promise<void>(resolve => { release = resolve; });
      await runtime.observeExecution({ actionId: scenario === 'other-action' ? 'machines.managed.power.set' : 'machines.managed.acquire',
        input: {}, actionRequestId: 'acquire', ...(scenario === 'session' ? { sessionId: 'original-session' } : {}),
        execute: async context => {
          signal = context.signal;
          context.operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: 'managed',
            ...(scenario === 'id-only' ? {} : { controller: scenario === 'account-owned' ? undefined : controller, resource }) } });
          if (scenario === 'terminal') return { ok: true, result: { completed: true } };
          context.operationAcceptance?.accept({ managedId: 'managed' });
          // The pending native boundary obeys the real runner's local signal.
          context.signal.addEventListener('abort', release, { once: true });
          await nativeCompletion;
          return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        } });
      const before = await runtime.handlers.getV2({ operationId: 'acquiring' });
      expect(before).toMatchObject({ kind: 'found', operation: { domainRef: { kind: 'managedMachine', id: 'managed' } } });
      if (scenario === 'account') accountId = 'another-account';
      try {
        await runtime.observeExecution({ actionId: 'machines.managed.inspect', input: {},
          ...(scenario === 'session' ? { sessionId: 'different-session' } : {}),
          execute: async context => {
            context.settleManagedNativeOperation?.({ managedId: scenario === 'managed-id' ? 'other' : 'managed',
              controller: scenario === 'account-owned' ? undefined
                : scenario === 'controller' ? { ...controller, installationId: 'other' } : controller,
              resource: scenario === 'resource' ? { ...resource, value: { id: 'other' } } : resource,
              requestId: 'delete', intentRevision: 1, intent: 'delete', succeeded: true });
            return { ok: true, result: {} };
          } });
        accountId = 'owner';
        if (scenario === 'linked' || scenario === 'account-owned' || scenario === 'id-only' || scenario === 'session') {
          expect(signal?.aborted).toBe(true);
          expect(await runtime.handlers.getV2({ operationId: 'acquiring', waitForTerminal: true }))
            .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
        } else {
          expect(signal?.aborted).toBe(false);
          expect(await runtime.handlers.getV2({ operationId: 'acquiring' })).toEqual(before);
        }
      } finally {
        accountId = 'owner';
        release();
      }
    });

  it.each(['returned', 'thrown'] as const)('projects native contributed settlement unknown alongside %s handler failure without an invalid terminal snapshot', async kind => {
    const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'unknown-effect' });
    const failure = { ok: false as const, errorCode: 'post_ack_failed', error: 'A later admitted handler step failed' };
    const thrown = Object.assign(new Error(failure.error), { code: failure.errorCode });
    const observed = runtime.observePluginExecution({ actionId: 'external.native-fixture/download', title: 'Download',
      operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } }, input: {},
      execute: async ({ operationOwnerUpdate }) => {
        operationOwnerUpdate?.update({ cancellation: 'unsupported', outcome: { ok: false, errorCode: 'indeterminate', error: 'Receiver completion is unknown' } });
        if (kind === 'thrown') throw thrown;
        return failure;
      } });
    if (kind === 'thrown') await expect(observed).rejects.toBe(thrown);
    else await expect(observed).resolves.toEqual(failure);
    const snapshot = runtime.store.get({ accountId: 'account', machineId: 'machine' }, 'unknown-effect');
    expect(ActionOperationSnapshotV1Schema.parse(snapshot)).toMatchObject({ state: 'running', cancellation: 'unsupported',
      observation: { kind: 'outcome_uncertain', code: failure.errorCode } });
  });
  it.each(['failed', 'cancelled', 'unknown', 'later_handler_failure'] as const)(
    'projects native contributed settlement %s only after the entire handler returns', async scenario => {
      const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
        generateOperationId: () => 'native-effect' });
      let finish!: () => void;
      const handlerFinished = new Promise<void>(resolve => { finish = resolve; });
      let settled!: () => void;
      const nativeSettled = new Promise<void>(resolve => { settled = resolve; });
      const result = await runtime.observePluginExecution({ actionId: 'external.native-fixture/download', title: 'Download',
        operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } }, input: {},
        execute: async ({ operationAcceptance, operationOwnerUpdate }) => {
          operationAcceptance?.accept({ status: 'accepted', operationId: 'native-effect' });
          operationOwnerUpdate?.update({ outcome: scenario === 'later_handler_failure'
            ? { ok: true, result: { success: true, status: 'completed' } }
            : { ok: false, errorCode: scenario === 'unknown' ? 'indeterminate' : scenario === 'cancelled' ? 'cancelled' : 'receiver_refused',
                error: 'Native receiver settlement' } });
          settled();
          await handlerFinished;
          return scenario === 'later_handler_failure'
            ? { ok: false, errorCode: 'post_ack_failed', error: 'A later admitted handler step failed' }
            : { ok: true, result: { success: false, status: scenario } };
        } });
      try {
        expect(result).toMatchObject({ ok: true, result: { status: 'accepted' } });
        await nativeSettled;
        expect(await runtime.handlers.getV2({ operationId: 'native-effect' })).toMatchObject({ kind: 'found', operation: { state: 'running' } });
        finish();
        const final = await runtime.handlers.getV2({ operationId: 'native-effect', waitForTerminal: true });
        expect(final).toMatchObject({ kind: 'found', operation: scenario === 'unknown'
          ? { state: 'running', observation: { kind: 'outcome_uncertain', code: 'indeterminate' } }
          : scenario === 'cancelled' ? { state: 'cancelled' }
            : { state: 'failed', error: { errorCode: scenario === 'later_handler_failure' ? 'post_ack_failed' : 'receiver_refused' } } });
      } finally { finish(); }
    });
  it('withdraws native Stop after known completion without undoing bytes during later handler work', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'completed-effect' });
    let acknowledge!: () => void;
    let finish!: () => void;
    let completed!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    const handlerFinished = new Promise<void>(resolve => { finish = resolve; });
    const nativeCompleted = new Promise<void>(resolve => { completed = resolve; });
    const accepted = await runtime.observePluginExecution({ actionId: 'external.native-fixture/download', title: 'Download',
      operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } }, input: {},
      execute: async ({ operationAcceptance, operationOwnerUpdate, signal }) => {
        operationOwnerUpdate?.update({ cancellation: 'supported' });
        operationAcceptance?.accept({ status: 'accepted', operationId: 'completed-effect' });
        await ack;
        operationOwnerUpdate?.update({ cancellation: 'unsupported', outcome: { ok: true, result: { success: true, status: 'completed' } } });
        completed();
        await handlerFinished;
        expect(signal.aborted).toBe(false);
        return { ok: true, result: { success: true, status: 'completed' } };
      } });
    try {
      expect(accepted).toMatchObject({ ok: true, result: { status: 'accepted' } });
      expect(await runtime.handlers.getV2({ operationId: 'completed-effect' }))
        .toMatchObject({ kind: 'found', operation: { state: 'running', cancellation: 'supported' } });
      acknowledge();
      await nativeCompleted;
      expect(await runtime.handlers.cancel({ operationId: 'completed-effect' })).toEqual({ kind: 'unsupported' });
      finish();
      expect(await runtime.handlers.getV2({ operationId: 'completed-effect', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'succeeded', result: { status: 'completed' } } });
    } finally { acknowledge(); finish(); }
  });
  // Open's native registrar owns observation across direct and relay calls;
  // its composed settlement keeper exercises this same outer adapter.
  it.each(listActionSpecs().filter(spec => spec.operation && spec.id !== 'projects.open' && spec.id !== 'localServices.launcher.start').map(spec => spec.id))(
    'supplies the incumbent runner acceptance to the admitted %s effect', async actionId => {
      const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'requester',
        generateOperationId: () => 'replayed-operation' });
      const result = await runtime.runActionOperation({ actionId, input: {}, context: { actionRequestId: 'original-request' },
        execute: async context => {
          expect(context.operationAcceptance).toMatchObject({ actionId, operationId: 'replayed-operation' });
          // Nested adapters consume that same acceptance instead of opening a second operation.
          return runtime.runActionOperation({ actionId, input: {}, context, execute: async current => {
            expect(current.operationAcceptance).toBe(context.operationAcceptance);
            return { ok: true, result: { completed: true } };
          } });
        } });
      expect(result).toEqual({ ok: true, result: { completed: true } });
      expect(runtime.store.list({ accountId: 'requester', machineId: 'machine' }).items)
        .toMatchObject([{ operationId: 'replayed-operation', actionId, requestId: 'original-request', state: 'succeeded' }]);
      expect(await runtime.runner.waitForTerminal({ accountId: 'requester', machineId: 'machine' }, 'replayed-operation'))
        .toMatchObject({ state: 'succeeded', result: { completed: true } });
    });
  it('offers Stop for machine setup without settling until its process owner observes exit', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'owner', generateOperationId: () => 'setup' });
    let exited!: () => void;
    const exit = new Promise<void>(resolve => { exited = resolve; });
    let stopRequested = false;
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const request = runtime.observeExecution({ actionId: 'machines.setup.apply', input: { homeId: 'home', machineId: 'guest', targets: [{
      homeId: 'home', machineId: 'guest', desiredRevision: 0, recipePlans: [], sources: [
      { kind: 'accountPreset', presetId: 'preset', presetRevision: 1, setup: { scripts: [{ body: 'echo retained', affects: 'none' }],  } },
      { kind: 'direct', setup: {} },
    ] }] },
      actionRequestId: 'setup-request', execute: async ({ signal, operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ state: 'running', domainRef: { kind: 'machineSetup', serverId: 'home', machineId: 'guest', preset: { id: 'preset', revision: 1 }, terminalId: 'actual-terminal' } });
        // Only physical process exit is substituted. Real host runner/store
        // owns the cancellation signal and cannot turn Stop into settlement.
        signal.addEventListener('abort', () => { stopRequested = true; }, { once: true });
        started(); await exit;
        return signal.aborted ? { ok: false, errorCode: 'cancelled', error: 'cancelled' } : { ok: true, result: { operationId: 'setup', terminalId: 'actual-terminal' } };
      } });
    await start;
    try {
      expect(await runtime.handlers.cancel({ operationId: 'setup' })).toEqual({ kind: 'requested' });
      expect(stopRequested).toBe(true);
      expect(await runtime.handlers.getV2({ operationId: 'setup' })).toMatchObject({ kind: 'found', operation: { state: 'running' } });
      exited(); await request;
      expect(await runtime.handlers.getV2({ operationId: 'setup', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
    } finally { exited(); await request; }
  });
  it('does not project an unknown machine setup process outcome as terminal failure', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'owner', generateOperationId: () => 'uncertain-setup' });
    expect(await runtime.observeExecution({ actionId: 'machines.setup.apply', input: {}, actionRequestId: 'setup-request',
      execute: async ({ operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ state: 'running', domainRef: { kind: 'machineSetup', serverId: 'home', machineId: 'guest',
          preset: { id: 'preset', revision: 1 }, terminalId: 'actual-terminal' } });
        // Native terminal supervision is the system boundary. An unavailable
        // exit observation is not proof that the owned process stopped.
        return { ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' };
      } })).toMatchObject({ ok: false, errorCode: 'outcome_uncertain' });
    expect(await runtime.handlers.getV2({ operationId: 'uncertain-setup' })).toMatchObject({ kind: 'found', operation: {
      state: 'running', observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' }, domainRef: { kind: 'machineSetup', terminalId: 'actual-terminal' } } });
  });
  it('keeps ordinary pending Session creation unconfirmed and re-enters its same request with resume-only admission', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'actual-spawn-operation' });
    const nativeModes: Array<boolean | undefined> = [];
    // The native Session creation/nonce transport is the system boundary. The
    // actual Action executor, admission, operation identity and store stay real.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      sessionSpawnNew: async (input): Promise<import('@happier-dev/protocol').SessionSpawnNewResultV1> => {
      nativeModes.push(input.resumeActionRequest);
      return input.resumeActionRequest ? { type: 'success', disposition: 'rejoined', sessionId: 'actual-session',
        executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' } } : { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
    } });
    const input = { executionTarget: { serverId: 'home', machineId: 'guest' }, directory: { kind: 'managed' as const },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } } };
    const invoke = () => runtime.observeExecution({ actionId: 'session.spawn_new', input, actionRequestId: 'original-creation',
      execute: context => executor.execute('session.spawn_new', input, { ...context, surface: 'cli', authority: 'present_user',
        presentUserConfirmation: { actionId: 'session.spawn_new' } }) });
    expect(await invoke()).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'unknown' } });
    const pendingOperation = await runtime.handlers.getV2({ operationId: 'actual-spawn-operation' });
    expect(pendingOperation, JSON.stringify(pendingOperation)).toMatchObject({ kind: 'found', operation: {
      state: 'running', requestId: 'original-creation', domainRef: { kind: 'spawnAttempt', id: 'original-creation' },
      observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' },
    } });
    expect(await invoke()).toMatchObject({ ok: true, result: { type: 'success', disposition: 'rejoined', sessionId: 'actual-session' } });
    expect(nativeModes).toEqual([undefined, true]);
    expect(await runtime.handlers.getV2({ operationId: 'actual-spawn-operation' })).toMatchObject({ kind: 'found', operation: {
      state: 'succeeded', result: { type: 'success', sessionId: 'actual-session' },
    } });
    expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'actual-spawn-operation'))
      .not.toHaveProperty('observation');
  });
  it.each(['opted', 'terminal'] as const)('selects committed Session acceptance separately for every observer when the first caller is %s', async first => {
    const runtime = createHostActionOperationRuntime({ serverId: 'home', machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'committed-spawn-operation' });
    const input = { creationKey: 'committed-creation', executionTarget: { serverId: 'home', machineId: 'guest' },
      directory: { kind: 'managed' as const }, agentTarget: { kind: 'agent' as const,
        identity: { pluginId: 'acme.agent', localId: 'coding' } }, initialInput: { text: 'One owned input' } };
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    let accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    let executions = 0;
    let admissions = 0;
    const execute: Parameters<typeof runtime.observeExecution>[0]['execute'] = async ({ operationAcceptance }) => {
      executions += 1;
      operationAcceptance!.accept({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted', sessionId: 'created-session' });
      accepted();
      await completion;
      admissions += 1;
      return { ok: true, result: { type: 'success', disposition: 'created', sessionId: 'created-session',
        executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'accepted', localId: 'original-owned-input' } } };
    };
    const observed: Record<string, unknown> = {};
    const invoke = (name: string, opted: boolean) => runtime.observeExecution({ actionId: 'session.spawn_new',
      input: { ...input, ...(opted ? { observeSessionCommit: true } : {}) }, actionRequestId: input.creationKey,
      execute }).then(value => { observed[name] = value; return value; });
    const original = invoke('first', first === 'opted');
    try {
      await acceptance;
      const terminal = invoke('terminal', false);
      const opted = invoke('opted', true);
      // Drain only the in-process promise chain: no periodic operation reads.
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(observed.opted).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'accepted',
        sessionId: 'created-session', operation: { serverId: 'home', machineId: 'guest', operationId: 'committed-spawn-operation' } } });
      const receipt = observed.opted;
      if (!receipt || typeof receipt !== 'object') throw new Error('Expected committed receipt');
      expect(preObservationSpawnResult.safeParse(Reflect.get(receipt, 'result')).success).toBe(false);
      expect(observed).not.toHaveProperty('terminal');
      if (first === 'terminal') expect(observed).not.toHaveProperty('first');
      expect(executions).toBe(1);
      expect(admissions).toBe(0);
      expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'committed-spawn-operation')).toMatchObject({ state: 'running' });
      release();
      await expect(terminal).resolves.toMatchObject({ ok: true, result: { type: 'success',
        initialInput: { status: 'accepted', localId: 'original-owned-input' } } });
      const legacyResult = await terminal;
      if (!legacyResult.ok) throw new Error('Expected legacy terminal result');
      expect(preObservationSpawnResult.parse(legacyResult.result)).toMatchObject({ type: 'success', sessionId: 'created-session' });
      await opted;
      await original;
      expect(admissions).toBe(1);
      expect(executions).toBe(1);
    } finally { release(); await original; }
  });
  it('keeps one keyed Session creation call attached after acceptance until its operation settles', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'settling-spawn-operation' });
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    let accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    let returned = false;
    const request = runtime.observeExecution({ actionId: 'session.spawn_new', input: {}, actionRequestId: 'one-call-creation',
      execute: async ({ operationAcceptance }) => {
        operationAcceptance!.accept({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' });
        accepted();
        await completion;
        return { ok: true as const, result: { type: 'success' as const, disposition: 'created' as const,
          sessionId: 'created-session', executionTarget: { serverId: 'home', machineId: 'guest' },
          organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' as const } } };
      } }).then(result => { returned = true; return result; });

    await acceptance;
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'settling-spawn-operation'))
      .toMatchObject({ state: 'running', requestId: 'one-call-creation' });

    release();
    await expect(request).resolves.toMatchObject({ ok: true, result: {
      type: 'success', disposition: 'created', sessionId: 'created-session',
    } });
    expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'settling-spawn-operation'))
      .toMatchObject({ state: 'succeeded', result: { type: 'success', sessionId: 'created-session' } });
  });
  it('propagates a terminal-only pre-acceptance failure without creating an orphan rejected observer', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'precommit-failure' });
    const failure = new Error('Home commit refused');
    const unhandled: unknown[] = [];
    const observeRejection = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', observeRejection);
    try {
      await expect(runtime.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'refused-before-commit' },
        execute: async () => { throw failure; } })).rejects.toBe(failure);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'precommit-failure')).toMatchObject({ state: 'failed' });
    } finally { process.removeListener('unhandledRejection', observeRejection); }
  });
  it.each(['agent_isolation_unavailable', 'provider.launch.refusal.'.repeat(12)])(
    'returns a terminal Session creation refusal after acceptance instead of swallowing it as pending (%s)', async cause => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'refused-spawn-operation' });
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    let accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    const refusal = { type: 'error' as const, code: 'spawn_failed' as const, retryable: false,
      launchError: { kind: 'launch_error' as const, code: cause, message: cause } };
    let executions = 0;
    const request = runtime.observeExecution({ actionId: 'session.spawn_new', input: {}, actionRequestId: 'refused-creation',
      execute: async ({ operationAcceptance }) => {
        executions++;
        operationAcceptance!.accept({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' });
        accepted();
        await completion;
        return { ok: true as const, result: refusal };
      } });

    await acceptance;
    release();
    await expect(request).resolves.toEqual({ ok: true, result: refusal });
    expect(await runtime.handlers.getV2({ operationId: 'refused-spawn-operation' }))
      .toMatchObject({ kind: 'found', operation: { state: 'failed',
        error: { errorCode: 'spawn_failed' }, result: refusal } });
    expect(await runtime.observeExecution({ actionId: 'session.spawn_new', input: {}, actionRequestId: 'refused-creation',
      execute: async () => { executions++; return { ok: true, result: refusal }; } }))
      .toEqual({ ok: true, result: refusal });
    expect(executions, 'A non-retryable refusal is observed without another launch').toBe(1);
  });
  it('releases an aborted Session creation waiter without cancelling or duplicating its keyed operation', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'detached-spawn-operation' });
    const caller = new AbortController();
    const disconnect = new Error('caller disconnected');
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    let accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    let executions = 0;
    const execute = async ({ operationAcceptance }: Parameters<Parameters<typeof runtime.observeExecution>[0]['execute']>[0]) => {
      executions += 1;
      operationAcceptance!.accept({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' });
      accepted();
      await completion;
      return { ok: true as const, result: { type: 'success' as const, disposition: 'created' as const,
        sessionId: 'created-session', executionTarget: { serverId: 'home', machineId: 'guest' },
        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' as const } } };
    };
    const input = { creationKey: 'detached-creation' };
    const request = runtime.observeExecution({ actionId: 'session.spawn_new', input,
      actionRequestId: input.creationKey, rpcContext: { signal: caller.signal }, execute });
    let detached = false;
    void request.catch(() => { detached = true; });
    try {
      await acceptance;
      caller.abort(disconnect);
      await vi.waitFor(() => expect(detached).toBe(true));
      await expect(request).rejects.toBe(disconnect);
      expect(runtime.store.get({ accountId: 'requester', machineId: 'guest' }, 'detached-spawn-operation'))
        .toMatchObject({ state: 'running', requestId: input.creationKey });

      const retry = runtime.observeExecution({ actionId: 'session.spawn_new', input,
        actionRequestId: input.creationKey, execute });
      release();
      await expect(retry).resolves.toMatchObject({ ok: true, result: {
        type: 'success', disposition: 'created', sessionId: 'created-session',
      } });
      expect(executions).toBe(1);
    } finally {
      release();
      await request.catch(() => undefined);
    }
  });
  it('retries a Discussion birth after HTTP 503 through the same ordinary creator instead of replaying its failed result forever', async () => {
    let operationSequence = 0;
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'owner',
      generateOperationId: () => `discussion-birth-operation-${++operationSequence}` });
    const input = { creationKey: 'participant-slot', executionTarget: { serverId: 'home', machineId: 'guest' },
      directory: { kind: 'managed' as const },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      discussionParticipant: { discussionId: 'discussion', participantSlotId: 'participant-slot' }, initialTriggers: [],
      connectedServices: { v: 2 as const, bindingsByServiceId: {} }, memoryEnabled: false };
    let available = false;
    let committed: Record<string, unknown> | null = null;
    let nativeStarts = 0;
    const creationTags: string[] = [];
    resetServerFeaturesClientForTests();
    // HTTP and the native machine transport are the only replaced boundaries;
    // Action admission, operation custody, birth metadata and creator stay real.
    vi.stubGlobal('fetch', vi.fn(async value => String(value).endsWith('/v1/features')
      ? Response.json({ features: {}, capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })
      : Response.json({ id: 'owner' })));
    vi.spyOn(axios, 'get').mockImplementation(async url => String(url).includes('/v1/access-keys/')
      ? { status: 200, data: { accessKey: 'existing' } }
      : { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: committed ? [committed] : [] } };
      if (!String(url).endsWith('/v1/sessions')) throw new Error(`Unexpected birth HTTP request ${url}`);
      const body = raw as ReturnType<typeof buildSessionMetadataEnvelopeCreateFields> & { tag: string };
      creationTags.push(body.tag);
      if (!available) return { status: 503, data: { error: 'database_transaction_conflict_exhausted' } };
      expect(committed).toBeNull();
      committed = { id: 'backing-session', seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        metadataLayoutVersion: body.metadataLayoutVersion, metadata: body.sharedMetadata.ciphertext,
        ownerMetadata: body.ownerMetadata, metadataVersion: 1, encryptionMode: 'plain',
        agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null };
      return { status: 200, data: { session: committed, created: true } };
    });
    try {
      const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
        sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {}, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
        sessionSpawnDirectTargetTransport: { machineId: 'guest',
          prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'managed', directoryCreationRequired: false, checkout: null }),
          spawnedSession: { spawn: async request => {
            expect(committed).not.toBeNull();
            expect(request).toMatchObject({ existingSessionId: 'backing-session' });
            expect(request).not.toHaveProperty('pendingFirstInput');
            nativeStarts++;
            return { type: 'success', sessionId: 'backing-session' };
          }, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
        } }));
      const invoke = (value = input) => runtime.observeExecution({ actionId: 'session.spawn_new', input: value,
        actionRequestId: input.creationKey, execute: context => executor.execute('session.spawn_new', value,
          { ...context, surface: 'cli', authority: 'present_user', serverId: 'home', presentUserConfirmation: { actionId: 'session.spawn_new' } }) });
      expect(await invoke()).toMatchObject({ ok: true, result: { type: 'error', code: 'spawn_failed', retryable: true,
        launchError: { message: 'Unexpected status from /v1/sessions: 503' } } });
      expect(committed).toBeNull();
      expect(nativeStarts).toBe(0);
      expect(creationTags).toHaveLength(1);
      const firstReceipt = runtime.store.get({ accountId: 'owner', machineId: 'guest' }, 'discussion-birth-operation-1');
      expect(firstReceipt).toMatchObject({ state: 'failed', result: { type: 'error', retryable: true } });
      expect(await invoke({ ...input, memoryEnabled: true })).toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
      expect(creationTags).toHaveLength(1);
      available = true;
      const completed = await invoke();
      expect(completed).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'backing-session' } });
      expect(creationTags).toHaveLength(2);
      expect(new Set(creationTags).size).toBe(1);
      expect(nativeStarts).toBe(1);
      expect(await invoke()).toEqual(completed);
      expect(creationTags).toHaveLength(2);
      expect(nativeStarts).toBe(1);
      expect(runtime.store.get({ accountId: 'owner', machineId: 'guest' }, 'discussion-birth-operation-1')).toEqual(firstReceipt);
      expect(runtime.store.list({ accountId: 'owner', machineId: 'guest' }).items).toHaveLength(2);
    } finally {
      vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests();
    }
  });
  it('explicitly retries ordinary creation failures with the same native nonce without replaying the failed receipt', async () => {
    let operationSequence = 0;
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'owner',
      generateOperationId: () => `ordinary-birth-operation-${++operationSequence}` });
    const input = { creationKey: 'ordinary-creation', executionTarget: { serverId: 'home', machineId: 'guest' },
      directory: { kind: 'managed' as const },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      initialTriggers: [], connectedServices: { v: 2 as const, bindingsByServiceId: {} }, memoryEnabled: false };
    const credentials = { token: 'token', encryption: null } as const;
    const coalescer = createSpawnRequestCoalescer();
    let committed: ReturnType<typeof createCurrentSessionProjectionRecordFixture> | null = null;
    let nativeStarts = 0;
    const nativeAdmissions: Array<{ tag: string | undefined; nonce: string | undefined }> = [];
    resetServerFeaturesClientForTests();
    // The native machine adapter and HTTP are genuine boundaries. The ordinary
    // Action creator and daemon's existing nonce coalescer are not substituted.
    vi.stubGlobal('fetch', vi.fn(async value => String(value).endsWith('/v1/features')
      ? Response.json({ features: {}, capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })
      : Response.json({ id: 'owner' })));
    vi.spyOn(axios, 'get').mockImplementation(async url => String(url).includes('/v2/sessions/')
      ? { status: 200, data: { session: committed } }
      : { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } });
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: committed ? [committed] : [] } };
      throw new Error(`Unexpected ordinary birth HTTP request ${url}`);
    });
    try {
      const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials,
        sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {}, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
        sessionSpawnDirectTargetTransport: { machineId: 'guest',
          prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'managed', directoryCreationRequired: false, checkout: null }),
          spawnedSession: { spawn: request => coalescer.run(computeDaemonSpawnRequestKey(request), async () => {
            nativeAdmissions.push({ tag: request.sessionCreationTag, nonce: request.spawnNonce });
            if (nativeAdmissions.length === 1) return { type: 'error', errorCode: 'SPAWN_FAILED',
              errorMessage: 'Unexpected status from /v1/sessions: 503' };
            expect(committed).toBeNull();
            const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'plain',
              storedContentMode: 'plain', agentState: null,
              metadata: buildCommittedLaunchMetadata({ options: request, directory: '/repo' }) });
            committed = createCurrentSessionProjectionRecordFixture({ id: 'ordinary-session', encryptionMode: 'plain', share: null,
              effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
              metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
              ownerMetadata: fields.ownerMetadata, dataEncryptionKey: null });
            nativeStarts++;
            return { type: 'success', sessionId: committed.id, sessionCreationOutcome: {
              disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
          }), resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
        } }));
      const invoke = () => runtime.observeExecution({ actionId: 'session.spawn_new', input, actionRequestId: input.creationKey,
        execute: context => executor.execute('session.spawn_new', input, { ...context, surface: 'cli', authority: 'present_user',
          serverId: 'home', presentUserConfirmation: { actionId: 'session.spawn_new' } }) });
      expect(await invoke()).toMatchObject({ ok: true, result: { type: 'error', code: 'spawn_failed', retryable: true } });
      expect(nativeStarts).toBe(0);
      const completed = await invoke();
      expect(completed).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'ordinary-session' } });
      expect(nativeAdmissions).toHaveLength(2);
      expect(nativeAdmissions[0]?.nonce).toBeTruthy();
      expect(nativeAdmissions[1]).toEqual(nativeAdmissions[0]);
      expect(await invoke()).toEqual(completed);
      expect(nativeAdmissions).toHaveLength(2);
      expect(nativeStarts).toBe(1);
    } finally {
      vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests();
    }
  });
  it('rejoins the same CLI creation after selection timestamps refresh, while refusing changed launch values', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'requester',
      generateOperationId: () => 'same-cli-spawn' });
    const nativeModes: Array<boolean | undefined> = [];
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      sessionSpawnNew: async input => {
        nativeModes.push(input.resumeActionRequest);
        return input.resumeActionRequest ? { type: 'success', disposition: 'rejoined', sessionId: 'original-session',
          executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
          initialInput: { status: 'notRequested' } } : { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
      } });
    const normalize = async (now: number, modelId = 'gpt-6-luna', effort = 'low') =>
      (await normalizeSessionCreateSpawnRequest({ directory: '/workspace', backendTargetKey: null, modelId,
        configOptions: { reasoning_effort: effort }, initialInput: { text: 'Reply once' } }, {
        activeServerId: 'home', defaultAgentId: 'codex', readSettings: async () => ({ machineId: 'guest' }),
        readAgentDefinitions: () => readAgentCatalogSnapshot().agentDefinitionsById.values(),
        now: () => now,
      })).input;
    const invoke = (input: Awaited<ReturnType<typeof normalize>>) => runtime.observeExecution({ actionId: 'session.spawn_new',
      input, actionRequestId: 'original-attempt', execute: context => executor.execute('session.spawn_new', input,
        { ...context, surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'session.spawn_new' } }) });
    const original = await normalize(100);
    expect(await invoke(original)).toMatchObject({ ok: true, result: { type: 'pending' } });
    const settled = await invoke(await normalize(200));
    expect(settled).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'original-session' } });
    expect(await invoke(await normalize(300))).toEqual(settled);
    for (const changed of [await normalize(400, 'other-model'), await normalize(400, 'gpt-6-luna', 'high'),
      { ...await normalize(400), initialInput: { text: 'Different prompt' } }]) {
      expect(await invoke(changed)).toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    }
    expect(nativeModes).toEqual([undefined, true]);
    expect(original.modelSelection?.updatedAt).toBe(100);
    expect(original.configuration?.options.reasoning_effort).toEqual({ value: 'low', updatedAtMs: 100 });
  });
  it.each(['machines.managed.acquire', 'machines.managed.bootstrap.retry'] as const)('keeps %s linked to its managed row and cancels the containing admitted lifetime', async actionId => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
      generateOperationId: () => 'managed-start' });
    let release!: () => void;
    const boundary = new Promise<void>(resolve => { release = resolve; });
    let aborted = false;
    await runtime.observeExecution({ actionId, input: { managedId: 'managed' }, actionRequestId: 'request',
      execute: async ({ signal, operationAcceptance, operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: 'managed' } });
        operationAcceptance?.accept({ managedId: 'managed', operation: { operationId: 'managed-start' } });
        operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: 'managed',
          bootstrapTask: { id: 'actual-task', taskKind: 'remote.ssh.bootstrapMachine.v1' } } });
        // Native completion is the system boundary. The actual runner/store
        // remains alive after acceptance and owns the public Stop signal.
        signal.addEventListener('abort', () => { aborted = true; release(); }, { once: true });
        await boundary;
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    try {
      expect(await runtime.handlers.getV2({ operationId: 'managed-start' })).toMatchObject({ kind: 'found', operation: {
        domainRef: { kind: 'managedMachine', id: 'managed', bootstrapTask: { id: 'actual-task' } }, cancellation: 'supported',
      } });
      expect(await runtime.handlers.cancel({ operationId: 'managed-start' })).toEqual({ kind: 'requested' });
      expect(aborted).toBe(true);
      expect(await runtime.handlers.getV2({ operationId: 'managed-start', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'cancelled', domainRef: { kind: 'managedMachine', id: 'managed' } } });
    } finally { release(); }
  });
  it.each(['machines.managed.power.set', 'machines.managed.delete'] as const)('cancels the actual accepted %s idle observer through its containing Action signal', async actionId => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
      generateOperationId: () => 'managed-idle' });
    let release!: () => void;
    let aborted = false;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    await runtime.observeExecution({ actionId, input: { when: 'after-idle' }, actionRequestId: 'intent',
      execute: async ({ signal, operationAcceptance, operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ progress: { phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine' } });
        operationAcceptance?.accept({ kind: 'accepted', managedId: 'managed', intentRevision: 1,
          operation: { operationId: 'managed-idle' } });
        signal.addEventListener('abort', () => { aborted = true; release(); }, { once: true });
        await waiting;
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    try {
      expect(await runtime.handlers.cancel({ operationId: 'managed-idle' })).toEqual({ kind: 'requested' });
      expect(aborted).toBe(true);
      expect(await runtime.handlers.get({ operationId: 'managed-idle', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
    } finally { release(); }
  });
  it('attributes the canonical Action RPC observation to the verified requester, not the custodian', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => 'custodian',
      custodyBinding: { serverId: 'home', installationId: 'installation' },
      generateOperationId: () => 'transported-operation' });
    const keys = tweetnacl.sign.keyPair();
    // Only the signed Home HTTP verifier is substituted; dispatch and the
    // actual CLI executor retain their ordinary unavailable-target behavior.
    const network = vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: 200,
      data: { v: 1, ok: true }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } }));
    try {
      const rpc = new RpcHandlerManager({ scopePrefix: 'worker', encryptionMode: 'plain',
        authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'worker',
          resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation',
          verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
            privateKey: keys.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }) }),
      });
      const spec = getActionSpec('projects.script.run');
      registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionSpecs: [spec],
        actionExecutor: createActionExecutor(createCliActionDeps({ token: '', sessionId: '', mode: 'plain', ctx: null })),
        observeExecution: runtime.observeExecution });
      await rpc.handleRequest({ method: `worker:${spec.bindings!.rpcMethod}`, params: {
        workspace: { serverId: 'home', machineId: 'worker', workspaceId: 'workspace', rootPath: '/project' },
        selection: { kind: 'named', name: 'build' },
      }, machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'custodian', machineId: 'worker',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' } });
      expect(runtime.store.get({ accountId: 'guest', machineId: 'worker' }, 'transported-operation'))
        .toMatchObject({ scope: { accountId: 'guest', machineId: 'worker' } });
      expect(runtime.store.get({ accountId: 'custodian', machineId: 'worker' }, 'transported-operation')).toBeNull();
    } finally { network.mockRestore(); }
  });
  it('owns a transported operation by its verified actor and admits a held read once per request', async () => {
    expect(getActionSpec('projects.script.run').operation).toBeDefined();
    let activeAccountId = 'custodian';
    const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => activeAccountId,
      custodyBinding: { serverId: 'home', installationId: 'installation' },
      generateOperationId: () => 'guest-operation' });
    const keys = tweetnacl.sign.keyPair();
    let current = true;
    let release!: () => void;
    const exit = new Promise<void>(resolve => { release = resolve; });
    // The HTTP access verifier and process-exit notification are genuine boundaries.
    const network = vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: current ? 200 : 403,
      data: current ? { v: 1, ok: true } : { code: 'access_denied' }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } }));
    try {
      const rpc = new RpcHandlerManager({ scopePrefix: 'worker', encryptionMode: 'plain',
        authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'worker',
          resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation',
          verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
            privateKey: keys.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }) }),
      });
      registerActionOperationRpcHandlers(rpc, runtime.handlers);
      rpc.registerHandler('execute-project', async (input: unknown, context?: RpcHandlerContext) => runtime.observeExecution({
        actionId: 'projects.script.run', input, rpcContext: context, execute: async operation => {
          operation.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
            machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' } });
          await exit;
          return { ok: true, result: { privateResult: 'guest-only' } };
        },
      }));
      const machineAdmission = { actorAccountId: 'guest', custodianAccountId: 'custodian', machineId: 'worker',
        installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
      const call = (method: string, params: unknown) => rpc.handleRequest({ method: `worker:${method}`, params, machineAdmission });
      expect(await call('execute-project', { accountId: 'custodian' })).toMatchObject({ ok: true, result: {
        operation: { scope: { accountId: 'guest', machineId: 'worker' }, state: 'accepted' },
      } });
      expect(runtime.store.get({ accountId: 'custodian', machineId: 'worker' }, 'guest-operation')).toBeNull();
      expect((await runtime.activity.read()).items).toContainEqual(expect.objectContaining({ ownerRef: 'guest-operation',
        attribution: { serverId: 'home', accountId: 'guest', machineId: 'worker', installationId: 'installation' },
      }));
      const beforeWait = network.mock.calls.length;
      const waiting = call(ACTION_OPERATION_RPC_METHODS_V1.get, { operationId: 'guest-operation', waitForTerminal: true });
      // Let the admitted long observation reach its real retained invocation before revocation.
      await vi.waitFor(() => expect(rpc.getActiveHandlerExecutions()).toContainEqual(expect.objectContaining({
        method: ACTION_OPERATION_RPC_METHODS_V1.get,
      })));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(network.mock.calls.length - beforeWait).toBe(1);
      activeAccountId = 'different-account';
      current = false;
      release();
      expect(await waiting).toMatchObject({ kind: 'found', operation: { state: 'succeeded', scope: { accountId: 'guest' } } });
      expect(network.mock.calls.length - beforeWait).toBe(1);
      const beforeDenied = network.mock.calls.length;
      expect(await call(ACTION_OPERATION_RPC_METHODS_V1.get, { operationId: 'guest-operation' }))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(network.mock.calls.length - beforeDenied).toBe(1);
      expect(runtime.store.get({ accountId: 'guest', machineId: 'worker' }, 'guest-operation')).toMatchObject({ state: 'succeeded' });
      expect(runtime.store.readRequesterWorkAttribution('guest-operation')).toEqual({ serverId: 'home', accountId: 'guest',
        machineId: 'worker', installationId: 'installation' });
      expect(runtime.store.get({ accountId: 'different-account', machineId: 'worker' }, 'guest-operation')).toBeNull();
    } finally { release(); network.mockRestore(); }
  });
  it('retries the same unconfirmed live process Stop and settles only after its observed exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-repeated-stop-'));
    const exits = new Set<(exit: PtyExitEvent) => void>();
    const process: PtyProcess = { pid: 12345, ownedProcessGroupId: 12345, write() {}, resize() {}, kill() {},
      onData: () => ({ dispose() {} }),
      onExit: listener => { exits.add(listener); return { dispose: () => exits.delete(listener) }; } };
    let attempts = 0;
    const terminals = createTerminalPtySessionManager({ ptyProvider: { spawn: () => process }, env: {}, platform: 'linux',
      probeProcessGroup: () => 'absent',
      stopProcessTree: async () => { attempts++; if (attempts === 1) throw new Error('OS tree Stop unconfirmed'); },
      config: { bufferMaxBytes: 100000, bufferMaxEvents: 1000,
        urlParseBufferLimit: 32768, maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 } });
    try {
      const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => 'account',
        generateOperationId: () => 'repeat-stop' });
      await runtime.observeExecution({ actionId: 'projects.compute.exec', input: {}, execute: async operation => {
        const launch = await authorizeResolvedProjectExecLaunchForHost({ launch: { command: '/managed/process', args: [], cwd: root, env: {} },
          signal: operation.signal, assertCurrent: () => undefined,
          projectLaunch: { status: 'ready', reviewedEffectDigest: 'reviewed', toolchain: {
            selection: { kind: 'host' }, root, platform: 'linux', io: { resolveTool: async () => null,
              run: async () => { throw new Error('Host environment never evaluates a native tool'); } } } } });
        try { return (await executeProjectFiniteProcess({ workspace: { id: 'workspace', serverId: 'home', machineId: 'worker',
          rootPath: root, createdAtMs: 1 }, purpose: 'exec', requesterAccountId: 'account', operation, terminalSessions: terminals, launch })).result; }
        finally { launch.release(); }
      } });
      expect(await runtime.handlers.cancel({ operationId: 'repeat-stop' })).toEqual({ kind: 'requested' });
      await expect.poll(() => runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')?.observation)
        .toMatchObject({ kind: 'stop_unconfirmed' });
      expect(runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')).toMatchObject({ state: 'running' });
      expect(await runtime.handlers.cancel({ operationId: 'repeat-stop' })).toEqual({ kind: 'requested' });
      await expect.poll(() => attempts).toBe(2);
      expect(runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')).not.toHaveProperty('settledAt');
      for (const exit of exits) exit({ exitCode: 0, signal: 0 });
      // An outstanding stop_unconfirmed observation makes public wait return
      // early; wait for the real process owner to consume its exit first.
      await expect.poll(() => runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')?.state)
        .toBe('cancelled');
      expect(await runtime.handlers.get({ operationId: 'repeat-stop', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
      expect(runtime.store.get({ accountId: 'account', machineId: 'worker' }, 'repeat-stop')).not.toHaveProperty('observation');
    } finally { terminals.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it('keeps a managed bootstrap task discoverable after acceptance while its native task remains running', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
      generateOperationId: () => 'managed' });
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    await expect(runtime.observeExecution({ actionId: 'machines.managed.acquire', input: {}, actionRequestId: 'request',
      execute: async ({ operationAcceptance, operationOwnerUpdate }) => {
        operationOwnerUpdate.update({ domainRef: { kind: 'systemTask', id: 'task', taskKind: 'remote.ssh.bootstrapMachine.v1' } });
        operationAcceptance?.accept({ managedId: 'machine', operation: { operationId: 'managed' } });
        await pending;
        return { ok: true, result: { managedId: 'machine', operation: { operationId: 'managed' } } };
      },
    })).resolves.toMatchObject({ ok: true, result: { managedId: 'machine' } });
    const acceptedOperation = await runtime.handlers.getV2({ operationId: 'managed' });
    expect(acceptedOperation, JSON.stringify(acceptedOperation)).toMatchObject({ kind: 'found', operation: {
      state: 'running', scope: { accountId: 'account', machineId: 'controller' },
      domainRef: { kind: 'systemTask', id: 'task', taskKind: 'remote.ssh.bootstrapMachine.v1' },
    } });
    settle();
    expect(await runtime.handlers.get({ operationId: 'managed', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
  });
  it('routes relocation cancellation to its supported owner without settling an unknown native start', async () => {
    const runtime = createHostActionOperationRuntime({ machineId: 'source', resolveAccountId: async () => 'account',
      generateOperationId: () => 'move', supportsCoreCancellation: actionId => actionId === 'projects.service.relocate' });
    const request = runtime.observeExecution({ actionId: 'projects.service.relocate', input: { requestId: 'move-1' },
      execute: async ({ signal, operationAcceptance }) => {
        operationAcceptance?.accept({ status: 'accepted', operationId: 'move' });
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { ok: false, errorCode: 'outcome_uncertain', error: 'native start is unknown' };
      },
    });
    await expect(request).resolves.toMatchObject({ ok: true });
    expect(await runtime.handlers.cancel({ operationId: 'move' })).toEqual({ kind: 'requested' });
    expect(await runtime.handlers.getV2({ operationId: 'move', waitForTerminal: true }))
      .toMatchObject({ kind: 'found', operation: { state: 'running', cancellation: 'unsupported',
        observation: { kind: 'outcome_uncertain' } } });
    expect(await runtime.handlers.cancel({ operationId: 'move' })).toEqual({ kind: 'unsupported' });
  });
  it('offers Stop for a finite producer and settles only its observed cancelled process', async () => {
    expect(getActionSpec('projects.script.run').operation).toBeDefined();
    const runtime = createHostActionOperationRuntime({ machineId: 'worker', resolveAccountId: async () => 'account',
      generateOperationId: () => 'finite' });
    let processCancelled = false;
    const reply = await runtime.observeExecution({ actionId: 'projects.script.run', input: {}, actionRequestId: 'request',
      execute: async ({ operationOwnerUpdate, signal }) => {
        operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
          machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' } });
        await new Promise<void>(resolve => signal.addEventListener('abort', () => { processCancelled = true; resolve(); }, { once: true }));
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    expect(reply).toMatchObject({ ok: true, result: { operation: { state: 'accepted', cancellation: 'supported' } } });
    expect(processCancelled).toBe(false);
    expect(await runtime.handlers.cancel({ operationId: 'finite' })).toEqual({ kind: 'requested' });
    const cancelledOperation = await runtime.handlers.getV2({ operationId: 'finite', waitForTerminal: true });
    expect(cancelledOperation, JSON.stringify(cancelledOperation))
      .toMatchObject({ kind: 'found', operation: { state: 'cancelled', domainRef: { kind: 'projectCommand' } } });
  });
});
