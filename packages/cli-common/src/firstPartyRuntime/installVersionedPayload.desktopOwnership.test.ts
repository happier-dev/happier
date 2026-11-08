import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { installVersionedPayload } from './installVersionedPayload.js';
import { resolveFirstPartyInstallLayout } from './installLayout.js';

describe('managed CLI Desktop creation ownership', () => {
  it('tracks both Desktop consumers of a newly created CLI and relinquishes on explicit standalone install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-desktop-cli-ownership-'));
    const processEnv = { ...process.env, HAPPIER_HOME_DIR: home };
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv });
    const ownershipPath = `${layout.installRoot}.desktop-ownership.json`;
    async function install(versionId: string, desktopBundleId?: string) {
      const payloadRoot = join(home, `payload-${versionId}`);
      await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
      await writeFile(join(payloadRoot, process.platform === 'win32' ? 'happier.exe' : 'happier'), versionId);
      await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};');
      await installVersionedPayload({ componentId: 'happier-cli', versionId, payloadRoot, processEnv, desktopBundleId });
    }
    try {
      await install('1.0.0', 'dev.happier.desktop');
      expect(JSON.parse(await readFile(ownershipPath, 'utf8'))).toEqual({
        version: 1, createdByDesktop: true, consumers: ['dev.happier.desktop'],
      });
      await install('1.0.1', 'dev.happier.desktop.preview');
      expect(JSON.parse(await readFile(ownershipPath, 'utf8')).consumers).toEqual([
        'dev.happier.desktop', 'dev.happier.desktop.preview',
      ]);
      await install('1.0.2');
      await expect(readFile(ownershipPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('never claims an existing installation or legacy/broken install root when Desktop repairs it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-desktop-cli-adopt-'));
    const processEnv = { ...process.env, HAPPIER_HOME_DIR: home };
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv });
    try {
      await mkdir(layout.installRoot, { recursive: true });
      const payloadRoot = join(home, 'payload');
      await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
      await writeFile(join(payloadRoot, process.platform === 'win32' ? 'happier.exe' : 'happier'), 'cli');
      await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};');
      await installVersionedPayload({
        componentId: 'happier-cli', versionId: '1.0.0', payloadRoot, processEnv,
        desktopBundleId: 'dev.happier.desktop',
      });
      await expect(readFile(`${layout.installRoot}.desktop-ownership.json`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
