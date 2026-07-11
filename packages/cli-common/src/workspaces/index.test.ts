import {
  atomicReplaceDirSync,
  bundleWorkspacePackage,
  bundleWorkspacePackageWithRuntimeDependencies,
  bundleWorkspacePackagesWithRuntimeDependencies,
  copyDirSafeSync,
  hasBundledWorkspacePackagesHealthy,
  resolveWorkspaceBundlesFromPackageJson,
} from './index';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('bundleWorkspacePackage', () => {
  let rootDir: string | undefined;
  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('removes legacy dist staging dirs when rebundling into an existing destination', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const srcPackageDir = resolve(rootDir, 'packages/protocol');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    mkdirSync(srcDistDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');

    const destPackageDir = resolve(rootDir, 'apps/stack/node_modules/@happier-dev/protocol');
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    const legacyTmpDir = resolve(destPackageDir, 'dist.__sync_tmp__.old-staging');
    const legacyBackupDir = resolve(destPackageDir, 'dist.__sync_backup__.old-staging');
    mkdirSync(legacyTmpDir, { recursive: true });
    mkdirSync(legacyBackupDir, { recursive: true });

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(() => readdirSync(legacyTmpDir)).toThrow();
    expect(() => readdirSync(legacyBackupDir)).toThrow();

    const destPackageJsonPath = resolve(destPackageDir, 'package.json');
    const destPackageJson = JSON.parse(readFileSync(destPackageJsonPath, 'utf8'));
    expect(destPackageJson).toEqual(
      expect.objectContaining({
        name: '@happier-dev/protocol',
        private: true,
        exports: { '.': { default: './dist/index.js' } },
      }),
    );

    expect(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8')).toBe('export {};');

    const destParent = resolve(destPackageDir, '..');
    const siblingNames = readdirSync(destParent);
    expect(siblingNames.some((name) => name.startsWith('.protocol.__sync_tmp__.'))).toBe(false);
    expect(siblingNames.some((name) => name.startsWith('.protocol.__sync_backup__.'))).toBe(false);
  });

  it('copies non-dist export targets referenced by the workspace package manifest', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-nondist-export-'));

    const srcPackageDir = resolve(rootDir, 'packages/release-runtime');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    mkdirSync(srcDistDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/release-runtime',
          version: '0.0.0',
          type: 'module',
          exports: {
            '.': { default: './dist/index.js' },
            './releaseRings': {
              import: './dist/releaseRings.js',
              require: './releaseRings.cjs',
              default: './dist/releaseRings.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};\n', 'utf8');
    writeFileSync(resolve(srcDistDir, 'releaseRings.js'), 'export const releaseRings = true;\n', 'utf8');
    writeFileSync(resolve(srcPackageDir, 'releaseRings.cjs'), 'module.exports = { releaseRings: true };\n', 'utf8');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/release-runtime');
    bundleWorkspacePackage({
      packageName: '@happier-dev/release-runtime',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(readFileSync(resolve(destPackageDir, 'releaseRings.cjs'), 'utf8')).toContain('releaseRings');
  });

  it('can reconcile a complete workspace package while keeping its live directory mounted', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-live-workspace-package-'));

    const srcPackageDir = resolve(rootDir, 'packages/cli-common');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    mkdirSync(srcDistDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli-common',
        version: '0.0.0',
        type: 'module',
        exports: { './publication-test': './dist/next.js' },
      }),
    );
    writeFileSync(resolve(srcDistDir, 'next.js'), 'export const version = "next";\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/cli-common');
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(destPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli-common',
        version: '0.0.0',
        type: 'module',
        exports: { './publication-test': './dist/previous.js' },
      }),
    );
    writeFileSync(resolve(destPackageDir, 'dist/previous.js'), 'export const version = "previous";\n');
    const liveDirectoryInode = statSync(destPackageDir).ino;

    bundleWorkspacePackage({
      packageName: '@happier-dev/cli-common',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
      preserveDestinationPath: true,
    });

    expect(statSync(destPackageDir).ino).toBe(liveDirectoryInode);
    expect(existsSync(resolve(destPackageDir, 'dist/previous.js'))).toBe(false);
    expect(readFileSync(resolve(destPackageDir, 'dist/next.js'), 'utf8')).toBe('export const version = "next";\n');
  });

  it('can repair a mounted workspace package without pruning existing files', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-presence-workspace-package-'));

    const srcPackageDir = resolve(rootDir, 'packages/protocol');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    mkdirSync(srcDistDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export const version = "next";\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    writeFileSync(resolve(destPackageDir, 'package.json'), '{}\n');
    writeFileSync(resolve(destPackageDir, 'dist/index.js'), 'export const version = "previous";\n');
    writeFileSync(resolve(destPackageDir, 'dist/legacy.js'), 'export const legacy = true;\n');
    const liveDirectoryInode = statSync(destPackageDir).ino;

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
      preserveDestinationPath: true,
      pruneStale: false,
    });

    expect(statSync(destPackageDir).ino).toBe(liveDirectoryInode);
    expect(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8')).toBe('export const version = "next";\n');
    expect(readFileSync(resolve(destPackageDir, 'dist/legacy.js'), 'utf8')).toBe('export const legacy = true;\n');
  });

  it('bundles external runtime dependencies inside the same workspace replacement', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const bundleWorkspacePackageWithRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).bundleWorkspacePackageWithRuntimeDependencies;
    expect(bundleWorkspacePackageWithRuntimeDependencies).toBeTypeOf('function');

    const srcPackageDir = resolve(rootDir, 'packages/agents');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    const zodPackageDir = resolve(srcPackageDir, 'node_modules/zod');
    mkdirSync(srcDistDir, { recursive: true });
    mkdirSync(resolve(zodPackageDir, 'v4/core'), { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { zod: '4.3.6' },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');
    writeFileSync(
      resolve(zodPackageDir, 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', type: 'module', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(zodPackageDir, 'v4/core/schemas.js'), 'export const schemas = {};\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/agents');

    (bundleWorkspacePackageWithRuntimeDependencies as (params: {
      packageName: string;
      srcDir: string;
      destDir: string;
    }) => void)({
      packageName: '@happier-dev/agents',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8')).toBe('export {};');
    expect(readFileSync(resolve(destPackageDir, 'node_modules/zod/v4/core/schemas.js'), 'utf8')).toBe(
      'export const schemas = {};\n',
    );
  });

  it('refreshes complete workspace bundles while keeping existing package directories mounted', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-complete-workspace-bundles-'));

    const srcPackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(srcPackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(resolve(srcPackageDir, 'dist/index.js'), 'export const version = "next";\n');

    const destPackageDir = resolve(rootDir, 'apps/stack/node_modules/@happier-dev/protocol');
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(destPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        exports: { './legacy': './dist/legacy.js' },
      }),
    );
    writeFileSync(resolve(destPackageDir, 'dist/index.js'), 'export const version = "previous";\n');
    writeFileSync(resolve(destPackageDir, 'dist/legacy.js'), 'export const legacy = true;\n');
    const liveDirectoryInode = statSync(destPackageDir).ino;

    bundleWorkspacePackagesWithRuntimeDependencies({
      bundles: [{
        packageName: '@happier-dev/protocol',
        srcDir: srcPackageDir,
        destDir: destPackageDir,
      }],
    });

    expect(statSync(destPackageDir).ino).toBe(liveDirectoryInode);
    expect(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8')).toBe(
      'export const version = "next";\n',
    );
    expect(readFileSync(resolve(destPackageDir, 'dist/legacy.js'), 'utf8')).toBe(
      'export const legacy = true;\n',
    );
  });

  it('prunes retained live targets when preparing an exact artifact bundle', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-artifact-workspace-bundles-'));

    const srcPackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(srcPackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(resolve(srcPackageDir, 'dist/index.js'), 'export const version = "next";\n');

    const destPackageDir = resolve(rootDir, 'apps/stack/node_modules/@happier-dev/protocol');
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    writeFileSync(resolve(destPackageDir, 'package.json'), '{}\n');
    writeFileSync(resolve(destPackageDir, 'dist/index.js'), 'export const version = "previous";\n');
    writeFileSync(resolve(destPackageDir, 'dist/legacy.js'), 'export const legacy = true;\n');

    bundleWorkspacePackagesWithRuntimeDependencies({
      publicationMode: 'artifact',
      bundles: [{
        packageName: '@happier-dev/protocol',
        srcDir: srcPackageDir,
        destDir: destPackageDir,
      }],
    });

    expect(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8')).toBe(
      'export const version = "next";\n',
    );
    expect(existsSync(resolve(destPackageDir, 'dist/legacy.js'))).toBe(false);
  });
});

