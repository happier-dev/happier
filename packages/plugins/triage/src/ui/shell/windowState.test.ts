import { describe, expect, it } from 'vitest';

import type { TriageListWindowV1 } from '../../projection/listWindow.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import { resolveTriageListShellState } from './windowState.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE = '11111111-1111-4111-8111-111111111111';

function window(overrides: Partial<TriageListWindowV1> = {}): TriageListWindowV1 {
  return {
    v: 1,
    rows: [],
    lanes: [],
    coverage: 'complete',
    assembledAtMs: 1_760_000_000_000,
    ...overrides,
  };
}

function snapshot(overrides: Partial<TriageListWindowSnapshotV1> = {}): TriageListWindowSnapshotV1 {
  return {
    freshness: 'fresh',
    pending: 'idle',
    configuredSources: [{ sourceInstanceId: INSTANCE, source: SOURCE, available: true }],
    ...overrides,
  };
}

describe('resolveTriageListShellState', () => {
  it('withholds "configure a source" until a pass has actually looked', () => {
    // Before the first completed cycle nothing has enumerated the configured
    // instances, so accusing the reader of not configuring one would be a guess.
    expect(resolveTriageListShellState(snapshot({ freshness: 'unknown', configuredSources: [] })))
      .toEqual({ kind: 'initial' });
  });

  it('names a genuinely unconfigured aggregate once a window exists', () => {
    expect(resolveTriageListShellState(snapshot({ window: window(), configuredSources: [] })))
      .toEqual({ kind: 'configureSources' });
  });

  it('reports the failure only when no window was ever assembled', () => {
    expect(resolveTriageListShellState(snapshot({
      freshness: 'unknown',
      error: { code: 'plugin_action_failed', message: 'The list could not be read.' },
    }))).toEqual({ kind: 'unavailable', message: 'The list could not be read.' });
  });

  it('keeps a failed refresh beside the rows instead of replacing them', () => {
    const rows = window({ rows: [], coverage: 'partial' });
    const state = resolveTriageListShellState(snapshot({
      window: rows,
      freshness: 'stale',
      error: { code: 'provider-busy', message: 'The source is busy.' },
    }));

    // The one thing this surface must never do is answer a provider failure
    // with a blank list, which reads as "nothing needs you".
    expect(state).toEqual({
      kind: 'window',
      window: rows,
      refreshing: false,
      stale: true,
      error: 'The source is busy.',
    });
  });

  it('separates a refresh in flight from staleness', () => {
    const state = resolveTriageListShellState(snapshot({ window: window(), pending: 'refresh' }));
    expect(state).toEqual({
      kind: 'window',
      window: window(),
      refreshing: true,
      stale: false,
      error: null,
    });
  });
});
