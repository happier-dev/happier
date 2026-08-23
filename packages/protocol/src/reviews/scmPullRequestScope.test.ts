import { describe, expect, it } from 'vitest';

import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';
import {
  SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY,
  ScmPullRequestReviewScopeV1Schema,
  produceScmPullRequestReviewScope,
  resolveScmPullRequestReviewScope,
} from './scmPullRequestScope.js';
import { REVIEW_SCM_SCOPE_INPUT_KEY } from './reviewStart.js';

const ACCOUNT = {
  service: { pluginId: 'happier.scm-github', localId: 'github' },
  accountId: 'account-7',
} as const;

const OBSERVED = {
  baseSha: '1111111111111111111111111111111111111111',
  headSha: '2222222222222222222222222222222222222222',
  nativeRevision: 'PR_kwDOABCD',
  observedAtMs: 1_700_000_000_000,
} as const;

const SCOPE = {
  kind: 'scm_pull_request_review_scope.v1',
  account: ACCOUNT,
  pullRequest: { number: 42 },
  observed: OBSERVED,
} as const;

const WORKTREE_SCOPE = {
  kind: 'review_scm_scope.v1',
  status: 'supported',
  scmBackendId: 'git',
  scmMode: 'worktree',
  repositoryRoot: '/repo',
  worktreeRoot: '/repo',
  baseRef: { source: 'default_branch', ref: 'main' },
  selectedPaths: [],
  committedPaths: [],
  uncommittedPaths: [],
  changedPaths: [],
  diff: { committedAvailable: true, uncommittedAvailable: true },
  diagnostics: [],
} as const;

describe('ScmPullRequestReviewScopeV1Schema', () => {
  it('travels under its own top-level review start input key', () => {
    expect(SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY).toBe('scmPullRequestReviewScope');
    expect(SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY).not.toBe(REVIEW_SCM_SCOPE_INPUT_KEY);
  });

  it('admits the exact account, canonical pull request reference and one observation', () => {
    const parsed = ScmPullRequestReviewScopeV1Schema.parse(SCOPE);

    expect(parsed).toEqual(SCOPE);
  });

  it('admits every canonical pull request reference arm without redeclaring the grammar', () => {
    for (const pullRequest of [
      { number: 42 },
      { url: 'https://github.example/owner/repo/pull/42' },
      { headBranch: 'feature/login' },
    ]) {
      expect(ScmPullRequestReviewScopeV1Schema.safeParse({ ...SCOPE, pullRequest }).success).toBe(true);
    }
    expect(ScmPullRequestReviewScopeV1Schema.safeParse({
      ...SCOPE,
      pullRequest: { headBranch: 'feature/login:evil' },
    }).success).toBe(false);
  });

  it('refuses a member the separate key does not declare', () => {
    expect(ScmPullRequestReviewScopeV1Schema.safeParse({
      ...SCOPE,
      repositoryRoot: '/repo',
    }).success).toBe(false);
  });

  it('refuses an observation missing the native revision or the observation time', () => {
    expect(ScmPullRequestReviewScopeV1Schema.safeParse({
      ...SCOPE,
      observed: { baseSha: OBSERVED.baseSha, headSha: OBSERVED.headSha },
    }).success).toBe(false);
    expect(ScmPullRequestReviewScopeV1Schema.safeParse({
      ...SCOPE,
      observed: { ...OBSERVED, observedAtMs: 1.5 },
    }).success).toBe(false);
    expect(ScmPullRequestReviewScopeV1Schema.safeParse({
      ...SCOPE,
      observed: { ...OBSERVED, extra: 'kept' },
    }).success).toBe(false);
  });

  it('refuses an account that is not the canonical qualified connected account ref', () => {
    expect(ScmPullRequestReviewScopeV1Schema.safeParse({
      ...SCOPE,
      account: 'account-7',
    }).success).toBe(false);
    expect(ScmPullRequestReviewScopeV1Schema.safeParse({
      ...SCOPE,
      account: { service: ACCOUNT.service, accountId: 'account-7', token: 'secret' },
    }).success).toBe(false);
  });

  it('projects the canonical account constraints into the portable JSON Schema', () => {
    const projected = zodSchemaToJsonSchemaObject(ScmPullRequestReviewScopeV1Schema) as Record<string, any>;

    expect(projected.additionalProperties).toBe(false);
    expect(projected.properties.account.properties.accountId).toMatchObject({ type: 'string' });
    expect(projected.properties.account.additionalProperties).toBe(false);
  });
});