describe('resolveWorkspaceBundlesFromPackageJson', () => {
  it('derives the full internal runtime workspace dependency closure from package manifests', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-resolve-closure-'));
    try {
      writeFileSync(resolve(rootDir, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2), 'utf8');
      writeFileSync(resolve(rootDir, 'yarn.lock'), '', 'utf8');

      const hostPackageDir = resolve(rootDir, 'apps', 'stack');
      mkdirSync(hostPackageDir, { recursive: true });
      writeFileSync(
        resolve(hostPackageDir, 'package.json'),
        JSON.stringify(
          {
            name: '@happier-dev/stack',
            version: '0.0.0',
            bundledDependencies: ['@happier-dev/cli-common', '@happier-dev/agents', '@happier-dev/protocol'],
          },
          null,
          2,
        ),
        'utf8',
      );

      const cliCommonDir = resolve(rootDir, 'packages', 'cli-common');
      mkdirSync(cliCommonDir, { recursive: true });
      writeFileSync(
        resolve(cliCommonDir, 'package.json'),
        JSON.stringify(
          {
            name: '@happier-dev/cli-common',
            version: '0.0.0',
            dependencies: {
              '@happier-dev/agents': '0.0.0',
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const agentsDir = resolve(rootDir, 'packages', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        resolve(agentsDir, 'package.json'),
        JSON.stringify(
          {
            name: '@happier-dev/agents',
            version: '0.0.0',
            dependencies: {
              '@happier-dev/protocol': '0.0.0',
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const protocolDir = resolve(rootDir, 'packages', 'protocol');
      mkdirSync(protocolDir, { recursive: true });
      writeFileSync(
        resolve(protocolDir, 'package.json'),
        JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }, null, 2),
        'utf8',
      );

      const bundles = resolveWorkspaceBundlesFromPackageJson({
        repoRoot: rootDir,
        hostPackageDir,
      });

      expect(bundles.map((bundle) => bundle.packageName)).toEqual([
        '@happier-dev/protocol',
        '@happier-dev/agents',
        '@happier-dev/cli-common',
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('fails when a transitive internal runtime workspace is absent from bundledDependencies', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-resolve-missing-closure-'));
    try {
      writeFileSync(resolve(rootDir, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2), 'utf8');
      writeFileSync(resolve(rootDir, 'yarn.lock'), '', 'utf8');

      const hostPackageDir = resolve(rootDir, 'apps', 'stack');
      mkdirSync(hostPackageDir, { recursive: true });
      writeFileSync(
        resolve(hostPackageDir, 'package.json'),
        JSON.stringify(
          {
            name: '@happier-dev/stack',
            version: '0.0.0',
            bundledDependencies: ['@happier-dev/cli-common'],
          },
          null,
          2,
        ),
        'utf8',
      );

      const cliCommonDir = resolve(rootDir, 'packages', 'cli-common');
      mkdirSync(cliCommonDir, { recursive: true });
      writeFileSync(
        resolve(cliCommonDir, 'package.json'),
        JSON.stringify(
          {
            name: '@happier-dev/cli-common',
            version: '0.0.0',
            dependencies: {
              '@happier-dev/agents': '0.0.0',
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const agentsDir = resolve(rootDir, 'packages', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        resolve(agentsDir, 'package.json'),
        JSON.stringify({ name: '@happier-dev/agents', version: '0.0.0' }, null, 2),
        'utf8',
      );

      expect(() => resolveWorkspaceBundlesFromPackageJson({
        repoRoot: rootDir,
        hostPackageDir,
      })).toThrow(/Missing bundled internal workspace dependencies/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('resolves plugin workspaces from packages/plugins/<pluginId>', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-resolve-plugins-'));
    try {
      writeFileSync(resolve(rootDir, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2), 'utf8');
      writeFileSync(resolve(rootDir, 'yarn.lock'), '', 'utf8');

      const pluginDir = resolve(rootDir, 'packages', 'plugins', 'acme');
      mkdirSync(resolve(pluginDir, 'dist'), { recursive: true });
      writeFileSync(
        resolve(pluginDir, 'package.json'),
        JSON.stringify(
          {
            name: '@happier-dev/plugins-acme',
            version: '0.0.0',
            type: 'module',
            exports: { '.': { default: './dist/index.js' } },
          },
          null,
          2,
        ),
        'utf8',
      );
      writeFileSync(resolve(pluginDir, 'dist/index.js'), 'export const acme = true;\n', 'utf8');

      const hostPackageDir = resolve(rootDir, 'apps', 'cli');
      mkdirSync(hostPackageDir, { recursive: true });
      writeFileSync(
        resolve(hostPackageDir, 'package.json'),
        JSON.stringify(
          {
            name: '@happier-dev/cli',
            version: '0.0.0',
            bundledDependencies: ['@happier-dev/plugins-acme'],
          },
          null,
          2,
        ),
        'utf8',
      );

      const bundles = resolveWorkspaceBundlesFromPackageJson({
        repoRoot: rootDir,
        hostPackageDir,
      });

      expect(bundles).toEqual([
        expect.objectContaining({
          packageName: '@happier-dev/plugins-acme',
          srcDir: resolve(rootDir, 'packages', 'plugins', 'acme'),
          destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', 'plugins-acme'),
        }),
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('hasBundledWorkspacePackagesHealthy', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('returns false when a bundled workspace runtime dependency tree is incomplete', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-'));

    const workspacePackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(workspacePackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: {
            depA: '^1.0.0',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(workspacePackageDir, 'dist/index.js'), 'export {};\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: workspacePackageDir,
      destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol'),
    });

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: rootDir,
        hostPackageDir,
      }),
    ).toBe(false);
  });

  it('returns false when repoRoot points at the host app package and a bundled workspace is incomplete', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-'));
    writeFileSync(resolve(rootDir, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2), 'utf8');
    writeFileSync(resolve(rootDir, 'yarn.lock'), '', 'utf8');

    const workspacePackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(workspacePackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: {
            depA: '^1.0.0',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(workspacePackageDir, 'dist/index.js'), 'export {};\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: workspacePackageDir,
      destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol'),
    });

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: hostPackageDir,
        hostPackageDir,
      }),
    ).toBe(false);
  });

  it('returns false when the source workspace package is unavailable but the bundled payload is incomplete', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-'));
    writeFileSync(resolve(rootDir, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2), 'utf8');
    writeFileSync(resolve(rootDir, 'yarn.lock'), '', 'utf8');

    const sourceWorkspaceDir = resolve(rootDir, 'external', 'protocol-source');
    mkdirSync(resolve(sourceWorkspaceDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(sourceWorkspaceDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: {
            depA: '^1.0.0',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(sourceWorkspaceDir, 'dist/index.js'), 'export {};\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: sourceWorkspaceDir,
      destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol'),
    });
    rmSync(resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'));

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: hostPackageDir,
        hostPackageDir,
      }),
    ).toBe(false);
  });

  it('returns true when bundled workspace outputs and runtime dependencies are healthy', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-'));

    const workspacePackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(workspacePackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(workspacePackageDir, 'dist/index.js'), 'export {};\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: workspacePackageDir,
      destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol'),
    });

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: rootDir,
        hostPackageDir,
      }),
    ).toBe(true);
  });

  it('treats retained targets from the previous live generation as healthy', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-retained-target-'));

    const workspacePackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(workspacePackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(workspacePackageDir, 'dist/index.js'), 'export const version = "source";\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    const destPackageDir = resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol');
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(destPackageDir, 'package.json'), '{}\n', 'utf8');
    writeFileSync(resolve(destPackageDir, 'dist/index.js'), 'export const version = "previous";\n', 'utf8');
    writeFileSync(resolve(destPackageDir, 'dist/retained.js'), 'export const retained = true;\n', 'utf8');

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: workspacePackageDir,
      destDir: destPackageDir,
      preserveDestinationPath: true,
      pruneStale: false,
    });

    expect(existsSync(resolve(destPackageDir, 'dist/retained.js'))).toBe(true);
    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: rootDir,
        hostPackageDir,
      }),
    ).toBe(true);
  });

  it('returns false when bundled workspace dist content is stale', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-stale-'));

    const workspacePackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(workspacePackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(workspacePackageDir, 'dist/index.js'), 'export const version = "source";\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );

    const destPackageDir = resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol');
    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: workspacePackageDir,
      destDir: destPackageDir,
    });
    writeFileSync(resolve(destPackageDir, 'dist/index.js'), 'export const version = "stale";\n', 'utf8');

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: rootDir,
        hostPackageDir,
      }),
    ).toBe(false);
  });

  it('accepts vendored runtime dependency main targets resolved with a js extension', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-extension-main-'));

    const workspacePackageDir = resolve(rootDir, 'packages/agents');
    mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
    const dependencyPackageDir = resolve(workspacePackageDir, 'node_modules/dep-a');
    mkdirSync(dependencyPackageDir, { recursive: true });
    writeFileSync(
      resolve(workspacePackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { 'dep-a': '1.0.0' },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(workspacePackageDir, 'dist/index.js'), 'export const agent = true;\n', 'utf8');
    writeFileSync(
      resolve(dependencyPackageDir, 'package.json'),
      JSON.stringify({ name: 'dep-a', version: '1.0.0', main: './index', dependencies: {} }, null, 2),
      'utf8',
    );
    writeFileSync(resolve(dependencyPackageDir, 'index.js'), 'module.exports = true;\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/agents'],
        },
        null,
        2,
      ),
      'utf8',
    );

    bundleWorkspacePackageWithRuntimeDependencies({
      packageName: '@happier-dev/agents',
      srcDir: workspacePackageDir,
      destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', 'agents'),
    });

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: rootDir,
        hostPackageDir,
      }),
    ).toBe(true);
  });

  it('ignores bundled workspace TypeScript build-info drift', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-tsbuildinfo-'));

    const workspacePackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(workspacePackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(workspacePackageDir, 'dist/index.js'), 'export const version = "source";\n', 'utf8');
    writeFileSync(resolve(workspacePackageDir, 'dist/.tsbuildinfo'), 'source build info\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );

    const destPackageDir = resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol');
    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: workspacePackageDir,
      destDir: destPackageDir,
    });
    writeFileSync(resolve(destPackageDir, 'dist/.tsbuildinfo'), 'bundled build info\n', 'utf8');

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: rootDir,
        hostPackageDir,
      }),
    ).toBe(true);
  });

  it('ignores bundled workspace declaration metadata drift', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-types-'));

    const workspacePackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(workspacePackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          types: './dist/index.d.ts',
          exports: {
            '.': {
              types: './dist/index.d.ts',
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(workspacePackageDir, 'dist/index.js'), 'export const version = "source";\n', 'utf8');
    writeFileSync(resolve(workspacePackageDir, 'dist/index.d.ts'), 'export declare const version = "source";\n', 'utf8');
    writeFileSync(resolve(workspacePackageDir, 'dist/index.d.ts.map'), '{"version":3,"source":"source"}\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );

    const destPackageDir = resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol');
    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: workspacePackageDir,
      destDir: destPackageDir,
    });
    writeFileSync(resolve(destPackageDir, 'dist/index.d.ts'), 'export declare const version = "bundled";\n', 'utf8');
    writeFileSync(resolve(destPackageDir, 'dist/index.d.ts.map'), '{"version":3,"source":"bundled"}\n', 'utf8');

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: rootDir,
        hostPackageDir,
      }),
    ).toBe(true);
  });
});

