import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import {
  createTestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/testkit';

const runtimeFactoryMock = vi.hoisted(() => ({
  createExecutionRunBridgeRuntime: vi.fn(),
}));
const markerWriterMock = vi.hoisted(() => ({
  writeExecutionRunMarker: vi.fn(async () => {}),
}));

vi.mock('./createExecutionRunBridgeRuntime', () => ({
  createExecutionRunBridgeRuntime: runtimeFactoryMock.createExecutionRunBridgeRuntime,
}));

vi.mock('@/daemon/executionRunRegistry', () => ({
  writeExecutionRunMarker: markerWriterMock.writeExecutionRunMarker,
}));

import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';

const TEST_BACKEND_ID = `${'task'}.${'backend'}` as never;

describe('ExecutionRunHostBridge detached task scope', () => {
  beforeEach(() => {
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockReset();
    markerWriterMock.writeExecutionRunMarker.mockClear();
  });

  it('executes a detached structured generic task at the incumbent run and marker owner without Session facts', async () => {
    const sent = vi.fn(async () => {});
    const committed = vi.fn(async () => ({ persisted: true, delivered: false }));
    const publicRuns: unknown[] = [];
    const parentSessionMutation = vi.fn(async () => {});
    const createdRuntimeOptions: Array<Record<string, unknown>> = [];
    const prompts: string[] = [];

    let runtime!: TestExecutionRunHostRuntime;
    runtime = createTestExecutionRunHostRuntime({
      onSendPrompt: async (_sessionId, prompt) => {
        prompts.push(prompt);
        runtime.emitMessage({ type: 'model-output', fullText: '{"answer":"detached result"}' } as AgentMessage);
      },
      onWaitForTurnCompletion: async () => {},
    });
    runtimeFactoryMock.createExecutionRunBridgeRuntime.mockImplementation((options: Record<string, unknown>) => {
      createdRuntimeOptions.push(options);
      return runtime as ExecutionRunHostRuntime;
    });

    const manager = new ExecutionRunHostBridge({
      parentProvider: TEST_BACKEND_ID,
      cwd: process.cwd(),
      sendAcp: sent,
      streamedTranscriptSession: {
        enqueueAgentMessageCommitted: committed,
      },
      parentSessionStateTarget: {
        sessionId: 'parent_session_1',
        enqueueRegisteredSessionStateFieldMutation: parentSessionMutation,
      },
      onPublicStateUpdated: (run) => publicRuns.push(run),
      getNowMs: () => 1_700_000_000_000,
    });

    try {
      const started = await manager.start({
        sessionId: null,
        intent: 'task',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        instructions: 'Return a bounded result.',
        intentInput: {
          input: { topic: 'execution lifecycle' },
          resultSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });

      await manager.waitForTerminal(started.runId);

      expect(manager.get(started.runId)).toMatchObject({
        runId: started.runId,
        sessionId: null,
        intent: 'task',
        status: 'succeeded',
        latestToolResult: { answer: 'detached result' },
      });
      expect(prompts).toEqual([
        expect.stringContaining('Task input (strict JSON):\n{"topic":"execution lifecycle"}'),
      ]);
      expect(prompts[0]).toContain('Return only one strict JSON value that satisfies this required result schema:');
      expect(createdRuntimeOptions).toHaveLength(1);
      expect(createdRuntimeOptions[0]).not.toHaveProperty('parentSessionStateTarget');
      expect(sent).not.toHaveBeenCalled();
      expect(committed).not.toHaveBeenCalled();
      expect(parentSessionMutation).not.toHaveBeenCalled();
      expect(publicRuns).toEqual([]);
      expect(markerWriterMock.writeExecutionRunMarker).toHaveBeenCalledWith(expect.objectContaining({
        runId: started.runId,
        happySessionId: null,
      }));
    } finally {
      await manager.dispose();
    }
  });
});
