import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { findUnservableBundledPluginPackageResources } from '../../bundledPluginResources.mjs';

import {
  compareCliNodeRuntimePayloadEntryNames,
  copyCliNodeRuntimePayload,
  copyCliNodeWorkspaceRuntimePackages,
  copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot,
  readCliNodeWorkspaceRuntimeIdentity,
} from './copyCliNodeRuntimePayload.js';

function writeWorkspacePackage(
  root: string,
  source: string,
  packageName = '@happier-dev/protocol',
): void {
  const packageJson = `${JSON.stringify({
    name: packageName,
    private: true,
    type: 'module',
    exports: { '.': './dist/index.js' },
  }, null, 2)}\n`;
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), packageJson, 'utf8');
  writeFileSync(join(root, 'dist', 'index.js'), source, 'utf8');
}

it('orders Unicode sibling names by code units for a locale-independent runtime identity', () => {
  const siblingNames = ['🧪', 'ä', 'z'];
  const codeUnitOrder = ['z', 'ä', '🧪'];

  expect([...siblingNames].sort(compareCliNodeRuntimePayloadEntryNames)).toEqual(codeUnitOrder);
  expect([...siblingNames].sort((left, right) => left.localeCompare(right, 'sv-SE')))
    .not.toEqual(codeUnitOrder);
  expect([...siblingNames].sort((left, right) => left.localeCompare(right, 'de-DE')))
    .not.toEqual(codeUnitOrder);
  // U+10000 begins with a surrogate code unit below U+E000, unlike code-point
  // or UTF-8 byte ordering.
  expect(compareCliNodeRuntimePayloadEntryNames('\u{10000}', '\uE000')).toBeLessThan(0);
});

