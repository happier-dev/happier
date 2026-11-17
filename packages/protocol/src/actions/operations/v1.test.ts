import { describe, expect, it } from 'vitest';
import { DeploymentDomainCaddyFailureDetailsV1Schema } from '../../deployments/deploymentDomainCaddyFailureV1.js';
import { ManagedControllerRequestFailureDetailsV1Schema } from './v1.js';

it('retains the exact bound Setup report path while rejecting URL, query and credential-bearing diagnostic paths', () => {
  const failure = { kind: 'managedControllerRequest', category: 'transport', path: '/v1/machines/setup/report' };
  expect(ManagedControllerRequestFailureDetailsV1Schema.parse(failure)).toEqual(failure);
  for (const path of ['https://home.example/v1/machines/setup/report', '/v1/machines/setup/report?token=secret', '/v1/machines/setup/credentials']) {
    expect(ManagedControllerRequestFailureDetailsV1Schema.safeParse({ ...failure, path }).success).toBe(false);
  }
});

import {
  ACTION_OPERATION_RPC_METHODS_V1,
  ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1,
  ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1,
  ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1,
  ActionOperationDeclarationV1Schema,
  ActionOperationProgressV1Schema,
  ActionOperationDomainRefV1Schema,
  ActionOperationSnapshotV1Schema,
  ActionOperationFailureV1Schema,
  ActionOperationCancelV1RequestSchema,
  ActionOperationCancelV1ResponseSchema,
  ActionOperationGetV1RequestSchema,
  ActionOperationGetV2RequestSchema,
  ActionOperationGetV1ResponseSchema,
  ActionOperationListV1RequestSchema,
  ActionOperationListV2RequestSchema,
  ActionOperationListV1ResponseSchema,
  ActionOperationSnapshotPushV1Schema,
  projectActionOperationSnapshotForV1Reader,
  readActionOperationTerminalResultV1,
  projectActionOperationListSnapshotV1,
  projectDeploymentBackupFailureResultV1,
} from './v1.js';

const baseSnapshot = {
  version: 1,
  operationId: 'operation-1',
  revision: 1,
  actionId: 'session.spawn_new',
  state: 'accepted',
  scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
  title: 'Create session',
  createdAt: 100,
  cancellation: 'unsupported',
} as const;

