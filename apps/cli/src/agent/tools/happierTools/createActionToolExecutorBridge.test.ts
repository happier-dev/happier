import { describe, expect, it } from 'vitest';

import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';

describe('createActionToolExecutorBridge', () => {
  it('passes through approval_request_created results for execution.run.* actions', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async (actionId) => ({
          ok: true,
          result: { kind: 'approval_request_created', artifactId: 'a1', actionId },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.start',
      input: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'execution.run.start' },
    });
  });

  it('normalizes execution.run.wait success payloads instead of returning undefined tool content', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async () => ({
          ok: true,
          result: {
            ok: true,
            status: 'failed',
            result: {
              run: {
                runId: 'run-1',
                status: 'failed',
              },
            },
          },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.wait',
      input: {
        sessionId: 'sess-1',
        runId: 'run-1',
        timeoutSeconds: 5,
      },
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: {
        status: 'failed',
        result: {
          run: {
            runId: 'run-1',
            status: 'failed',
          },
        },
      },
    });
  });

  it('normalizes execution.run.wait timeout payloads into tool errors', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async () => ({
          ok: true,
          result: {
            ok: false,
            code: 'timeout',
          },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.wait',
      input: {
        sessionId: 'sess-1',
        runId: 'run-1',
        timeoutSeconds: 5,
      },
    }, 'sess-1');

    expect(res).toEqual({
      ok: false,
      errorCode: 'timeout',
      error: 'timeout',
    });
  });
});
