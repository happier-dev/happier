import { describe, expect, it } from 'vitest';

import { runHsetupCli } from './hsetup.js';

describe('runHsetupCli (interactive system tasks)', () => {
  it('cancels a pending stdin prompt when the native host terminates the task', async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const output: unknown[] = [];
    const result = await runHsetupCli(['system-tasks', 'run', '--spec-json', JSON.stringify({
      protocolVersion: 1, kind: 'test.prompt.v1', params: {},
    })], {
      stdin: { readAll: async () => '', readLine: () => new Promise(() => {}) },
      stdout: { write: chunk => {
        const event = JSON.parse(chunk);
        output.push(event);
        if (event.type === 'prompt') listeners.get('SIGTERM')?.();
      } },
      stderr: { write: chunk => { throw new Error(chunk); } },
      processObject: {
        once: (name, listener) => { listeners.set(name, listener); },
        off: name => { listeners.delete(name); },
      },
      interactiveKinds: { 'test.prompt.v1': { run: async ctx => {
        await ctx.prompt({ kind: 'confirm', message: 'Continue?', data: {} });
        return { completed: true };
      } } },
    });
    expect(result).toBe(143);
    expect(output.at(-1)).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });

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
