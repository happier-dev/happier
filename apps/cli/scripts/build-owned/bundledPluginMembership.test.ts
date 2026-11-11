import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage } from '../__tests__/testkit/packageLayoutSandbox';
import { readBundledPluginPackageNames, syncCliBundledPluginMembership } from './bundledPluginMembership';

it('publishes changed membership once without rewriting an unchanged shared dependency input', () => {
  const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-membership-noop-');
  try {
    writeBundledPluginSourceInputs({ repoRoot, pluginId: 'example' });
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: [], dependencies: {} });
    const path = join(happyCliDir, 'package.json');
    syncCliBundledPluginMembership({ rootDir: repoRoot, mode: 'write' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      bundledDependencies: ['@happier-dev/plugins-example'], dependencies: { '@happier-dev/plugins-example': '0.0.0' },
    });
    utimesSync(path, new Date(1_000), new Date(1_000));
    const before = { bytes: readFileSync(path, 'utf8'), modified: statSync(path).mtimeMs };
    syncCliBundledPluginMembership({ rootDir: repoRoot, mode: 'write' });
    expect({ bytes: readFileSync(path, 'utf8'), modified: statSync(path).mtimeMs }).toEqual(before);
  } finally { cleanup(); }
});

it('retains a plugin with missing declarations in source capture while publication remains strict', () => {
  const { repoRoot, cleanup } = createPackageLayoutSandbox('happier-source-membership-');
  try {
    const root = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'broken' });
    rmSync(join(root, 'src/manifest.ts'));
    expect(() => readBundledPluginPackageNames(repoRoot)).toThrow(/Missing required plugin manifest/u);
    expect(readBundledPluginPackageNames(repoRoot, { requireManifestSource: false }))
      .toEqual(['@happier-dev/plugins-broken']);
  } finally { cleanup(); }
});

it('excludes explicitly unbundled shipping plugins from declarations and CLI dependencies', () => {
  const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-opt-in-membership-');
  try {
    writeBundledPluginSourceInputs({ repoRoot, pluginId: 'example' });
    const root = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'asciinema' });
    const path = join(root, 'package.json');
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...pkg, happier: { bundled: false } }));
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: [], dependencies: {} });
    expect(readBundledPluginPackageNames(repoRoot)).toEqual(['@happier-dev/plugins-example']);
    syncCliBundledPluginMembership({ rootDir: repoRoot, mode: 'write' });
    expect(JSON.parse(readFileSync(join(happyCliDir, 'package.json'), 'utf8')).dependencies)
      .toEqual({ '@happier-dev/plugins-example': '0.0.0' });
  } finally { cleanup(); }
});