describe('copyDirSafeSync', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('retries a transient ENOENT while copying a directory tree', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-copy-dir-'));

    const srcDir = resolve(rootDir, 'packages/protocol/dist');
    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol/dist');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(resolve(srcDir, 'index.js'), 'export const ok = true;\n');

    let attempts = 0;

    copyDirSafeSync(srcDir, destDir, {
      retries: 1,
      delayMs: 0,
      copyFileSyncImpl(source, target) {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('ENOENT');
          Reflect.set(error, 'code', 'ENOENT');
          throw error;
        }

        return copyFileSync(source, target);
      },
    });

    expect(attempts).toBe(2);
    expect(readFileSync(resolve(destDir, 'index.js'), 'utf8')).toBe('export const ok = true;\n');
  });

  it('copies directory trees without delegating traversal to native cpSync', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-copy-dir-js-walk-'));

    const srcDir = resolve(rootDir, 'packages/protocol/dist');
    const nestedDir = resolve(srcDir, 'nested');
    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol/dist');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(resolve(nestedDir, 'index.js'), 'export const nested = true;\n');

    let readdirCalls = 0;

    copyDirSafeSync(srcDir, destDir, {
      readdirSyncImpl(path) {
        readdirCalls += 1;
        return readdirSync(path, { withFileTypes: true });
      },
    });

    expect(readdirCalls).toBeGreaterThan(0);
    expect(readFileSync(resolve(destDir, 'nested', 'index.js'), 'utf8')).toBe('export const nested = true;\n');
  });
});

