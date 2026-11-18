import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { handleAgyCliCommand } from './command';

afterEach(() => vi.unstubAllEnvs());

describe('happier agy auth login', () => {
  it('signs in through the agy CLI ACP login', async () => {
    await withTempDir('agy-auth-login-', async dir => {
      const argvPath = join(dir, 'argv.json');
      const agy = join(dir, 'agy');
      // The vendor CLI owns the Google login; a real child process records how Happier invoked it.
      await writeFile(agy, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));\n`);
      await chmod(agy, 0o755);
      vi.stubEnv('HAPPIER_AGY_PATH', agy);

      await handleAgyCliCommand({ args: ['agy', 'auth', 'login'], rawArgv: [], terminalRuntime: null });

      expect(JSON.parse(await readFile(argvPath, 'utf8'))).toEqual(['acp', '--login']);
    });
  });
});
