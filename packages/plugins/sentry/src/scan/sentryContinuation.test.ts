import { describe, expect, it } from 'vitest';

import { MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';

import {
  decodeSentryScanContinuation,
  encodeSentryScanContinuation,
} from './sentryContinuation.js';

const PROBE = Object.freeze({ cursor: '1754000000000:0:0', stepsSince: 0, interval: 2 });

describe('encodeSentryScanContinuation', () => {
  it('freezes nativeLimit 37 rather than 100 for every request of the same active scan', () => {
    const token = encodeSentryScanContinuation({
      v: 1,
      scanLimit: 37,
      nativeLimit: 37,
      cursor: '1754000000000:0:0',
      probe: PROBE,
      query: '',
      statsPeriod: '90d',
      sort: 'date',
    });

    const decoded = decodeSentryScanContinuation(token ?? '');
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.continuation.nativeLimit).toBe(37);
    expect(decoded.continuation.scanLimit).toBe(37);
    expect(decoded.continuation.cursor).toBe('1754000000000:0:0');
    expect(decoded.continuation.probe).toEqual(PROBE);
  });

  it('rejects encoded geometry whose nativeLimit is not min(scanLimit, 100)', () => {
    expect(encodeSentryScanContinuation({
      v: 1,
      scanLimit: 37,
      nativeLimit: 100,
      cursor: 'c',
      probe: { cursor: 'c', stepsSince: 0, interval: 2 },
      query: '',
      statsPeriod: '90d',
      sort: 'date',
    })).toBeNull();

    expect(decodeSentryScanContinuation(JSON.stringify({
      v: 1,
      scanLimit: 37,
      nativeLimit: 100,
      cursor: 'c',
      probe: { cursor: 'c', stepsSince: 0, interval: 2 },
      query: '',
      statsPeriod: '90d',
      sort: 'date',
    })).ok).toBe(false);
  });

  it('rejects a scan limit outside the public page bound', () => {
    for (const scanLimit of [0, -1, 65, 1.5]) {
      expect(decodeSentryScanContinuation(JSON.stringify({
        v: 1,
        scanLimit,
        nativeLimit: scanLimit,
        cursor: 'c',
        probe: { cursor: 'c', stepsSince: 0, interval: 2 },
        query: '',
        statsPeriod: '90d',
        sort: 'date',
      })).ok).toBe(false);
    }
  });

  it('rejects a continuation whose frozen pass facts were changed', () => {
    const base = {
      v: 1,
      scanLimit: 20,
      nativeLimit: 20,
      cursor: 'c',
      probe: { cursor: 'c', stepsSince: 0, interval: 2 },
      query: '',
      statsPeriod: '90d',
      sort: 'date',
    };
    // The unmodified record is admitted, so every rejection below is caused by
    // the one field it changed rather than by a base this decoder never accepts.
    expect(decodeSentryScanContinuation(JSON.stringify(base)).ok).toBe(true);

    expect(decodeSentryScanContinuation(JSON.stringify({ ...base, query: 'is:unresolved' })).ok)
      .toBe(false);
    expect(decodeSentryScanContinuation(JSON.stringify({ ...base, statsPeriod: '14d' })).ok)
      .toBe(false);
    expect(decodeSentryScanContinuation(JSON.stringify({ ...base, sort: 'freq' })).ok).toBe(false);
    expect(decodeSentryScanContinuation(JSON.stringify({ ...base, cursor: '' })).ok).toBe(false);
    // A probe is a saved position plus the schedule that moves it. A record
    // whose schedule this side could not have produced — a step count outside
    // its own wait, a wait that is not a doubling of the first one, an empty
    // saved position, or no probe at all — is not one this source minted, and a
    // walk cannot vouch for evidence it did not write.
    expect(decodeSentryScanContinuation(
      JSON.stringify({ ...base, probe: { cursor: 'c', stepsSince: 2, interval: 2 } }),
    ).ok).toBe(false);
    expect(decodeSentryScanContinuation(
      JSON.stringify({ ...base, probe: { cursor: 'c', stepsSince: -1, interval: 2 } }),
    ).ok).toBe(false);
    expect(decodeSentryScanContinuation(
      JSON.stringify({ ...base, probe: { cursor: 'c', stepsSince: 0, interval: 3 } }),
    ).ok).toBe(false);
    expect(decodeSentryScanContinuation(
      JSON.stringify({ ...base, probe: { cursor: 'c', stepsSince: 0, interval: 1 } }),
    ).ok).toBe(false);
    expect(decodeSentryScanContinuation(
      JSON.stringify({ ...base, probe: { cursor: '', stepsSince: 0, interval: 2 } }),
    ).ok).toBe(false);
    expect(decodeSentryScanContinuation(
      JSON.stringify({ ...base, probe: ['c'] }),
    ).ok).toBe(false);
    expect(decodeSentryScanContinuation(
      JSON.stringify({ ...base, probe: undefined }),
    ).ok).toBe(false);
    expect(decodeSentryScanContinuation(JSON.stringify({ ...base, v: 2 })).ok).toBe(false);
    expect(decodeSentryScanContinuation('not-json').ok).toBe(false);
  });

  it('refuses a frontier the protocol paging bound cannot carry, without claiming a bad cursor', () => {
    const fits = encodeSentryScanContinuation({
      v: 1,
      scanLimit: 20,
      nativeLimit: 20,
      cursor: 'c'.repeat(1024),
      probe: { cursor: 'c'.repeat(1024), stepsSince: 0, interval: 2 },
      query: '',
      statsPeriod: '90d',
      sort: 'date',
    });
    expect(fits).not.toBeNull();

    // Same well-formed frontier, one cursor too wide for the bounded envelope:
    // the walk cannot be continued, which is not a statement about the cursor.
    expect(encodeSentryScanContinuation({
      v: 1,
      scanLimit: 20,
      nativeLimit: 20,
      cursor: 'c'.repeat(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1),
      probe: { cursor: 'c', stepsSince: 0, interval: 2 },
      query: '',
      statsPeriod: '90d',
      sort: 'date',
    })).toBeNull();
  });

  it('carries no route state, credential, host clock or durable resume fact', () => {
    const token = encodeSentryScanContinuation({
      v: 1,
      scanLimit: 20,
      nativeLimit: 20,
      cursor: '1754000000000:0:0',
      probe: { cursor: '1755000000000:0:0', stepsSince: 1, interval: 2 },
      query: '',
      statsPeriod: '90d',
      sort: 'date',
    });

    expect(token).not.toBeNull();
    const parsed = JSON.parse(token ?? '') as Record<string, unknown>;
    // `probe` is this pass's own saved position — the same kind of within-pass
    // fact `cursor` already is, and equally worthless after the pass that
    // acquired it ends.
    expect(Object.keys(parsed).sort()).toEqual([
      'cursor',
      'nativeLimit',
      'probe',
      'query',
      'scanLimit',
      'sort',
      'statsPeriod',
      'v',
    ]);
    expect(token).not.toContain('sentry.io');
    expect(token).not.toContain('Bearer');
    expect(token).not.toContain('7701');
    expect(token).not.toContain('scanStartedAtMs');
    expect(token).not.toContain('lastCompletedPass');
  });
});
