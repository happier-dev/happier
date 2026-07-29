import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import { resolveSessionRunnerRuntimeState } from './resolveRuntimeState';

describe('resolveSessionRunnerRuntimeState', () => {
  it('does not call identical mutable roots current because their generation is unattested', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: {
        happySessionId: 'sess-1',
        pid: 123,
        startedBy: 'daemon',
        processCommand: 'node /work/apps/cli/src/index.ts claude --happy-starting-mode remote --started-by daemon',
        spawnOptions: {
          directory: '/work',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          resume: 'thread-1',
        },
      } as TrackedSession,
      currentIdentity: {
        status: 'known',
        source: 'launch_spec',
        comparableId: 'path:/work/apps/cli',
        entrypointVersion: null,
      },
      observedAtMs: 100,
    });

    expect(state.versionState).toBe('unknown');
    expect(state.plannedRestart).toMatchObject({
      eligible: false,
      disabledReason: 'runner_generation_unattested',
    });
  });
});
