import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import {
  ensurePiBridgeExtensionAsset,
  resolvePiBridgeExtensionDir,
  resolvePiBridgeExtensionPath,
} from './piBridgeExtensionAssets';
import { buildPiBridgeExtensionSource, type PiBridgeExtensionSourceParams } from './piBridgeExtensionSource';

const TEMP_DIRS = new Set<string>();

function tempAgentDir(): string {
  const dir = createTempDirSync('happier-pi-bridge-assets-');
  TEMP_DIRS.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TEMP_DIRS) removeTempDirSync(dir);
  TEMP_DIRS.clear();
});

function baseParams(overrides?: Partial<PiBridgeExtensionSourceParams>): PiBridgeExtensionSourceParams {
  return {
    renameEnabled: true,
    memoryEnabled: true,
    launchFilePath: '/usr/bin/node',
    launchArgPrefix: ['--no-warnings', 'dist/index.mjs'],
    launchEnv: {},
    ...overrides,
  };
}

describe('pi bridge extension assets', () => {
  it('resolves a deterministic, non-auto-discoverable path', () => {
    expect(resolvePiBridgeExtensionDir('/agent')).toBe('/agent/extensions/happier-pi-tools-bridge');
    expect(resolvePiBridgeExtensionPath('/agent')).toBe(
      '/agent/extensions/happier-pi-tools-bridge/happier-pi-tools-bridge.js',
    );
    // Never an auto-discovered shape: not extensions/*.js and not extensions/SUBDIR/index.js.
    const base = resolvePiBridgeExtensionPath('/agent');
    expect(base.split('/').at(-1)).not.toBe('index.js');
    expect(base.startsWith('/agent/extensions/')).toBe(true);
  });

  it('writes the generated extension and is idempotent on repeat ensures', async () => {
    const agentDir = tempAgentDir();
    const params = baseParams();

    const path = await ensurePiBridgeExtensionAsset(agentDir, params);
    expect(path).toBe(resolvePiBridgeExtensionPath(agentDir));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(buildPiBridgeExtensionSource(params));

    // Rewrite with the same content must not touch the file.
    const firstContent = readFileSync(path, 'utf8');
    await ensurePiBridgeExtensionAsset(agentDir, params);
    expect(readFileSync(path, 'utf8')).toBe(firstContent);
  });

  it('refreshes the asset when the source changes', async () => {
    const agentDir = tempAgentDir();
    await ensurePiBridgeExtensionAsset(agentDir, baseParams());
    await ensurePiBridgeExtensionAsset(agentDir, baseParams({ renameEnabled: false }));
    const content = readFileSync(resolvePiBridgeExtensionPath(agentDir), 'utf8');
    expect(content).toContain('const RENAME_ENABLED = false;');
  });

  it('retires the legacy flat asset (which Pi would auto-discover) when ensuring', async () => {
    const agentDir = tempAgentDir();
    const extensionRoot = join(agentDir, 'extensions');
    mkdirSync(extensionRoot, { recursive: true });
    const legacyFlat = join(extensionRoot, 'happier-pi-tools-bridge.js');
    writeFileSync(legacyFlat, '// legacy flat', { mode: 0o600 });
    expect(existsSync(legacyFlat)).toBe(true);

    await ensurePiBridgeExtensionAsset(agentDir, baseParams());
    expect(existsSync(legacyFlat)).toBe(false);
    expect(existsSync(resolvePiBridgeExtensionPath(agentDir))).toBe(true);
  });

  it('retires stale versioned assets in both the root and the bridge subdir', async () => {
    const agentDir = tempAgentDir();
    const extensionRoot = join(agentDir, 'extensions');
    const extensionDir = resolvePiBridgeExtensionDir(agentDir);
    mkdirSync(extensionDir, { recursive: true });
    const staleRoot = join(extensionRoot, 'happier-pi-tools-bridge-0.js');
    const staleDir = join(extensionDir, 'happier-pi-tools-bridge-1.js');
    writeFileSync(staleRoot, '// stale', { mode: 0o600 });
    writeFileSync(staleDir, '// stale', { mode: 0o600 });

    await ensurePiBridgeExtensionAsset(agentDir, baseParams());
    expect(existsSync(staleRoot)).toBe(false);
    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(resolvePiBridgeExtensionPath(agentDir))).toBe(true);
  });
});
