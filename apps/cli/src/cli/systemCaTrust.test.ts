import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { createEphemeralTlsServerFixture } from '../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

const run = promisify(execFile);

it.skipIf(process.platform !== 'linux')('trusts Linux system and extra CAs while refusing an unknown CA', async () => {
  const fixture = await createEphemeralTlsServerFixture();
  const server = createServer({
    key: await readFile(fixture.privateKeyPath),
    cert: await readFile(fixture.leafCertificatePath),
  }, (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ version: 'fixture' }));
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing TLS fixture address');

    const repo = resolve(import.meta.dirname, '../../../..');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('HAPPIER_') && ![
        'NODE_OPTIONS', 'NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
        'SSL_CERT_FILE', 'SSL_CERT_DIR',
      ].includes(key)));
    const serverUrl = `https://127.0.0.1:${address.port}`;
    await writeFile(resolve(fixture.directoryPath, 'settings.json'), JSON.stringify({
      schemaVersion: 6,
      activeServerId: 'fixture',
      servers: { fixture: { id: 'fixture', name: 'Fixture', serverUrl, webappUrl: serverUrl } },
    }));
    const probe = async (tlsEnv: NodeJS.ProcessEnv) => {
      try {
        const { stdout } = await run(process.execPath, [
          '--conditions=happier-source', '--import', resolve(repo, 'packages/cli-common/registerSourceRuntime.mjs'),
          resolve(repo, 'apps/cli/src/index.ts'), 'server', 'test', '--json',
        ], { cwd: repo, env: {
          ...env,
          HAPPIER_HOME_DIR: fixture.directoryPath,
          HAPPIER_CLI_RUNTIME_DISABLE: '1',
          HAPPIER_CLI_UPDATE_CHECK: '0',
          ...tlsEnv,
        } });
        return { exitCode: 0, response: JSON.parse(stdout) };
      } catch (error) {
        if (error instanceof Error && 'code' in error && 'stdout' in error && typeof error.stdout === 'string' && error.stdout) {
          return { exitCode: error.code, response: JSON.parse(error.stdout) };
        }
        throw error;
      }
    };

    expect(await probe({})).toMatchObject({
      exitCode: 1,
      response: { data: { ok: false, status: null, error: expect.stringMatching(/certificate/i) } },
    });
    const trusted = { exitCode: 0, response: { data: { ok: true, version: 'fixture' } } };
    expect(await probe({ NODE_EXTRA_CA_CERTS: fixture.caCertificatePath })).toMatchObject(trusted);
    expect(await probe({ SSL_CERT_FILE: fixture.caCertificatePath })).toMatchObject(trusted);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    await fixture.cleanup();
  }
}, 120_000);
