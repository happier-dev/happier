import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as tar from 'tar';

import { stageManagedRuntimeArchives } from './stageManagedRuntimeArchives.mjs';

test('publication archive carries both managed wrapper and process-custody helper', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'managed-runtime-archive-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const archivesDir = join(root, 'archives');
  const platformDir = 'x64-linux';

  await stageManagedRuntimeArchives({
    archivesDir,
    platformDirs: [platformDir],
    repoRoot: root,
    runCommand: async () => undefined,
    yarn: { cmd: 'yarn', args: [] },
    stageManagedRuntime: async ({ payloadDir }) => {
      const output = join(payloadDir, 'tools', 'unpacked');
      await mkdir(output, { recursive: true });
      await Promise.all([
        writeFile(join(output, 'happier-cliproxyapi-managed'), 'wrapper'),
        writeFile(join(output, 'CLIProxyAPI-LICENSE'), 'license'),
        writeFile(join(output, 'CLIProxyAPI-THIRD-PARTY-NOTICES'), 'notices'),
      ]);
    },
    stageProcessCustody: async ({ payloadDir }) => {
      const output = join(payloadDir, 'tools', 'unpacked');
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'happier-process-custody'), 'custody');
    },
  });

  const entries = [];
  await tar.list({
    file: join(archivesDir, 'happier-cliproxyapi-managed-x64-linux.tar.gz'),
    onentry: (entry) => entries.push(entry.path),
  });
  assert.deepEqual(entries.sort(), [
    'CLIProxyAPI-LICENSE',
    'CLIProxyAPI-THIRD-PARTY-NOTICES',
    'happier-cliproxyapi-managed',
    'happier-process-custody',
  ]);
  assert.match(
    await readFile(join(archivesDir, 'checksums.runtime-assets.sha256'), 'utf8'),
    /happier-cliproxyapi-managed-x64-linux\.tar\.gz/u,
  );
});
