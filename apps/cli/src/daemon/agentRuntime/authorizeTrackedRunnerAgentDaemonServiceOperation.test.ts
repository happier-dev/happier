import { describe, expect, it, vi } from 'vitest';

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
    runnerProcessIdentity: { pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash },
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
  it('requires the exact live native input under the same runner and source custody without a Queue witness', () => {
    const current = tracked();
    delete current.agentRuntimeDaemonServiceAdmittedTurnId;
    const admission = { admissionId: 'native-input', occurrenceId: 'realtime-occurrence', attemptId: 'attempt-1' };
    const nativeWitness = { turnId: 'provider-turn-1', inputId: admission.admissionId, userMessageSeq: null,
      userMessageSeqs: [], nativeRealtimeAdmission: admission,
      agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
    const request = { tracked: current, ...direct, witness: nativeWitness, allowIdleCurrentGeneration: false };
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation(request)).toBe(false);
    current.agentRuntimeDaemonServiceNativeRealtimeAdmission = { admission, runner, sourceCustody: binding.sourceCustody };
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation(request)).toBe(true);
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({ ...request, witness: { ...nativeWitness, turnId: 'provider-turn-2' } })).toBe(true);
    for (const denied of [
      { ...nativeWitness, nativeRealtimeAdmission: { ...admission, attemptId: 'attempt-2' } },
      { ...nativeWitness, inputId: 'queue-like-forgery' },
      { ...nativeWitness, userMessageSeq: 1, userMessageSeqs: [1] },
      { ...nativeWitness, nativeRealtimeAdmission: undefined },
      { ...nativeWitness, agentStartCaller: undefined },
      { ...nativeWitness, agentStartCaller: { ...nativeWitness.agentStartCaller, sessionId: 'another-session' } },
    ]) expect(authorizeTrackedRunnerAgentDaemonServiceOperation({ ...request, witness: denied })).toBe(false);
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({ ...request, sessionId: 'another-session' })).toBe(false);
    current.agentRuntimeDaemonServiceNativeRealtimeAdmission = { admission, runner: { ...runner, processStartTimeMs: 456 }, sourceCustody: binding.sourceCustody };
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation(request)).toBe(false);
    current.agentRuntimeDaemonServiceNativeRealtimeAdmission = { admission, runner,
      sourceCustody: { kind: 'managed', immutableGenerationId: 'different-source', installSource: 'localPath' } };
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation(request)).toBe(false);
    delete current.agentRuntimeDaemonServiceNativeRealtimeAdmission;
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation(request)).toBe(false);
  });
  it.each(['snapshot', 'session', 'source_custody', 'runner_process'] as const)('diagnoses only the failed %s predicate', predicate => {
    const current = tracked();
    if (predicate === 'session') current.happySessionId = 'other-session';
    if (predicate === 'source_custody') delete current.runnerAgentSourceCustodyV1;
    if (predicate === 'runner_process') current.runnerProcessIdentity = { ...runner, pid: runner.pid + 1 };
    const onRefused = vi.fn();
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({ tracked: current, ...direct, witness: undefined,
      allowIdleCurrentGeneration: true, runSnapshotCurrent: predicate !== 'snapshot', onRefused })).toBe(false);
    expect(onRefused.mock.calls).toEqual([[predicate]]);
  });

  it('refuses an unwitnessed child role even when wrapper and child birth samples coincide', () => {
    const unwitnessed = tracked();
    delete unwitnessed.runnerProcessIdentity;
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: unwitnessed, ...direct, witness, allowIdleCurrentGeneration: false,
    })).toBe(false);
    unwitnessed.pid = runner.pid;
    delete unwitnessed.sessionRunnerPid;
    unwitnessed.reattachedFromDiskMarker = true;
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation({
      tracked: unwitnessed, ...direct, witness, allowIdleCurrentGeneration: false,
    })).toBe(true);
  });

  it('admits the captured runner behind a live wrapper and refuses a replaced runner generation', () => {
    const admitted = tracked();
    admitted.processStartTimeMs = 100;
    admitted.runnerProcessIdentity = { ...runner };
    const request = { tracked: admitted, ...direct, witness, allowIdleCurrentGeneration: false };
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation(request)).toBe(true);
    admitted.runnerProcessIdentity = { ...runner, processStartTimeMs: runner.processStartTimeMs + 1 };
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation(request)).toBe(false);
    admitted.runnerProcessIdentity = { ...runner, pid: runner.pid + 1 };
    expect(authorizeTrackedRunnerAgentDaemonServiceOperation(request)).toBe(false);
  });

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
    reattached.runnerProcessIdentity = { ...runner, processStartTimeMs: runner.processStartTimeMs + 1 };
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
