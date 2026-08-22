import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import { SessionRunnerRuntimeStateV1Schema } from '@happier-dev/protocol';

import { resolveSessionRunnerRuntimeState } from './resolveRuntimeState';
import type { SessionRunnerEntrypointIdentity } from './types';

const CURRENT_CLI_IDENTITY = {
  status: 'known',
  source: 'launch_spec',
  comparableId: 'version:0.2.10',
  entrypointVersion: '0.2.10',
} satisfies SessionRunnerEntrypointIdentity;

function trackedRunner(): TrackedSession {
  return {
    happySessionId: 'sess-1',
    pid: 123,
    startedBy: 'daemon',
    processCommand:
      'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs codex --happy-starting-mode remote --started-by daemon',
    processCommandHash: 'runner-command-hash',
    processStartTimeMs: 12_345,
    runnerAgentImmutableGenerationId: 'generation-g',
    spawnOptions: {
      directory: '/work',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      resume: 'thread-1',
    },
  };
}

describe('resolveSessionRunnerRuntimeState retained Agent generation aggregate', () => {
  it.each([
    ['current', 'current'],
    ['stale', 'stale'],
    ['unknown', 'unknown'],
  ] as const)(
    'folds same-CLI Agent currentness %s into the existing V1 aggregate',
    (agentRuntimeVersionState, expected) => {
      const state = resolveSessionRunnerRuntimeState({
        sessionId: 'sess-1',
        tracked: trackedRunner(),
        currentIdentity: CURRENT_CLI_IDENTITY,
        agentRuntimeVersionState,
        observedAtMs: 100,
      });

      expect(state).toEqual(expect.objectContaining({
        versionState: expected,
        statusSource: 'daemon_tracking',
      }));
    },
  );

  it('keeps private Agent generation and component identities out of strict V1 status', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedRunner(),
      currentIdentity: CURRENT_CLI_IDENTITY,
      agentRuntimeVersionState: 'stale',
      observedAtMs: 100,
    });

    expect(JSON.stringify(state)).not.toContain('generation-g');
    expect(state).not.toHaveProperty('agentId');
    expect(state).not.toHaveProperty('agentGeneration');
    expect(state).not.toHaveProperty('components');
    expect(SessionRunnerRuntimeStateV1Schema.parse(state)).toEqual(state);
  });

  it('projects removed Agent or selected Provider contribution unavailability through existing V1 plannedRestart', () => {
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedRunner(),
      currentIdentity: CURRENT_CLI_IDENTITY,
      agentRuntimeVersionState: 'stale',
      agentRuntimeRestartUnavailableReason: 'unsupported_backend',
      observedAtMs: 100,
    });

    expect(state).toEqual(expect.objectContaining({
      versionState: 'stale',
      plannedRestart: {
        supported: true,
        eligible: false,
        disabledReason: 'unsupported_backend',
      },
    }));
  });

  it('keeps a hard-revoked Agent runtime unknown even when the CLI entrypoint is stale', () => {
    const staleCliIdentity = {
      ...CURRENT_CLI_IDENTITY,
      comparableId: 'version:0.2.11',
      entrypointVersion: '0.2.11',
    } satisfies SessionRunnerEntrypointIdentity;
    const state = resolveSessionRunnerRuntimeState({
      sessionId: 'sess-1',
      tracked: trackedRunner(),
      currentIdentity: staleCliIdentity,
      agentRuntimeVersionState: 'unknown',
      agentRuntimeRestartUnavailableReason: 'unsupported_backend',
      observedAtMs: 100,
    });

    expect(state).toEqual(expect.objectContaining({
      versionState: 'unknown',
      plannedRestart: {
        supported: true,
        eligible: false,
        disabledReason: 'unsupported_backend',
      },
    }));
  });
});
