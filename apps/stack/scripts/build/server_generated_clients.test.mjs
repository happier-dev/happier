// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { readStaleServerGeneratedClients } from './server_generated_clients.mjs';

test('schema reuse follows the server layout for owned and borrowed installations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-client-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, 'installation/apps/server/node_modules/@prisma/client');
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: '@prisma/client' }));
  const source = Buffer.from('model Machine { id String @id }');
  const stamp = Buffer.from(createHash('sha256').update(source).digest('hex'));
  for (const [name, client] of [['installation', 'apps/server/node_modules/.prisma/client'],
    ['capture', 'apps/server/generated/default-client']]) {
    const repoDir = join(root, name);
    if (name === 'capture') {
      await mkdir(join(repoDir, 'apps/server/node_modules/@prisma'), { recursive: true });
      await symlink(installed, join(repoDir, 'apps/server/node_modules/@prisma/client'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const readSchema = path => path === 'apps/server/prisma/schema.prisma' ? source : null;
    const readStamp = path => path === `${client}/.happier-source-schema.sha256` ? stamp : null;
    assert.deepEqual(readStaleServerGeneratedClients({ repoDir, readSchema, readStamp }), [], name);
    assert.deepEqual(readStaleServerGeneratedClients({ repoDir, readSchema, readStamp: () => null }), [client], `${name}: missing stamp refuses reuse`);
    assert.deepEqual(readStaleServerGeneratedClients({ repoDir, readSchema, readStamp: () => Buffer.from('another schema') }), [client], `${name}: foreign schema refuses reuse`);
  }
});
