import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStandaloneVoicePolicyHarness, prepareStandaloneVoicePolicyHarness } from '@/dev/testkit/harness/standaloneVoicePolicyHarness';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunTurnStreamStartV2RequestSchema, ExecutionRunTurnStreamStartResponseSchema,
  ExecutionRunTurnStreamReadRequestSchema, ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunUserTranscriptCommitRequestSchema, ExecutionRunUserTranscriptCommitResponseSchema,
  type ExecutionRunTurnStreamEvent } from '@happier-dev/protocol/execution/runs/streaming';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
await prepareStandaloneVoicePolicyHarness();
const restoreActionLoader = await installRealActionExecutorModuleLoader();
afterAll(() => restoreActionLoader());
const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');
type Reply = { assistantText: string; actions: VoiceAssistantAction[] };
let replies: Reply[];
let turnIndex = 0;
let daemon: Awaited<ReturnType<typeof createRetainedVoiceAgentRpcBoundary>>;
let home: Awaited<ReturnType<typeof createStandaloneVoicePolicyHarness>> | undefined;
let activation: Awaited<ReturnType<NonNullable<typeof home>['activateLocalAgent']>> | undefined;
const outputs = new Map<string, ExecutionRunTurnStreamEvent[]>();
const wireTurns: Array<ReturnType<typeof ExecutionRunTurnStreamStartV2RequestSchema.parse>> = [];

async function answerTurnRpc(method: string, input: unknown): Promise<unknown> {
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1) {
    ExecutionRunUserTranscriptCommitRequestSchema.parse(input);
    return ExecutionRunUserTranscriptCommitResponseSchema.parse({ ok: true });
  }
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
    wireTurns.push(ExecutionRunTurnStreamStartV2RequestSchema.parse(input));
    const streamId = 'bounded-turn-' + turnIndex++;
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected additional provider turn');
    const events: ExecutionRunTurnStreamEvent[] = reply.actions.map((action, index) => ({
      t: 'voice_output', output: { v: 1, kind: 'side_effect', turnId: streamId, seq: index,
        effectId: streamId + ':effect:' + index, action },
    }));
    events.push({ t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: streamId,
      seq: events.length, text: reply.assistantText } });
    outputs.set(streamId, events);
    return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId });
  }
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
    const request = ExecutionRunTurnStreamReadRequestSchema.parse(input);
    const events = outputs.get(request.streamId);
    if (!events) throw new Error('Unknown bounded Voice stream');
    return ExecutionRunTurnStreamReadResponseSchema.parse({ streamId: request.streamId,
      events: request.cursor === 0 ? events : [], nextCursor: events.length, done: true });
  }
  throw new Error('Unexpected bounded Voice RPC: ' + method);
}

const readAction: VoiceAssistantAction = { t: 'listAgentBackends', args: {} };
describe('runVoiceAgentTurnWithTools interruptible tool loop', () => {
  beforeEach(async () => {
    replies = []; turnIndex = 0; outputs.clear(); wireTurns.length = 0;
    daemon = await createRetainedVoiceAgentRpcBoundary({ handleOtherRpc: answerTurnRpc });
    home = await createStandaloneVoicePolicyHarness({ mode: 'off', dispatch: daemon.dispatch });
    activation = await home.activateLocalAgent();
  });
  afterEach(async () => {
    try { await activation?.dispose(); }
    finally { activation = undefined; await home?.dispose(); home = undefined; }
  });

  it('continues valid tool work beyond both retired round ceilings and publishes only the terminal answer', async () => {
    replies = [
      ...Array.from({ length: 9 }, () => ({ assistantText: 'Checking.', actions: [readAction] })),
      { assistantText: 'The checks completed.', actions: [] },
    ];
    const onAssistantTurn = vi.fn();
    const onToolResults = vi.fn();
    const onOutputEvent = vi.fn();
    const result = await runVoiceAgentTurnWithTools({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, userText: 'check and change it',
      durableLocalId: 'tool-round-limit-1', voiceAgentSessions,
      onAssistantTurn, onToolResults, onOutputEvent,
    });
    expect(result).toMatchObject({ disposition: 'completed',
      assistantTurns: ['The checks completed.'], totalActions: 9 });
    expect(result.toolResultBatches).toHaveLength(9);
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({ t: 'listAgentBackends', args: {} });
    expect(daemon.readRetainedRun()).toMatchObject({ status: 'running' });
    expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
    expect(onAssistantTurn).toHaveBeenCalledTimes(1);
    expect(onAssistantTurn).toHaveBeenCalledWith({ assistantText: 'The checks completed.', actions: [], turnIndex: 9 });
    expect(onToolResults).toHaveBeenCalledTimes(9);
    expect(onOutputEvent.mock.calls.map(([output]) => JSON.stringify(output)).join('\n')).toContain('The checks completed.');
    expect(wireTurns).toHaveLength(10);
    expect(daemon.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([]);
  });

  it('stops requesting follow-ups when speech or End aborts after a tool result', async () => {
    replies = [{ assistantText: 'Checking.', actions: [readAction] }];
    const controller = new AbortController();
    await expect(runVoiceAgentTurnWithTools({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      userText: 'check until I interrupt', durableLocalId: 'interruptible-tool-loop', voiceAgentSessions,
      signal: controller.signal, onToolResults: () => controller.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(wireTurns).toHaveLength(1);
    expect(replies).toEqual([]);
  });

  it('publishes an actionless terminal answer without retiring the conversation', async () => {
    replies = [
      { assistantText: 'I will check once.', actions: [readAction] },
      { assistantText: 'The check completed.', actions: [] },
    ];
    const onAssistantTurn = vi.fn();
    const result = await runVoiceAgentTurnWithTools({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      userText: 'check it', durableLocalId: 'tool-round-limit-2', voiceAgentSessions,
      onAssistantTurn });
    expect(result.disposition).toBe('completed');
    expect(result.assistantTurns).toEqual(['The check completed.']);
    expect(onAssistantTurn).toHaveBeenLastCalledWith({
      assistantText: 'The check completed.', actions: [], turnIndex: 1,
    });
    expect(daemon.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([]);
  });
});
