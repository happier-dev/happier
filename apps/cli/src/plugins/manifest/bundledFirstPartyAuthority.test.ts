import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  declaresBundledFirstPartyWorkspacePackageContract,
  isCanonicalBundledFirstPartyWorkspacePluginPackage,
  resolveLocalPluginSourceManifestAuthority,
} from './bundledFirstPartyAuthority';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const BUNDLED_PLUGIN_ROOT = resolve(REPO_ROOT, 'packages/plugins/codex');
const BUNDLED_PACKAGE_NAME = '@happier-dev/plugins-codex';
const OTHER_BUNDLED_PACKAGE_NAME = '@happier-dev/plugins-claude';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function createTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

describe('declaresBundledFirstPartyWorkspacePackageContract', () => {
  it('accepts the private, discovery-metadata-free package contract a bundled plugin actually ships', async () => {
    const packageJson = JSON.parse(
      await readFile(join(BUNDLED_PLUGIN_ROOT, 'package.json'), 'utf8'),
    ) as unknown;

    expect(declaresBundledFirstPartyWorkspacePackageContract(packageJson)).toBe(true);
  });

  it('rejects a package that declares installable-plugin discovery metadata or is publishable', () => {
    expect(declaresBundledFirstPartyWorkspacePackageContract({
      name: '@happier-dev/plugins-codex',
      private: true,
      keywords: ['happier-plugin'],
    })).toBe(false);
    expect(declaresBundledFirstPartyWorkspacePackageContract({
      name: '@happier-dev/plugins-codex',
      private: true,
      happier: { manifest: '.happier-plugin/plugin.json' },
    })).toBe(false);
    expect(declaresBundledFirstPartyWorkspacePackageContract({
      name: '@happier-dev/plugins-codex',
      private: false,
    })).toBe(false);
    expect(declaresBundledFirstPartyWorkspacePackageContract(null)).toBe(false);
    expect(declaresBundledFirstPartyWorkspacePackageContract([{ private: true }])).toBe(false);
  });
});

describe('isCanonicalBundledFirstPartyWorkspacePluginPackage', () => {
  it('accepts the exact workspace source root the current checkout bundles under that package name', async () => {
    await expect(isCanonicalBundledFirstPartyWorkspacePluginPackage({
      packageRootPath: BUNDLED_PLUGIN_ROOT,
      packageName: BUNDLED_PACKAGE_NAME,
    })).resolves.toBe(true);
  });

  it('rejects a workspace root claiming a different bundled package name', async () => {
    await expect(isCanonicalBundledFirstPartyWorkspacePluginPackage({
      packageRootPath: BUNDLED_PLUGIN_ROOT,
      packageName: OTHER_BUNDLED_PACKAGE_NAME,
    })).resolves.toBe(false);
  });

  it('rejects a copy of the same package outside any Happier workspace', async () => {
    const impostorRoot = await createTemporaryRoot('happier-bundled-authority-impostor-');
    await cp(join(BUNDLED_PLUGIN_ROOT, 'package.json'), join(impostorRoot, 'package.json'));

    await expect(isCanonicalBundledFirstPartyWorkspacePluginPackage({
      packageRootPath: impostorRoot,
      packageName: BUNDLED_PACKAGE_NAME,
    })).resolves.toBe(false);
  });
});

describe('resolveLocalPluginSourceManifestAuthority', () => {
  it('grants first-party authority to the checkout source root of a plugin this CLI bundles', async () => {
    await expect(resolveLocalPluginSourceManifestAuthority({
      pluginRootPath: BUNDLED_PLUGIN_ROOT,
    })).resolves.toBe('bundled_first_party');
  });

  it('keeps a byte-identical copy of that package outside the workspace external', async () => {
    const impostorRoot = await createTemporaryRoot('happier-bundled-authority-copy-');
    await cp(join(BUNDLED_PLUGIN_ROOT, 'package.json'), join(impostorRoot, 'package.json'));

    await expect(resolveLocalPluginSourceManifestAuthority({
      pluginRootPath: impostorRoot,
    })).resolves.toBe('external');
  });

  it('keeps a root without a readable package.json external', async () => {
    const emptyRoot = await createTemporaryRoot('happier-bundled-authority-empty-');

    await expect(resolveLocalPluginSourceManifestAuthority({
      pluginRootPath: emptyRoot,
    })).resolves.toBe('external');
  });

  it('keeps a root whose package.json has no usable name external', async () => {
    const namelessRoot = await createTemporaryRoot('happier-bundled-authority-nameless-');
    await writeFile(
      join(namelessRoot, 'package.json'),
      JSON.stringify({ name: '   ', private: true }),
      'utf8',
    );

    await expect(resolveLocalPluginSourceManifestAuthority({
      pluginRootPath: namelessRoot,
    })).resolves.toBe('external');
  });
});
