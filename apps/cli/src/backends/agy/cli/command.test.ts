import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { handleAgyCliCommand } from './command';

afterEach(() => vi.unstubAllEnvs());

describe('happier agy auth login', () => {
  it.each([
    { scenario: 'the default profile', geminiHome: false },
    { scenario: 'the GEMINI_HOME profile', geminiHome: true },
  ])('signs in to $scenario through the agy CLI ACP login, in the OS keyring', async ({ geminiHome }) => {
    await withTempDir('agy-auth-login-', async dir => {
      const capturePath = join(dir, 'capture.json');
      // `.cjs` makes the launch helper supply the JavaScript runtime on Windows, which ignores shebangs.
      const agy = join(dir, 'agy.cjs');
      // The vendor CLI owns the Google login; a real child process records how Happier invoked it.
      await writeFile(agy, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), fileTokenStorage: process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE ?? null }));\n`);
      await chmod(agy, 0o755);
      vi.stubEnv('HAPPIER_AGY_PATH', agy);
      vi.stubEnv('AGY_CLI_FORCE_FILE_TOKEN_STORAGE', '1');
      // Explicit in both rows so a developer's own GEMINI_HOME cannot change the expected launch.
      vi.stubEnv('GEMINI_HOME', geminiHome ? join(dir, 'profile') : '');

      await handleAgyCliCommand({ args: ['agy', 'auth', 'login'], rawArgv: [], terminalRuntime: null });

      expect(JSON.parse(await readFile(capturePath, 'utf8'))).toEqual({
        args: ['acp', ...(geminiHome ? ['--gemini-dir', join(dir, 'profile')] : []), '--login'],
        fileTokenStorage: null,
      });
    });
  });

  it('signs in to the machine login even from a connected-account session shell', async () => {
    await withTempDir('agy-auth-login-', async dir => {
      const capturePath = join(dir, 'capture.json');
      const agy = join(dir, 'agy.cjs');
      await writeFile(agy, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), fileTokenStorage: process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE ?? null }));\n`);
      await chmod(agy, 0o755);
      vi.stubEnv('HAPPIER_AGY_PATH', agy);
      // What a connected session's environment carries: its selection and materialized profile.
      vi.stubEnv('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON', JSON.stringify([{ kind: 'profile', serviceId: 'antigravity', profileId: 'work' }]));
      vi.stubEnv('HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON', JSON.stringify(['GEMINI_HOME']));
      vi.stubEnv('GEMINI_HOME', join(dir, 'connected-home'));

      await handleAgyCliCommand({ args: ['agy', 'auth', 'login'], rawArgv: [], terminalRuntime: null });

      expect(JSON.parse(await readFile(capturePath, 'utf8'))).toEqual({ args: ['acp', '--login'], fileTokenStorage: null });
    });
  });

  it('no longer offers the retired pinned-server login', async () => {
    await expect(handleAgyCliCommand({ args: ['agy', 'auth', 'login', '--pinned'], rawArgv: [], terminalRuntime: null }))
      .rejects.toThrow(/Unknown AGY auth command/);
  });
});
