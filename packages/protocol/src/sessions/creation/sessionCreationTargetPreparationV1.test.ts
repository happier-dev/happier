import { describe, expect, it } from 'vitest';

import {
  SessionCreationTargetPreparationRequestV1Schema,
  SessionCreationTargetPreparationResultV1Schema,
} from './sessionCreationTargetPreparationV1.js';

describe('Session creation target preparation V1', () => {
  it('keeps only the bounded target-owned directory and checkout preparation input', () => {
    expect(SessionCreationTargetPreparationRequestV1Schema.parse({
      directory: '~\\projects/acme',
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature/session-placement',
        baseRef: 'main',
        branchMode: 'existing',
      },
    })).toEqual({
      directory: '~\\projects/acme',
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature/session-placement',
        baseRef: 'main',
        branchMode: 'existing',
      },
    });

    expect(() => SessionCreationTargetPreparationRequestV1Schema.parse({
      directory: '/repo',
      callerPathAlias: '/other',
    })).toThrow();

    expect(() => SessionCreationTargetPreparationRequestV1Schema.parse({
      directory: '/repo',
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
      directoryCreationRequired: false,
      checkout: {
        kind: 'git_worktree',
        finalDirectory: 'C:\\Users\\alice\\repo\\.dev\\worktree\\feature',
        baseRef: null,
        branchMode: 'new',
      },
    })).toEqual({
      ok: true,
      directory: 'C:\\Users\\alice\\repo\\.dev\\worktree\\feature',
      directoryCreationRequired: false,
      checkout: {
        kind: 'git_worktree',
        finalDirectory: 'C:\\Users\\alice\\repo\\.dev\\worktree\\feature',
        baseRef: null,
        branchMode: 'new',
      },
    });

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
