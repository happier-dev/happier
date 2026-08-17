import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTuiRuntimePublicationSummaryLines } from './runtime_publication_summary.mjs';

test('TUI renders a degraded runtime publication while preserving the current last-green snapshot', () => {
  assert.deepEqual(
    formatTuiRuntimePublicationSummaryLines({
      runtimePublication: {
        phase: 'failed',
        currentSnapshotId: 'snap-last-green',
        components: {
          server: { phase: 'current', error: null },
          daemon: { phase: 'failed', error: 'credential refresh failed' },
          web: { phase: 'stale', error: null },
        },
      },
    }),
    [
      'runtime publication:',
      '  phase: failed',
      '  currentSnapshot: snap-last-green',
      '  server: current',
      '  daemon: failed (credential refresh failed)',
      '  web: stale',
    ],
  );
});

test('TUI ignores absent or unsupported publication state instead of failing its summary', () => {
  assert.deepEqual(formatTuiRuntimePublicationSummaryLines({}), []);
  assert.deepEqual(formatTuiRuntimePublicationSummaryLines({ runtimePublication: { phase: 'unknown' } }), []);
});
