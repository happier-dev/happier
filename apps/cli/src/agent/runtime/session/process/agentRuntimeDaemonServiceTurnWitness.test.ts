import { describe, expect, it } from 'vitest';
import {
  admitAgentStartV1,
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  type AgentStartContextV1,
} from '@happier-dev/protocol';
import type {
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { stampTurnFacts } from '@/agent/runtime/session/turn/stampTurnFacts';
import { AgentRuntimeDaemonServiceRequestV1Schema } from './agentRuntimeDaemonServiceProtocol';
import { AgentRuntimeDaemonServiceTurnWitnessV1Schema, projectAgentRuntimeDaemonServiceTurnWitnessV1 } from './agentRuntimeDaemonServiceTurnWitness';
import { SessionIndexedIdentifierMaxLengthV1 } from '@happier-dev/protocol/sessions/idsV1';

describe('daemon service host turn depth', () => {
  it.each([
    { name: 'fresh session', starterDepth: 0, senderDepth: undefined, turnDepth: 0, workDepth: 0, messageCount: 1 },
    { name: 'depth-2 worker on a user turn', starterDepth: 2, senderDepth: undefined, turnDepth: 0, workDepth: 2, messageCount: 1 },
    { name: 'agent-caused turn deeper than its session', starterDepth: 1, senderDepth: 3, turnDepth: 4, workDepth: 4, messageCount: 1 },
    { name: 'batched turn with 4097 admitted messages', starterDepth: 0, senderDepth: undefined, turnDepth: 0, workDepth: 0, messageCount: 4097 },
  ])('preserves $name depth from the native host through daemon admission', async ({ starterDepth, senderDepth, turnDepth, workDepth, messageCount }) => {
    const userMessageSeqs = Array.from({ length: messageCount }, (_, index) => index + 1);
    const facts = stampTurnFacts({
      sessionWorkDepth: starterDepth,
      ...(senderDepth === undefined ? {} : {
        provenance: { v: 1 as const, kind: 'happierSession' as const, sourceSessionId: 'sender', via: 'mcp' as const, callerDepth: senderDepth },
      }),
    });
    const caller = { kind: 'session' as const, sessionId: 'session-1', starterDepth, turnDepth: facts.workDepth };
    const providerRequests: Parameters<AgentSessionRuntime['send']>[0][] = [];
    const provider: AgentSessionRuntime = {
      async send(request) {
        providerRequests.push(request);
        return { status: 'admitted' };
      },
      watch: () => ({ dispose() {} }),
      dispose() {},
    };
    const admittedWitnesses: unknown[] = [];
    const native = createNativeAgentSessionOperations(
      provider, 'session-1', undefined, undefined, undefined, undefined, undefined,
      {
        context: {} as AgentSessionRuntimeContext,
        cwd: '/workspace', connectedAccounts: [],
        capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
      },
      undefined, [], undefined, undefined,
      async (witness) => {
        const projected = projectAgentRuntimeDaemonServiceTurnWitnessV1(witness);
        const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({
          v: 1, context: { sessionId: 'session-1', token: 'A'.repeat(43) },
          operation: { kind: 'turn.admission.authorize', requestId: witness.inputId, witness: projected },
        });
        admittedWitnesses.push(request.operation);
        return { status: 'admitted' };
      },
    );
    try {
      const meta = { localId: 'input-1', turnId: 'turn-1', agentStartCaller: caller, userMessageSeqs };
      await native.sendTurnPrompt('Work on the task', meta);
      expect(admittedWitnesses).toEqual([expect.objectContaining({
        witness: expect.objectContaining({ workDepth, agentStartCaller: { ...caller, turnDepth } }),
      })]);
      const active = native.readActiveTurnAdmissionWitness?.();
      expect(active).toMatchObject({ agentStartCaller: caller });
      if (!active) throw new Error('Expected an active admitted turn');
      const parsed = projectAgentRuntimeDaemonServiceTurnWitnessV1(active);
      expect(parsed).toMatchObject({ workDepth, agentStartCaller: caller });
      expect(parsed.userMessageSeqs).toEqual(userMessageSeqs);
      if (!parsed.agentStartCaller) throw new Error('Expected host Session caller facts');
      expect(providerRequests[0]).not.toHaveProperty('agentStartCaller');
      expect(providerRequests[0]).not.toHaveProperty('workDepth');
      expect(providerRequests[0]?.input).not.toHaveProperty('agentStartCaller');
      caller.turnDepth = 99;
      expect(native.readActiveTurnAdmissionWitness?.()?.agentStartCaller?.turnDepth).toBe(turnDepth);
      const context: AgentStartContextV1 = {
        caller: parsed.agentStartCaller,
        baseline: { machineId: 'machine-1', directory: '/workspace', configuration: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'agent' } },
        } },
        ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'default',
      };
      expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'spawn_new', facts: {} }, context))
        .toMatchObject(workDepth === 4
          ? { ok: false, refusal: { code: 'work_depth_exceeded' } }
          : { ok: true, stamped: { workDepth: workDepth + 1 } });
    } finally {
      await native.resetOrDisposeRuntime();
    }
  });

  it('does not invent session caller depth when host facts are unavailable', () => {
    const projected = projectAgentRuntimeDaemonServiceTurnWitnessV1({
      inputId: 'input-1', turnId: 'turn-1', userMessageSeq: null, userMessageSeqs: [],
    });
    expect(projected).not.toHaveProperty('workDepth');
    expect(projected).not.toHaveProperty('agentStartCaller');
  });

  it('retains exact canonical Session identity on the private daemon request', () => {
    const sessionId = 's'.repeat(SessionIndexedIdentifierMaxLengthV1);
    const witness = projectAgentRuntimeDaemonServiceTurnWitnessV1({
      inputId: 'input-1', turnId: 'turn-1', userMessageSeq: null, userMessageSeqs: [],
    });
    const request = {
      v: 1, context: { sessionId, token: 'A'.repeat(43) },
      operation: { kind: 'turn.admission.authorize', requestId: 'input-1', witness },
    };
    expect(AgentRuntimeDaemonServiceRequestV1Schema.parse(request).context.sessionId).toBe(sessionId);
    for (const invalidId of [`${sessionId}s`, ' lead', 'lead ']) {
      expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse({
        ...request, context: { ...request.context, sessionId: invalidId },
      }).success).toBe(false);
    }
  });

  it('rejects malformed host depth rather than normalizing it to zero', () => {
    const witness = {
      inputId: 'input-1', turnId: 'turn-1', userMessageSeq: null, userMessageSeqs: [],
      agentStartCaller: { kind: 'session' as const, sessionId: 'session-1', starterDepth: -1, turnDepth: 0 },
    };
    expect(() => projectAgentRuntimeDaemonServiceTurnWitnessV1(witness)).toThrow();
  });

  it('rejects a forged depth or extra caller authority on the private daemon request', () => {
    const witness = projectAgentRuntimeDaemonServiceTurnWitnessV1({
      inputId: 'input-1', turnId: 'turn-1', userMessageSeq: null, userMessageSeqs: [],
      agentStartCaller: { kind: 'session', sessionId: 'session-1', starterDepth: 2, turnDepth: 0 },
    });
    expect(AgentRuntimeDaemonServiceTurnWitnessV1Schema.safeParse({ ...witness, workDepth: 0 }).success).toBe(false);
    expect(AgentRuntimeDaemonServiceTurnWitnessV1Schema.safeParse({
      ...witness, agentStartCaller: { ...witness.agentStartCaller, initiator: 'user' },
    }).success).toBe(false);
  });
});
