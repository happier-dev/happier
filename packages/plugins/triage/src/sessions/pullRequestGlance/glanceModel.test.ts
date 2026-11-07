import { describe, expect, it } from 'vitest';
import type { TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageSessionPullRequestBindingV1 } from '../sessionPullRequestStatus.js';
import { projectPullRequestGlanceV1 } from './glanceModel.js';
import { operationOffers } from '../testkit/sessionPullRequestOperations.test-support.js';

const status = (
  patch: Partial<TriagePullRequestStatusV1> = {},
): TriagePullRequestStatusV1 => ({
  kind: 'status',
  observedAtMs: 100,
  checks: null,
  review: null,
  merge: null,
  branch: { head: 'fix-settings-remount', base: 'v0.3' },
  facts: [],
  ...patch,
});
const check = (
  id: string,
  state: 'passed' | 'failed' | 'pending' | 'neutral' | 'unknown',
) => ({ id, name: id, state });
const binding = (
  patch: Partial<TriageSessionPullRequestBindingV1> = {},
): TriageSessionPullRequestBindingV1 => ({
  bindingId: 'b1',
  revision: 3,
  link: {
    provider: 'github',
    repository: 'acme/widgets',
    number: 2512,
    url: 'https://github.com/acme/widgets/pull/2512',
  },
  watch: {
    policy: { mode: 'notify', archiveAfterMerge: false },
    reason: null,
    fixAttemptLimit: 3,
    roundsStarted: 0,
    watchingMachine: null,
  },
  latestUpdate: null,
  nativeStatus: { kind: 'current', checkedAtMs: 200, value: status() },
  ...patch,
});

