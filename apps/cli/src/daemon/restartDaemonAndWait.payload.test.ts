import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { withConfiguredDaemonTestHome } from './testkit/fakeDaemonLifecycle.testkit';

const { spawnProcess } = vi.hoisted(() => ({ spawnProcess: vi.fn<typeof import('child_process').spawn>() }));
// Only the OS process launch is intercepted; restart, Stack selection and environment projection stay real.
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: spawnProcess,
}));

let restartDaemonAndWait: typeof import('./restartDaemonAndWait')['restartDaemonAndWait'];
beforeAll(async () => { ({ restartDaemonAndWait } = await import('./restartDaemonAndWait')); }, 300_000);
afterEach(() => { spawnProcess.mockReset(); });

describe('daemon restart payload selection', () => {
  it.each([true, false])('launches the current Stack payload through the startup resolver (takeover=%s)', async takeover => {
    await withTempDir('daemon-restart-payload-', async root => {
      const cliDir = join(root, 'selected', 'cli');
      const entrypoint = join(cliDir, 'src', 'index.mjs');
      const payloadRoot = join(root, 'selected', 'guest-payload');
      const statePath = join(root, 'stack.runtime.json');
      mkdirSync(dirname(entrypoint), { recursive: true });
      writeFileSync(entrypoint, 'export {};');
      writeFileSync(statePath, JSON.stringify({ sourceRuntimeLaunch: {
        entrypoint, cliDir, env: { HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: payloadRoot },
      } }));
      await withConfiguredDaemonTestHome({ prefix: 'daemon-restart-payload-home-', env: {
        HAPPIER_STACK_STACK: 'payload-regression',
        HAPPIER_STACK_RUNTIME_STATE_PATH: statePath,
        HAPPIER_STACK_CLI_ROOT_DIR: join(root, 'incumbent', 'cli'),
        HAPPIER_CLI_ROOT_DIR: join(root, 'incumbent', 'cli'),
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: join(root, 'incumbent', 'cli', 'src', 'index.mjs'),
        HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(root, 'incumbent', 'guest-payload'),
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined,
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: undefined,
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
      } }, async () => {
        const intercepted = new Error('OS launch intercepted');
        let launched: Readonly<{ selectedEntrypointInArgs: boolean; payloadRoot: string | undefined; entrypoint: string | undefined }> | undefined;
        spawnProcess.mockImplementation((_command, args, options) => {
          launched = {
            selectedEntrypointInArgs: args?.some(arg => arg.includes(entrypoint)) ?? false,
            payloadRoot: options?.env?.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT,
            entrypoint: options?.env?.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT,
          };
          throw intercepted;
        });

        await expect(restartDaemonAndWait({ takeover })).rejects.toBe(intercepted);
        // Project only nonsecret launch facts; never print the inherited process environment on failure.
        expect(launched).toEqual({
          selectedEntrypointInArgs: true,
          payloadRoot,
          entrypoint,
        });
      });
    });
  });
});
