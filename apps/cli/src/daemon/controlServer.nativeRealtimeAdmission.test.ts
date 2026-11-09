import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonSessionAccountActionExecutor } from './agentRuntime/createDaemonSessionAccountActionExecutor';
import { configuration } from '@/configuration';
import { AGENT_RUNTIME_DAEMON_SERVICES_PATH, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createDaemonControlApp } from './controlServer';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from './agentRuntime/sessionBridgeAuthorization';
import type { TrackedSession } from './types';
import { createDaemonAdmissionDrain } from './lifecycle/admissionDrain';
import { applyTrackedSessionTurnLifecycle } from './sessions/applyTrackedSessionTurnLifecycle';
import { writeSessionMarker, removeSessionMarker } from './sessionRegistry';

const capabilityA = 'A'.repeat(43);

function createRetainedAgent() {
  return createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: 'acme.plugin',
    pluginVersion: '1.2.3',
    agentId: 'acme-agent',
    localAgentId: 'acme-agent',
    sourceCustody: {
      kind: 'managed',
      immutableGenerationId: `sha256:${'1'.repeat(64)}`,
      installSource: 'npm',
    },
    locator: {
      module: './runtime.mjs',
      export: 'createRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: '/immutable/acme/runtime.mjs',
    loadMode: 'immutable-js',
  });
}