describe('PR glance projection', () => {
  it('keeps coarse mergeability unknown without a source verdict and follows that verdict when supplied', () => {
    const value = status({ merge: { state: 'mergeable', blocker: null }, projectionTruncated: true });
    const project = (value: TriagePullRequestStatusV1) => projectPullRequestGlanceV1(binding({
      nativeStatus: { kind: 'current', checkedAtMs: 200, value },
    })).merge.kind;
    expect(project(value)).toBe('unknown');
    expect(project({ ...value, operations: operationOffers })).toBe('unknown');
    expect(project({ ...value, operations: { ...operationOffers, readiness: 'ready' } })).toBe('ready');
  });

  it('does not fabricate branch display labels from an observed head revision', () => {
    const value = status({ branch: { headRevision: 'new-head' } });
    const model = projectPullRequestGlanceV1(binding({ nativeStatus: { kind: 'current', checkedAtMs: 200, value } }));
    expect(model.branch).toBeNull();
    expect(value.branch).toEqual({ headRevision: 'new-head' });
  });

  it('names the failing count and the first failing check rather than a running or passed summary', () => {
    const model = projectPullRequestGlanceV1(
      binding({
        nativeStatus: {
          kind: 'current',
          checkedAtMs: 200,
          value: status({
            checks: {
              state: 'complete',
              passed: 11,
              failed: 1,
              pending: 1,
              total: 13,
              incomplete: false,
              rows: [
                check('lint', 'passed'),
                check('test (ubuntu-latest)', 'failed'),
                check('build', 'pending'),
              ],
            },
          }),
        },
      }),
    );
    expect(model.checks).toEqual({
      kind: 'failing',
      count: 1,
      first: 'test (ubuntu-latest)',
      more: 0,
    });
  });

  it('keeps running checks running and counts cancelled (neutral) runs apart from passes', () => {
    const model = projectPullRequestGlanceV1(
      binding({
        nativeStatus: {
          kind: 'current',
          checkedAtMs: 200,
          value: status({
            checks: {
              state: 'incomplete',
              passed: 9,
              failed: 0,
              pending: 2,
              total: 12,
              incomplete: false,
              rows: [
                check('a', 'passed'),
                check('b', 'pending'),
                check('c', 'neutral'),
              ],
            },
          }),
        },
      }),
    );
    expect(model.checks).toEqual({
      kind: 'running',
      done: 10,
      total: 12,
      cancelled: 1,
    });
  });

  it('never turns unknown check counts into zero or into passed', () => {
    const model = projectPullRequestGlanceV1(
      binding({
        nativeStatus: {
          kind: 'current',
          checkedAtMs: 200,
          value: status({
            checks: {
              state: 'unknown',
              passed: null,
              failed: null,
              pending: null,
              total: null,
              incomplete: true,
              rows: [],
            },
          }),
        },
      }),
    );
    expect(model.checks).toEqual({ kind: 'unknown' });
    expect(projectPullRequestGlanceV1(binding()).checks).toEqual({
      kind: 'unknown',
    });
  });

  it('derives the blocked reason from the facts it shows', () => {
    const model = projectPullRequestGlanceV1(
      binding({
        nativeStatus: {
          kind: 'current',
          checkedAtMs: 200,
          value: status({
            checks: {
              state: 'complete',
              passed: 1,
              failed: 1,
              pending: 0,
              total: 2,
              incomplete: false,
              rows: [check('t', 'failed')],
            },
            review: {
              decision: 'changesRequested',
              incomplete: false,
              reviewers: [
                { id: 'm', name: 'Mara Chen', verb: 'changesRequested' },
              ],
            },
            merge: { state: 'blocked', blocker: null },
            operations: { ...operationOffers, readiness: 'blocked', unmetRequirements: [
              { kind: 'check', id: 't', label: 't' },
              { kind: 'review', id: 'review', label: 'Required review' },
            ] },
          }),
        },
      }),
    );
    expect(model.review).toEqual({
      kind: 'changesRequested',
      people: ['Mara Chen'],
    });
    expect(model.merge).toEqual({ kind: 'blocked', why: 'checksAndReview' });
  });

  it('reads the watch line from the binding: off, fixing, exhausted, credentials, offline Machine', () => {
    expect(
      projectPullRequestGlanceV1(
        binding({
          watch: {
            ...binding().watch,
            policy: {
              mode: 'off',
              archiveAfterMerge: false,
            },
          },
        }),
      ).watch,
    ).toEqual({ kind: 'off' });
    expect(
      projectPullRequestGlanceV1(
        binding({
          watch: {
            ...binding().watch,
            policy: {
              mode: 'address',
              archiveAfterMerge: false,
            },
            roundsStarted: 1,
            progress: {
              roundsStarted: 1,
              continuationRounds: 0,
              activeRound: { obligationId: 'o', started: true },
            },
          },
        }),
      ).watch,
    ).toEqual({ kind: 'fixing', mode: 'address', round: 1, limit: 3 });
    expect(
      projectPullRequestGlanceV1(
        binding({
          watch: {
            ...binding().watch,
            policy: {
              mode: 'autoFix',
              archiveAfterMerge: false,
            },
            reason: 'exhausted',
            roundsStarted: 3,
          },
        }),
      ).watch,
    ).toEqual({ kind: 'exhausted', mode: 'autoFix', rounds: 3 });
    expect(
      projectPullRequestGlanceV1(
        binding({ watch: { ...binding().watch, reason: 'credentials' } }),
      ).watch,
    ).toEqual({ kind: 'credentials', mode: 'notify' });
    expect(
      projectPullRequestGlanceV1(
        binding({
          watch: {
            ...binding().watch,
            reason: 'paused',
            watchingMachine: {
              serverId: 's',
              machineId: 'm',
              label: 'MacBook Pro',
            },
          },
        }),
      ).watch,
    ).toEqual({ kind: 'paused', mode: 'notify', machine: 'MacBook Pro' });
  });

  it('a merged link ends the facts and reports the terminal state', () => {
    const model = projectPullRequestGlanceV1(
      binding({
        link: { ...binding().link, state: 'merged', observedAt: 5 },
        watch: { ...binding().watch, reason: 'terminal' },
      }),
    );
    expect(model.merge).toEqual({ kind: 'merged' });
    expect(model.watch).toEqual({ kind: 'terminal', terminal: 'merged' });
  });

  it('never projects a stale successful read as a ready merge, while a stale blocker stays a blocker', () => {
    const failure = { code: 'rate_limited', message: 'limited' } as never;
    const mergeable = status({ merge: { state: 'mergeable', blocker: null }, operations: { ...operationOffers, readiness: 'ready' } });
    const blocked = status({ merge: { state: 'blocked', blocker: 'Review required' }, operations: { ...operationOffers, readiness: 'blocked' } });
    const project = (value: TriagePullRequestStatusV1, kind: 'current' | 'stale') =>
      projectPullRequestGlanceV1(
        binding({
          nativeStatus:
            kind === 'current'
              ? { kind, checkedAtMs: 150, value }
              : { kind, checkedAtMs: 150, value, failure },
        }),
      ).merge;
    expect(project(mergeable, 'current').kind).toBe('ready');
    expect(project(mergeable, 'stale').kind).toBe('stale');
    expect(project(blocked, 'stale').kind).toBe('blocked');
  });

  it('keeps stale native facts with their time and the failure, and unavailable without invented facts', () => {
    const failure = { code: 'rate_limited', message: 'limited' } as never;
    const stale = projectPullRequestGlanceV1(
      binding({
        nativeStatus: {
          kind: 'stale',
          checkedAtMs: 150,
          value: status(),
          failure,
        },
      }),
    );
    expect(stale.freshness).toEqual({
      kind: 'stale',
      checkedAtMs: 150,
      failure,
    });
    const unavailable = projectPullRequestGlanceV1(
      binding({ nativeStatus: { kind: 'unavailable', failure } }),
    );
    expect(unavailable.freshness).toEqual({ kind: 'unavailable', failure });
    expect(unavailable.checks).toEqual({ kind: 'unknown' });
    expect(unavailable.merge).toEqual({ kind: 'unknown' });
    expect(unavailable.branch).toBeNull();
  });
});
