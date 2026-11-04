import { describe, expect, it } from 'vitest';
import {
  projectSessionSpawnNewActionResultV1,
  readSessionSpawnNewActionResultV1,
  SessionSpawnNewActionResultV1Schema,
  SessionSpawnNewResultV1Schema,
} from './sessionSpawnNewResultV1.js';
import { createProviderErrorV1 } from '../../providers/errors.js';

describe('Session creation fork files', () => {
  it('preserves only canonical content-free runtime causes on launch failures', () => {
    const legacy = { type: 'error', code: 'spawn_failed', retryable: true,
      launchError: { kind: 'launch_error', code: 'CHILD_EXITED_BEFORE_WEBHOOK', message: 'Runner exited' } };
    expect(SessionSpawnNewResultV1Schema.parse(legacy)).toEqual(legacy);
    const failureCause = { code: 'agent_startup_failed', phase: 'client_start', failureReason: 'unclassified_provider_error' };
    const current = { ...legacy, launchError: { ...legacy.launchError, failureCause } };
    expect(SessionSpawnNewResultV1Schema.parse(current)).toEqual(current);
    expect(SessionSpawnNewActionResultV1Schema.parse(current)).toEqual(current);
    for (const invalid of [
      { ...failureCause, message: 'PRIVATE_PROVIDER_BODY' },
      { ...failureCause, path: '/private/person' },
      { ...failureCause, code: 'PRIVATE provider prose' },
      { ...failureCause, failureReason: 'PRIVATE_PROVIDER_BODY' },
    ]) {
      expect(SessionSpawnNewResultV1Schema.safeParse({ ...legacy,
        launchError: { ...legacy.launchError, failureCause: invalid } }).success).toBe(false);
    }
  });

  it('projects the public Action section vocabulary and restores the internal placement', () => {
    const internal = SessionSpawnNewResultV1Schema.parse({
      type: 'success', disposition: 'created', sessionId: 'session-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
      organizationPlacement: { folderId: 'section-3', tagIds: ['tag-4'] },
      initialInput: { status: 'notRequested' },
    });
    const action = projectSessionSpawnNewActionResultV1(internal);
    expect(action).toMatchObject({ organizationPlacement: { sectionId: 'section-3', tagIds: ['tag-4'] } });
    expect(action.organizationPlacement).not.toHaveProperty('folderId');
    expect(SessionSpawnNewActionResultV1Schema.parse(action)).toEqual(action);
    expect(readSessionSpawnNewActionResultV1(action)).toEqual(internal);
  });

  it('returns strict persisted attested birth facts with committed Session creation', () => {
    const result = {
      type: 'success', disposition: 'rejoined', sessionId: 'session-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
      organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' },
      attestedContext: { externalPrincipalId: 'sales@batiplus.ch', sourceMessageId: '<original@example.test>' },
    };
    expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result,
      attestedContext: { ...result.attestedContext, sessionId: 'forged-session' },
    }).success).toBe(false);
  });

  it('keeps committed creation successful while source-key preparation waits', () => {
    const result = {
      type: 'success', disposition: 'created', sessionId: 'session-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted', localId: 'initial-input' },
      sourceKeyPreparation: { kind: 'waiting', reason: 'source_key_unavailable' },
    };
    expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result,
      sourceKeyPreparation: { kind: 'waiting', reason: 'source_key_unavailable', sourceDataKey: 'private' },
    }).success).toBe(false);
  });
  it('reports an empty cross-machine fork without accepting unbounded reasons', () => {
    const result = {
      type: 'success', disposition: 'created', sessionId: 'session-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
      filesNotCopied: { reason: 'cross_machine' },
    };
    expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, filesNotCopied: { reason: 'unknown' } }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, filesNotCopied: { reason: 'cross_machine', sourcePath: '/private' } }).success).toBe(false);
  });
});

describe('Session creation Agent preconditions', () => {
  it.each(['agent_cli_missing', 'agent_signed_out'])('requires Agent identity only for %s', (code) => {
    const result = { type: 'error', code, agentId: 'antigravity', retryable: false };
    expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(SessionSpawnNewResultV1Schema.safeParse({ type: 'error', code, retryable: false }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, agentId: ' ' }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, code: 'spawn_failed' }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, retryable: true }).success).toBe(false);
  });

  it('accepts signed-out recovery detail without changing the precondition or accepting another cause', () => {
    const result = { type: 'error', code: 'agent_signed_out', agentId: 'custom-agent', retryable: false,
      launchError: { kind: 'launch_error', code: 'agent_signed_out', message: 'Choose your sign-in method.' } };
    expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result,
      launchError: { ...result.launchError, code: 'SPAWN_FAILED' },
    }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result,
      launchError: { ...result.launchError, auth: 'private' },
    }).success).toBe(false);
  });
});

