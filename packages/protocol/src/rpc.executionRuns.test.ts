import { describe, expect, it } from 'vitest';

import { SESSION_RPC_METHODS } from './rpc.js';

describe('SESSION_RPC_METHODS (execution runs)', () => {
  it('includes execution.run.* methods', () => {
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_START).toBe('execution.run.start');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_LIST).toBe('execution.run.list');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_GET).toBe('execution.run.get');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT).toBe('execution.run.wait');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION).toBe('execution.run.action');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2).toBe('execution.run.stream.start.v2');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1).toBe(
      'execution.run.userTranscript.commit.v1',
    );
  });
});

describe('SESSION_RPC_METHODS (visible agents)', () => {
  it('names the exact visible/role-bearing start, child-turn report, and prompt preview methods', () => {
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2).toBe('execution.run.start.v2');
    expect(SESSION_RPC_METHODS.SESSION_EXECUTION_RUN_CHILD_TURN_REPORT_V1).toBe('session.executionRun.childTurn.report.v1');
    expect(SESSION_RPC_METHODS.SESSION_PROMPT_PREVIEW_GET_V1).toBe('session.promptPreview.get.v1');
  });
});
