import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { claudeRemoteAgentSdk } from '../remote/claudeRemoteAgentSdk';
import { claudePreflightModelsProbeAdapter } from './claudePreflightModelsProbeAdapter';
import { claudeCatalogProcessFixture, waitForClosed } from './claudeCatalogProcessFixture.testkit';

const sdkLogEnv = createEnvKeyScope(['DEBUG', 'DEBUG_SDK']);
beforeEach(() => sdkLogEnv.patch({ DEBUG: undefined, DEBUG_SDK: undefined }));
afterEach(() => sdkLogEnv.restore());

describe('Claude pre-session native catalogs', () => {
  it('settles cancellation only after the owned native process closes', async () => {
    await withTempDir('happier-claude-catalog-cancel-', async (cwd) => {
      const executable = join(cwd, 'claude.js');
      const logPath = join(cwd, 'transport.jsonl');
      await writeFile(executable, claudeCatalogProcessFixture);
      const controller = new AbortController();
      const pending = claudePreflightModelsProbeAdapter.probeCatalogsRaw!({ cwd, timeoutMs: 5_000, signal: controller.signal,
        processEnv: { ...process.env, HAPPIER_CLAUDE_PATH: executable,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath, HAPPIER_E2E_CATALOG_HANG: '1' } });
      const rejected = expect(pending).rejects.toThrow(/abort|cancel/i);
      let pid = 0;
      try {
        await vi.waitFor(async () => {
          const events = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string; pid?: number });
          pid = events.find((event) => event.type === 'spawn')?.pid ?? 0;
          expect(pid).toBeGreaterThan(0);
          expect(events.some((event) => event.type === 'control_request')).toBe(true);
        });
        controller.abort();
        await rejected;
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
        await waitForClosed(logPath);
      }
    });
  });

  it('returns native slash commands without a prompt or persistent session and closes the subprocess', async () => {
    await withTempDir('happier-claude-catalog-', async (cwd) => {
      const executable = join(cwd, 'claude.js');
      const logPath = join(cwd, 'transport.jsonl');
      await writeFile(executable, claudeCatalogProcessFixture);
      const result = await claudePreflightModelsProbeAdapter.probeCatalogsRaw?.({
        cwd,
        timeoutMs: 5_000,
        accountSettings: { claudeRemoteSettingSourcesV2: ['project'] },
        processEnv: {
          ...process.env,
          HAPPIER_CLAUDE_PATH: executable,
          CLAUDE_CONFIG_DIR: join(cwd, 'selected-config'),
          CLAUDECODE: 'parent-session',
          CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'must-not-forward',
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_CATALOG_COMMANDS: JSON.stringify([{ name: 'review', description: 'Review changes', argumentHint: '' }]),
        },
      });
      expect(result).toEqual({ commands: [{ name: 'review', description: 'Review changes', argumentHint: '' }], skills: null });
      const events = await waitForClosed(logPath);
      expect(events[0]).toMatchObject({ type: 'spawn', cwd, configDir: join(cwd, 'selected-config') });
      expect(events[0]?.nestedSession).toBeUndefined();
      expect(events[0]?.refreshToken).toBeUndefined();
      expect(events[0]?.argv).toEqual(expect.arrayContaining(['--no-session-persistence', '--setting-sources=project']));
      expect(events.some((event) => event.type === 'control_request')).toBe(true);
      expect(events.some((event) => event.type === 'user')).toBe(false);
      expect(events.some((event) => event.type === 'closed')).toBe(true);
    });
  });

  it('protects a shared native transcript store even when probing without session persistence', async () => {
    await withTempDir('happier-claude-catalog-retention-', async (cwd) => {
      const nativeHome = join(cwd, 'native');
      const activeHome = join(cwd, 'active');
      await mkdir(join(nativeHome, 'projects'), { recursive: true });
      await mkdir(activeHome);
      await symlink(join(nativeHome, 'projects'), join(activeHome, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(join(nativeHome, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 365 }));
      const executable = join(cwd, 'claude.js');
      const logPath = join(cwd, 'transport.jsonl');
      await writeFile(executable, claudeCatalogProcessFixture);
      await claudePreflightModelsProbeAdapter.probeCatalogsRaw!({
        cwd, timeoutMs: 5_000,
        processEnv: { ...process.env, HAPPIER_CLAUDE_PATH: executable, CLAUDE_CONFIG_DIR: activeHome,
          HAPPIER_CLAUDE_NATIVE_CONFIG_DIR: nativeHome,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath, HAPPIER_E2E_CATALOG_COMMANDS: '[]' },
      });
      const events = await waitForClosed(logPath);
      const args = events[0]?.argv as string[];
      const settingsArgs = args.flatMap((arg, index) => arg === '--settings'
        ? [args[index + 1]]
        : arg.startsWith('--settings=') ? [arg.slice('--settings='.length)] : []);
      expect(settingsArgs).toHaveLength(1);
      expect(JSON.parse(settingsArgs[0]!)).toMatchObject({ cleanupPeriodDays: 365 });
    });
  });

  it('distinguishes an observed empty command catalog from unsupported skill mentions', async () => {
    await withTempDir('happier-claude-catalog-empty-', async (cwd) => {
      const executable = join(cwd, 'claude.js');
      const logPath = join(cwd, 'transport.jsonl');
      await writeFile(executable, claudeCatalogProcessFixture);
      const result = await claudePreflightModelsProbeAdapter.probeCatalogsRaw?.({ cwd, timeoutMs: 5_000, processEnv: {
        ...process.env, HAPPIER_CLAUDE_PATH: executable,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath, HAPPIER_E2E_CATALOG_COMMANDS: '[]',
      } });
      expect(result).toEqual({ commands: [], skills: null });
      expect((await waitForClosed(logPath)).some((event) => event.type === 'closed')).toBe(true);
    });
  });

  it('rejects at the owning probe deadline and closes a pending initialization', async () => {
    await withTempDir('happier-claude-catalog-timeout-', async (cwd) => {
      const executable = join(cwd, 'claude.js');
      const logPath = join(cwd, 'transport.jsonl');
      await writeFile(executable, claudeCatalogProcessFixture);
      const pending = claudePreflightModelsProbeAdapter.probeCatalogsRaw?.({ cwd, timeoutMs: 500, processEnv: {
        ...process.env, HAPPIER_CLAUDE_PATH: executable,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath, HAPPIER_E2E_CATALOG_HANG: '1',
      } });
      await expect(pending).rejects.toThrow(/timed out/i);
      expect((await waitForClosed(logPath)).some((event) => event.type === 'closed')).toBe(true);
    });
  });

  it.each([
    { label: 'nonempty', commands: [{ name: 'review', description: 'Review changes', argumentHint: '' }],
      names: ['review'], details: [{ command: 'review', description: 'Review changes' }], input: '/review changed-file.ts' },
    { label: 'empty', commands: [], names: [], details: [], input: 'hello' },
  ])('publishes $label native catalogs in-session and preserves the first input', async ({ commands, names, details, input }) => {
    await withTempDir('happier-claude-catalog-session-', async (cwd) => {
      const executable = join(cwd, 'claude.js');
      const logPath = join(cwd, 'transport.jsonl');
      await writeFile(executable, claudeCatalogProcessFixture);
      const fixtureEnv = createEnvKeyScope(['HAPPIER_E2E_FAKE_CLAUDE_LOG', 'HAPPIER_E2E_CATALOG_COMMANDS']);
      fixtureEnv.patch({ HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
        HAPPIER_E2E_CATALOG_COMMANDS: JSON.stringify(commands),
      });
      try {
        let firstInput = true;
        const onCapabilities = vi.fn();
        let finishSession!: () => void;
        const sessionFinished = new Promise<void>((resolve) => { finishSession = resolve; });
        await claudeRemoteAgentSdk({
          sessionId: null,
          transcriptPath: null,
          path: cwd,
          claudeExecutablePath: executable,
          canCallTool: async () => ({ behavior: 'deny', message: 'No tools in the catalog fixture' }),
          isAborted: () => false,
          nextMessage: async () => {
            if (!firstInput) {
              await sessionFinished;
              return null;
            }
            firstInput = false;
            return { message: input, mode: { permissionMode: 'default' } };
          },
          onReady: () => {},
          onSessionFound: () => {},
          onMessage: (message) => { if (message.type === 'result') finishSession(); },
          onCapabilities,
        });
        expect(onCapabilities).toHaveBeenCalledWith(expect.objectContaining({
          slashCommands: names,
          slashCommandDetails: details,
        }));
        const events = await waitForClosed(logPath);
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'user', message: {
          role: 'user', content: [{ type: 'text', text: input }],
        } })]));
      } finally {
        fixtureEnv.restore();
      }
    });
  });

});
