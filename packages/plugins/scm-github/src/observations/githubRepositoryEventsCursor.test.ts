import { describe, expect, it } from 'vitest';

import {
  classifyGithubRepositoryEvents,
  createGithubRepositoryEventsBaseline,
  reuseGithubRepositoryEventsCheckpointOnNotModified,
} from './githubRepositoryEventsCursor.js';

describe('GitHub repository-events checkpoint', () => {
  it('baselines without importing history, then emits new supported events oldest first', () => {
    const baseline = createGithubRepositoryEventsBaseline({
      observationStartsAtMs: 1_000,
      observedAtMs: 1_000,
      events: [{ eventId: '2', createdAtMs: 900, observation: { kind: 'push', id: '2' } }, {
        eventId: '1', createdAtMs: 800, observation: { kind: 'push', id: '1' },
      }],
    });
    expect(baseline).toEqual({
      v: 1,
      observationStartsAtMs: 1_000,
      observedAtMs: 1_000,
      seenEventIds: ['1', '2'],
      etag: null,
    });

    const result = classifyGithubRepositoryEvents({
      cursor: baseline,
      observedAtMs: 2_000,
      etag: 'current-page-set',
      maxEntries: 10,
      events: [{ eventId: '4', createdAtMs: 1_900, observation: { kind: 'push', id: '4' } }, {
        eventId: '3', createdAtMs: 1_800, observation: null,
      }, {
        eventId: '2', createdAtMs: 900, observation: { kind: 'push', id: '2' } }, {
        eventId: '1', createdAtMs: 800, observation: { kind: 'push', id: '1' } },
      ],
    });

    expect(result).toEqual({
      kind: 'observations',
      observations: [{ kind: 'push', id: '4' }],
      checkpoint: {
        v: 1,
        observationStartsAtMs: 1_000,
        observedAtMs: 2_000,
        seenEventIds: ['1', '2', '3', '4'],
        etag: 'current-page-set',
      },
    });
  });

  it('leaves an unprocessed supported event unseen and clears its ETag until the timeline is fully classified', () => {
    const result = classifyGithubRepositoryEvents({
      cursor: {
        v: 1,
        observationStartsAtMs: 1_000,
        observedAtMs: 1_000,
        seenEventIds: ['1'],
        etag: 'old-page-set',
      },
      observedAtMs: 2_000,
      etag: 'current-page-set',
      maxEntries: 1,
      events: [{ eventId: '3', createdAtMs: 1_900, observation: { kind: 'push', id: '3' } }, {
        eventId: '2', createdAtMs: 1_800, observation: { kind: 'push', id: '2' } }, {
        eventId: '1', createdAtMs: 900, observation: { kind: 'push', id: '1' } },
      ],
    });

    expect(result).toEqual({
      kind: 'observations',
      observations: [{ kind: 'push', id: '2' }],
      checkpoint: {
        v: 1,
        observationStartsAtMs: 1_000,
        observedAtMs: 2_000,
        seenEventIds: ['1', '2'],
        etag: null,
      },
    });
  });

  it('reports a bounded-history gap instead of advancing when the prior timeline has disappeared', () => {
    const result = classifyGithubRepositoryEvents({
      cursor: {
        v: 1,
        observationStartsAtMs: 1_000,
        observedAtMs: 1_000,
        seenEventIds: ['old-2', 'old-1'],
        etag: 'old-page-set',
      },
      observedAtMs: 2_000,
      etag: 'current-page-set',
      maxEntries: 10,
      events: [{ eventId: 'new-2', createdAtMs: 1_900, observation: { kind: 'push', id: 'new-2' } }, {
        eventId: 'new-1', createdAtMs: 1_800, observation: { kind: 'push', id: 'new-1' } },
      ],
    });

    expect(result).toEqual({ kind: 'historyGap' });
  });

  it('reports a gap rather than advancing through a changed empty timeline after a retained event', () => {
    const result = classifyGithubRepositoryEvents({
      cursor: {
        v: 1,
        observationStartsAtMs: 1_000,
        observedAtMs: 1_000,
        seenEventIds: ['old'],
        etag: 'old-page-set',
      },
      observedAtMs: 2_000,
      etag: 'changed-empty-page-set',
      maxEntries: 10,
      events: [],
    });

    expect(result).toEqual({ kind: 'historyGap' });
  });

  it('derives oldest-first processing from immutable timestamp and ID facts across permuted pages', () => {
    const result = classifyGithubRepositoryEvents({
      cursor: {
        v: 1,
        observationStartsAtMs: 1_000,
        observedAtMs: 1_000,
        seenEventIds: ['baseline'],
        etag: 'old-page-set',
      },
      observedAtMs: 2_000,
      etag: 'combined-page-set',
      maxEntries: 10,
      // These are deliberately interleaved from two Link-followed pages, not
      // in a provider response order that the Events contract promises.
      events: [{ eventId: 'event-b', createdAtMs: 1_700, observation: { id: 'event-b' } }, {
        eventId: 'event-c', createdAtMs: 1_800, observation: { id: 'event-c' },
      }, {
        eventId: 'baseline', createdAtMs: 900, observation: { id: 'baseline' },
      }, {
        eventId: 'event-a', createdAtMs: 1_700, observation: { id: 'event-a' },
      }],
    });

    expect(result).toEqual({
      kind: 'observations',
      observations: [{ id: 'event-a' }, { id: 'event-b' }, { id: 'event-c' }],
      checkpoint: {
        v: 1,
        observationStartsAtMs: 1_000,
        observedAtMs: 2_000,
        seenEventIds: ['baseline', 'event-a', 'event-b', 'event-c'],
        etag: 'combined-page-set',
      },
    });

    if (result.kind !== 'observations') throw new Error('expected checkpoint');
    expect(classifyGithubRepositoryEvents({
      cursor: result.checkpoint,
      observedAtMs: 3_000,
      etag: 'unchanged-semantics-new-etag',
      maxEntries: 10,
      events: [{ eventId: 'event-b', createdAtMs: 1_700, observation: { id: 'event-b' } }, {
        eventId: 'event-c', createdAtMs: 1_800, observation: { id: 'event-c' },
      }, {
        eventId: 'baseline', createdAtMs: 900, observation: { id: 'baseline' },
      }, {
        eventId: 'event-a', createdAtMs: 1_700, observation: { id: 'event-a' },
      }],
    })).toMatchObject({ kind: 'observations', observations: [] });
  });

  it('uses the immutable activation cutoff rather than the last poll watermark when delayed events first appear', () => {
    const baseline = createGithubRepositoryEventsBaseline({
      observationStartsAtMs: 1_000,
      observedAtMs: 1_200,
      events: [],
    });
    const afterAnEmptyPoll = classifyGithubRepositoryEvents({
      cursor: baseline,
      observedAtMs: 2_000,
      etag: 'empty-page-set',
      maxEntries: 10,
      events: [],
    });
    expect(afterAnEmptyPoll).toMatchObject({ kind: 'observations' });
    if (afterAnEmptyPoll.kind !== 'observations') throw new Error('expected checkpoint');

    const result = classifyGithubRepositoryEvents({
      cursor: afterAnEmptyPoll.checkpoint,
      observedAtMs: 3_000,
      etag: 'delayed-page-set',
      maxEntries: 10,
      events: [{
        eventId: 'delayed-after-activation',
        createdAtMs: 1_100,
        observation: { kind: 'push', id: 'delayed-after-activation' },
      }, {
        eventId: 'delayed-before-activation',
        createdAtMs: 900,
        observation: { kind: 'push', id: 'delayed-before-activation' },
      }],
    });

    expect(result).toEqual({
      kind: 'observations',
      observations: [{ kind: 'push', id: 'delayed-after-activation' }],
      checkpoint: {
        v: 1,
        observationStartsAtMs: 1_000,
        observedAtMs: 3_000,
        seenEventIds: ['delayed-before-activation', 'delayed-after-activation'],
        etag: 'delayed-page-set',
      },
    });
  });

  it('reports a gap rather than silently accepting an empty timeline after the documented Events retention window', () => {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;
    const baseline = createGithubRepositoryEventsBaseline({
      observationStartsAtMs: 1_000,
      observedAtMs: 1_000,
      events: [],
    });

    const result = classifyGithubRepositoryEvents({
      cursor: baseline,
      observedAtMs: 1_000 + thirtyDaysMs + 1,
      etag: 'empty-page-set',
      maxEntries: 10,
      events: [],
    });

    expect(result).toEqual({ kind: 'historyGap' });
  });

  it('reports a gap when a sparse post-retention timeline cannot prove continuity with an empty retained baseline', () => {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;
    const baseline = createGithubRepositoryEventsBaseline({
      observationStartsAtMs: 1_000,
      observedAtMs: 1_000,
      events: [],
    });

    const result = classifyGithubRepositoryEvents({
      cursor: baseline,
      observedAtMs: 1_000 + thirtyDaysMs + 1,
      etag: 'sparse-page-set',
      maxEntries: 300,
      events: Array.from({ length: 299 }, (_, index) => ({
        eventId: `new-${index + 1}`,
        createdAtMs: 2_000 + index,
        observation: { id: `new-${index + 1}` },
      })),
    });

    expect(result).toEqual({ kind: 'historyGap' });
  });

  it('refreshes the continuity horizon on a timely conditional response', () => {
    const dayMs = 24 * 60 * 60 * 1_000;
    const baseline = createGithubRepositoryEventsBaseline({
      observationStartsAtMs: 1_000,
      observedAtMs: 1_000,
      events: [],
      etag: 'prior-page-set',
    });
    const afterNotModified = reuseGithubRepositoryEventsCheckpointOnNotModified(
      baseline,
      1_000 + 29 * dayMs,
    );

    const result = classifyGithubRepositoryEvents({
      cursor: afterNotModified,
      observedAtMs: 1_000 + 31 * dayMs,
      etag: 'current-page-set',
      maxEntries: 300,
      events: [{ eventId: 'late-but-continuous', createdAtMs: 1_000 + 30 * dayMs, observation: { id: 'late' } }],
    });

    expect(afterNotModified.observedAtMs).toBe(1_000 + 29 * dayMs);
    expect(result).toMatchObject({ kind: 'observations', observations: [{ id: 'late' }] });
  });

  it('keeps a sparse post-retention timeline when a retained event proves continuity', () => {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;
    const result = classifyGithubRepositoryEvents({
      cursor: {
        v: 1,
        observationStartsAtMs: 1_000,
        observedAtMs: 1_000,
        seenEventIds: ['overlap'],
        etag: 'prior-page-set',
      },
      observedAtMs: 1_000 + thirtyDaysMs + 1,
      etag: 'current-page-set',
      maxEntries: 300,
      events: [{ eventId: 'overlap', createdAtMs: 1_100, observation: { id: 'overlap' } }, {
        eventId: 'new', createdAtMs: 2_000, observation: { id: 'new' },
      }],
    });

    expect(result).toMatchObject({ kind: 'observations', observations: [{ id: 'new' }] });
  });

  it('refuses a stale poll that would regress the persisted observation watermark', () => {
    expect(() => classifyGithubRepositoryEvents({
      cursor: {
        v: 1,
        observationStartsAtMs: 0,
        observedAtMs: 2_000,
        seenEventIds: [],
        etag: 'current-page-set',
      },
      observedAtMs: 1_500,
      etag: 'stale-page-set',
      maxEntries: 10,
      events: [],
    })).toThrow('cannot move backwards');
  });
});
