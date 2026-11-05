import { describe, expect, it } from 'vitest';
import { readMachineActionRpcResult } from '../../actions/executor/actionFailureEnvelope.js';
import { deriveSessionCreationTagV1 } from './sessionCreationIdentityV1.js';

import {
  SessionCreationTargetPreparationRequestV1Schema,
  SessionCreationTargetPreparationResultV1Schema,
  readSessionCreationTargetPreparationResultV1,
} from './sessionCreationTargetPreparationV1.js';

describe('Session creation target preparation V1', () => {
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
