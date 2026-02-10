import { describe, it, expect } from 'vitest';

import { AcpReplayCapture } from '../acpReplayCapture';
import type { SessionUpdate } from '../../sessionUpdateHandlers';

describe('AcpReplayCapture', () => {
  it('seeds a synthetic tool_call when the provider only emits tool_call_update', () => {
    const capture = new AcpReplayCapture();

    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bash-1',
      status: 'completed',
      kind: 'bash',
      title: 'Run echo hello',
      rawInput: { command: 'echo hello' },
      rawOutput: { stdout: 'hello\n' },
    };

    capture.handleUpdate(update);

    const replay = capture.finalize();
    expect(replay).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'bash-1',
        kind: 'bash',
        title: 'Run echo hello',
        rawInput: { command: 'echo hello' },
      },
      {
        type: 'tool_result',
        toolCallId: 'bash-1',
        status: 'completed',
        rawOutput: { stdout: 'hello\n' },
        content: undefined,
      },
    ]);
  });
});
