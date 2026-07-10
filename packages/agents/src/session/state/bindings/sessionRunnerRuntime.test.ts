import { describe, expect, it } from 'vitest';
import { SESSION_RUNNER_RUNTIME_METADATA_KEY } from '@happier-dev/protocol';

import {
  clearSessionStateFieldFromMetadata,
  createSessionStateFieldMetadataUpdater,
  hasSessionStateFieldMetadataBinding,
} from './publishField.js';
import { readSessionRunnerRuntimeSessionState } from './sessionRunnerRuntime.js';

const runtimeState = {
  v: 1,
  sessionId: 'sess-1',
  machineId: null,
  daemonId: null,
  observedAtMs: 100,
  runner: {
    pid: 4242,
    runtimeId: 'version:1.2.3',
    cliVersion: '1.2.3',
    entrypointVersion: '1.2.3',
    processCommandHash: 'hash-1',
    entrypointSource: 'process_command',
    startedBy: 'daemon',
    startingMode: 'remote',
  },
  daemon: {
    cliVersion: '1.2.4',
    startedWithCliVersion: '1.2.4',
    currentEntrypointVersion: 'version:1.2.4',
    currentEntrypointSource: 'launch_spec',
  },
  versionState: 'stale',
  statusSource: 'process_command_inferred',
  plannedRestart: {
    supported: true,
    eligible: true,
    disabledReason: null,
  },
} as const;

describe('session-runner runtime session-state binding', () => {
  it('reads the canonical metadata key as runtime.sessionRunner', () => {
    expect(readSessionRunnerRuntimeSessionState({ [SESSION_RUNNER_RUNTIME_METADATA_KEY]: runtimeState })).toEqual({
      value: runtimeState,
      updatedAt: 100,
    });
  });

  it('writes and clears the canonical metadata key through the generic updater', () => {
    expect(hasSessionStateFieldMetadataBinding('runtime.sessionRunner')).toBe(true);

    const updater = createSessionStateFieldMetadataUpdater('runtime.sessionRunner', runtimeState);
    expect(updater({ path: '/tmp/project' })).toEqual({
      path: '/tmp/project',
      [SESSION_RUNNER_RUNTIME_METADATA_KEY]: runtimeState,
    });

    const clearUpdater = createSessionStateFieldMetadataUpdater('runtime.sessionRunner', null);
    expect(clearUpdater({
      path: '/tmp/project',
      [SESSION_RUNNER_RUNTIME_METADATA_KEY]: runtimeState,
    })).toEqual({
      path: '/tmp/project',
    });
  });

  it('clears the canonical metadata field by field id', () => {
    expect(clearSessionStateFieldFromMetadata({
      path: '/tmp/project',
      [SESSION_RUNNER_RUNTIME_METADATA_KEY]: runtimeState,
    }, 'runtime.sessionRunner')).toEqual({
      path: '/tmp/project',
    });
  });
});
