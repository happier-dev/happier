import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBuiltUiArtifactContributionIds } from './builtUiArtifacts';

let pluginRoot: string;

async function writeArtifactsManifest(content: string): Promise<void> {
  const dir = join(pluginRoot, 'dist', 'happier-plugin-ui');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'ui-artifacts.json'), content, 'utf8');
}

beforeEach(async () => {
  pluginRoot = await mkdtemp(join(tmpdir(), 'happier-built-ui-artifacts-'));
});

afterEach(async () => {
  await rm(pluginRoot, { recursive: true, force: true });
});

describe('readBuiltUiArtifactContributionIds', () => {
  it('returns the contribution ids of the built react-native-web artifact manifest', async () => {
    await writeArtifactsManifest(JSON.stringify({
      version: 1,
      entries: [
        {
          contributionId: 'main-native',
          tier: 'reactNative',
          platform: 'web',
          entry: 'react-native-web/main-native/entry.mjs',
          files: [{
            relativePath: 'react-native-web/main-native/entry.mjs',
            digest: `sha256:${'b'.repeat(64)}`,
            byteSize: 1,
          }],
          digest: `sha256:${'a'.repeat(64)}`,
          builtWith: { bundler: 'vite', version: '7.0.0' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
      ],
    }));

    expect(await readBuiltUiArtifactContributionIds(pluginRoot)).toEqual(['main-native']);
  });

  it('returns an empty list when no built UI artifact manifest exists', async () => {
    expect(await readBuiltUiArtifactContributionIds(pluginRoot)).toEqual([]);
  });

  it('returns an empty list for an invalid manifest instead of throwing', async () => {
    await writeArtifactsManifest('{ not valid json');
    expect(await readBuiltUiArtifactContributionIds(pluginRoot)).toEqual([]);
  });
});
