import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliUpdateFactsSchema } from '@happier-dev/protocol';

import { readCliUpdateFacts } from './cliUpdateFacts';

describe('readCliUpdateFacts (K5)', () => {
  let homeDir = '';
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-update-facts-'));
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function installManaged(root: string, versionId: string): string {
    const versionDir = join(homeDir, root, 'versions', versionId);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(join(versionDir, 'happier'), 'binary');
    writeFileSync(join(homeDir, root, 'current.version'), `${versionId}\n`);
    return join(versionDir, 'happier');
  }

  it('reports a managed install with its ring-filtered latest, update command and last outcome', () => {
    const execPath = installManaged('cli-preview', '0.2.13-preview.1');
    mkdirSync(join(homeDir, 'cache'), { recursive: true });
    writeFileSync(join(homeDir, 'cache', 'update.preview.json'), JSON.stringify({ checkedAt: 1, latest: '0.2.14-preview.3' }));
    writeFileSync(join(homeDir, 'cli-preview', 'last-update.json'), JSON.stringify({
      targetVersion: '0.2.13-preview.1', outcome: 'pendingReconnect', at: 5, message: null,
    }));

    const facts = readCliUpdateFacts({
      homeDir,
      publicReleaseRing: 'preview',
      currentVersion: '0.2.13-preview.1',
      execPath,
      invokedPath: execPath,
      platform: 'linux',
      npmPackageName: '@happier-dev/cli',
    });

    expect(CliUpdateFactsSchema.parse(facts)).toEqual({
      currentVersion: '0.2.13-preview.1',
      latestVersion: '0.2.14-preview.3',
      channel: 'preview',
      installSource: 'managed',
      updateCommand: 'hprev self update',
      canUpdateRemotely: true,
      lastUpdate: { targetVersion: '0.2.13-preview.1', outcome: 'pendingReconnect', at: 5, message: null },
    });
  });

  it('offers a remote update for a managed Windows install', () => {
    const execPath = installManaged('cli', '0.2.13');
    expect(readCliUpdateFacts({
      homeDir, publicReleaseRing: 'stable', currentVersion: '0.2.13', execPath, invokedPath: execPath, platform: 'win32', npmPackageName: '@happier-dev/cli',
    })).toMatchObject({ installSource: 'managed', canUpdateRemotely: true, updateCommand: 'happier self update' });
  });

  it('treats the home bin hardlink of the versioned payload as the managed install', () => {
    const versionDir = join(homeDir, 'cli', 'versions', '0.2.13');
    mkdirSync(versionDir, { recursive: true });
    const payload = join(versionDir, 'happier.exe');
    writeFileSync(payload, 'binary');
    writeFileSync(join(homeDir, 'cli', 'current.version'), '0.2.13\n');
    const shim = join(homeDir, 'bin', 'happier.exe');
    mkdirSync(join(homeDir, 'bin'), { recursive: true });
    linkSync(payload, shim);

    expect(readCliUpdateFacts({
      homeDir, publicReleaseRing: 'stable', currentVersion: '0.2.13', execPath: shim, invokedPath: shim, platform: 'win32', npmPackageName: '@happier-dev/cli',
    })).toMatchObject({ installSource: 'managed', canUpdateRemotely: true, updateCommand: 'happier self update' });
  });

  it('names the package manager\'s command for an npm install and never offers a remote update', () => {
    const packageRoot = join(homeDir, 'global', 'node_modules', '@happier-dev', 'cli');
    mkdirSync(join(packageRoot, 'bin'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
    writeFileSync(join(packageRoot, 'bin', 'happier.mjs'), '');

    expect(readCliUpdateFacts({
      homeDir,
      publicReleaseRing: 'stable',
      currentVersion: '0.2.12',
      execPath: '/usr/bin/node',
      invokedPath: join(packageRoot, 'bin', 'happier.mjs'),
      platform: 'linux',
      npmPackageName: '@happier-dev/cli',
    })).toMatchObject({
      installSource: 'npm',
      updateCommand: 'npm install -g @happier-dev/cli@latest',
      canUpdateRemotely: false,
      lastUpdate: null,
      latestVersion: null,
    });
  });

  it.skipIf(process.platform === 'win32')('never names Homebrew for a CLI that only runs on a Homebrew Node', () => {
    // Homebrew's Node resolves into its own keg (`Cellar/node/<version>/bin/node`); that keg is
    // Node's, not this CLI's, so it neither names `brew upgrade node` nor hides the npm install.
    const nodeKeg = join(homeDir, 'homebrew', 'Cellar', 'node', '22.9.0', 'bin', 'node');
    mkdirSync(join(nodeKeg, '..'), { recursive: true });
    writeFileSync(nodeKeg, 'binary');
    mkdirSync(join(homeDir, 'homebrew', 'opt'), { recursive: true });
    symlinkSync(join('..', 'Cellar', 'node', '22.9.0'), join(homeDir, 'homebrew', 'opt', 'node'));
    const packageRoot = join(homeDir, 'homebrew', 'lib', 'node_modules', '@happier-dev', 'cli');
    mkdirSync(join(packageRoot, 'bin'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
    writeFileSync(join(packageRoot, 'bin', 'happier.mjs'), '');
    const checkout = join(homeDir, 'src', 'happier', 'apps', 'cli', 'dist', 'index.mjs');
    mkdirSync(join(checkout, '..'), { recursive: true });
    writeFileSync(checkout, '');

    const read = (invokedPath: string) => readCliUpdateFacts({
      homeDir, publicReleaseRing: 'stable', currentVersion: '1.0.0', execPath: nodeKeg, invokedPath, platform: 'darwin', npmPackageName: '@happier-dev/cli',
    });
    expect(read(join(packageRoot, 'bin', 'happier.mjs'))).toMatchObject({
      installSource: 'npm',
      updateCommand: 'npm install -g @happier-dev/cli@latest',
    });
    expect(read(checkout)).toMatchObject({ installSource: 'other', updateCommand: null });
  });

  it('treats a binary outside the managed layout as other, with no command', () => {
    const stray = join(homeDir, 'somewhere', 'happier');
    mkdirSync(join(homeDir, 'somewhere'), { recursive: true });
    writeFileSync(stray, 'binary');
    installManaged('cli', '0.2.13');
    expect(readCliUpdateFacts({
      homeDir, publicReleaseRing: 'stable', currentVersion: '0.2.13', execPath: stray, invokedPath: stray, platform: 'linux', npmPackageName: '@happier-dev/cli',
    })).toMatchObject({ installSource: 'other', updateCommand: null, canUpdateRemotely: false });
  });
});
