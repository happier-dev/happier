import { describe, expect, it } from 'vitest';
import type { TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';

import { operationOffers } from '../testkit/sessionPullRequestOperations.test-support.js';
import { checksFact, mergeFact, reviewFact } from './factPresentation.js';
import { projectPullRequestStatusFactsV1 } from './glanceModel.js';

/**
 * The words every PR presentation says about one pull request (the Triage header's cells, the Companion glance, the
 * linked-entry detail). The failures guarded here are sentences that contradict each other on one screen: "Ready"
 * beside "2 failing", "15 cancelled" beside "All 33 passed", "Not read yet" while the read is running.
 */
const english = ((
  _key: string,
  fallback = '',
  values: Readonly<Record<string, string | number>> = {},
) =>
  fallback.replace(/\{(\w+)\}/gu, (_match, name: string) =>
    String(values[name] ?? ''),
  )) as unknown as Parameters<typeof checksFact>[0];

const status = (
  patch: Partial<TriagePullRequestStatusV1> = {},
): TriagePullRequestStatusV1 => ({
  kind: 'status',
  observedAtMs: 100,
  checks: null,
  review: null,
  merge: null,
  branch: { head: 'fix', base: 'main' },
  facts: [],
  ...patch,
});
const failing = {
  state: 'complete',
  passed: 2,
  failed: 2,
  pending: 0,
  total: 4,
  incomplete: false,
  rows: [
    { id: 'v', name: 'Vercel', state: 'failed' },
    { id: 'c', name: 'ci', state: 'failed' },
  ],
} as const;

describe('PR fact words', () => {
  it('says the read is running while it runs, and "not read yet" only when no read is under way', () => {
    const reading = projectPullRequestStatusFactsV1(null, undefined, {
      reading: true,
    });
    expect(checksFact(english, reading.checks).sub).toBe('Reading…');
    expect(reviewFact(english, reading.review).sub).toBe('Reading…');
    expect(mergeFact(english, reading.merge, null).sub).toBe('Reading…');
    const idle = projectPullRequestStatusFactsV1(null);
    expect(checksFact(english, idle.checks).sub).toBe('Not read yet');
  });

  it('never says ready beside failing checks without saying why it still merges', () => {
    const ready = projectPullRequestStatusFactsV1(
      status({
        checks: failing,
        operations: { ...operationOffers, readiness: 'ready' },
      }),
    );
    expect(mergeFact(english, ready.merge, 'main')).toMatchObject({
      value: 'Ready',
      sub: 'failing checks aren’t required',
    });
  });

  it('says a required failing check blocks it, in the failure ink', () => {
    const blocked = projectPullRequestStatusFactsV1(
      status({
        checks: failing,
        operations: {
          ...operationOffers,
          readiness: 'blocked',
          unmetRequirements: [{ kind: 'check', id: 'v', label: 'Vercel' }],
        },
      }),
    );
    expect(mergeFact(english, blocked.merge, 'main')).toEqual({
      value: 'Blocked',
      tone: 'danger',
      sub: 'a required check failed',
    });
  });

  it('says what it knows when the forge states no readiness: the checks are failing', () => {
    const unknown = projectPullRequestStatusFactsV1(
      status({ checks: failing }),
    );
    expect(mergeFact(english, unknown.merge, 'main')).toMatchObject({
      value: 'Checks failing',
      tone: 'danger',
    });
  });

  it('counts passes the way the checks step does: cancelled and skipped runs are no news', () => {
    const passed = projectPullRequestStatusFactsV1(
      status({
        checks: {
          state: 'complete',
          passed: 33,
          failed: 0,
          pending: 0,
          total: 48,
          incomplete: false,
          rows: Array.from({ length: 15 }, (_, index) => ({
            id: `n${index}`,
            name: `n${index}`,
            state: 'neutral' as const,
          })),
        },
      }),
    );
    expect(checksFact(english, passed.checks)).toMatchObject({
      value: '33 passed',
      sub: null,
    });
  });
});
