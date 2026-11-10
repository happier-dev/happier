import { describe, expect, it } from 'vitest';
import { readMachineActionRpcResult } from '../../actions/executor/actionFailureEnvelope.js';
import { deriveSessionCreationTagV1 } from './sessionCreationIdentityV1.js';
import { SessionSpawnNewResultV1Schema } from './sessionSpawnNewResultV1.js';

import {
  SessionCreationTargetPreparationRequestV1Schema,
  SessionCreationTargetPreparationResultV1Schema,
  readSessionCreationTargetPreparationResultV1,
} from './sessionCreationTargetPreparationV1.js';

describe('Session creation target preparation V1', () => {
  it.each(['raw', 'transport'] as const)('preserves machine admission cause through %s path-directory preflight', shape => {
    const failureCause = { phase: 'rpc.admission.machine', errorClass: 'Error',
      errorCode: 'machine_unavailable', httpStatus: 403 };
    const raw = { error: 'Forbidden', errorCode: 'RPC_FORBIDDEN', failureCause };
    let refusal: unknown = raw;
    if (shape === 'transport') {
      try { readMachineActionRpcResult(raw); } catch (error) { refusal = error; }
    }
    const prepared = readSessionCreationTargetPreparationResultV1(refusal);
    expect(prepared).toEqual({ ok: false, result: { type: 'error', code: 'permission_denied',
      retryable: false, failureCause } });
    if (!prepared.ok) expect(SessionSpawnNewResultV1Schema.parse(prepared.result)).toEqual(prepared.result);
  });

  it.each([401, 403])('preserves an HTTP %s admission cause without exposing transport details', status => {
    const failureCause = { phase: 'rpc.admission.machine', errorClass: 'Error',
      errorCode: 'machine_unavailable', httpStatus: status };
    const error = Object.assign(new Error('private transport detail'), {
      response: { status }, failureCause,
    });
    expect(readSessionCreationTargetPreparationResultV1(error)).toEqual({ ok: false,
      result: { type: 'error', code: 'permission_denied', retryable: false, failureCause } });
  });

  it('keeps legacy forbidden replies readable and rejects arbitrary cause contents', () => {
    const legacy = { type: 'error', code: 'permission_denied', retryable: false };
    expect(SessionSpawnNewResultV1Schema.parse(legacy)).toEqual(legacy);
    expect(readSessionCreationTargetPreparationResultV1({ error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' }))
      .toEqual({ ok: false, result: legacy });
    const failureCause = { phase: 'rpc.admission.machine', errorClass: 'Error',
      errorCode: 'machine_unavailable', httpStatus: 403, message: 'private transport detail' };
    expect(SessionSpawnNewResultV1Schema.safeParse({ ...legacy, failureCause }).success).toBe(false);
    expect(readSessionCreationTargetPreparationResultV1({ error: 'Forbidden', errorCode: 'RPC_FORBIDDEN', failureCause }))
      .toEqual({ ok: false, result: legacy });
  });

  it('retains the directory preflight refusal through the public creation result', () => {
    expect(readSessionCreationTargetPreparationResultV1({ ok: false, code: 'invalid_directory' }))
      .toMatchObject({ ok: false, result: { type: 'error', code: 'spawn_failed', retryable: false,
        launchError: { kind: 'launch_error', code: 'invalid_directory' } } });
  });
  it.each(['agent_isolation_unavailable', 'filesystem_identity_custody_unavailable', 'MACHINE_ENCRYPTION_UNAVAILABLE'] as const)(
    'preserves %s after the real CLI Machine transport envelope reader throws it', code => {
    let refused: unknown;
    try {
      readMachineActionRpcResult({ error: 'private native detail', errorCode: code,
        details: { directory: '/private/requester/home', reason: 'private custody detail' } });
    } catch (error) { refused = error; }
    expect(readSessionCreationTargetPreparationResultV1(refused)).toEqual({ ok: false,
      result: { type: 'error', code: 'spawn_failed', retryable: false,
        launchError: { kind: 'launch_error', code, message: code } } });
  });

  it('preserves a raw filesystem custody refusal without exposing private native details', () => {
    expect(readSessionCreationTargetPreparationResultV1({
      error: 'private native detail', errorCode: 'filesystem_identity_custody_unavailable',
      details: { directory: '/private/requester/home', reason: 'private custody detail' },
    })).toEqual({ ok: false, result: { type: 'error', code: 'spawn_failed', retryable: false,
      launchError: { kind: 'launch_error', code: 'filesystem_identity_custody_unavailable',
        message: 'filesystem_identity_custody_unavailable' } } });
  });

  it('keeps preparation success, typed refusals and raw isolation refusals in one response projection', () => {
    const preparedTarget = SessionCreationTargetPreparationResultV1Schema.parse({ ok: true, directory: '/workspace',
      directoryKind: 'path', directoryCreationRequired: true, checkout: null });
    expect(readSessionCreationTargetPreparationResultV1(preparedTarget)).toEqual({ ok: true, preparedTarget });
    expect(readSessionCreationTargetPreparationResultV1({ ok: false, code: 'checkout_unavailable' })).toEqual({
      ok: false, result: { type: 'error', code: 'incompatible_target', retryable: false,
        incompatibleTarget: { reason: 'checkout_unavailable' } },
    });
    expect(readSessionCreationTargetPreparationResultV1({ error: 'private daemon detail', errorCode: 'agent_isolation_unavailable' }))
      .toEqual({ ok: false, result: { type: 'error', code: 'spawn_failed', retryable: false,
        launchError: { kind: 'launch_error', code: 'agent_isolation_unavailable', message: 'agent_isolation_unavailable' } } });
  });

  it.each([
    { error: 'private detail', errorCode: 'unknown_private_cause' },
    { errorCode: 'agent_isolation_unavailable' },
    { ok: true, error: 'conflicting result', errorCode: 'agent_isolation_unavailable' },
  ])('keeps malformed or unclassified preparation responses incompatible without exposing their contents', raw => {
    expect(readSessionCreationTargetPreparationResultV1(raw)).toEqual({ ok: false,
      result: { type: 'error', code: 'incompatible_target', retryable: false,
        incompatibleTarget: { reason: 'target_preparation_invalid_result' } } });
  });

  it('carries the canonical creation tag for a managed intent without accepting a raw creation key', () => {
    const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'attempt' });
    expect(SessionCreationTargetPreparationRequestV1Schema.parse({ directory: { kind: 'managed' }, sessionCreationTag }))
      .toEqual({ directory: { kind: 'managed' }, sessionCreationTag });
    expect(SessionCreationTargetPreparationRequestV1Schema.safeParse({ directory: { kind: 'managed' }, creationKey: 'attempt' }).success).toBe(false);
  });
  it('keeps only the bounded target-owned directory and checkout preparation input', () => {
    expect(SessionCreationTargetPreparationRequestV1Schema.parse({
      directory: { kind: 'path', path: '~\\projects/acme' },
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature/session-placement',
        baseRef: 'main',
        branchMode: 'existing',
      },
    })).toEqual({
      directory: { kind: 'path', path: '~\\projects/acme' },
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature/session-placement',
        baseRef: 'main',
        branchMode: 'existing',
      },
    });

    expect(() => SessionCreationTargetPreparationRequestV1Schema.parse({
      directory: { kind: 'path', path: '/repo' },
      callerPathAlias: '/other',
    })).toThrow();

    expect(() => SessionCreationTargetPreparationRequestV1Schema.parse({
      directory: { kind: 'path', path: '/repo' },
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature/session-placement',
        baseRef: 'main',
        unrecognizedCheckoutSecret: 'must-not-persist',
      },
    })).toThrow();
  });

  it('returns only the canonical final directory, missing-directory fact, and immutable checkout facts', () => {
    expect(SessionCreationTargetPreparationResultV1Schema.parse({
      ok: true,
      directory: 'C:\\Users\\alice\\repo\\.dev\\worktree\\feature',
      directoryKind: 'path',
      directoryCreationRequired: false,
      checkout: {
        kind: 'git_worktree',
        finalDirectory: 'C:\\Users\\alice\\repo\\.dev\\worktree\\feature',
        baseRef: null,
        branchMode: 'new',
        created: true,
      },
    })).toEqual({
      ok: true,
      directory: 'C:\\Users\\alice\\repo\\.dev\\worktree\\feature',
      directoryKind: 'path',
      directoryCreationRequired: false,
      checkout: {
        kind: 'git_worktree',
        finalDirectory: 'C:\\Users\\alice\\repo\\.dev\\worktree\\feature',
        baseRef: null,
        branchMode: 'new',
        created: true,
      },
    });

    expect(SessionCreationTargetPreparationResultV1Schema.parse({
      ok: true,
      directory: '/repo/.dev/worktree/reused',
      directoryKind: 'path',
      directoryCreationRequired: false,
      checkout: {
        kind: 'git_worktree',
        finalDirectory: '/repo/.dev/worktree/reused',
        baseRef: null,
        branchMode: 'existing',
      },
    }).checkout).not.toHaveProperty('created');

    expect(() => SessionCreationTargetPreparationResultV1Schema.parse({
      ok: true,
      directory: '/repo/new-directory',
      checkout: null,
    })).toThrow();

    expect(SessionCreationTargetPreparationResultV1Schema.parse({
      ok: false,
      code: 'checkout_unavailable',
    })).toEqual({ ok: false, code: 'checkout_unavailable' });
  });
});
