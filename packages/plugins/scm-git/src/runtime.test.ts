import { describe, expect, it } from 'vitest';

import { runWithBackendRuntimeServices as runWithScmBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

import { normalizePathspec, runScmCommand } from './runtime.js';

describe('Git SCM plugin runtime', () => {
  it('delegates command execution to the host SCM backend runtime service', async () => {
    const calls: unknown[] = [];

    const result = await runWithScmBackendRuntimeServices({
      async runCommand(input) {
        calls.push(input);
        return {
          success: true,
          stdout: 'ok',
          stderr: '',
          exitCode: 0,
        };
      },
    }, async () => await runScmCommand({
      bin: 'git',
      cwd: '/repo',
      args: ['status', '--short'],
      timeoutMs: 123,
      stdin: 'input',
      maxOutputBytes: 456,
      env: { CUSTOM_VALUE: 'x' },
    }));

    expect(result).toEqual({
      success: true,
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    });
    expect(calls).toEqual([
      {
        installableKey: 'git-cli',
        command: 'git',
        cwd: '/repo',
        args: ['status', '--short'],
        timeoutMs: 123,
        stdin: 'input',
        maxOutputBytes: 456,
        env: {
          CUSTOM_VALUE: 'x',
          GIT_ALLOW_PROTOCOL: 'https:ssh:git:file',
        },
      },
    ]);
  });

  it('rejects root-equivalent selected mutation paths', () => {
    const cwd = process.cwd();

    for (const path of ['', ' ', '.', './', ':', ':(top)*', '-path']) {
      expect(normalizePathspec(path, cwd).ok).toBe(false);
    }

    expect(normalizePathspec('src/a.ts', cwd)).toMatchObject({
      ok: true,
      pathspec: 'src/a.ts',
    });
  });
});
