import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';

import { resolveOpenCodeConnectedConfigHomeDir } from './configHome.js';
import {
  ensureOpenCodeBrokerPluginAssets,
  resolveOpenCodeBrokerPluginDir,
  resolveOpenCodeBrokerPluginPath,
} from './assets.js';
import { OPEN_CODE_BROKER_PLUGIN_VERSION } from './source.js';

describe('openCode broker assets', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeRootDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-broker-root-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('derives deterministic, version-keyed `.js` plugin paths under the isolated config home', () => {
    const rootDir = '/srv/connected/home';
    const configHome = resolveOpenCodeConnectedConfigHomeDir(rootDir);
    expect(configHome).toBe(join(rootDir, 'connected-config'));
    expect(resolveOpenCodeBrokerPluginDir(configHome)).toBe(join(configHome, 'opencode', 'plugin'));
    expect(resolveOpenCodeBrokerPluginPath('openai', configHome)).toBe(
      join(configHome, 'opencode', 'plugin', `happier-broker-openai-${OPEN_CODE_BROKER_PLUGIN_VERSION}.js`),
    );
    // MUST be `.js` (opencode auto-discovery ignores `.mjs`).
    expect(resolveOpenCodeBrokerPluginPath('anthropic', configHome).endsWith('.js')).toBe(true);
  });

  it('writes broker `.js` assets idempotently into the config-home plugin dir (config isolation)', async () => {
    const rootDir = await makeRootDir();
    const configHome = resolveOpenCodeConnectedConfigHomeDir(rootDir);

    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai', 'anthropic'], connectedConfigHomeDir: configHome });

    const openaiPath = resolveOpenCodeBrokerPluginPath('openai', configHome);
    const anthropicPath = resolveOpenCodeBrokerPluginPath('anthropic', configHome);
    const openaiSource = await readFile(openaiPath, 'utf8');
    const anthropicSource = await readFile(anthropicPath, 'utf8');
    expect(openaiSource).toContain('Provider: openai');
    expect(anthropicSource).toContain('Provider: anthropic');

    // Idempotent: a second call does not throw and leaves the assets intact.
    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai', 'anthropic'], connectedConfigHomeDir: configHome });
    expect(await readFile(openaiPath, 'utf8')).toBe(openaiSource);

    // The assets are mode 0600 (no secrets, but consistent with secret-handling hygiene).
    const mode = (await stat(openaiPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('only writes the config home (no plugin dir) when no broker providers are requested', async () => {
    const rootDir = await makeRootDir();
    const configHome = resolveOpenCodeConnectedConfigHomeDir(rootDir);

    await ensureOpenCodeBrokerPluginAssets({ providers: [], connectedConfigHomeDir: configHome });

    // Config home exists (isolation root) but no broker plugin dir was created.
    expect((await stat(configHome)).isDirectory()).toBe(true);
    await expect(stat(resolveOpenCodeBrokerPluginDir(configHome))).rejects.toThrow();
  });
});
