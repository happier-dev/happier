import { describe, expect, it } from 'vitest';

import { createGitlabResponseHeaders } from './gitlabHeaders.js';
import {
  GITLAB_MAX_RATE_LIMIT_WINDOW_MS,
  readGitlabRetryEvidence,
} from './gitlabRateLimit.js';

const NOW_MS = 1_609_844_100_000; // 2021-01-05T10:55:00Z

describe('readGitlabRetryEvidence', () => {
  it('converts an explicit Retry-After through the injected clock and prefers it over the reset', () => {
    const evidence = readGitlabRetryEvidence(
      createGitlabResponseHeaders({
        'Retry-After': '30',
        'RateLimit-Reset': '1609844400',
      }),
      NOW_MS,
    );
    expect(evidence).toEqual({
      retryNotBeforeMs: NOW_MS + 30_000,
      source: 'retry-after',
      clamped: false,
    });
  });

  it('reads RateLimit-Reset as absolute epoch seconds, not a relative delay', () => {
    const evidence = readGitlabRetryEvidence(
      createGitlabResponseHeaders({ 'ratelimit-reset': '1609844400' }),
      NOW_MS,
    );
    // 1609844400s === 2021-01-05T11:00:00Z, five minutes after `NOW_MS`. Treating it
    // as a delay would park the source for over fifty years.
    expect(evidence?.retryNotBeforeMs).toBe(1_609_844_400_000);
    expect(evidence?.source).toBe('ratelimit-reset');
  });

  it('falls back to the throttled-only RateLimit-ResetTime date when no numeric evidence exists', () => {
    const evidence = readGitlabRetryEvidence(
      createGitlabResponseHeaders({ 'RateLimit-ResetTime': 'Tue, 05 Jan 2021 11:00:00 GMT' }),
      NOW_MS,
    );
    expect(evidence).toEqual({
      retryNotBeforeMs: 1_609_844_400_000,
      source: 'ratelimit-reset-time',
      clamped: false,
    });
  });

  it('invents no deadline when GitLab supplied none, and never treats quota telemetry as one', () => {
    expect(readGitlabRetryEvidence(createGitlabResponseHeaders({}), NOW_MS)).toBeNull();
    // An application-level limit answers 429 with no matching quota headers.
    expect(readGitlabRetryEvidence(
      createGitlabResponseHeaders({ 'RateLimit-Limit': '60', 'RateLimit-Observed': '67' }),
      NOW_MS,
    )).toBeNull();
    // A reset already in the past is spent, not a deadline.
    expect(readGitlabRetryEvidence(
      createGitlabResponseHeaders({ 'RateLimit-Reset': '1609844000' }),
      NOW_MS,
    )).toBeNull();
    // A non-numeric Retry-After is not silently reinterpreted.
    expect(readGitlabRetryEvidence(
      createGitlabResponseHeaders({ 'Retry-After': 'soon' }),
      NOW_MS,
    )).toBeNull();
  });

  it('clamps a reset beyond the documented maximum quota window instead of parking the source', () => {
    const evidence = readGitlabRetryEvidence(
      createGitlabResponseHeaders({ 'RateLimit-Reset': String(Math.floor(NOW_MS / 1000) + 86_400) }),
      NOW_MS,
    );
    expect(evidence).toEqual({
      retryNotBeforeMs: NOW_MS + GITLAB_MAX_RATE_LIMIT_WINDOW_MS,
      source: 'ratelimit-reset',
      clamped: true,
    });
  });
});
