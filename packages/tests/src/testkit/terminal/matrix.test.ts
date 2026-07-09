import { describe, expect, it } from 'vitest';

import {
  TERMINAL_FOUNDATION_LIFECYCLE_SCENARIO_IDS,
  assertTerminalValidationMatrixCovers,
  listTerminalFoundationLifecycleScenarios,
} from './matrix';

describe('terminal validation matrix', () => {
  it('tracks every TERM-7a lifecycle and rollout scenario in stable order', () => {
    expect(listTerminalFoundationLifecycleScenarios().map((scenario) => scenario.id)).toEqual([
      'daemon-restart-live-surface',
      'app-restart-byte-replay',
      'concurrent-terminals-independent-cursors',
      'feature-denied-or-missing-server-bit',
      'native-webview-fallback-module-missing',
      'renderer-crash-or-webview-boot-failure',
      'memory-retention-cleanup',
      'old-new-client-compatibility',
      'windows-conpty-legacy-fallback',
    ]);
    expect(TERMINAL_FOUNDATION_LIFECYCLE_SCENARIO_IDS).toEqual(
      listTerminalFoundationLifecycleScenarios().map((scenario) => scenario.id),
    );
  });

  it('fails when validation evidence omits a required scenario', () => {
    expect(() => assertTerminalValidationMatrixCovers(TERMINAL_FOUNDATION_LIFECYCLE_SCENARIO_IDS)).not.toThrow();
    expect(() => assertTerminalValidationMatrixCovers(['daemon-restart-live-surface'])).toThrow(
      /missing terminal validation scenarios/i,
    );
  });
});
