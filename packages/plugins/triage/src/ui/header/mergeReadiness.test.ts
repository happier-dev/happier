import { describe, expect, it } from 'vitest';
import type { TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';
import type { TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';

import { presentTriageMergeReadinessV1 } from './mergeReadiness.js';
import { operationOffers } from '../../sessions/testkit/sessionPullRequestOperations.test-support.js';

const text = (
  _key: string,
  fallback: string,
  values?: Readonly<Record<string, string>>,
) =>
  fallback.replace(
    /\{(\w+)\}/gu,
    (_, name: string) => values?.[name] ?? `{${name}}`,
  );
const count = (
  _key: string,
  n: number,
  english: Readonly<{ one: string; other: string }>,
) => (n === 1 ? english.one : english.other).replace('{count}', String(n));

function status(
  overrides: Partial<TriagePullRequestStatusV1> = {},
): TriagePullRequestStatusV1 {
  return {
    kind: 'status',
    observedAtMs: 1_000,
    checks: {
      state: 'complete',
      passed: 5,
      failed: 0,
      pending: 0,
      total: 5,
      incomplete: false,
      rows: [
        { id: 'lint', name: 'Lint', state: 'passed', required: true },
        { id: 'e2e', name: 'E2E', state: 'passed', required: true },
      ],
    },
    review: {
      decision: 'approved',
      reviewers: [{ id: 'u1', name: 'Mara Chen', verb: 'approved' }],
      incomplete: false,
    },
    merge: {
      state: 'mergeable',
      blocker: null,
      draft: false,
      nativeState: 'CLEAN',
    },
    branch: { head: 'fix-settings-modal', base: 'v0.3', headRevision: 'abc' },
    facts: [],
    operations: { ...operationOffers, readiness: 'ready' },
    ...overrides,
  };
}

function write(
  value: TriagePullRequestStatusV1,
  extra: Partial<TriageDetailPrimaryWriteV1> = {},
): TriageDetailPrimaryWriteV1 {
  return {
    id: 'merge',
    title: 'Merge',
    disabledReason: null,
    pending: false,
    nativeStatus: { kind: 'current', value, checkedAtMs: 2_000 },
    readiness: { label: 'Ready to merge', enabled: true, reason: null },
    unmetRequirements: [],
    alternatives: [],
    execute: async () => {},
    ...extra,
  };
}

const present = (w: TriageDetailPrimaryWriteV1) =>
  presentTriageMergeReadinessV1(w, text, count, 'GitHub');

describe('merge readiness beside Merge', () => {
  it('reads Ready only when every reported requirement is met', () => {
    expect(present(write(status()))?.line?.words).toBe('Ready');
  });

  it('uses the source verdict when the displayed requirements alone look complete', () => {
    const view = present(write(status({ operations: operationOffers })));
    expect(view?.line?.words).toBe('GitHub didn’t report every requirement');
    expect(view?.head).not.toBe('Ready to merge');
  });

  it('follows a source Ready verdict even when its displayed check list is partial', () => {
    const value = status();
    if (value.checks === null) throw new Error('Expected check fixture');
    const view = present(write({ ...value, projectionTruncated: true,
      checks: { ...value.checks, incomplete: true } }));
    expect(view?.line?.words).toBe('Ready');
    expect(view?.line?.detail).toBe('GitHub sent only part of it');
  });

  it('never reads Ready when a requirement was not reported', () => {
    const view = present(write(status({ review: null, operations: operationOffers })));
    expect(view?.line?.words).toBe('GitHub didn’t report every requirement');
    expect(view?.rows.find((row) => row.id === 'review')?.state).toBe(
      'unknown',
    );
  });

  it('names failing required checks and the missing approval, failing first', () => {
    const value = status({
      checks: {
        state: 'complete',
        passed: 1,
        failed: 1,
        pending: 0,
        total: 2,
        incomplete: false,
        rows: [
          { id: 'lint', name: 'Lint', state: 'passed', required: true },
          { id: 'e2e', name: 'E2E · webkit', state: 'failed', required: true },
          { id: 'docs', name: 'Docs', state: 'failed', required: false },
        ],
      },
      review: {
        decision: 'changesRequested',
        reviewers: [{ id: 'u1', name: 'Mara Chen', verb: 'changesRequested' }],
        incomplete: false,
      },
      merge: { state: 'blocked', blocker: null, nativeState: 'BLOCKED' },
      operations: { ...operationOffers, readiness: 'blocked' },
    });
    const view = present(write(value));
    expect(view?.line).toMatchObject({
      words: '1 check failing',
      detail: '1 approval needed',
      tone: 'danger',
    });
    expect(view?.head).toBe('2 things before you can merge');
    // An optional failure stays in Checks; it is never a blocker here.
    expect(view?.rows.find((row) => row.id === 'checks')?.detail).toBe(
      '1 of 2 passed · E2E · webkit failed',
    );
  });

  it('does not draw a branch that is only behind as a block', () => {
    const view = present(
      write(
        status({
          merge: { state: 'mergeable', blocker: null, nativeState: 'BEHIND' },
          operations: operationOffers,
        }),
      ),
    );
    expect(view?.line?.words).toBe('Behind v0.3');
    expect(view?.rows.find((row) => row.id === 'upToDate')?.state).toBe(
      'unknown',
    );
  });

  it.each([false, true])('never reads a stale successful status as Ready, and keeps the last read time (partial=%s)', (partial) => {
    const value = status(partial ? { projectionTruncated: true } : {});
    const view = present(
      write(status(), {
        nativeStatus: {
          kind: 'stale',
          value,
          checkedAtMs: 2_000,
          failure: { class: 'transient', code: 'offline' },
        } as never,
        disabledReason: 'Read failed',
      }),
    );
    expect(view?.stale).toBe(true);
    expect(view?.checkedAtMs).toBe(2_000);
    expect(view?.head).not.toBe('Ready to merge');
    expect(view?.line?.words).not.toBe('Ready');
    expect(view?.line?.detail).not.toBe('all requirements met');
    if (partial) expect(view?.sub).not.toContain('every requirement was met');
  });

  it('never reads Ready when the native status could not be read at all', () => {
    const view = present(
      write(status(), {
        nativeStatus: {
          kind: 'unavailable',
          failure: { class: 'unsupportedContract', code: 'plugin_action_execution_placement_unavailable' },
        } as never,
        readiness: { label: 'Ready to merge', enabled: true, reason: null },
      }),
    );
    expect(view?.line?.words).toBe('Status unavailable');
    expect(view?.head).not.toBe('Ready to merge');
    expect(view?.rows).toEqual([]);
  });

  it('keeps a stale blocker visible, since a blocker never reads as Ready', () => {
    const view = present(
      write(
        status({
          merge: { state: 'blocked', blocker: null, nativeState: 'BLOCKED' },
          review: { decision: 'reviewRequired', reviewers: [], incomplete: false },
          operations: { ...operationOffers, readiness: 'blocked' },
        }),
        {
          nativeStatus: {
            kind: 'stale',
            value: status({
              merge: { state: 'blocked', blocker: null, nativeState: 'BLOCKED' },
              review: { decision: 'reviewRequired', reviewers: [], incomplete: false },
              operations: { ...operationOffers, readiness: 'blocked' },
            }),
            checkedAtMs: 2_000,
            failure: { class: 'transient', code: 'offline' },
          } as never,
        },
      ),
    );
    expect(view?.stale).toBe(true);
    expect(view?.line?.words).toBe('1 approval needed');
  });

  it('says it is still checking while the status has not been read', () => {
    const view = present(
      write(status(), { nativeStatus: undefined, pending: true }),
    );
    expect(view?.line?.words).toBe('Checking whether it can merge…');
    expect(view?.rows).toEqual([]);
  });

  it('carries GitHub’s queue position only when GitHub supplied it', () => {
    const queued = present(
      write(
        status({
          merge: {
            state: 'mergeable',
            blocker: null,
            queue: { id: 'q', state: 'QUEUED', position: 2 },
          },
        }),
      ),
    );
    expect(queued?.queue).toEqual({ position: 2, etaSeconds: null });
  });

  it('leaves a write without merge status to the plain control', () => {
    expect(
      present({
        title: 'Mark ready',
        disabledReason: null,
        pending: false,
        execute: async () => {},
      }),
    ).toBeNull();
  });
});
