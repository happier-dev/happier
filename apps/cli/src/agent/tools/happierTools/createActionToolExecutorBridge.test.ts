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
});
