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
  sourceCustody: {
    kind: 'managed',
    immutableGenerationId: 'generation-g',
    installSource: 'localPath',
  },
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
    runnerAgentSourceCustodyV1: binding.sourceCustody,
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
  it('checks the complete admitted batch, including a changed sequence beyond 4096', () => {
    const userMessageSeqs = Array.from({ length: 4097 }, (_, index) => index + 1);
    const admitted = tracked();
    admitted.agentRuntimeDaemonServiceAdmittedUserMessageSeqs = userMessageSeqs;
    const batchWitness = { ...witness, userMessageSeqs: [...userMessageSeqs] };
    const request = { tracked: admitted, ...direct, witness: batchWitness, allowIdleCurrentGeneration: false };
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation(request)).toBe(true);
    batchWitness.userMessageSeqs[4096] = 4098;
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation(request)).toBe(false);
  });
  it('admits only the exact session, runner, retained Agent, and active-turn witness', () => {
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: tracked(),
      ...direct,
      witness,
      allowIdleCurrentGeneration: false,
    })).toBe(true);
    const reattached = tracked();
    reattached.processCommandHash = '6'.repeat(64);
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: reattached,
      ...direct,
      witness,
      allowIdleCurrentGeneration: false,
    })).toBe(true);
    reattached.processStartTimeMs = runner.processStartTimeMs + 1;
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: reattached,
      ...direct,
      witness,
      allowIdleCurrentGeneration: false,
    })).toBe(false);

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
    replaced.runnerAgentSourceCustodyV1 = {
      kind: 'managed',
      immutableGenerationId: 'generation-replaced',
      installSource: 'localPath',
    };
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: replaced,
      ...direct,
      witness,
      allowIdleCurrentGeneration: false,
    })).toBe(false);
  });
});
