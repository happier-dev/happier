import { mkdtemp, realpath, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { materializeSamplePluginFixture } from '@/plugins/testkit/samplePackage';
import { resolvePluginAuthoringSource } from '@/plugins/authoring/sourceModule';
import { handlePluginsCommand } from './plugins';

describe('plugins dev author root', () => {
  it.each([{ args: [] }, { args: ['.'] }, { args: ['../plugin'] }])('retains the caller root across install rejoin: $args', async ({ args }) => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-root-'));
    const sourceRoot = join(parent, 'plugin');
    await materializeSamplePluginFixture(sourceRoot);
    const caller = args[0] === '../plugin' ? join(parent, 'caller') : sourceRoot;
    await mkdir(caller, { recursive: true });
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    const output = captureConsoleJsonOutput();
    let deliveredInput: unknown;
    let resolvedRoot: string | undefined;
    try {
      process.chdir(caller);
      await handlePluginsCommand(['dev', ...args, '--json'], {
        ensureDaemon: async () => undefined,
        // Daemon control and remote Action execution are process boundaries.
        controlPluginDevelopment: async () => ({ kind: 'failed', code: 'plugin_dev_reviewRequired',
          message: 'Review required', status: { roots: [], plugins: [] } }),
        actionExecutionDeps: {
          readCredentialsFn: async () => ({ token: 'fixture', encryption: null }),
          createExecutorFn: () => ({
            resolveSessionTarget: async () => { throw new Error('Unexpected Session target'); },
            execute: async (_actionId, input) => {
              deliveredInput = input;
              // Resolve the actual Action operand from the receiver's cwd.
              process.chdir(previousCwd);
              const locator = input && typeof input === 'object' && 'path' in input ? input.path : null;
              const resolved = await resolvePluginAuthoringSource(typeof locator === 'string' ? locator : '');
              if (resolved.ok) resolvedRoot = resolved.kind === 'code' ? resolved.entry.packageRoot : resolved.source.pluginRootPath;
              return { ok: false, errorCode: 'review_required', error: 'Review required' };
            },
          }),
        },
      });
      expect(deliveredInput).toMatchObject({ path: expect.any(String), dev: true });
      expect(resolvedRoot).toBe(await realpath(sourceRoot));
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
      output.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
