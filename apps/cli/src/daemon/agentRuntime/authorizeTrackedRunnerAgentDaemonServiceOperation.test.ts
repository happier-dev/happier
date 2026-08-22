import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '../types';
import {
  createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  authorizeTrackedRunnerAgentDaemonServiceOperation,
} from './authorizeTrackedRunnerAgentDaemonServiceOperation';

const binding = createAgentSessionRunnerFactoryBinding({
  v: 1,
  pluginId: 'plugin.runner',
  pluginVersion: '1.0.0',
  agentId: 'runner',
  localAgentId: 'runner',
  immutableGenerationId: 'generation-g',
  locator: {
    module: './runtime.mjs',
    export: 'createRuntime',
    runtimeApiVersion: 1,
  },
  normalizedModulePath: 'runtime.mjs',
  loadMode: 'immutable-js',
});
const sessionId = 'session-1';
const runner = {
  pid: 42,
  processStartTimeMs: 123,
  processCommandHash: '5'.repeat(64),
  snapshotIdentity: 'snapshot:test',
};
const direct = Object.freeze({
  sessionId,
  runner,
  retainedAgent: binding,
});
const witness = {
  turnId: 'turn-1',
  inputId: 'input-1',
  userMessageSeq: 7,
  userMessageSeqs: [6, 7],
};

function tracked(): TrackedSession {
  return {
    pid: 41,
    sessionRunnerPid: 42,
    startedBy: 'daemon',
    happySessionId: 'session-1',
    runnerAgentImmutableGenerationId:
      binding.immutableGenerationId,
    processStartTimeMs: 123,
    processCommandHash: '5'.repeat(64),
    agentRuntimeDaemonServiceAdmittedTurnId:
      witness.turnId,
    agentRuntimeDaemonServiceAdmittedInputId:
      witness.inputId,
    agentRuntimeDaemonServiceAdmittedUserMessageSeq:
      witness.userMessageSeq,
    agentRuntimeDaemonServiceAdmittedUserMessageSeqs:
      [...witness.userMessageSeqs],
  };
}

describe('tracked Runner Agent daemon-service operation authority', () => {
  it('admits only the exact session, runner, retained Agent, and active-turn witness', () => {
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: tracked(),
      ...direct,
      witness,
      allowIdleCurrentGeneration: false,
    })).toBe(true);

    for (const deniedWitness of [
      undefined,
      { ...witness, turnId: 'stale' },
      { ...witness, userMessageSeqs: [7] },
    ]) {
      expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
        tracked: tracked(),
        ...direct,
        witness: deniedWitness,
        allowIdleCurrentGeneration: false,
      })).toBe(false);
    }

    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: tracked(),
      ...direct,
      witness: undefined,
      allowIdleCurrentGeneration: true,
    })).toBe(true);

    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: tracked(),
      ...direct,
      witness: { ...witness, inputId: 'forged' },
      allowIdleCurrentGeneration: true,
    })).toBe(false);

    const terminal = tracked();
    delete terminal.agentRuntimeDaemonServiceAdmittedTurnId;
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: terminal,
      ...direct,
      witness: undefined,
      allowIdleCurrentGeneration: false,
    })).toBe(false);
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: terminal,
      ...direct,
      witness: undefined,
      allowIdleCurrentGeneration: true,
    })).toBe(true);

    const replaced = tracked();
    replaced.runnerAgentImmutableGenerationId =
      'generation-replaced';
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: replaced,
      ...direct,
      witness,
      allowIdleCurrentGeneration: false,
    })).toBe(false);
  });
});