it('rejects workspace package bytes that do not match the admitted runtime identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-runtime-workspace-'));
  try {
    const packageName = '@happier-dev/protocol';
    const hostRoot = join(root, 'apps', 'cli');
    mkdirSync(hostRoot, { recursive: true });
    writeFileSync(join(hostRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      dependencies: { [packageName]: 'workspace:*' },
      bundledDependencies: [packageName],
    }), 'utf8');
    writeWorkspacePackage(join(root, 'packages', 'protocol'), 'export const generation = "source";\n');
    writeWorkspacePackage(
      join(hostRoot, 'node_modules', '@happier-dev', 'protocol'),
      'export const generation = "admitted";\n',
    );
    const admittedIdentity = readCliNodeWorkspaceRuntimeIdentity({ repoRoot: root });

    const runtimeRoot = join(root, 'runtime-artifact');
    writeWorkspacePackage(
      join(runtimeRoot, 'node_modules', '@happier-dev', 'protocol'),
      'export const generation = "tampered";\n',
    );

    expect(() => copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot({
      runtimeRoot,
      payloadDir: join(root, 'pinned-runner'),
      packageNames: admittedIdentity.packageNames,
      expectedWorkspaceRuntimeIdentity: admittedIdentity.fingerprint,
    })).toThrow(/does not match its dist publication/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves the exact admitted workspace package tree when pinning a runtime root', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-runtime-hidden-file-'));
  try {
    const packageName = '@happier-dev/plugins-example';
    const runtimeRoot = join(root, 'runtime-artifact');
    const packageRoot = join(runtimeRoot, 'node_modules', '@happier-dev', 'plugins-example');
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(runtimeRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-runtime-fixture',
      dependencies: { [packageName]: 'workspace:*' },
      bundledDependencies: [packageName],
    }), 'utf8');
    writeWorkspacePackage(
      packageRoot,
      'export const generation = "admitted";\n',
      packageName,
    );
    mkdirSync(join(packageRoot, '.happier-plugin'), { recursive: true });
    writeFileSync(
      join(packageRoot, '.happier-plugin', 'plugin.json'),
      '{"id":"happier.example"}\n',
      'utf8',
    );
    mkdirSync(join(packageRoot, 'assets'), { recursive: true });
    writeFileSync(join(packageRoot, 'assets', 'brand.txt'), 'brand bytes\n', 'utf8');
    mkdirSync(join(packageRoot, 'resources'), { recursive: true });
    writeFileSync(join(packageRoot, 'resources', 'prompt.md'), '# Prompt\n', 'utf8');

    const admittedIdentity = readCliNodeWorkspaceRuntimeIdentity({
      repoRoot: root,
      hostPackageDir: runtimeRoot,
    });
    const payloadDir = join(root, 'pinned-runner');

    expect(() => copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot({
      runtimeRoot,
      payloadDir,
      packageNames: admittedIdentity.packageNames,
      expectedWorkspaceRuntimeIdentity: admittedIdentity.fingerprint,
    })).not.toThrow();
    expect(existsSync(join(
      payloadDir,
      'node_modules',
      '@happier-dev',
      'plugins-example',
      '.happier-plugin',
      'plugin.json',
    ))).toBe(true);
    expect(existsSync(join(
      payloadDir,
      'node_modules',
      '@happier-dev',
      'plugins-example',
      'assets',
      'brand.txt',
    ))).toBe(true);
    expect(existsSync(join(
      payloadDir,
      'node_modules',
      '@happier-dev',
      'plugins-example',
      'resources',
      'prompt.md',
    ))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves the admitted external runtime dependency closure when pinning a runtime root', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-runtime-external-closure-'));
  try {
    const packageName = '@happier-dev/protocol';
    const runtimeRoot = join(root, 'runtime-artifact');
    const supportNodeModules = join(root, 'daemon-support', 'node_modules');
    const packageRoot = join(supportNodeModules, '@happier-dev', 'protocol');
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(runtimeRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-runtime-fixture',
      dependencies: { [packageName]: 'workspace:*' },
      bundledDependencies: [packageName],
    }), 'utf8');
    writeWorkspacePackage(
      packageRoot,
      'export const generation = "admitted";\n',
      packageName,
    );
    const workspaceZodRoot = join(packageRoot, 'node_modules', 'zod');
    mkdirSync(workspaceZodRoot, { recursive: true });
    writeFileSync(join(workspaceZodRoot, 'package.json'), JSON.stringify({
      name: 'zod',
      version: '4.3.6-workspace',
    }), 'utf8');
    writeFileSync(join(workspaceZodRoot, 'index.js'), 'export const z = "workspace";\n', 'utf8');

    const zodRoot = join(supportNodeModules, 'zod');
    mkdirSync(join(zodRoot, 'node_modules', 'zod-core'), { recursive: true });
    writeFileSync(join(zodRoot, 'package.json'), JSON.stringify({
      name: 'zod',
      version: '4.3.6',
      dependencies: { 'zod-core': '1.0.0' },
    }), 'utf8');
    writeFileSync(join(zodRoot, 'index.js'), 'export const z = true;\n', 'utf8');
    writeFileSync(join(zodRoot, 'node_modules', 'zod-core', 'package.json'), JSON.stringify({
      name: 'zod-core',
      version: '1.0.0',
    }), 'utf8');
    writeFileSync(join(zodRoot, 'node_modules', 'zod-core', 'index.js'), 'export const core = true;\n', 'utf8');

    const scopedRuntimeRoot = join(supportNodeModules, '@example', 'runtime');
    mkdirSync(scopedRuntimeRoot, { recursive: true });
    writeFileSync(join(scopedRuntimeRoot, 'package.json'), JSON.stringify({
      name: '@example/runtime',
      version: '1.0.0',
    }), 'utf8');
    writeFileSync(join(scopedRuntimeRoot, 'index.js'), 'export const runtime = true;\n', 'utf8');
    symlinkSync(
      supportNodeModules,
      join(runtimeRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const admittedIdentity = readCliNodeWorkspaceRuntimeIdentity({
      repoRoot: root,
      hostPackageDir: runtimeRoot,
    });
    const payloadDir = join(root, 'pinned-runner');

    expect(() => copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot({
      runtimeRoot,
      payloadDir,
      packageNames: admittedIdentity.packageNames,
      expectedWorkspaceRuntimeIdentity: admittedIdentity.fingerprint,
    })).not.toThrow();

    expect(readFileSync(join(payloadDir, 'node_modules', 'zod', 'index.js'), 'utf8'))
      .toContain('z = true');
    expect(readFileSync(join(payloadDir, 'node_modules', 'zod', 'node_modules', 'zod-core', 'index.js'), 'utf8'))
      .toContain('core = true');
    expect(readFileSync(
      join(payloadDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'zod', 'index.js'),
      'utf8',
    )).toContain('z = "workspace"');
    expect(readFileSync(join(payloadDir, 'node_modules', '@example', 'runtime', 'index.js'), 'utf8'))
      .toContain('runtime = true');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves the exact installed workspace package tree when pinning a source runtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-source-runtime-hidden-file-'));
  try {
    const packageName = '@happier-dev/plugins-example';
    const hostRoot = join(root, 'apps', 'cli');
    const packageRoot = join(hostRoot, 'node_modules', '@happier-dev', 'plugins-example');
    mkdirSync(hostRoot, { recursive: true });
    writeFileSync(join(hostRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      dependencies: { [packageName]: 'workspace:*' },
      bundledDependencies: [packageName],
    }), 'utf8');
    writeWorkspacePackage(
      join(root, 'packages', 'plugins', 'example'),
      'export const generation = "source";\n',
      packageName,
    );
    writeWorkspacePackage(
      packageRoot,
      'export const generation = "admitted";\n',
      packageName,
    );
    mkdirSync(join(packageRoot, '.happier-plugin'), { recursive: true });
    writeFileSync(
      join(packageRoot, '.happier-plugin', 'plugin.json'),
      '{"id":"happier.example"}\n',
      'utf8',
    );
    mkdirSync(join(packageRoot, 'resources'), { recursive: true });
    writeFileSync(join(packageRoot, 'resources', 'prompt.md'), '# Prompt\n', 'utf8');

    const admittedIdentity = readCliNodeWorkspaceRuntimeIdentity({ repoRoot: root });
    const payloadDir = join(root, 'pinned-runner');
    const staged = copyCliNodeWorkspaceRuntimePackages({
      repoRoot: root,
      payloadDir,
      expectedWorkspaceRuntimeIdentity: admittedIdentity.fingerprint,
    });

    expect(staged).toEqual(admittedIdentity);
    expect(existsSync(join(
      payloadDir,
      'node_modules',
      '@happier-dev',
      'plugins-example',
      '.happier-plugin',
      'plugin.json',
    ))).toBe(true);
    expect(existsSync(join(
      payloadDir,
      'node_modules',
      '@happier-dev',
      'plugins-example',
      'resources',
      'prompt.md',
    ))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('returns the exact staged identity when artifact packaging excludes source-only package files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-runtime-payload-'));
  try {
    const packageName = '@happier-dev/protocol';
    const hostRoot = join(root, 'apps', 'cli');
    const hostPackageRoot = join(hostRoot, 'node_modules', '@happier-dev', 'protocol');
    mkdirSync(hostRoot, { recursive: true });
    writeFileSync(join(hostRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      dependencies: { [packageName]: 'workspace:*' },
      bundledDependencies: [packageName],
    }), 'utf8');
    writeWorkspacePackage(join(root, 'packages', 'protocol'), 'export const generation = "source";\n');
    writeWorkspacePackage(hostPackageRoot, 'export const generation = "admitted";\n');
    writeFileSync(join(hostPackageRoot, 'API.md'), '# source-only documentation\n', 'utf8');
    const admittedIdentity = readCliNodeWorkspaceRuntimeIdentity({ repoRoot: root });

    const distDir = join(hostRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), 'export {};\n', 'utf8');
    const payloadDir = join(root, 'runtime-artifact');
    const staged = await copyCliNodeRuntimePayload({
      repoRoot: root,
      payloadDir,
      distDir,
      expectedWorkspaceRuntimeIdentity: admittedIdentity.fingerprint,
    });
    const stagedIdentity = staged;

    expect(stagedIdentity).toMatchObject({ packageNames: [packageName] });
    expect(stagedIdentity.fingerprint).not.toBe(admittedIdentity.fingerprint);
    expect(existsSync(join(payloadDir, 'node_modules', '@happier-dev', 'protocol', 'API.md'))).toBe(false);
    expect(() => copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot({
      runtimeRoot: payloadDir,
      payloadDir: join(root, 'pinned-runner'),
      packageNames: stagedIdentity.packageNames,
      expectedWorkspaceRuntimeIdentity: stagedIdentity.fingerprint,
    })).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reads and stages a bundled workspace package hoisted to the repository node_modules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-runtime-hoisted-workspace-'));
  try {
    const packageName = '@happier-dev/protocol';
    const hostRoot = join(root, 'apps', 'cli');
    const hoistedPackageRoot = join(root, 'node_modules', '@happier-dev', 'protocol');
    mkdirSync(hostRoot, { recursive: true });
    writeFileSync(join(hostRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      dependencies: { [packageName]: 'workspace:*' },
      bundledDependencies: [packageName],
    }), 'utf8');
    writeWorkspacePackage(join(root, 'packages', 'protocol'), 'export const generation = "source";\n');
    writeWorkspacePackage(hoistedPackageRoot, 'export const generation = "hoisted";\n');

    const distDir = join(hostRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), 'export {};\n', 'utf8');

    const admittedIdentity = readCliNodeWorkspaceRuntimeIdentity({ repoRoot: root });
    const payloadDir = join(root, 'runtime-artifact');
    await expect(copyCliNodeRuntimePayload({
      repoRoot: root,
      payloadDir,
      distDir,
      expectedWorkspaceRuntimeIdentity: admittedIdentity.fingerprint,
    })).resolves.toMatchObject({ packageNames: [packageName] });
    expect(existsSync(join(hostRoot, 'node_modules', '@happier-dev', 'protocol'))).toBe(false);
    expect(readFileSync(join(
      payloadDir,
      'node_modules',
      '@happier-dev',
      'protocol',
      'dist',
      'index.js',
    ), 'utf8')).toContain('hoisted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The daemon artifact payload is the *second* generation of a bundled plugin package: the
 * installed tree it copies from was itself written by this bundler, so its package.json is
 * already sanitized and no longer carries the source `files` list. The manifest survives that
 * second copy; the resources the manifest declares must survive it too, or the daemon refuses
 * its own artifact at first start (F-STACK-2b).
 */
function writeInstalledBundledPluginGeneration(
  packageRoot: string,
  declaredResourcePaths: readonly string[],
  presentResourcePaths: readonly string[],
): void {
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  // Exactly what `sanitizeBundledPackageJson` writes: no `files`.
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@happier-dev/plugins-example',
    private: true,
    type: 'module',
    exports: { '.': './dist/index.js' },
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(packageRoot, 'dist', 'index.js'), 'export const generation = "admitted";\n', 'utf8');
  mkdirSync(join(packageRoot, '.happier-plugin'), { recursive: true });
  writeFileSync(join(packageRoot, '.happier-plugin', 'plugin.json'), `${JSON.stringify({
    id: 'happier.example',
    contributes: {
      resources: [
        ...declaredResourcePaths.map((path, index) => ({ id: `packaged-${index}`, path })),
        // A dynamic Resource contributes no packaged bytes and must not be required.
        { id: 'dynamic', source: 'dynamic' },
      ],
    },
  })}\n`, 'utf8');
  for (const relativePath of presentResourcePaths) {
    const targetPath = join(packageRoot, ...relativePath.replace(/^\.\//u, '').split('/'));
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `bytes for ${relativePath}\n`, 'utf8');
  }
}

function createBundledPluginPayloadFixture(
  root: string,
  declaredResourcePaths: readonly string[],
  presentResourcePaths: readonly string[],
): Readonly<{ payloadDir: string; distDir: string; packageName: string }> {
  const packageName = '@happier-dev/plugins-example';
  const hostRoot = join(root, 'apps', 'cli');
  mkdirSync(hostRoot, { recursive: true });
  writeFileSync(join(hostRoot, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    dependencies: { [packageName]: 'workspace:*' },
    bundledDependencies: [packageName],
  }), 'utf8');
  writeWorkspacePackage(
    join(root, 'packages', 'plugins', 'example'),
    'export const generation = "source";\n',
    packageName,
  );
  writeInstalledBundledPluginGeneration(
    join(hostRoot, 'node_modules', '@happier-dev', 'plugins-example'),
    declaredResourcePaths,
    presentResourcePaths,
  );
  const distDir = join(hostRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.mjs'), 'export {};\n', 'utf8');
  return { payloadDir: join(root, 'runtime-artifact'), distDir, packageName };
}

it('carries the resources a bundled plugin manifest declares into the daemon artifact payload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-payload-plugin-resources-'));
  try {
    const declared = ['assets/brand.png', './resources/prompt.md'];
    const fixture = createBundledPluginPayloadFixture(root, declared, declared);

    await copyCliNodeRuntimePayload({
      repoRoot: root,
      payloadDir: fixture.payloadDir,
      distDir: fixture.distDir,
    });

    const payloadPackageRoot = join(
      fixture.payloadDir,
      'node_modules',
      '@happier-dev',
      'plugins-example',
    );
    // The manifest ships, so the bytes it declares must ship with it.
    expect(existsSync(join(payloadPackageRoot, '.happier-plugin', 'plugin.json'))).toBe(true);
    expect(findUnservableBundledPluginPackageResources(payloadPackageRoot)).toEqual([]);
    expect(existsSync(join(payloadPackageRoot, 'assets', 'brand.png'))).toBe(true);
    expect(existsSync(join(payloadPackageRoot, 'resources', 'prompt.md'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('refuses to publish a bundled plugin package that cannot serve a resource its manifest declares', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-payload-plugin-resource-gap-'));
  try {
    const fixture = createBundledPluginPayloadFixture(
      root,
      ['assets/brand.png', './resources/prompt.md'],
      ['./resources/prompt.md'],
    );

    await expect(copyCliNodeRuntimePayload({
      repoRoot: root,
      payloadDir: fixture.payloadDir,
      distDir: fixture.distDir,
    })).rejects.toThrow(/assets\/brand\.png/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