describe('Action operation v1 contract', () => {
  it('carries the pending SSH trust question on an admitted standalone task without a managed Machine', () => {
    const domainRef = { kind: 'systemTask', id: 'prepare-trust', taskKind: 'remote.ssh.bootstrapMachine.v1',
      prompt: { kind: 'ssh.trustHost', message: 'Trust this guest?', host: '192.168.64.7', keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:guest', existingFingerprint: null } };
    expect(ActionOperationDomainRefV1Schema.parse(domainRef)).toEqual(domainRef);
  });
  it('retains the closed native Caddy observation through the public failed operation reader', () => {
    const details = DeploymentDomainCaddyFailureDetailsV1Schema.parse({ requiredFact: 'caddyContainer',
      failure: { kind: 'native_observation_unavailable', reason: 'required_fact_unavailable',
        requiredFact: 'caddyContainer', errorCode: 'ENOENT' },
      remedy: 'Restore access to the selected Docker engine and inspect owned Caddy.' });
    const error = { errorCode: 'required_fact_unavailable', error: 'required_fact_unavailable', effectAttempted: false, details };
    const wire = { ...baseSnapshot, actionId: 'machines.reachability.inspect', state: 'failed', startedAt: 110, settledAt: 120, error };
    const projected = ActionOperationGetV1ResponseSchema.parse(JSON.parse(JSON.stringify({ kind: 'found', operation: wire })));
    expect(projected).toMatchObject({ kind: 'found', operation: { error } });
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, errorCode: 'native_effect_failed' }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error,
      details: { ...details, stderr: 'PRIVATE_NATIVE_OUTPUT' } }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error,
      details: { ...details, failure: { ...details.failure, errorCode: 'PRIVATE_NATIVE_OUTPUT' } } }).success).toBe(false);
    const effectDetails = { ...details, failure: { ...details.failure, kind: 'native_effect_failed' } };
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, details: effectDetails }).success).toBe(true);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, errorCode: 'native_effect_failed', details: effectDetails }).success).toBe(false);
  });

  it.each(['distinctAdministrator', 'administratorSudoToRoot'])('retains the closed Ask CHECK refusal for %s in serialized Activity', requiredFact => {
    const failure = { kind: 'native_check_unavailable', reason: 'required_fact_unavailable', phase: 'check', requiredFact,
      remedy: 'Choose a distinct administrator with existing native sudo access.' };
    const details = { failure, remedy: failure.remedy };
    const error = { errorCode: failure.kind, error: failure.kind, details };
    const wire = { ...baseSnapshot, actionId: 'machines.reachability.inspect', state: 'failed', startedAt: 110, settledAt: 120, error };
    expect(ActionOperationGetV1ResponseSchema.parse(JSON.parse(JSON.stringify({ kind: 'found', operation: wire }))))
      .toMatchObject({ kind: 'found', operation: { error } });
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, errorCode: 'native_effect_failed' }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, errorCode: failure.reason }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error,
      details: { ...details, stderr: 'PRIVATE_NATIVE_OUTPUT' } }).success).toBe(false);
  });

  it('retains content-free finite command failure facts in V2 and omits them for V1 readers', () => {
    const details = { kind: 'finiteCommand', phase: 'setup', step: 1, exitCode: 23, signal: 0 };
    const snapshot = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.setup.apply',
      actor: { actorKind: 'agent', sessionId: 'requesting-session', onBehalfOf: { serverId: 'requester-home', accountId: 'requester' } },
      state: 'failed', startedAt: 110, settledAt: 120,
      error: { errorCode: 'machine_setup_setup_failed', error: 'machine_setup_setup_failed', details } });
    expect(ActionOperationSnapshotV1Schema.parse(JSON.parse(JSON.stringify(snapshot))).error?.details).toEqual(details);
    const current = ActionOperationGetV1ResponseSchema.parse(JSON.parse(JSON.stringify({ kind: 'found', operation: snapshot })));
    expect(current).toMatchObject({ kind: 'found', operation: { actor: snapshot.actor } });
    const predecessor = projectActionOperationSnapshotForV1Reader(snapshot);
    expect(predecessor).not.toHaveProperty('actor');
    expect(predecessor.error).not.toHaveProperty('details');
    for (const extra of [{ body: 'PRIVATE_COMMAND' }, { env: { TOKEN: 'PRIVATE_ENV' } }, { stdout: 'PRIVATE_OUTPUT' }]) {
      expect(ActionOperationFailureV1Schema.safeParse({ ...snapshot.error, details: { ...details, ...extra } }).success).toBe(false);
    }
  });
  it('retains only the matching public contributed refusal and omits it for predecessor readers', () => {
    const result = { ok: false, code: 'connection_required', retryable: false,
      remediation: { kind: 'openSettings', path: '/settings/plugins/acme.review/connections' } };
    const raw = { ...baseSnapshot, actionId: 'acme.review/prepare', state: 'failed', startedAt: 110, settledAt: 120,
      error: { errorCode: result.code, error: result.code }, result };
    const snapshot = ActionOperationSnapshotV1Schema.parse(raw);
    expect(snapshot.result).toEqual(result);
    expect(projectActionOperationSnapshotForV1Reader(snapshot)).not.toHaveProperty('result');
    for (const invalid of [
      { ...raw, actionId: 'session.spawn_new' },
      { ...raw, result: { ...result, code: 'other_failure' } },
      { ...raw, result: { ok: true, result: { kind: 'prepared' } } },
      { ...raw, result: { ...result, privateDetails: 'must-not-cross' } },
    ]) expect(ActionOperationSnapshotV1Schema.safeParse(invalid).success).toBe(false);
  });

  it.each(['failed', 'cancelled'] as const)('retains completed backup native failure evidence through the %s operation writer and serialized terminal reader', state => {
    const errorCode = state === 'failed' ? 'backup_failed' : 'cancelled';
    const nativeFailure = { exitCode: 1, stderr: 'Fatal: could not find snapshot [REDACTED]', stderrTruncated: true };
    const result = projectDeploymentBackupFailureResultV1('deployments.backups.run', errorCode,
      { step: 'tree', code: errorCode, nativeFailure, untrustedPayload: 'PRIVATE_NATIVE_PAYLOAD' });
    expect(result).toEqual({ step: 'tree', code: errorCode, nativeFailure });
    const operation = ActionOperationSnapshotV1Schema.parse(JSON.parse(JSON.stringify({ ...baseSnapshot,
      actionId: 'deployments.backups.run', state, startedAt: 110, settledAt: 120, result,
      ...(state === 'failed' ? { error: { errorCode, error: errorCode } } : {}) })));
    expect(readActionOperationTerminalResultV1(operation)).toEqual({ ok: false, errorCode, error: errorCode, details: result });
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...operation,
      result: { ...result, nativeFailure: { ...nativeFailure, argv: 'PRIVATE_NATIVE_ARGV' } } }).success).toBe(false);
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)('omits only terminal result from the %s list projection', state => {
    const full = { ...baseSnapshot, state, startedAt: 110, settledAt: 120,
      result: { retained: true } };
    const { result: _result, ...summary } = full;
    expect(projectActionOperationListSnapshotV1(full)).toEqual(summary);
    expect(projectActionOperationListSnapshotV1(summary)).toBe(summary);
    const active = { ...full, state: 'running' as const, settledAt: undefined };
    expect(projectActionOperationListSnapshotV1(active)).toBe(active);
  });
  it('recovers failed and cancelled restore steps from the retained terminal receipt', () => {
    const result = { steps: [{ id: 'restore', status: 'failed' }],
      nativeFailure: { exitCode: 1, stderr: 'pg_restore: import failed [REDACTED]', stderrTruncated: false } };
    const failed = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'deployments.backups.restore',
      state: 'failed', startedAt: 110, settledAt: 120, result,
      error: { errorCode: 'restore_failed', error: 'restore_failed' } });
    expect(readActionOperationTerminalResultV1(failed)).toEqual({ ok: false, errorCode: 'restore_failed',
      error: 'restore_failed', details: result });
    const cancelled = ActionOperationSnapshotV1Schema.parse({ ...failed, state: 'cancelled', error: undefined });
    expect(readActionOperationTerminalResultV1(cancelled)).toEqual({ ok: false,
      errorCode: 'cancelled', error: 'cancelled', details: result });
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...failed,
      result: { ...result, nativeFailure: { ...result.nativeFailure, argv: 'PRIVATE_NATIVE_ARGV' } } }).success).toBe(false);
    expect(readActionOperationTerminalResultV1(ActionOperationSnapshotV1Schema.parse(baseSnapshot))).toBeNull();
  });
  it('retains current setup step facts and omits the setup reference for released V1 readers', () => {
    const steps = [{ planIndex: 0, stepId: 'install', label: { key: 'setup.install', fallback: 'Install tools' },
      state: 'failed', failureCause: 'native_effect_failed', terminalId: 'native-output' }];
    const snapshot = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.setup.apply',
      domainRef: { kind: 'machineSetup', serverId: 'home', machineId: 'machine-1', steps } });
    expect(ActionOperationGetV1ResponseSchema.parse(JSON.parse(JSON.stringify({ kind: 'found', operation: snapshot }))))
      .toMatchObject({ operation: { domainRef: { steps } } });
    expect(projectActionOperationSnapshotForV1Reader(snapshot)).not.toHaveProperty('domainRef');
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...snapshot, domainRef: { ...snapshot.domainRef,
      steps: [{ ...steps[0], scriptBody: 'PRIVATE_SCRIPT' }] } }).success).toBe(false);
  });

  it('round trips reviewed Project command rows with their actual terminal and confirmed outcome', () => {
    const steps = [
      { index: 0, source: { kind: 'command', command: 'echo first' }, state: 'succeeded', terminalId: 'first-terminal', exitCode: 0 },
      { index: 1, source: { kind: 'command', command: 'echo second' }, state: 'failed', terminalId: 'second-terminal', exitCode: 7 },
    ];
    const snapshot = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'projects.prepare',
      domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'home', machineId: 'machine-1',
        workspaceRefId: 'workspace-1', cwd: '/repo', terminalId: 'second-terminal', exitCode: 7, steps } });
    expect(ActionOperationGetV1ResponseSchema.parse(JSON.parse(JSON.stringify({ kind: 'found', operation: snapshot }))))
      .toMatchObject({ operation: { domainRef: { steps } } });
  });

  it('retains a typed spawn refusal on a failed operation with the same cause', () => {
    const refusal = { type: 'error', code: 'spawn_failed', retryable: false,
      launchError: { kind: 'launch_error', code: 'agent_isolation_unavailable', message: 'agent_isolation_unavailable' } };
    const wire = { ...baseSnapshot, state: 'failed', startedAt: 110, settledAt: 120,
      error: { errorCode: 'spawn_failed', error: 'spawn_failed' }, result: refusal };
    expect(ActionOperationGetV1ResponseSchema.parse(JSON.parse(JSON.stringify({ kind: 'found', operation: wire }))))
      .toMatchObject({ operation: { state: 'failed', result: refusal } });
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...wire, actionId: 'session.fork' }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...wire,
      error: { errorCode: 'other_failure', error: 'other_failure' } }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...wire, result: { type: 'success' } }).success).toBe(false);
  });

  it('round trips the child spawn refusal on its managed acquisition operation without replacing the root request', () => {
    const details = { type: 'error' as const, code: 'spawn_failed' as const, retryable: false,
      launchError: { kind: 'launch_error' as const, code: 'agent_cli_target_unavailable', message: 'The Agent CLI cannot run in this target' } };
    const error = { errorCode: details.code, error: details.launchError.message, requestId: 'native-child-request',
      effectAttempted: false, details };
    const wire = { ...baseSnapshot, actionId: 'machines.managed.acquire', requestId: 'managed-root-request',
      state: 'failed', startedAt: 110, settledAt: 120, error };
    expect(ActionOperationGetV1ResponseSchema.parse(JSON.parse(JSON.stringify({ kind: 'found', operation: wire }))))
      .toMatchObject({ operation: { requestId: wire.requestId, error } });
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, errorCode: 'other_failure' }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, details: { ...details, privateOutput: 'PRIVATE_OUTPUT' } }).success).toBe(false);
    expect(projectActionOperationSnapshotForV1Reader(ActionOperationSnapshotV1Schema.parse(wire)).error)
      .toEqual({ errorCode: error.errorCode, error: error.error });
  });

  it('retains the signed-out Session refusal with its existing managed Agent setup recovery target', () => {
    const failure = { type: 'error', code: 'agent_signed_out', retryable: false, agentId: 'coding',
      launchError: { kind: 'launch_error', code: 'agent_signed_out', message: 'The selected Agent account needs sign-in' } };
    const error = { errorCode: failure.code, error: failure.launchError.message,
      details: { kind: 'managedAgentStart', machineId: 'guest', agentId: 'coding', failure } };
    const snapshot = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.managed.acquire',
      state: 'failed', startedAt: 110, settledAt: 120, error });
    expect(readActionOperationTerminalResultV1(snapshot)).toMatchObject({ ok: false, ...error });
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, errorCode: 'agent_cli_missing' }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, details: { ...error.details,
      failure: { ...failure, privateOutput: 'PRIVATE_OUTPUT' } } }).success).toBe(false);
  });

  it('retains content-free deployment recovery through the public operation reader', () => {
    const error = { errorCode: 'unclassified_provider_refusal', error: 'unclassified_provider_refusal',
      details: { requiredFact: 'deploymentActionResult', remedy: 'Inspect the target capabilities and retry the original request.' } };
    const wire = { ...baseSnapshot, actionId: 'deployments.logs.read', state: 'failed', startedAt: 110, settledAt: 120, error };
    expect(ActionOperationGetV1ResponseSchema.parse(JSON.parse(JSON.stringify({ kind: 'found', operation: wire }))))
      .toMatchObject({ operation: { error } });
    expect(ActionOperationFailureV1Schema.safeParse({ ...error,
      details: { ...error.details, providerPayload: 'PRIVATE_PROVIDER_PAYLOAD' } }).success).toBe(false);
  });

  it.each([
    { state: 'failed', errorCode: 'deployment_failed' },
    { state: 'cancelled', errorCode: 'cancelled' },
    { state: 'outcome_unknown', errorCode: 'outcome_unknown' },
  ])('retains terminal receipt recovery for $state and rejects mismatched or private details', ({ state, errorCode }) => {
    const error = { errorCode, error: errorCode, details: { ok: true, environmentId: 'environment', revision: 4,
      deploymentId: 'receipt', deploymentRevision: 2, state,
      requiredFact: 'deploymentActionResult', remedy: 'Confirm the previous deployment before retrying.' } };
    const wire = { ...baseSnapshot, actionId: 'deployments.deploy', state: 'failed', startedAt: 110, settledAt: 120, error };
    expect(ActionOperationGetV1ResponseSchema.parse({ kind: 'found', operation: wire }))
      .toMatchObject({ operation: { error } });
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, errorCode: 'unrelated_failure' }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error,
      details: { ...error.details, state: 'succeeded' } }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error,
      details: { ...error.details, providerPayload: 'PRIVATE_PROVIDER_PAYLOAD' } }).success).toBe(false);
  });

  it('keeps failed operations readable when cause diagnostics evolve, while writes and lifecycle stay strict', () => {
    const error = { errorCode: 'project_script_effect_changed', error: 'Project inputs changed' };
    for (const diagnostic of [
      { cause: { phase: 'project.worker.prepare', future: 'PRIVATE_DIAGNOSTIC' } },
      { failureCause: { phase: 'project.worker.prepare', errorClass: 'FutureWorkerError', errorCode: 'PRIVATE_DIAGNOSTIC', httpStatus: null } },
    ]) {
      const wire = { ...baseSnapshot, actionId: 'projects.script.run', state: 'failed', startedAt: 110, settledAt: 120,
        error: { ...error, ...diagnostic } };
      const read = ActionOperationGetV1ResponseSchema.parse({ kind: 'found', operation: wire });
      expect(read).toMatchObject({ operation: { state: 'failed', error: { ...error,
        failureCause: { kind: 'unknown', errorCode: 'unknown_failure_cause' } } } });
      expect(JSON.stringify(read)).not.toContain('PRIVATE_DIAGNOSTIC');
      expect(ActionOperationFailureV1Schema.safeParse(wire.error).success).toBe(false);
      expect(ActionOperationGetV1ResponseSchema.safeParse({ kind: 'found', operation: { ...wire, settledAt: undefined } }).success).toBe(false);
    }
    const failureCause = { phase: 'dispatch', errorClass: 'Error', errorCode: 'ENOSPC', httpStatus: null };
    expect(ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, state: 'failed', startedAt: 110, settledAt: 120,
      error: { ...error, failureCause } }).error).toEqual({ ...error, failureCause });
  });

  it('retains exact reboot Domain subjects for current readers and omits them for released V1 readers', () => {
    const domain = { environmentId: 'environment', targetLinkId: 'link', domainId: 'domain',
      machineId: 'machine-1', installationId: 'installation' };
    const domainRef = { kind: 'machineReboot', serverId: 'home', machineId: 'machine-1', installationId: 'installation',
      task: { id: 'task', taskKind: 'machine.reboot.v1' }, basis: { bootedAt: 1, expectedRunningServiceIds: [],
        expectedRunningServicesKnown: true, dispatchStarted: true, domains: [domain] } };
    const operation = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.reboot',
      state: 'running', startedAt: 110, domainRef });
    expect(ActionOperationGetV1ResponseSchema.parse({ kind: 'found', operation })).toMatchObject({ operation: { domainRef } });
    expect(projectActionOperationSnapshotForV1Reader(operation)).not.toHaveProperty('domainRef');
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, basis: { ...domainRef.basis,
      domains: [{ ...domain, endpoint: 'https://private' }] } }).success).toBe(false);
  });
  it('retains closed Software Apply causes for current readers without native output', () => {
    const error = { errorCode: 'outcome_unknown', error: 'outcome_unknown', details: {
      kind: 'machineSetup', failure: { kind: 'native_effect_failed', reason: 'required_fact_unavailable',
        requiredFact: 'administratorIdentity', remedy: 'Check administratorIdentity with administrator access, then retry.' },
    } };
    const current = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.setup.apply',
      state: 'failed', startedAt: 110, settledAt: 120, error });
    expect(current.error).toEqual(error);
    expect(projectActionOperationSnapshotForV1Reader(current).error).toEqual({ errorCode: error.errorCode, error: error.error });
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, details: { kind: 'machineSetup',
      failure: { kind: 'native_effect_failed', reason: 'required_fact_unavailable' } } }).success).toBe(true);
    for (const failure of [
      { ...error.details.failure, stderr: 'private native output' },
      { ...error.details.failure, reason: 'arbitrary native prose' },
      { ...error.details.failure, kind: 'unknown_failure' },
    ]) expect(ActionOperationFailureV1Schema.safeParse({ ...error, details: { ...error.details, failure } }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, errorCode: 'cancelled' }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ errorCode: 'platform_unsupported', error: 'platform_unsupported',
      details: { kind: 'machineSetup', failure: { kind: 'native_effect_failed' } } }).success).toBe(true);
  });
  it('retains the pre-native Setup refusal branch without credentials or native content', () => {
    const failure = { kind: 'target_unavailable', phase: 'machine_setup_target', branch: 'installed_runtime', reason: 'credentials' };
    const error = { errorCode: 'target_unavailable', error: 'target_unavailable', details: { kind: 'machineSetup', failure } };
    const current = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.setup.apply',
      state: 'failed', startedAt: 110, settledAt: 120, error });
    expect(current.error).toEqual(error);
    expect(projectActionOperationSnapshotForV1Reader(current).error).toEqual({ errorCode: error.errorCode, error: error.error });
    for (const extra of [{ token: 'private' }, { stderr: 'private' }, { phase: 'unknown' }, { branch: 'unknown' }, { reason: 'private prose' }]) {
      expect(ActionOperationFailureV1Schema.safeParse({ ...error, details: { ...error.details,
        failure: { ...failure, ...extra } } }).success).toBe(false);
    }
  });
  it('retains only Home-owned availability facts on target-unavailable operations', () => {
    const details = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
    const error = { errorCode: 'target_unavailable', error: 'Target unavailable', details };
    const current = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.setup.apply',
      state: 'failed', startedAt: 110, settledAt: 120, error });
    expect(current.error).toEqual(error);
    expect(projectActionOperationSnapshotForV1Reader(current).error).toEqual({ errorCode: error.errorCode, error: error.error });
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, errorCode: 'action_failed' }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, details: { ...details, token: 'PRIVATE_TOKEN' } }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, details: { ...details, remedy: 'select_current_machine' } }).success).toBe(false);
  });
  it('retains only closed Home authority facts for current readers', () => {
    const error = { errorCode: 'HOME_AUTHORITY_MISMATCH', error: 'Home authority mismatch', details: {
      kind: 'homeAuthorityMismatch', authorityReason: 'descriptor', authorityPhase: 'controller_approval',
      authorityCarrier: 'https', authorityDescriptorPresent: false,
    } };
    const current = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.managed.acquire',
      state: 'failed', startedAt: 110, settledAt: 120, error });
    expect(current.error).toEqual(error);
    expect(projectActionOperationSnapshotForV1Reader(current).error).toEqual({ errorCode: error.errorCode, error: error.error });
    for (const extra of [{ token: 'private' }, { authorityReason: 'https://private' }, { authorityPhase: 'unknown' },
      { authorityCarrier: 'unknown' }, { authorityDescriptorPresent: 'false' }]) {
      expect(ActionOperationFailureV1Schema.safeParse({ ...error, details: { ...error.details, ...extra } }).success).toBe(false);
    }
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, errorCode: 'action_failed' }).success).toBe(false);
  });
  it('retains typed no-dispatch reboot refusals at the current strict operation read seam only', () => {
    const failed = { ...baseSnapshot, actionId: 'machines.reboot', state: 'failed', startedAt: 110, settledAt: 120,
      error: { errorCode: 'action_operation_failed', error: 'action_operation_failed' } };
    for (const result of [{ kind: 'blocked', reasons: ['setup'] }, { kind: 'failed', reasonCode: 'denied' },
      { kind: 'unavailable', reason: 'daemon_shutting_down' }]) {
      const operation = { ...failed, result };
      expect(ActionOperationSnapshotV1Schema.parse(operation).result).toEqual(result);
      expect(ActionOperationGetV1ResponseSchema.parse({ kind: 'found', operation })).toMatchObject({ operation: { result } });
    }
    // A physical dispatch receipt is not terminal failure/success evidence;
    // unrelated Actions retain the existing prohibition on failed results.
    for (const operation of [
      { ...failed, actionId: 'session.spawn_new', result: { kind: 'blocked', reasons: ['setup'] } },
      { ...failed, result: { kind: 'accepted', operation: { operationId: failed.operationId }, bootedAt: 1000 } },
      { ...failed, result: { kind: 'outcome_unknown' } },
      { ...failed, state: 'running', settledAt: undefined, error: undefined, result: { kind: 'blocked', reasons: ['setup'] } },
    ]) expect(ActionOperationSnapshotV1Schema.safeParse(operation).success).toBe(false);
  });
  it('carries closed interpreter diagnostics only to current operation readers', () => {
    const error = { errorCode: 'bootstrap_effect_unavailable', error: 'bootstrap_effect_unavailable', details: {
      kind: 'managedBootstrap', phase: 'apply', response: 'result', exitStatus: 1, stdoutPresent: true, stderrPresent: false,
      resultStatus: 'unavailable', reason: 'native_effect_failed',
    } };
    const current = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.managed.bootstrap.retry',
      state: 'failed', startedAt: 110, settledAt: 120, error });
    expect(current.error).toEqual(error);
    expect(projectActionOperationSnapshotForV1Reader(current).error).toEqual({ errorCode: error.errorCode, error: error.error });
    for (const extra of [{ stderr: 'private content' }, { reason: 'private arbitrary prose' }, { response: 'missing_result' }]) {
      expect(ActionOperationFailureV1Schema.safeParse({ ...error, details: { ...error.details, ...extra } }).success).toBe(false);
    }
  });
  it('retains one qualified immutable deployment receipt for current readers and omits it for released V1 readers', () => {
    const domainRef = { kind: 'deployment', serverId: 'home', environmentId: 'staging', deploymentId: 'receipt-a',
      expectedDown: { operation: 'backup', targetLinkId: 'link', machineId: 'machine-1', installationId: 'installation', serviceIds: ['instance/web'],
        domains: [{ environmentId: 'staging', targetLinkId: 'link', domainId: 'domain', machineId: 'machine-1', installationId: 'installation' }] } };
    const snapshot = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, domainRef });
    expect(snapshot.domainRef).toEqual(domainRef);
    expect(projectActionOperationSnapshotForV1Reader(snapshot)).not.toHaveProperty('domainRef');
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, commitSha: 'private-source' }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, deploymentId: '' }).success).toBe(false);
  });
  it.each([
    { httpStatusClass: '4xx', code: 'resource_limit_exceeded' },
    { localCause: 'native_configure_refused', httpStatus: 400 },
    { localCause: 'native_delete_refused', httpStatus: 400 },
    { localCause: 'native_route_not_found', route: 'stop', httpStatus: 404 },
  ])('preserves safe managed native diagnostics for current readers and omits them for released V1 readers: %j', nativeCause => {
    const error = { errorCode: 'provider_unavailable', error: 'provider_unavailable', details: {
      kind: 'managedNative', nativeCause,
    } };
    const current = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.managed.acquire',
      state: 'failed', startedAt: 110, settledAt: 120, error });
    expect(current.error).toEqual(error);
    expect(projectActionOperationSnapshotForV1Reader(current).error).toEqual({ errorCode: error.errorCode, error: error.error });
    expect(ActionOperationFailureV1Schema.safeParse({ ...error, details: { ...error.details,
      nativeCause: { ...error.details.nativeCause, message: 'private vendor content' } } }).success).toBe(false);
  });
  it('carries the exact blocking Ask only during its approval wait and omits the reference for V1 readers', () => {
    const approval = { kind: 'approval_request_created', artifactId: 'stop-ask', actionId: 'machines.managed.power.set' };
    const progress = { kind: 'phase', phase: 'waiting_for_approval', label: 'Waiting for approval', approval };
    const snapshot = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, state: 'running', startedAt: 110, progress });
    expect(snapshot.progress).toEqual(progress);
    expect(projectActionOperationSnapshotForV1Reader(snapshot).progress).toEqual({
      kind: 'phase', phase: 'waiting_for_approval', label: 'Waiting for approval',
    });
    expect(ActionOperationProgressV1Schema.safeParse({ ...progress, phase: 'managed.intent.draining' }).success).toBe(false);
    expect(ActionOperationProgressV1Schema.safeParse({ ...progress, approval: { ...approval, actionArgs: { intent: 'stop' } } }).success).toBe(false);
    expect(ActionOperationProgressV1Schema.safeParse({ ...progress, approval: { ...approval, artifactId: '' } }).success).toBe(false);
  });
  it('retains machine setup output on the exact Home and Machine without exposing executable or secret material', () => {
    const domainRef = { kind: 'machineSetup', serverId: 'setup-home', machineId: 'guest',
      preset: { id: 'preset', revision: 3 }, managedId: 'paid', terminalId: 'actual-terminal', exitCode: 17 };
    const snapshot = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.setup.apply',
      state: 'failed', startedAt: 110, settledAt: 120, domainRef,
      error: { errorCode: 'machine_setup_failed', error: 'Setup failed' } });
    expect(snapshot.domainRef).toEqual(domainRef);
    expect(projectActionOperationSnapshotForV1Reader(snapshot)).not.toHaveProperty('domainRef');
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, terminalId: undefined }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, setupScript: 'private script' }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, preset: { ...domainRef.preset, secret: 'private' } }).success).toBe(false);
  });
  it('retains both actual machine setup phase terminals after the current output changes', () => {
    const domainRef = { kind: 'machineSetup', serverId: 'home', machineId: 'guest',
      preset: { id: 'preset', revision: 1 }, terminalId: 'setup-output',
      terminals: { install: 'install-output', setup: 'setup-output' } };
    expect(ActionOperationDomainRefV1Schema.parse(domainRef)).toEqual(domainRef);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, terminals: { arbitrary: 'output' } }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, terminalId: 'unrelated-output' }).success).toBe(false);
  });
  it('retains output for the canonical first preset revision zero', () => {
    const domainRef = { kind: 'machineSetup', serverId: 'home', machineId: 'guest', preset: { id: 'preset', revision: 0 } };
    expect(ActionOperationDomainRefV1Schema.parse(domainRef)).toEqual(domainRef);
  });
  it('publishes numeric FIFO ahead as a queue phase while retaining the closed predecessor progress shape', () => {
    const progress = { kind: 'phase', phase: 'queued', label: 'Queued', queueAhead: 2 } as const;
    const current = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, progress });
    expect(current.progress).toEqual(progress);
    // ../0.2 at 37a6541578749067b49d4579be8c752c9591b8c8 accepts
    // exactly kind/phase/label on its closed phase arm, not current queue facts.
    expect(projectActionOperationSnapshotForV1Reader(current).progress)
      .toEqual({ kind: 'phase', phase: 'queued', label: 'Queued' });
    for (const invalid of [
      { ...progress, queueAhead: -1 },
      { ...progress, queueAhead: 0.5 },
      { ...progress, queueAhead: Number.MAX_SAFE_INTEGER + 1 },
      { ...progress, phase: 'preparing' },
      { ...progress, queuedAccountId: 'private-requester' },
    ]) expect(ActionOperationProgressV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('retains qualified source Script identity separately from its actual execution target and observed exit', () => {
    const sourceWorkspace = { serverId: 'source-home', machineId: 'source-machine', workspaceId: 'shared-id', rootPath: '/source' };
    const attachment = { kind: 'projectCommand', purpose: 'script', serverId: 'target-home', machineId: 'worker',
      workspaceRefId: 'shared-id', cwd: '/copy/packages/web', terminalId: 'actual-terminal', sourceWorkspace };
    const sources = [
      { name: 'test', source: { kind: 'command', command: 'run tests', cwd: 'packages/web' } },
      { source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'test' } },
      { source: { kind: 'pluginNative', adapter: { pluginId: 'acme.tools', localId: 'runner' }, file: 'tasks.json', target: 'test' } },
    ];
    for (const script of sources) {
      const domainRef = { ...attachment, script, exitCode: 17 };
      expect(ActionOperationDomainRefV1Schema.parse(domainRef)).toEqual(domainRef);
      expect(ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'projects.script.run', state: 'failed',
        startedAt: 110, settledAt: 140, domainRef, error: { errorCode: 'project_command_step_failed', error: 'Process failed' },
      }).domainRef).toEqual(domainRef);
      expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, sourceWorkspace: undefined }).success).toBe(false);
      expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, script: { ...script, credentials: 'private' } }).success).toBe(false);
      expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, exitCode: 1.5 }).success).toBe(false);
      expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, terminalId: undefined }).success).toBe(false);
    }
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...attachment,
      script: { name: '', source: sources[0]!.source } }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...attachment, sourceWorkspace: { ...sourceWorkspace, accountId: 'caller' } }).success).toBe(false);
  });
  it('keeps a managed row associated while its actual bootstrap task is attached', () => {
    const domainRef = { kind: 'managedMachine', id: 'managed-row',
      controller: { machineId: 'controller', installationId: 'installation' },
      resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained' } },
      bootstrapTask: { id: 'real-task', taskKind: 'remote.ssh.bootstrapMachine.v1' } };
    expect(ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.managed.acquire', domainRef }).domainRef)
      .toEqual(domainRef);
    expect(ActionOperationDomainRefV1Schema.parse({ kind: 'managedMachine', id: 'waiting-row' }))
      .toEqual({ kind: 'managedMachine', id: 'waiting-row' });
    const { bootstrapTask: _task, ...bootRecovery } = domainRef;
    expect(ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.managed.bootstrap.retry', domainRef: bootRecovery }).domainRef)
      .toEqual(bootRecovery);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef,
      bootstrapTask: { ...domainRef.bootstrapTask, taskKind: 'arbitrary.task' } }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, intentRevision: 0 }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef,
      bootstrapTask: { ...domainRef.bootstrapTask, controller: domainRef.controller, resource: domainRef.resource } }).success).toBe(false);
    for (const kind of ['ssh.trustHost', 'ssh.replaceHostKey']) {
      const prompt = { kind, message: 'Review the SSH host key', host: 'guest.example', keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:new-key', existingFingerprint: kind === 'ssh.replaceHostKey' ? 'SHA256:previous-key' : null };
      expect(ActionOperationDomainRefV1Schema.parse({ ...domainRef,
        bootstrapTask: { ...domainRef.bootstrapTask, prompt } })).toEqual({ ...domainRef,
        bootstrapTask: { ...domainRef.bootstrapTask, prompt } });
    }
  });
  it.each(['start', 'relocation'] as const)('retains only the qualified service %s attempt without claiming a native lifetime', purpose => {
    const domainRef = { kind: 'projectService', purpose,
      workspace: { serverId: 'home', machineId: 'selected-worker', workspaceId: 'selected-ref', rootPath: '/selected' },
      declaration: { workspaceRefId: 'selected-ref', selection: { kind: 'manifest', name: 'web' } } };
    const operation = { ...baseSnapshot, actionId: purpose === 'start' ? 'localServices.launcher.start' : 'projects.service.relocate', state: 'running', startedAt: 110,
      domainRef, observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' } };
    const parsed = ActionOperationSnapshotV1Schema.parse(operation);
    expect(parsed.domainRef).toEqual(domainRef);
    expect(projectActionOperationSnapshotForV1Reader(parsed)).not.toHaveProperty('domainRef');
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef,
      declaration: { ...domainRef.declaration, workspaceRefId: 'source-ref' } }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, managedServiceId: 'unobserved-native' }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, running: true }).success).toBe(false);
  });
  it('retains observed native Stop identity only on its qualified declaration and workspace scope', () => {
    const declaration = { workspaceRefId: 'old-ref', selection: { kind: 'manifest', name: 'web' } };
    const currentTarget = { kind: 'managed_service', managedServiceId: 'observed-native', machineId: 'old-worker',
      workspaceId: 'old-ref', declaration, cwd: 'c:/Work/Project/packages/web' };
    const domainRef = { kind: 'projectService', purpose: 'relocation',
      workspace: { serverId: 'home', machineId: 'old-worker', workspaceId: 'old-ref', rootPath: 'C:\\Work\\Project' },
      declaration, currentTarget };
    expect(ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'projects.service.relocate',
      state: 'running', startedAt: 110, domainRef, observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' },
    }).domainRef).toEqual(domainRef);
    const mismatches = [
      { ...currentTarget, machineId: 'other-worker' },
      { ...currentTarget, workspaceId: 'other-ref' },
      { ...currentTarget, declaration: { ...declaration, selection: { kind: 'manifest', name: 'other-service' } } },
      { ...currentTarget, declaration: undefined },
      { ...currentTarget, cwd: undefined },
      { ...currentTarget, sessionId: 'unrelated-session' },
    ];
    for (const target of mismatches) {
      expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, currentTarget: target }).success).toBe(false);
    }
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, currentTarget: { ...currentTarget, running: true } }).success).toBe(false);
  });
  it('keeps strict no-effect setup review live without exposing unsafe plans or terminal review state', () => {
    const setupReview = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'setup',
      reviewedEffect: { commands: [] } };
    const held = { ...baseSnapshot, actionId: 'projects.script.run', setupReview,
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: 'machine',
        workspaceRefId: 'workspace', cwd: '/project' } };
    expect(ActionOperationSnapshotV1Schema.safeParse(held).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...held, setupReview: { ...setupReview, plan: { credentials: 'secret' } } }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...held, setupReview: { ...setupReview, code: 'project_script_effect_changed' } }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...held, actionId: 'session.spawn_new' }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...held, state: 'succeeded', startedAt: 110, settledAt: 120 }).success).toBe(false);
  });
  it.each(['scm.worktree.remove', 'machines.storage.trash.move', 'machines.storage.deleteNow'])(
    'retains teardown review on the original %s operation', actionId => {
      const held = { ...baseSnapshot, actionId,
        setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'cleanup',
          reviewedEffect: { commands: [] } },
        domainRef: { kind: 'projectCommand', purpose: 'teardown', serverId: 'home', machineId: 'machine',
          workspaceRefId: 'workspace', cwd: '/project' } };
      expect(ActionOperationSnapshotV1Schema.safeParse(held).success).toBe(true);
      expect(ActionOperationSnapshotV1Schema.safeParse({ ...held,
        domainRef: { ...held.domainRef, purpose: 'setup' } }).success).toBe(false);
      expect(ActionOperationSnapshotV1Schema.safeParse({ ...held, state: 'succeeded', startedAt: 110, settledAt: 120 }).success).toBe(false);
    });
  it('retains closed finite cleanup settlement without embedding another review', () => {
    const failed = { ...baseSnapshot, actionId: 'scm.worktree.remove', state: 'failed', startedAt: 110, settledAt: 120,
      error: { errorCode: 'project_setup_step_failed', error: 'Cleanup failed', details: {
        kind: 'finiteCommand', phase: 'teardown', step: 1, exitCode: 7, signal: null,
      } } };
    expect(ActionOperationSnapshotV1Schema.safeParse(failed).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...failed,
      error: { ...failed.error, details: { ...failed.error.details, cleanupReview: {} } } }).success).toBe(false);
  });
  it('accepts only strict producer setup-consent facts bound to the terminal failure code', () => {
    const failure = { errorCode: 'project_setup_consent_required', error: 'Consent required', details: {
      kind: 'pendingApproval', code: 'project_setup_consent_required',
      reviewedEffect: { commands: ['install'] }, reviewedEffectDigest: 'reviewed-effect',
    } };
    expect(ActionOperationFailureV1Schema.parse(failure)).toEqual(failure);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, errorCode: 'different' }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, details: { ...failure.details, credential: 'private' } }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, details: { arbitrary: 'private' } }).success).toBe(false);
  });
  it('retains terminal Script changed-effect review without granting a setup continuation', () => {
    const failure = { errorCode: 'project_script_effect_changed', error: 'Script effect changed', details: {
      kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest: 'current-script',
      reviewedEffect: { command: { kind: 'command', command: 'echo changed' }, toolchain: { kind: 'host' } },
    } };
    expect(ActionOperationFailureV1Schema.parse(failure)).toEqual(failure);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, errorCode: 'project_setup_effect_changed' }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, details: { ...failure.details, consentScope: 'untilChanged' } }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, details: { ...failure.details, setupGrant: 'private' } }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, details: { ...failure.details, reviewedEffect: { unsupported: undefined } } }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, actionId: 'projects.script.run', setupReview: failure.details }).success).toBe(false);
  });
  it('preserves configured worker fallback refusals without promoting unknown eligibility or exposing private facts', () => {
    for (const unavailable of ['ask', 'primary', 'fail'] as const) {
      const errorCode = unavailable === 'fail' ? 'not_accepting' : 'choice_required';
      const failure = { errorCode, error: errorCode, details: {
        kind: 'no_worker_can_accept', unavailable, reason: 'not_accepting',
      } };
      expect(ActionOperationFailureV1Schema.parse(failure)).toEqual(failure);
      expect(ActionOperationFailureV1Schema.safeParse({ ...failure, errorCode: 'process_exit_nonzero' }).success).toBe(false);
      for (const reason of ['memory_unavailable', 'worker_status_unavailable', 'load_unknown']) {
        expect(ActionOperationFailureV1Schema.safeParse({ ...failure,
          details: { ...failure.details, reason } }).success).toBe(false);
      }
      expect(ActionOperationFailureV1Schema.safeParse({ ...failure,
        details: { ...failure.details, credential: 'private' } }).success).toBe(false);
    }
    expect(ActionOperationFailureV1Schema.safeParse({ errorCode: 'choice_required', error: 'Choice needed',
      details: { kind: 'no_worker_can_accept', unavailable: 'fail', reason: 'not_accepting' } }).success).toBe(false);
  });
  it('links only the existing remote enrollment task without granting another routing identity', () => {
    const domainRef = { kind: 'systemTask', id: 'bootstrap-task', taskKind: 'remote.ssh.bootstrapMachine.v1' };
    expect(ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.managed.acquire', domainRef }).domainRef)
      .toEqual(domainRef);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, taskKind: 'arbitrary.task' }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, token: 'secret' }).success).toBe(false);
  });
  it('keeps unknown launch or stop evidence distinct from terminal process outcomes', () => {
    const observation = { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' };
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, observation }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, observation: { ...observation, success: true } }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, state: 'cancelled', startedAt: 110,
      settledAt: 120, observation }).success).toBe(false);
  });
  it('accepts terminal observation only at get, never as an implicit stop request', () => {
    const refresh = { operationId: 'operation', refreshSetupReview: true };
    expect(ActionOperationGetV2RequestSchema.parse(refresh)).toEqual(refresh);
    expect(ActionOperationGetV1RequestSchema.safeParse(refresh).success).toBe(false);
    expect(ActionOperationGetV2RequestSchema.safeParse({ ...refresh, consent: 'approved' }).success).toBe(false);
    expect(ActionOperationGetV2RequestSchema.safeParse({ ...refresh, refreshSetupReview: false }).success).toBe(false);
    const managedPrompt = { operationId: 'operation', waitForTerminal: true, includeManagedPrompt: true };
    expect(ActionOperationGetV2RequestSchema.parse(managedPrompt)).toEqual(managedPrompt);
    expect(ActionOperationGetV1RequestSchema.safeParse(managedPrompt).success).toBe(false);
    expect(ActionOperationGetV2RequestSchema.safeParse({ operationId: 'operation', includeManagedPrompt: true }).success).toBe(false);
    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation', waitForTerminal: true }).success).toBe(true);
    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation', waitForTerminal: true, includeSetupReview: true }).success).toBe(true);
    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation', includeSetupReview: true }).success).toBe(false);
    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation', waitForTerminal: false }).success).toBe(false);
    expect(ActionOperationCancelV1RequestSchema.safeParse({ operationId: 'operation', waitForTerminal: true }).success).toBe(false);
  });
  it('retains a strict qualified project command before launch and after failure or cancellation', () => {
    const domainRef = { kind: 'projectCommand', purpose: 'script', serverId: 'home-1',
      machineId: 'worker-1', workspaceRefId: 'workspace-1', cwd: '/project',
      originRun: { kind: 'workflow_run', serverId: 'home-1', runId: 'workflow-1' } };
    const accepted = { ...baseSnapshot, actionId: 'projects.script.run', domainRef };
    expect(ActionOperationSnapshotV1Schema.safeParse(accepted).success).toBe(true);
    expect(ActionOperationDomainRefV1Schema.parse({ ...domainRef, cwd: '/project with trailing space ' }))
      .toMatchObject({ cwd: '/project with trailing space ' });
    for (const state of ['failed', 'cancelled']) {
      const terminal = { ...accepted, state, startedAt: 110, settledAt: 120,
        domainRef: { ...domainRef, terminalId: 'terminal-1' },
        ...(state === 'failed' ? { error: { errorCode: 'process_exit_nonzero', error: 'Process failed' } } : {}) };
      expect(ActionOperationSnapshotV1Schema.safeParse(terminal).success).toBe(true);
      expect(ActionOperationSnapshotV1Schema.safeParse({ ...terminal, result: { exitCode: 1 } }).success).toBe(false);
    }
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, actorAccountId: 'caller-minted' }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef,
      originRun: { ...domainRef.originRun, authority: 'caller-minted' } }).success).toBe(false);
  });
  it('owns the exact additive machine RPC method names', () => {
    expect(ACTION_OPERATION_RPC_METHODS_V1).toEqual({
      list: 'actionOperation.list.v1',
      get: 'actionOperation.get.v1',
      cancel: 'actionOperation.cancel.v1',
    });
  });

  it('accepts only the exact v1 Action declaration', () => {
    expect(ActionOperationDeclarationV1Schema.parse({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    })).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    });
    for (const onStart of ['current', 'detail', 'activity'] as const) {
      expect(ActionOperationDeclarationV1Schema.safeParse({
        version: 1,
        visibility: 'activity',
        progress: 'reported',
        presentation: { onStart },
      }).success).toBe(true);
    }
    expect(ActionOperationDeclarationV1Schema.safeParse({
      version: 2,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    }).success).toBe(false);
    expect(ActionOperationDeclarationV1Schema.safeParse({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      title: 'Duplicated presentation',
    }).success).toBe(false);
  });

  it('enforces bounded truthful progress', () => {
    expect(ActionOperationProgressV1Schema.parse({
      kind: 'determinate', current: 2, total: 4, label: 'Uploading',
    })).toEqual({ kind: 'determinate', current: 2, total: 4, label: 'Uploading' });

    for (const progress of [
      { kind: 'determinate', current: -1, total: 4 },
      { kind: 'determinate', current: 5, total: 4 },
      { kind: 'determinate', current: 1, total: 0 },
      { kind: 'determinate', current: Number.POSITIVE_INFINITY, total: 4 },
      { kind: 'phase', phase: '', label: 'Preparing' },
      { kind: 'phase', phase: 'p'.repeat(ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1 + 1), label: 'Preparing' },
      { kind: 'phase', phase: 'prepare', label: 'l'.repeat(ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1 + 1) },
    ]) {
      expect(ActionOperationProgressV1Schema.safeParse(progress).success).toBe(false);
    }
  });

  it('keeps the common v1 progress bounds', () => {
    expect(ActionOperationProgressV1Schema.safeParse({
      kind: 'phase',
      phase: 'p'.repeat(200),
      label: 'l'.repeat(1_000),
    }).success).toBe(true);
  });

  it('accepts the predecessor fork strategy projection without widening other references', () => {
    expect(ActionOperationDomainRefV1Schema.parse({
      kind: 'forkRequest', id: 'fork-request-1', strategy: 'replay',
    })).toEqual({ kind: 'forkRequest', id: 'fork-request-1', strategy: 'replay' });
    expect(ActionOperationDomainRefV1Schema.safeParse({
      kind: 'handoff', id: 'handoff-1', strategy: 'native',
    }).success).toBe(false);
  });

  it('accepts the optional common-v1 handoff target without widening other references', () => {
    expect(ActionOperationDomainRefV1Schema.parse({
      kind: 'handoff', id: 'handoff-1',
    })).toEqual({ kind: 'handoff', id: 'handoff-1' });
    expect(ActionOperationDomainRefV1Schema.parse({
      kind: 'handoff', id: 'handoff-1', targetMachineId: 'machine-target',
    })).toEqual({ kind: 'handoff', id: 'handoff-1', targetMachineId: 'machine-target' });
    expect(ActionOperationDomainRefV1Schema.safeParse({
      kind: 'spawnAttempt', id: 'spawn-1', targetMachineId: 'machine-target',
    }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({
      kind: 'handoff', id: 'handoff-1', targetMachineId: ' ',
    }).success).toBe(false);
  });

  it('keeps the remote-dev predecessor redacted failure shape as common v1', () => {
    // remote-dev's strict public failure projection has exactly errorCode + error.
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'failed',
      startedAt: 110,
      settledAt: 120,
      error: { errorCode: 'spawn_failed', error: 'Session creation failed' },
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'failed',
      startedAt: 110,
      settledAt: 120,
      error: {
        errorCode: 'spawn_failed',
        error: 'Session creation failed',
        details: { token: 'must-not-cross-the-public-operation-wire' },
      },
    }).success).toBe(false);
  });

  it('retains only code-bound content-free stale facts in terminal operation observations', () => {
    const snapshot = { ...baseSnapshot, state: 'failed', startedAt: 110, settledAt: 120,
      error: { errorCode: 'approval_stale', error: 'approval_stale', details: { reason: 'directory_approval_missing' } } };
    expect(ActionOperationSnapshotV1Schema.parse(snapshot).error).toEqual(snapshot.error);
    for (const error of [
      { ...snapshot.error, errorCode: 'spawn_failed' },
      { ...snapshot.error, details: { reason: 'unknown' } },
      { ...snapshot.error, details: { reason: 'directory_approval_missing', credential: 'private-fixture' } },
    ]) expect(ActionOperationSnapshotV1Schema.safeParse({ ...snapshot, error }).success).toBe(false);
  });

  it('enforces the remote-dev predecessor common snapshot bounds', () => {
    const predecessorBoundarySnapshot = {
      ...baseSnapshot,
      operationId: 'o'.repeat(2_000),
      actionId: 'a'.repeat(2_000),
      scope: {
        accountId: 'c'.repeat(2_000),
        machineId: 'm'.repeat(2_000),
        sessionId: 's'.repeat(2_000),
      },
      title: 't'.repeat(10_000),
    } as const;
    expect(ActionOperationSnapshotV1Schema.safeParse(predecessorBoundarySnapshot).success).toBe(true);

    for (const incompatible of [
      { ...baseSnapshot, operationId: 'o'.repeat(2_001) },
      { ...baseSnapshot, actionId: 'a'.repeat(2_001) },
      { ...baseSnapshot, scope: { ...baseSnapshot.scope, accountId: 'c'.repeat(2_001) } },
      { ...baseSnapshot, title: 't'.repeat(10_001) },
      { ...baseSnapshot, createdAt: 100.5 },
      {
        ...baseSnapshot,
        state: 'failed',
        startedAt: 110,
        settledAt: 120,
        error: { errorCode: 'e'.repeat(201), error: 'Failed' },
      },
      {
        ...baseSnapshot,
        state: 'failed',
        startedAt: 110,
        settledAt: 120,
        error: { errorCode: 'failed', error: 'e'.repeat(10_001) },
      },
    ]) {
      expect(ActionOperationSnapshotV1Schema.safeParse(incompatible).success).toBe(false);
    }
  });

  it('requires a positive revision and state-consistent lifecycle payload', () => {
    expect(ActionOperationSnapshotV1Schema.parse(baseSnapshot)).toEqual(baseSnapshot);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, revision: 0 }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, startedAt: 110 }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot, state: 'running', startedAt: 110,
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'succeeded',
      startedAt: 110,
      settledAt: 120,
      result: { sessionId: 'new-session' },
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'failed',
      startedAt: 110,
      settledAt: 120,
      error: { errorCode: 'spawn_failed', error: 'Session creation failed' },
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot, state: 'failed', startedAt: 110, settledAt: 120,
    }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'cancelled',
      startedAt: 110,
      settledAt: 120,
      result: { shouldNotExist: true },
    }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot, state: 'succeeded', startedAt: 110, settledAt: 105,
    }).success).toBe(false);
  });

  it('keeps raw invocation input outside the strict snapshot wire shape', () => {
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      input: { token: 'secret' },
    }).success).toBe(false);
  });

  it('carries bounded request correlation without making it the operation identity', () => {
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      requestId: 'r'.repeat(ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1),
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      requestId: 'r'.repeat(ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1 + 1),
    }).success).toBe(false);
  });

  it('owns a strict encrypted machine push envelope', () => {
    const envelope = {
      v: 1,
      machineId: 'machine-1',
      ciphertext: 'ciphertext',
    } as const;
    expect(ActionOperationSnapshotPushV1Schema.parse(envelope)).toEqual(envelope);
    expect(ActionOperationSnapshotPushV1Schema.safeParse({ ...envelope, extra: true }).success).toBe(false);
  });

  it('validates every additive machine RPC payload', () => {
    expect(ActionOperationListV1RequestSchema.safeParse({
      states: ['accepted', 'running'], sessionId: 'session-1', cursor: 'cursor-1',
    }).success).toBe(true);
    expect(ActionOperationListV1ResponseSchema.safeParse({
      items: [baseSnapshot], nextCursor: null,
    }).success).toBe(true);
    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation-1' }).success).toBe(true);
    expect(ActionOperationGetV1ResponseSchema.safeParse({ kind: 'found', operation: baseSnapshot }).success).toBe(true);
    expect(ActionOperationGetV1ResponseSchema.safeParse({ kind: 'not_found' }).success).toBe(true);
    expect(ActionOperationCancelV1RequestSchema.safeParse({ operationId: 'operation-1' }).success).toBe(true);
    for (const kind of ['unsupported', 'requested', 'already_settled', 'not_found'] as const) {
      expect(ActionOperationCancelV1ResponseSchema.safeParse({ kind }).success).toBe(true);
    }

  });

  it('keeps request-identity selection closed and exclusive to the current list reader', () => {
    const requestIdentity = { actionId: 'session.spawn_new', requestId: 'manual:click' };
    expect(ActionOperationListV2RequestSchema.parse({ requestIdentity })).toEqual({ requestIdentity });
    expect(ActionOperationListV1RequestSchema.safeParse({ requestIdentity }).success).toBe(false);
    for (const request of [
      { requestIdentity: { requestId: 'click' } },
      { requestIdentity: { ...requestIdentity, accountId: 'stranger' } },
      { requestIdentity, accountId: 'stranger' },
      { requestIdentity: { ...requestIdentity, requestId: 'r'.repeat(ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1 + 1) } },
      { requestIdentity, states: ['running', 'running'] },
    ]) expect(ActionOperationListV2RequestSchema.safeParse(request).success).toBe(false);
  });

  it('keeps Activity requester and creation-time filters exclusive to the closed V2 list request', () => {
    const request = { actorAccountId: 'alice', createdAtFromMs: 0, createdAtToMs: 1000 };
    expect(ActionOperationListV2RequestSchema.parse(request)).toEqual(request);
    expect(ActionOperationListV1RequestSchema.safeParse(request).success).toBe(false);
    for (const invalid of [{ actorAccountId: '' }, { createdAtFromMs: -1 }, { createdAtToMs: 1.5 },
      { ...request, accountId: 'bob' }]) {
      expect(ActionOperationListV2RequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

});
