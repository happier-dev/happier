import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeExistingAccountCountForServerComponent } from './startup.mjs';

test('probeExistingAccountCountForServerComponent reads account count from a runtime-style sqlite payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-startup-runtime-probe-'));
  const serverDir = join(root, 'server');
  const generatedDir = join(serverDir, 'generated', 'sqlite-client');
  const dataDir = join(root, 'data');

  try {
    await mkdir(generatedDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(generatedDir, 'index.js'),
      [
        'export class PrismaClient {',
        '  constructor() {',
        '    this.account = { count: async () => 2 };',
        '  }',
        '  async $disconnect() {}',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await probeExistingAccountCountForServerComponent({
      serverComponentName: 'happier-server-light',
      serverDir,
      env: {
        HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
        DATABASE_URL: `file:${join(dataDir, 'happier-server-light.sqlite')}`,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.accountCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