describe('atomicReplaceDirSync', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('keeps a live runtime dependency path readable while replacing its contents', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol/node_modules');
    const liveFile = resolve(destDir, '@noble/hashes/esm/sha512.js');
    mkdirSync(resolve(destDir, '@noble/hashes/esm'), { recursive: true });
    writeFileSync(liveFile, 'export const version = "old";\n');

    let observedMissingLiveFile = false;

    atomicReplaceDirSync({
      destDir,
      preserveDestinationPath: true,
      buildInto(tempDir) {
        mkdirSync(resolve(tempDir, '@noble/hashes/esm'), { recursive: true });
        writeFileSync(resolve(tempDir, '@noble/hashes/esm/sha512.js'), 'export const version = "new";\n');
      },
      fsOps: {
        renameSync(source, target) {
          const result = renameSync(source, target);
          if (!existsSync(liveFile)) observedMissingLiveFile = true;
          return result;
        },
      },
    });

    expect(observedMissingLiveFile).toBe(false);
    expect(readFileSync(liveFile, 'utf8')).toBe('export const version = "new";\n');
  });

  it('retries transient Windows-style failures while replacing a live file', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-live-file-retry-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const liveFile = resolve(destDir, 'dist/index.js');
    mkdirSync(resolve(destDir, 'dist'), { recursive: true });
    writeFileSync(liveFile, 'export const version = "old";\n');

    let replacementAttempts = 0;
    atomicReplaceDirSync({
      destDir,
      preserveDestinationPath: true,
      pruneStale: false,
      buildInto(tempDir) {
        mkdirSync(resolve(tempDir, 'dist'), { recursive: true });
        writeFileSync(resolve(tempDir, 'dist/index.js'), 'export const version = "new";\n');
      },
      fsOps: {
        renameSync(source, target) {
          if (target === liveFile) {
            replacementAttempts += 1;
            if (replacementAttempts < 3) {
              expect(readFileSync(liveFile, 'utf8')).toBe('export const version = "old";\n');
              const error = new Error('EPERM');
              Reflect.set(error, 'code', 'EPERM');
              throw error;
            }
          }
          return renameSync(source, target);
        },
      },
    });

    expect(replacementAttempts).toBe(3);
    expect(readFileSync(liveFile, 'utf8')).toBe('export const version = "new";\n');
  });

  it('does not republish unchanged live files', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-live-file-noop-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const liveFile = resolve(destDir, 'dist/index.js');
    mkdirSync(resolve(destDir, 'dist'), { recursive: true });
    writeFileSync(liveFile, 'export const version = "same";\n');
    const previousInode = statSync(liveFile).ino;

    let liveReplacementAttempts = 0;
    atomicReplaceDirSync({
      destDir,
      preserveDestinationPath: true,
      pruneStale: false,
      buildInto(tempDir) {
        mkdirSync(resolve(tempDir, 'dist'), { recursive: true });
        writeFileSync(resolve(tempDir, 'dist/index.js'), 'export const version = "same";\n');
      },
      fsOps: {
        renameSync(source, target) {
          if (target === liveFile) liveReplacementAttempts += 1;
          return renameSync(source, target);
        },
      },
    });

    expect(liveReplacementAttempts).toBe(0);
    expect(statSync(liveFile).ino).toBe(previousInode);
  });

  it('rolls back files already published when a later live replacement fails persistently', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-live-file-rollback-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const firstLiveFile = resolve(destDir, 'dist/a.js');
    const failingLiveFile = resolve(destDir, 'dist/b.js');
    const packageJsonPath = resolve(destDir, 'package.json');
    mkdirSync(resolve(destDir, 'dist'), { recursive: true });
    writeFileSync(firstLiveFile, 'export const version = "old-a";\n');
    writeFileSync(failingLiveFile, 'export const version = "old-b";\n');
    writeFileSync(packageJsonPath, JSON.stringify({ version: 'old' }));

    let failingReplacementAttempts = 0;
    let failingTargetRemovalAttempts = 0;
    expect(() =>
      atomicReplaceDirSync({
        destDir,
        preserveDestinationPath: true,
        pruneStale: false,
        buildInto(tempDir) {
          mkdirSync(resolve(tempDir, 'dist'), { recursive: true });
          writeFileSync(resolve(tempDir, 'dist/a.js'), 'export const version = "new-a";\n');
          writeFileSync(resolve(tempDir, 'dist/b.js'), 'export const version = "new-b";\n');
          writeFileSync(resolve(tempDir, 'package.json'), JSON.stringify({ version: 'new' }));
        },
        fsOps: {
          renameSync(source, target) {
            if (target === failingLiveFile && String(source).includes('.__sync_tmp__.')) {
              failingReplacementAttempts += 1;
              const error = new Error('EPERM');
              Reflect.set(error, 'code', 'EPERM');
              throw error;
            }
            return renameSync(source, target);
          },
          rmSync(path, options) {
            if (path === failingLiveFile) {
              failingTargetRemovalAttempts += 1;
              const error = new Error('EPERM');
              Reflect.set(error, 'code', 'EPERM');
              throw error;
            }
            return rmSync(path, options);
          },
        },
      }),
    ).toThrow(/EPERM/);

    expect(failingReplacementAttempts).toBe(6);
    expect(failingTargetRemovalAttempts).toBe(0);
    expect(readFileSync(firstLiveFile, 'utf8')).toBe('export const version = "old-a";\n');
    expect(readFileSync(failingLiveFile, 'utf8')).toBe('export const version = "old-b";\n');
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8')).version).toBe('old');
  });

  it('publishes a new package manifest after its targets exist and before prior targets are pruned', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-package-publication-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/cli-common');
    const packageJsonPath = resolve(destDir, 'package.json');
    const previousTarget = resolve(destDir, 'dist/previous.js');
    const nextTarget = resolve(destDir, 'dist/next.js');
    mkdirSync(resolve(destDir, 'dist'), { recursive: true });
    writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: '@happier-dev/cli-common',
        exports: { './publication-test': './dist/previous.js' },
      }),
    );
    writeFileSync(previousTarget, 'export const version = "previous";\n');

    let observedManifestPublication = false;

    atomicReplaceDirSync({
      destDir,
      preserveDestinationPath: true,
      buildInto(tempDir) {
        mkdirSync(resolve(tempDir, 'dist'), { recursive: true });
        writeFileSync(resolve(tempDir, 'dist/next.js'), 'export const version = "next";\n');
        writeFileSync(
          resolve(tempDir, 'package.json'),
          JSON.stringify({
            name: '@happier-dev/cli-common',
            exports: { './publication-test': './dist/next.js' },
          }),
        );
      },
      fsOps: {
        renameSync(source, target) {
          if (target === packageJsonPath) {
            observedManifestPublication = true;
            expect(existsSync(nextTarget)).toBe(true);
            expect(existsSync(previousTarget)).toBe(true);
            expect(JSON.parse(readFileSync(packageJsonPath, 'utf8')).exports['./publication-test']).toBe(
              './dist/previous.js',
            );
          }
          return renameSync(source, target);
        },
      },
    });

    expect(observedManifestPublication).toBe(true);
    expect(existsSync(previousTarget)).toBe(false);
    expect(readFileSync(nextTarget, 'utf8')).toBe('export const version = "next";\n');
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8')).exports['./publication-test']).toBe('./dist/next.js');
  });

  it('retries a staged swap when the destination briefly reappears during the rename', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const tempFileName = 'next.txt';
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';
    let renameFailures = 0;

    atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, tempFileName), 'new');
      },
      fsOps: {
        renameSync(source, target) {
          if (source === stagedDir && target === destDir && renameFailures === 0) {
            renameFailures += 1;
            const error = new Error('ENOTEMPTY');
            Reflect.set(error, 'code', 'ENOTEMPTY');
            throw error;
          }

          return renameSync(source, target);
        },
      },
    });

    expect(renameFailures).toBe(1);
    expect(readFileSync(resolve(destDir, tempFileName), 'utf8')).toBe('new');
    expect(existsSync(resolve(destDir, previousFileName))).toBe(false);
  });

  it('continues when the destination disappears after the existence check', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const tempFileName = 'next.txt';
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';
    let existsChecks = 0;
    let renameCalls = 0;

    atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, tempFileName), 'new');
      },
      fsOps: {
        existsSync(targetPath) {
          if (targetPath === destDir) {
            existsChecks += 1;
            return existsChecks === 1 ? true : existsSync(targetPath);
          }
          return existsSync(targetPath);
        },
        renameSync(source, target) {
          if (source === destDir && target !== destDir && renameCalls === 0) {
            renameCalls += 1;
            rmSync(destDir, { recursive: true, force: true });
            const error = new Error('ENOENT');
            Reflect.set(error, 'code', 'ENOENT');
            throw error;
          }

          return renameSync(source, target);
        },
      },
    });

    expect(renameCalls).toBe(1);
    expect(readFileSync(resolve(destDir, tempFileName), 'utf8')).toBe('new');
    expect(existsSync(resolve(destDir, previousFileName))).toBe(false);
  });

  it('does not remove the live destination when backup rename is blocked', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';

    expect(() => atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, 'next.txt'), 'new');
      },
      fsOps: {
        renameSync(source, target) {
          if (source === destDir && target !== destDir) {
            const error = new Error('EPERM');
            Reflect.set(error, 'code', 'EPERM');
            throw error;
          }
          return renameSync(source, target);
        },
      },
    })).toThrow(/EPERM/);

    expect(existsSync(stagedDir)).toBe(false);
    expect(readFileSync(resolve(destDir, previousFileName), 'utf8')).toBe('old');
  });
});