describe('daemon native Realtime input admission', () => {
  it('admits connected-account identity observations while idle and draining without admitting a turn', async () => {
    const sessionId = 'connected-account-observation-session';
    const retainedAgent = createRetainedAgent();
    const runner = { pid: 2246, processStartTimeMs: 1_717_171_717_801,
      processCommandHash: 'd'.repeat(64), snapshotIdentity: 'snapshot:connected-account-observation' };
    const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing });
    const authority = await publishAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path: authorityPath, sessionId, runner, retainedAgent, httpPort: 46_010,
      capability: capabilityA, readPluginHardRevocationRevision: async () => 0 });
    const tracked: TrackedSession = { startedBy: 'daemon', pid: runner.pid, sessionRunnerPid: runner.pid,
      happySessionId: sessionId, processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
      agentRuntimeDaemonServiceAuthorityFilePath: authorityPath, agentRuntimeDaemonServiceCapabilityHash: authority.capabilityDigest,
      runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
      runnerAgentInvocationContext: { cwd: '/workspace', environment: {}, providerBindingActive: false } };
    const observations: unknown[] = [];
    const admissionDrain = createDaemonAdmissionDrain();
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'guest', admissionDrain,
      stopSession: async () => ({ status: 'not_found' as const }), spawnSession: async () => ({ type: 'success' as const, sessionId }),
      requestShutdown() {}, onHappySessionWebhook() {}, controlToken: 'control-token',
      // The service handler is the boundary beneath the real control-route admission.
      agentRuntimeDaemonServices: { dispatch: async (request, subject) => {
        if (request.operation.kind !== 'connected_account.identity.observe') throw new Error('Unexpected service operation');
        expect(await subject.isCurrent()).toBe(true);
        observations.push(request.operation.observation);
        return { ok: true, result: { kind: 'connected_account.identity.observed' } };
      } } });
    const observation = { kind: 'connected-account-identity-observed', sequence: 1, sessionId,
      emittedAtMs: 100, observedAtMs: 99, service: { pluginId: 'acme.plugin', localId: 'subscription' },
      nativeSessionId: 'native-1', providerOrganizationId: 'org-1' };
    const send = (sourceSessionId = sessionId, token = capabilityA) => app.inject({ method: 'POST',
      url: AGENT_RUNTIME_DAEMON_SERVICES_PATH, headers: { 'x-happier-daemon-token': token },
      payload: { v: 1, context: { token, sessionId: sourceSessionId },
        operation: { kind: 'connected_account.identity.observe', observation } } });
    let releaseDrain = () => {};
    try {
      await writeSessionMarker({ pid: runner.pid, happySessionId: sessionId, startedBy: 'daemon', cwd: '/workspace' });
      const idle = await send();
      expect(idle.statusCode).toBe(200);
      expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(idle.json())).toEqual({ ok: true,
        result: { kind: 'connected_account.identity.observed' } });
      expect((await send('foreign-observation-session')).statusCode).toBe(403);
      expect((await send(sessionId, 'B'.repeat(43))).statusCode).toBe(403);
      releaseDrain = admissionDrain.beginTemporaryDrain();
      const draining = await send();
      expect(draining.statusCode).toBe(200);
      expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(draining.json())).toEqual({ ok: true,
        result: { kind: 'connected_account.identity.observed' } });
      expect(observations).toEqual([observation, observation]);
      expect(tracked.activeTurnId).toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedTurnId).toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceNativeRealtimeAdmission).toBeUndefined();
    } finally {
      releaseDrain();
      await app.close();
      await removeSessionMarker(runner.pid);
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path: authorityPath, capabilityDigest: authority.capabilityDigest });
    }
  });

  it('admits one native input in authenticated runner custody and retires only the matching attempt', async () => {
    const sessionId = 'native-realtime-session';
    const retainedAgent = createRetainedAgent();
    const runner = { pid: 2245, processStartTimeMs: 1_717_171_717_800,
      processCommandHash: 'c'.repeat(64), snapshotIdentity: 'snapshot:native-realtime' };
    const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing });
    const authority = await publishAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path: authorityPath, sessionId, runner, retainedAgent, httpPort: 46_009,
      capability: capabilityA, readPluginHardRevocationRevision: async () => 0 });
    const tracked: TrackedSession = { startedBy: 'daemon', pid: runner.pid, sessionRunnerPid: runner.pid,
      happySessionId: sessionId, processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
      agentRuntimeDaemonServiceAuthorityFilePath: authorityPath, agentRuntimeDaemonServiceCapabilityHash: authority.capabilityDigest,
      runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
      runnerAgentInvocationContext: { cwd: '/workspace', environment: {}, providerBindingActive: false } };
    let currentAction: (() => Promise<boolean>) | undefined;
    const delivered: unknown[] = [];
    // Home reads and notification delivery are the genuine external boundaries.
    const home = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: sessionId, share: null }) } });
    const execute = createDaemonSessionAccountActionExecutor({
      serverId: 'native-home', serverHttpBaseUrl: 'https://native-home.test', token: 'native-daemon-token',
      createExecutor: () => createActionExecutor({
        ...createCliActionDeps({ token: 'native-daemon-token', sessionId: '', mode: 'plain', ctx: null }),
        notificationsNotifyMe: async (input, context) => {
          delivered.push({ input, context });
          return { attemptedChannels: 1, deliveredChannels: 1 };
        },
      }),
    });
    const admissionDrain = createDaemonAdmissionDrain();
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'guest', admissionDrain,
      stopSession: async () => ({ status: 'not_found' as const }), spawnSession: async () => ({ type: 'success' as const, sessionId }),
      requestShutdown() {}, onHappySessionWebhook() {}, controlToken: 'control-token',
      agentRuntimeDaemonServices: { dispatch: async (request, subject) => {
        if (request.operation.kind !== 'action.execute') throw new Error('Native input must remain in control-server custody');
        currentAction = subject.isCurrent;
        return { ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId,
          outcome: await execute(request.operation, subject) } };
      } } });
    const admission = { admissionId: 'native-input-1', occurrenceId: 'occurrence-1', attemptId: 'attempt-1' };
    let releaseDrain = () => {};
    const send = (operation: unknown, sourceSessionId = sessionId) => app.inject({ method: 'POST',
      url: AGENT_RUNTIME_DAEMON_SERVICES_PATH, headers: { 'x-happier-daemon-token': capabilityA },
      payload: { v: 1, context: { token: capabilityA, sessionId: sourceSessionId }, operation } });
    const action = { kind: 'action.execute', requestId: 'native-action', actionId: 'notifications.notify_me', input: { message: 'Finished' },
      witness: { turnId: 'provider-turn', inputId: admission.admissionId, userMessageSeq: null, userMessageSeqs: [],
        nativeRealtimeAdmission: admission, workDepth: 0,
        agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } } };
    try {
      await writeSessionMarker({ pid: runner.pid, happySessionId: sessionId, startedBy: 'daemon', cwd: '/workspace' });
      expect((await send(action)).statusCode).toBe(403);
      const admitted = await send({ kind: 'native_realtime.input.admit', admission });
      expect(admitted.statusCode).toBe(200);
      expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(admitted.json())).toEqual({ ok: true,
        result: { kind: 'native_realtime.input.admission', admission } });
      expect((await send({ kind: 'native_realtime.input.admit', admission })).statusCode).toBe(200);
      expect((await send({ kind: 'native_realtime.input.admit', admission: { ...admission, attemptId: 'attempt-2' } })).statusCode).toBe(403);
      expect((await send(action, 'another-session')).statusCode).toBe(403);
      const executed = await send(action);
      expect(executed.statusCode).toBe(200);
      expect(executed.json()).toMatchObject({ ok: true, result: { outcome: { ok: true } } });
      expect(delivered).toEqual([expect.objectContaining({ context: expect.objectContaining({ nativeRealtimeInput: true }) })]);
      expect((await send({ ...action, actionId: 'approval.request.decide',
        input: { artifactId: 'ordinary-approval', decision: 'approve' } })).json())
        .toMatchObject({ ok: true, result: { outcome: { ok: false, errorCode: 'present_user_required' } } });
      expect(await currentAction?.()).toBe(true);
      expect(tracked.activeTurnId).toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedTurnId).toBeUndefined();
      for (const turnId of ['native-speech-turn-1', 'native-speech-turn-2']) {
        expect(await applyTrackedSessionTurnLifecycle({ trackedSessions: [tracked], sessionId, event: 'task_started', turnId }))
          .toEqual({ status: 'recorded', activeTurnId: turnId });
        expect((await send({ ...action, witness: { ...action.witness, turnId } })).json())
          .toMatchObject({ ok: true, result: { outcome: { ok: true } } });
        expect(await applyTrackedSessionTurnLifecycle({ trackedSessions: [tracked], sessionId, event: 'assistant_message_end', turnId }))
          .toEqual({ status: 'recorded', activeTurnId: null });
        expect(await currentAction?.()).toBe(true);
        expect(await applyTrackedSessionTurnLifecycle({ trackedSessions: [tracked], sessionId,
          event: 'prompt_or_steer', activeTurnIdWitness: null })).toEqual({ status: 'recorded', activeTurnId: null });
        expect(await currentAction?.()).toBe(true);
        expect((await send({ ...action, witness: { ...action.witness, turnId: `${turnId}-next` } })).json())
          .toMatchObject({ ok: true, result: { outcome: { ok: true } } });
      }
      await send({ kind: 'native_realtime.input.retire', admission: { ...admission, attemptId: 'attempt-2' } });
      expect(await currentAction?.()).toBe(true);
      expect((await send({ ...action, witness: { ...action.witness, nativeRealtimeAdmission: undefined } })).statusCode).toBe(403);
      releaseDrain = admissionDrain.beginTemporaryDrain();
      expect((await send({ kind: 'native_realtime.input.retire', admission })).json()).toEqual({ ok: true,
        result: { kind: 'native_realtime.input.retired' } });
      releaseDrain();
      expect(await currentAction?.()).toBe(false);
      expect((await send(action)).statusCode).toBe(403);
      await send({ kind: 'native_realtime.input.admit', admission: { ...admission, attemptId: 'attempt-2' } });
      expect((await send(action)).statusCode).toBe(403);
    } finally { releaseDrain(); home.mockRestore(); await app.close(); await removeSessionMarker(runner.pid);
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path: authorityPath, capabilityDigest: authority.capabilityDigest }); }
  });
});