describe('Session creation Provider recovery', () => {
  it('retains closed content-free scoped transport diagnostics in the launch cause', () => {
    const result = { type: 'error', code: 'spawn_failed', retryable: true,
      launchError: { kind: 'launch_error', code: 'MACHINE_RPC_TIMEOUT', message: 'Setup timed out.',
        rpcErrorCode: 'MACHINE_RPC_TIMEOUT', connectionPhase: 'socket-connect' } };
    expect(SessionSpawnNewResultV1Schema.parse(result)).toEqual(result);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result,
      launchError: { ...result.launchError, connectionPhase: 'private request content' } }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result,
      launchError: { ...result.launchError, rpcErrorCode: 'private credential' } }).success).toBe(false);
  });
  it('keeps a bounded incompatibility predicate only on a nonretryable incompatible target', () => {
    const result = { type: 'error', code: 'incompatible_target', retryable: false,
      incompatibleTarget: { reason: 'target_preparation_invalid_result' } };
    expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, code: 'spawn_failed' }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, retryable: true }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result,
      incompatibleTarget: { reason: 'unbounded_exception_message' } }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result,
      incompatibleTarget: { reason: 'target_preparation_invalid_result', response: 'private' } }).success).toBe(false);
  });
  it('retains terminal-host setup recovery only for nonretryable incompatible targets', () => {
    const terminalHostError = { kind: 'terminal_host_unavailable', host: 'herdr', reason: 'installation_unavailable' };
    const result = { type: 'error', code: 'incompatible_target', retryable: false, terminalHostError };
    expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, retryable: true }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, code: 'spawn_failed' }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, terminalHostError: { ...terminalHostError, localPath: '/private' } }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ type: 'error', code: 'incompatible_target', retryable: false }).success).toBe(true);
  });
  it('preserves bounded Provider details and their canonical retryability', () => {
    const providerError = createProviderErrorV1('provider_not_enabled_on_machine', {
      connectionId: 'pc_work', machineId: 'machine-1',
    });
    const result = { type: 'error', code: 'spawn_failed', retryable: false, providerError };
    expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, retryable: true }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, code: 'machine_offline' }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, providerError: { ...providerError, token: 'secret' } }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, providerError: { ...providerError, action: 'retry' } }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ type: 'error', code: 'spawn_failed', retryable: true })).toMatchObject({ success: true });
  });
});

describe('Session creation update requirement', () => {
  const details = { kind: 'update_required', operation: 'session.spawn_new', component: 'server', reason: 'session_initial_access_update_required' };
  it('preserves a strict component-specific update requirement', () => {
    const result = { type: 'error', code: 'update_required', retryable: false, details };
    expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, details: { ...details, token: 'secret' } }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, retryable: true }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ type: 'error', code: 'update_required', retryable: false }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ type: 'error', code: 'spawn_failed', retryable: false, details }).success).toBe(false);
  });
});

describe('Session creation initial-access failures', () => {
  it.each([
    ['recipient_key_unavailable', false],
    ['session_access_invalid_recipient_envelope', false],
    ['session_access_subject_not_found', false],
    ['session_access_subject_ineligible', false],
    ['session_access_external_sharing_requires_team_admin', false],
    ['session_access_external_sharing_disabled', false],
    ['session_access_sharing_unavailable', false],
    ['session_access_authentication_required', false],
    ['session_access_authentication_unavailable', false],
    ['session_data_key_unavailable', false],
    ['session_access_request_failed', true],
  ] as const)('preserves the strict %s outcome without secret-bearing details', (code, retryable) => {
    const result = { type: 'error', code, retryable } as const;
    expect(SessionSpawnNewResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, retryable: !retryable }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, details: { publicKey: 'secret' } }).success).toBe(false);
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...result, providerError: { code: 'provider_unknown', retryable: false } }).success).toBe(false);
  });
});
