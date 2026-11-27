import { PassThrough } from 'node:stream';
import * as os from 'node:os';
import * as filesystem from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { runAgentLaunchShim } from '../../cli/commands/agentLaunch';

import { encodeAgentLaunchFrame, readAgentLaunchFrame, type AgentLaunchPayload } from './agentLaunchFrame';

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, userInfo: vi.fn(actual.userInfo) };
});

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof filesystem>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const payload: AgentLaunchPayload = {
  v: 1, executable: '/usr/bin/cat', args: [], cwd: '/srv/happier/project',
  runtimeHome: '/home/happier-agent/.local/state/happier/runtime/session',
  environment: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'selected-secret' },
  selectedMaterials: [{ relativePath: '.config/provider/auth', contentBase64: Buffer.from([0, 255, 10]).toString('base64') }],
};

const nativeIdentity = { username: 'hpm-' + '1'.repeat(24), agentUid: 2401, agentGid: 2401,
  home: '/var/lib/happier/members/' + '1'.repeat(64) };
const resolution = { v: 1, action: 'resolve_cwd', nativeIdentity,
  cwd: nativeIdentity.home + '/repo', workspaceRoots: [nativeIdentity.home] };

function rawFrame(record: unknown): PassThrough {
  const body = Buffer.from(JSON.stringify(record));
  const header = Buffer.from('HAPAGT1\n\0\0\0\0', 'ascii');
  header.writeUInt32BE(body.length, 8);
  const input = new PassThrough();
  input.end(Buffer.concat([header, body]));
  return input;
}

describe('Agent launch stdin frame', () => {
  it('accepts the closed directory control frame only on the RunAs control reader', async () => {
    await expect(readAgentLaunchFrame(rawFrame(resolution), undefined, true)).resolves.toEqual(resolution);
    await expect(readAgentLaunchFrame(rawFrame(resolution))).rejects.toMatchObject({ code: 'agent_launch_frame_invalid' });
    for (const invalid of [{ ...resolution, executable: '/bin/cat' }, { ...resolution, nativeIdentity: undefined },
      { ...resolution, nativeIdentity: { ...nativeIdentity, extra: true } }, { ...resolution, workspaceRoots: ['relative'] }]) {
      await expect(readAgentLaunchFrame(rawFrame(invalid), undefined, true)).rejects.toMatchObject({ code: 'agent_launch_frame_invalid' });
    }
  });

  it.skipIf(process.platform !== 'linux')('refuses a mismatched retained UID before looking up any path', async () => {
    const lookup = vi.mocked(filesystem.realpath);
    lookup.mockClear();
    vi.mocked(os.userInfo).mockReturnValue({ username: nativeIdentity.username, uid: 2402, gid: 2401,
      homedir: nativeIdentity.home, shell: '/usr/sbin/nologin' });
    try {
      vi.spyOn(process as NodeJS.Process & { getuid(): number }, 'getuid').mockReturnValue(2402);
      vi.spyOn(process, 'stdin', 'get').mockReturnValue(rawFrame(resolution) as unknown as NodeJS.ReadStream);
      await expect(runAgentLaunchShim([])).rejects.toMatchObject({ code: 'agent_launch_identity_unavailable' });
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      vi.mocked(os.userInfo).mockReset();
      vi.restoreAllMocks();
    }
  });

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
