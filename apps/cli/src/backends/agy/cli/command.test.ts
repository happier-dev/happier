import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { installPinnedAgyAcpServerFixture, withIsolatedHappierHome } from '../acp/pinnedAgyAcpServer.testkit';
import { handleAgyCliCommand } from './command';

vi.mock('cross-spawn', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('cross-spawn') }>();
  if (process.platform !== 'win32') return actual;
  const { wrapPinnedFixtureSpawn } = await import('../acp/pinnedAgyAcpServer.testkit');
  return { ...actual, default: wrapPinnedFixtureSpawn(actual.default) };
});


afterEach(() => vi.unstubAllEnvs());

describe('happier agy auth login', () => {
  it('signs in through the agy CLI ACP login', async () => {
    await withTempDir('agy-auth-login-', async dir => {
      const argvPath = join(dir, 'argv.json');
      // `.cjs` makes the launch helper supply the JavaScript runtime on Windows, which ignores shebangs.
      const agy = join(dir, 'agy.cjs');
      // The vendor CLI owns the Google login; a real child process records how Happier invoked it.
      await writeFile(agy, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));\n`);
      await chmod(agy, 0o755);
      vi.stubEnv('HAPPIER_AGY_PATH', agy);

      await handleAgyCliCommand({ args: ['agy', 'auth', 'login'], rawArgv: [], terminalRuntime: null });

      expect(JSON.parse(await readFile(argvPath, 'utf8'))).toEqual(['acp', '--login']);
    });
  });
  it.each([
    { flags: ['--pinned'], method: 'oauth-personal' },
    { flags: ['--method', 'oauth-business'], method: 'oauth-business' },
  ])('can refresh the released pinned login using $method', async ({ flags, method }) => {
    await withIsolatedHappierHome(async dir => {
      const capturePath = join(dir, 'method.json');
      await installPinnedAgyAcpServerFixture(`#!${process.execPath}
        const fs = require('node:fs');
        const input = require('node:readline').createInterface({ input: process.stdin });
        input.on('line', (line) => {
          const request = JSON.parse(line);
          const result = request.method === 'initialize' ? {
            protocolVersion: 1,
            authMethods: [{ id: 'oauth-personal', name: 'Personal' }, { id: 'oauth-business', name: 'Business' }],
          } : {};
          if (request.method === 'authenticate') {
            fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(request.params.methodId));
          }
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        });
      `);
      await handleAgyCliCommand({ args: ['agy', 'auth', 'login', ...flags], rawArgv: [], terminalRuntime: null });
      expect(JSON.parse(await readFile(capturePath, 'utf8'))).toBe(method);
    });
  });
});
