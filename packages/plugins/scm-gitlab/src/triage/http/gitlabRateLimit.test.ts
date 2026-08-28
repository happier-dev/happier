import { describe, expect, it } from 'vitest';

import { createGitlabResponseHeaders } from './gitlabHeaders.js';
import { readGitlabRetryEvidence } from './gitlabRateLimit.js';

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

  it('reports a reset far beyond any documented quota window as GitLab stated it, and bounds nothing here', () => {
    // The horizon on a provider-stated deadline is one policy owned by the single
    // consumer that honours it (`plugins/triage` `refresh/refreshEligibility.ts`).
    // A private ceiling here would be a fifth owner of it and would hide the raw
    // header from the one place that can bound it for every source.
    const statedMs = NOW_MS + (86_400 * 1_000);
    const evidence = readGitlabRetryEvidence(
      createGitlabResponseHeaders({ 'RateLimit-Reset': String(Math.floor(NOW_MS / 1000) + 86_400) }),
      NOW_MS,
    );
    expect(evidence).toEqual({
      retryNotBeforeMs: statedMs,
      source: 'ratelimit-reset',
    });
  });

  it('omits provider evidence whose derived epoch milliseconds are not a strict-JSON integer', () => {
    const unsafeSeconds = String(Number.MAX_SAFE_INTEGER);

    expect(readGitlabRetryEvidence(
      createGitlabResponseHeaders({ 'Retry-After': unsafeSeconds }),
      NOW_MS,
    )).toBeNull();
    expect(readGitlabRetryEvidence(
      createGitlabResponseHeaders({ 'RateLimit-Reset': unsafeSeconds }),
      NOW_MS,
    )).toBeNull();
  });
});