describe('resolveScmPullRequestReviewScope', () => {
  it('fails closed with scope_absent when SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY is not present', () => {
    expect(resolveScmPullRequestReviewScope({
      engineIds: ['acme.review'],
      instructions: 'Review.',
      [REVIEW_SCM_SCOPE_INPUT_KEY]: WORKTREE_SCOPE,
    })).toEqual({ status: 'scope_absent' });
    expect(resolveScmPullRequestReviewScope(undefined)).toEqual({ status: 'scope_absent' });
    expect(resolveScmPullRequestReviewScope({
      [SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY]: undefined,
    })).toEqual({ status: 'scope_absent' });
  });

  it('resolves the exact scope the run was started with', () => {
    expect(resolveScmPullRequestReviewScope({
      [REVIEW_SCM_SCOPE_INPUT_KEY]: WORKTREE_SCOPE,
      [SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY]: SCOPE,
    })).toEqual({ status: 'scope_present', scope: SCOPE });
  });

  it('fails closed with scope_malformed rather than reading the worktree scope beside it', () => {
    for (const malformed of [
      { ...SCOPE, kind: 'review_scm_scope.v1' },
      { ...SCOPE, observed: { ...OBSERVED, headSha: '' } },
      WORKTREE_SCOPE,
      null,
      'scm_pull_request_review_scope.v1',
    ]) {
      expect(resolveScmPullRequestReviewScope({
        [REVIEW_SCM_SCOPE_INPUT_KEY]: WORKTREE_SCOPE,
        [SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY]: malformed,
      })).toEqual({ status: 'scope_malformed' });
    }
  });
});

describe('produceScmPullRequestReviewScope', () => {
  const authoritative = {
    account: ACCOUNT,
    pullRequest: { number: 42 },
    observed: OBSERVED,
  } as const;

  it('produces the scope from one authoritative read of the expected account and pair', () => {
    expect(produceScmPullRequestReviewScope({
      authoritative,
      expected: { account: ACCOUNT, baseSha: OBSERVED.baseSha, headSha: OBSERVED.headSha },
    })).toEqual({ status: 'produced', scope: SCOPE });
  });

  it('refuses when the read was authorized as a different account', () => {
    expect(produceScmPullRequestReviewScope({
      authoritative,
      expected: {
        account: { ...ACCOUNT, accountId: 'account-8' },
        baseSha: OBSERVED.baseSha,
        headSha: OBSERVED.headSha,
      },
    })).toEqual({ status: 'refused', reason: 'accountMismatch' });
  });

  it('refuses when the same account id belongs to a different contribution', () => {
    expect(produceScmPullRequestReviewScope({
      authoritative,
      expected: {
        account: { service: { pluginId: 'happier.scm-gitlab', localId: 'gitlab' }, accountId: 'account-7' },
        baseSha: OBSERVED.baseSha,
        headSha: OBSERVED.headSha,
      },
    })).toEqual({ status: 'refused', reason: 'accountMismatch' });
  });

  it('refuses a head the caller never observed rather than scoping the review to a newer one', () => {
    expect(produceScmPullRequestReviewScope({
      authoritative,
      expected: {
        account: ACCOUNT,
        baseSha: OBSERVED.baseSha,
        headSha: '3333333333333333333333333333333333333333',
      },
    })).toEqual({ status: 'refused', reason: 'observationMismatch' });
  });

  it('refuses a moved base even when the head still matches', () => {
    expect(produceScmPullRequestReviewScope({
      authoritative,
      expected: {
        account: ACCOUNT,
        baseSha: '4444444444444444444444444444444444444444',
        headSha: OBSERVED.headSha,
      },
    })).toEqual({ status: 'refused', reason: 'observationMismatch' });
  });

  it('refuses a read that is not admissible rather than repairing it', () => {
    expect(produceScmPullRequestReviewScope({
      authoritative: { ...authoritative, pullRequest: { number: 0 } },
      expected: { account: ACCOUNT, baseSha: OBSERVED.baseSha, headSha: OBSERVED.headSha },
    })).toEqual({ status: 'refused', reason: 'malformed' });

    expect(produceScmPullRequestReviewScope({
      authoritative: { ...authoritative, observed: { ...OBSERVED, nativeRevision: '' } },
      expected: { account: ACCOUNT, baseSha: OBSERVED.baseSha, headSha: OBSERVED.headSha },
    })).toEqual({ status: 'refused', reason: 'malformed' });
  });

  it('round-trips through the reader that admits it, under its own input key', () => {
    const produced = produceScmPullRequestReviewScope({
      authoritative,
      expected: { account: ACCOUNT, baseSha: OBSERVED.baseSha, headSha: OBSERVED.headSha },
    });
    if (produced.status !== 'produced') throw new Error('expected a produced scope');
    expect(resolveScmPullRequestReviewScope({
      [SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY]: produced.scope,
    })).toEqual({ status: 'scope_present', scope: SCOPE });
  });
});
