import { describe, it, expect } from 'vitest';

import { AcpReplayCapture } from '../acpReplayCapture';
import type { SessionUpdate } from '../../sessionUpdateHandlers';

describe('AcpReplayCapture', () => {
  it('retains standard tool image content without copying image bytes into a synthetic call input', () => {
    const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' };
    const capture = new AcpReplayCapture();
    capture.handleUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'read-image', status: 'completed', content: [image] });
    const replay = capture.finalize();
    expect(replay[0]).toMatchObject({ type: 'tool_call', toolCallId: 'read-image', rawInput: [] });
    expect(replay[1]).toMatchObject({ type: 'tool_result', content: [image] });
  });

  it.each(['', 'inspect this'])('retains image chunks next to message text (%j)', text => {
    // Standard ACP session/load image chunk; pinned producer provenance is recorded in the lane evidence.
    const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' };
    const capture = new AcpReplayCapture();
    if (text) capture.handleUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
    capture.handleUpdate({ sessionUpdate: 'user_message_chunk', content: image });
    capture.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
    expect(capture.finalize()).toEqual([
      { type: 'message', role: 'user', text, content: [image] },
      { type: 'message', role: 'agent', text: 'done' },
    ]);
  });

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
