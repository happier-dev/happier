import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { encodeAgentLaunchFrame, readAgentLaunchFrame, type AgentLaunchPayload } from './agentLaunchFrame';

const payload: AgentLaunchPayload = {
  v: 1, executable: '/usr/bin/cat', args: [], cwd: '/srv/happier/project',
  runtimeHome: '/home/happier-agent/.local/state/happier/runtime/session',
  environment: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'selected-secret' },
  selectedMaterials: [{ relativePath: '.config/provider/auth', contentBase64: Buffer.from([0, 255, 10]).toString('base64') }],
};

describe('Agent launch stdin frame', () => {
  it('consumes exactly a fragmented frame, leaving binary provider stdin and EOF', async () => {
    const input = new PassThrough();
    const frame = encodeAgentLaunchFrame(payload);
    const tail = Buffer.from([0, 255, 13, 10, 128]);
    const result = readAgentLaunchFrame(input);
    for (const byte of frame.subarray(0, frame.length - 2)) input.write(Buffer.from([byte]));
    input.end(Buffer.concat([frame.subarray(frame.length - 2), tail]));
    expect(await result).toEqual(payload);
    const received: Buffer[] = [];
    for await (const chunk of input) received.push(Buffer.from(chunk));
    expect(Buffer.concat(received)).toEqual(tail);
  });

  it('rejects truncated input and unknown frame fields without exposing selected bytes', async () => {
    const truncated = new PassThrough();
    truncated.end(encodeAgentLaunchFrame(payload).subarray(0, 15));
    await expect(readAgentLaunchFrame(truncated)).rejects.toMatchObject({ code: 'agent_launch_frame_invalid' });
    expect(() => encodeAgentLaunchFrame({ ...payload, unexpected: 'selected-secret' } as AgentLaunchPayload))
      .toThrow('agent_launch_frame_invalid');
  });
});

describe('Agent launch PTY frame', () => {
  it('preserves the exact binary frame through fragmented PTY text writes and leaves interactive input', async () => {
    const input = new PassThrough();
    const frame = encodeAgentLaunchFrame(payload).toString('base64') + '\n';
    const parsed = readAgentLaunchFrame(input, 'terminal');
    for (const char of frame.slice(0, -1)) input.write(char);
    input.end('\ninteractive input\n');
    expect(await parsed).toEqual(payload);
    const received: Buffer[] = [];
    for await (const chunk of input) received.push(Buffer.from(chunk));
    expect(Buffer.concat(received).toString()).toBe('interactive input\n');
  });
  it('rejects malformed or trailing native bytes before execution', async () => {
    for (const value of ['!invalid!\n', Buffer.concat([encodeAgentLaunchFrame(payload), Buffer.from('extra')]).toString('base64') + '\n']) {
      const input = new PassThrough(); input.end(value);
      await expect(readAgentLaunchFrame(input, 'terminal')).rejects.toMatchObject({ code: 'agent_launch_frame_invalid' });
    }
  });
});
