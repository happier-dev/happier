import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { clearStackForceLoginCredentialPaths } from './clearStackForceLoginCredentialPaths.mjs';
import { resolveStackCredentialPaths } from './credentials_paths.mjs';

async function writeCredential(path, token) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      token,
      encryption: { publicKey: 'AA==', machineKey: 'AA==' },
    }) + '\n',
    'utf8',
  );
}

test('clearStackForceLoginCredentialPaths preserves the settings-backed active server-scoped credential slot', async () => {
  const cliHomeDir = await mkdtemp(join(tmpdir(), 'hstack-clear-force-login-'));
  try {
    const serverUrl = 'http://127.0.0.1:4101';
    const env = {
      ...process.env,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'stack_dev__id_default',
    };
    const activeServerId = 'stack-dev-profile';

    await writeFile(
      join(cliHomeDir, 'settings.json'),
      JSON.stringify(
        {
          schemaVersion: 6,
          activeServerId,
          servers: {
            [activeServerId]: {
              id: activeServerId,
              name: activeServerId,
              serverUrl,
              webappUrl: 'http://localhost:4101',
              createdAt: 1,
              updatedAt: 1,
              lastUsedAt: 1,
            },
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    const resolved = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
    await writeCredential(resolved.serverScopedPath, 'token-active');
    await Promise.all(
      resolved.aliasServerScopedPaths.map((path, index) => writeCredential(path, `token-alias-${index}`)),
    );
    await writeCredential(resolved.legacyPath, 'token-legacy');

    const result = await clearStackForceLoginCredentialPaths({ cliHomeDir, serverUrl, env });

    assert.equal(result.attemptedPaths.includes(resolved.serverScopedPath), false);
    assert.equal(result.attemptedPaths.includes(resolved.legacyPath), true);
    assert.deepEqual(
      result.attemptedPaths.sort(),
      [...new Set([...resolved.aliasServerScopedPaths, resolved.legacyPath])].sort(),
    );

    const activeRaw = await readFile(resolved.serverScopedPath, 'utf8');
    assert.match(activeRaw, /token-active/);

    await Promise.all(
      resolved.aliasServerScopedPaths.map(async (path) => {
        await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
      }),
    );
    await assert.rejects(readFile(resolved.legacyPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(cliHomeDir, { recursive: true, force: true });
  }
});
