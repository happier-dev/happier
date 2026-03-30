import { describe, expect, it } from 'vitest';

import { runHsetupCli } from './hsetup.js';

describe('runHsetupCli (interactive system tasks)', () => {
  it('streams prompt events and resumes execution when a prompt answer is provided over stdin', async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdinLines: string[] = [
      JSON.stringify({
        protocolVersion: 1,
        kind: 'test.prompt.v1',
        params: {},
      }),
      JSON.stringify({ trusted: true }),
    ];

    const exitCode = await runHsetupCli(['system-tasks', 'run'], {
      stdin: {
        async readAll() {
          return stdinLines.join('\n');
        },
        async readLine() {
          return stdinLines.shift() ?? null;
        },
      },
      stdout: {
        write(chunk) {
          stdoutChunks.push(chunk);
        },
      },
      stderr: {
        write(chunk) {
          stderrChunks.push(chunk);
        },
      },
      now: (() => {
        let ts = 1000;
        return () => ts++;
      })(),
      taskIdFactory: () => 'task-1',
      interactiveKinds: {
        'test.prompt.v1': {
          async run(ctx) {
            ctx.emit({ type: 'progress', stepId: 'prepare', message: 'Preparing' });
            const answer = await ctx.prompt({
              kind: 'ssh.trustHost',
              stepId: 'ssh.hostTrust',
              message: 'Trust this host?',
              data: { host: 'example.test', fingerprint: 'SHA256:abc' },
            }) as { trusted?: boolean };
            ctx.emit({ type: 'progress', stepId: 'finish', message: `Trusted=${answer.trusted}` });
            return { done: true };
          },
        },
      },
    });

    expect(stderrChunks.join('')).toBe('');
    expect(exitCode).toBe(0);

    const lines = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any);

    expect(lines[0]).toMatchObject({
      taskId: 'task-1',
      type: 'progress',
      stepId: 'prepare',
    });
    expect(lines[1]).toMatchObject({
      taskId: 'task-1',
      type: 'prompt',
      stepId: 'ssh.hostTrust',
    });
    expect(lines[2]).toMatchObject({
      taskId: 'task-1',
      type: 'progress',
      stepId: 'finish',
    });
    expect(lines[3]).toMatchObject({
      taskId: 'task-1',
      ok: true,
    });
  });
});
