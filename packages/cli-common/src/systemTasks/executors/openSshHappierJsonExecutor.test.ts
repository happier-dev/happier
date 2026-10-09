import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createOpenSshHappierJsonExecutor, parseStrictPersonalHomeTaskFinalResult } from './openSshHappierJsonExecutor.js';
import { buildRemoteBootstrapCommand, buildRemoteHappierInvocationCommand } from '../ssh/remoteBootstrapCommandBuilder.js';
import { createHappierJsonExecutorFromTextRunner } from './happierJsonExecutor.js';

describe('transport-neutral Happier JSON executor', () => {
  it('refuses a failed CLI envelope even when the native process exits successfully', async () => {
    const executor = createHappierJsonExecutorFromTextRunner(async () => ({ status: 0, stdout: JSON.stringify({ ok: false, error: { code: 'installation_failed', message: 'Install failed' } }), stderr: '' }));
    await expect(executor.runHappierJson(['service', 'install', '--json'])).rejects.toMatchObject({ code: 'cli_command_failed' });
    await expect(executor.runHappierJson(['auth', 'status', '--json'], { allowJsonFailure: true })).resolves.toMatchObject({ ok: false });
  });
});

describe('parseStrictPersonalHomeTaskFinalResult', () => {
  const valid = { kind: 'personal_home_task_result', protocolVersion: 1, result: { protocolVersion: 1, taskId: 'task-1', ok: true, data: { running: false } } };
  it('accepts JSONL events only when the last line is the exact successful result', () => {
    expect(parseStrictPersonalHomeTaskFinalResult(`${JSON.stringify({ type: 'progress' })}\n${JSON.stringify(valid)}\n`).data).toEqual({ running: false });
  });
  it.each([
    ['missing', ''], ['noise-after-result', `${JSON.stringify(valid)}\nnoise`],
    ['wrong-kind', JSON.stringify({ ...valid, kind: 'other' })],
    ['wrong-version', JSON.stringify({ ...valid, protocolVersion: 2 })],
    ['failure', JSON.stringify({ ...valid, result: { protocolVersion: 1, taskId: 'task-1', ok: false, error: { code: 'x', message: 'x' } } })],
    ['missing-data', JSON.stringify({ ...valid, result: { protocolVersion: 1, taskId: 'task-1', ok: true } })],
    ['empty-task-id', JSON.stringify({ ...valid, result: { protocolVersion: 1, taskId: '', ok: true, data: {} } })],
    ['unknown-inner-key', JSON.stringify({ ...valid, result: { protocolVersion: 1, taskId: 'task-1', ok: true, data: {}, extra: true } })],
  ])('rejects %s', (_name, text) => {
    expect(() => parseStrictPersonalHomeTaskFinalResult(text)).toThrow();
  });
});

describe('createOpenSshHappierJsonExecutor', () => {
  it('preserves the selected release ring through a transport-neutral guest invocation', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'happier-native-ring-'));
    const binary = join(directory, 'guest binary');
    try {
      await writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "$HAPPIER_RELEASE_RING"\n');
      await chmod(binary, 0o755);
      const command = buildRemoteHappierInvocationCommand({ binaryPath: binary, channel: 'preview', args: ['service', 'install'] });
      const result = await promisify(execFile)('/bin/sh', ['-c', command]);
      expect(result.stdout).toBe('preview\n');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['executor', 'bootstrap'] as const)('executes the default HOME-relative binary through a real POSIX shell (%s)', async (invocation) => {
    if (process.platform === 'win32') return; // Remote execution targets POSIX Linux/macOS; Windows is the local client.
    const directory = await mkdtemp(join(tmpdir(), 'happier-ssh-command-'));
    const home = join(directory, 'home with spaces');
    const binary = join(home, '.happier', 'cli', 'current', 'happier');
    try {
      await mkdir(join(home, '.happier', 'cli', 'current'), { recursive: true });
      await writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
      await chmod(binary, 0o755);
      const executor = createOpenSshHappierJsonExecutor({
        ssh: { target: 'dev@example.test', auth: 'agent' },
        auth: { mode: 'agent' },
        knownHostsMode: 'system',
        runRemoteText: async ({ remoteCommand }) => {
          const { stdout, stderr } = await promisify(execFile)('/bin/sh', ['-c', remoteCommand], {
            env: { ...process.env, HOME: home },
          });
          return { status: 0, stdout, stderr };
        },
      });
      if (invocation === 'executor') {
        const args = ['auth', 'status', "literal ' $HOME $(false); argument"];
        expect((await executor.runHappierText(args)).stdout).toBe(`${args.join('\n')}\n`);
      } else {
        const command = buildRemoteBootstrapCommand({ label: 'auth.status', serverUrl: 'https://home.example.test' });
        const result = await promisify(execFile)('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home } });
        expect(result.stdout).toBe('auth\nstatus\n--json\n');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('carries bounded ephemeral stdin separately from the remote command string', async () => {
    const observed = vi.fn();
    const executor = createOpenSshHappierJsonExecutor({
      ssh: { target: 'dev@example.test', auth: 'agent' },
      auth: { mode: 'agent' },
      knownHostsMode: 'system',
      runRemoteText: async (params) => {
        observed(params);
        return { status: 0, stdout: '{}\n', stderr: '' };
      },
    });
    const input = '{"v":1,"confirmed":true}\n';

    await executor.runHappierText(['home', 'erase', '--approval-stdin'], { input });

    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ input }));
    expect(String(observed.mock.calls[0]?.[0]?.remoteCommand)).not.toContain('confirmed');
  });

  it('prefixes remote commands with release-ring env scoping for dev lane', async () => {
    const runRemoteText = vi.fn<(params: any) => Promise<void>>(async () => {});

    const executor = createOpenSshHappierJsonExecutor({
      ssh: { target: 'dev@example.test', auth: 'agent' },
      auth: { mode: 'agent' },
      knownHostsMode: 'app',
      channel: 'publicdev',
      runRemoteText: async ({ remoteCommand, ...rest }) => {
        await runRemoteText({ remoteCommand, ...rest });
        return { status: 0, stdout: '{}\n', stderr: '' };
      },
    });

    await executor.runHappierText(['auth', 'status']);

    const firstCall = runRemoteText.mock.calls[0]?.[0];
    expect(String(firstCall?.remoteCommand ?? '')).toContain("HAPPIER_PUBLIC_RELEASE_CHANNEL='dev'");
    expect(String(firstCall?.remoteCommand ?? '')).toContain("HAPPIER_RELEASE_RING='dev'");
  });

  it('does not prefix scoping env vars for the stable lane', async () => {
    const runRemoteText = vi.fn<(remoteCommand: string) => Promise<void>>(async () => {});

    const executor = createOpenSshHappierJsonExecutor({
      ssh: { target: 'dev@example.test', auth: 'agent' },
      auth: { mode: 'agent' },
      knownHostsMode: 'app',
      channel: 'stable',
      runRemoteText: async ({ remoteCommand }) => {
        await runRemoteText(remoteCommand);
        return { status: 0, stdout: '{}\n', stderr: '' };
      },
    });

    await executor.runHappierText(['auth', 'status']);

    const cmd = String(runRemoteText.mock.calls[0]?.[0] ?? '');
    expect(cmd).not.toContain('HAPPIER_PUBLIC_RELEASE_CHANNEL');
    expect(cmd).not.toContain('HAPPIER_RELEASE_RING');
  });
});
