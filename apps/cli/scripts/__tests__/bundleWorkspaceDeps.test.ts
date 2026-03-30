import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { bundleWorkspaceDeps } from '../bundleWorkspaceDeps.mjs';
import {
  createPackageLayoutSandbox,
  writeCliBundledHostPackage,
  writeRuntimeDependencyStub,
  writeWorkspacePackageFixture,
} from './testkit/packageLayoutSandbox';

describe('bundleWorkspaceDeps', () => {
  it('copies dist + writes a sanitized package.json without install scripts', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-workspace-deps-');

    try {
      // Hoisted runtime deps used by bundled workspaces (resolved from workspace package.json).
      writeRuntimeDependencyStub({
        repoRoot,
        packageName: 'base64-js',
        manifestOverrides: { version: '1.5.1' },
      });
      writeRuntimeDependencyStub({
        repoRoot,
        packageName: '@noble/hashes',
        manifestOverrides: { version: '1.8.0' },
      });
      writeRuntimeDependencyStub({
        repoRoot,
        packageName: 'tweetnacl',
        manifestOverrides: { version: '1.0.3', main: 'nacl-fast.js' },
        files: { 'nacl-fast.js': 'module.exports = {};\n' },
      });

      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: [
          '@happier-dev/agents',
          '@happier-dev/cli-common',
          '@happier-dev/connection-supervisor',
          '@happier-dev/protocol',
          '@happier-dev/transfers',
          '@happier-dev/release-runtime',
        ],
      });

    writeWorkspacePackageFixture({
      repoRoot,
      workspacePath: 'packages/agents',
      packageName: '@happier-dev/agents',
      manifestOverrides: {
        scripts: { postinstall: 'echo should-not-run' },
        devDependencies: { typescript: '^5' },
      },
      files: { 'dist/index.js': 'export const x = 1;\n' },
    });
    writeWorkspacePackageFixture({
      repoRoot,
      workspacePath: 'packages/protocol',
      packageName: '@happier-dev/protocol',
      manifestOverrides: {
        scripts: { postinstall: 'echo should-not-run' },
        dependencies: {
          'base64-js': '^1.5.1',
          '@noble/hashes': '^1.8.0',
          tweetnacl: '^1.0.3',
        },
      },
      files: { 'dist/index.js': 'export const y = 2;\n' },
    });
    writeWorkspacePackageFixture({
      repoRoot,
      workspacePath: 'packages/cli-common',
      packageName: '@happier-dev/cli-common',
      manifestOverrides: { scripts: { postinstall: 'echo should-not-run' } },
      files: { 'dist/index.js': 'export const z = 3;\n' },
    });
    writeWorkspacePackageFixture({
      repoRoot,
      workspacePath: 'packages/connection-supervisor',
      packageName: '@happier-dev/connection-supervisor',
      manifestOverrides: { scripts: { postinstall: 'echo should-not-run' } },
      files: { 'dist/index.js': 'export const q = 4;\n' },
    });
    writeWorkspacePackageFixture({
      repoRoot,
      workspacePath: 'packages/transfers',
      packageName: '@happier-dev/transfers',
      manifestOverrides: {
        scripts: { postinstall: 'echo should-not-run' },
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
        },
      },
      files: { 'dist/index.js': 'export const transfer = true;\n' },
    });
    writeWorkspacePackageFixture({
      repoRoot,
      workspacePath: 'packages/release-runtime',
      packageName: '@happier-dev/release-runtime',
      manifestOverrides: {
        scripts: { postinstall: 'echo should-not-run' },
        devDependencies: { typescript: '^5' },
      },
      files: { 'dist/index.js': 'export const w = 4;\n' },
    });

      await bundleWorkspaceDeps({ repoRoot, happyCliDir });

    // Protocol runtime deps should be vendored under the bundled protocol package.
    expect(
      existsSync(
        join(happyCliDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'base64-js', 'package.json'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(happyCliDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', '@noble', 'hashes', 'package.json'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(happyCliDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'tweetnacl', 'package.json'),
      ),
    ).toBe(true);

    // Avoid duplicating protocol deps at the CLI root `node_modules`.
    expect(existsSync(join(happyCliDir, 'node_modules', 'base64-js'))).toBe(false);
    expect(existsSync(join(happyCliDir, 'node_modules', '@noble'))).toBe(false);
    expect(existsSync(join(happyCliDir, 'node_modules', 'tweetnacl'))).toBe(false);
    const bundledAgentsPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'agents', 'package.json'), 'utf8'),
    );
    const bundledProtocolPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'protocol', 'package.json'), 'utf8'),
    );
    const bundledCommonPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'cli-common', 'package.json'), 'utf8'),
    );
    const bundledConnectionSupervisorPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'connection-supervisor', 'package.json'), 'utf8'),
    );
    const bundledTransfersPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'transfers', 'package.json'), 'utf8'),
    );
    const bundledReleaseRuntimePkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'release-runtime', 'package.json'), 'utf8'),
    );

    expect(bundledAgentsPkgJson.scripts).toBeUndefined();
    expect(bundledAgentsPkgJson.devDependencies).toBeUndefined();
    expect(bundledAgentsPkgJson.name).toBe('@happier-dev/agents');

    expect(bundledProtocolPkgJson.scripts).toBeUndefined();
    expect(bundledProtocolPkgJson.name).toBe('@happier-dev/protocol');

    expect(bundledCommonPkgJson.scripts).toBeUndefined();
    expect(bundledCommonPkgJson.name).toBe('@happier-dev/cli-common');

    expect(bundledConnectionSupervisorPkgJson.scripts).toBeUndefined();
    expect(bundledConnectionSupervisorPkgJson.name).toBe('@happier-dev/connection-supervisor');

    expect(bundledTransfersPkgJson.scripts).toBeUndefined();
    expect(bundledTransfersPkgJson.name).toBe('@happier-dev/transfers');
    expect(bundledTransfersPkgJson.dependencies?.['@happier-dev/protocol']).toBeUndefined();
    expect(bundledTransfersPkgJson.dependencies?.['base64-js']).toBeUndefined();

      expect(bundledReleaseRuntimePkgJson.scripts).toBeUndefined();
      expect(bundledReleaseRuntimePkgJson.devDependencies).toBeUndefined();
      expect(bundledReleaseRuntimePkgJson.name).toBe('@happier-dev/release-runtime');
    } finally {
      cleanup();
    }
  });

  it('vendors the external runtime dependency tree for bundled workspace packages', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-workspace-deps-tree-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/protocol', '@happier-dev/release-runtime'],
      });

    writeWorkspacePackageFixture({
      repoRoot,
      workspacePath: 'packages/protocol',
      packageName: '@happier-dev/protocol',
      manifestOverrides: {
        dependencies: {
          'dep-a': '^1.0.0',
        },
      },
      files: { 'dist/index.js': 'export const y = 2;\n' },
    });
    writeWorkspacePackageFixture({
      repoRoot,
      workspacePath: 'packages/release-runtime',
      packageName: '@happier-dev/release-runtime',
      files: { 'dist/index.js': 'export const w = 4;\n' },
    });

    writeRuntimeDependencyStub({
      repoRoot,
      packageName: 'dep-a',
      manifestOverrides: {
        dependencies: {
          'dep-b': '^1.0.0',
        },
      },
      files: { 'index.js': 'module.exports = { a: true };\n' },
    });
    writeRuntimeDependencyStub({
      repoRoot,
      packageName: 'dep-b',
      files: { 'index.js': 'module.exports = { b: true };\n' },
    });

    // Minimal stubs for other bundled workspace packages.
    for (const pkg of [
      { name: '@happier-dev/agents', workspacePath: 'packages/agents' },
      { name: '@happier-dev/cli-common', workspacePath: 'packages/cli-common' },
      { name: '@happier-dev/transfers', workspacePath: 'packages/transfers' },
    ]) {
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: pkg.workspacePath,
        packageName: pkg.name,
        manifestOverrides: {
          dependencies: {
            '@happier-dev/protocol': '0.0.0',
          },
        },
        files: { 'dist/index.js': 'export const x = 1;\n' },
      });
    }

      await bundleWorkspaceDeps({ repoRoot, happyCliDir });

    // dep-a is vendored because protocol declares it.
    expect(() =>
      readFileSync(
        resolve(happyCliDir, 'node_modules', '@happier-dev', 'protocol', 'node_modules', 'dep-a', 'package.json'),
        'utf8',
      ),
    ).not.toThrow();

    // dep-b is vendored transitively because dep-a depends on it.
      expect(() =>
        readFileSync(
          resolve(
            happyCliDir,
            'node_modules',
            '@happier-dev',
            'protocol',
            'node_modules',
            'dep-a',
            'node_modules',
            'dep-b',
            'package.json',
          ),
          'utf8',
        ),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('derives bundled workspaces from the host package bundledDependencies manifest', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-manifest-');

    try {
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/agents',
        packageName: '@happier-dev/agents',
        manifestOverrides: { exports: { '.': { default: './dist/index.js' } } },
        files: { 'dist/index.js': 'export const agent = true;\n' },
      });
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/cli-common',
        packageName: '@happier-dev/cli-common',
        manifestOverrides: { exports: { '.': { default: './dist/index.js' } } },
        files: { 'dist/index.js': 'export const cliCommon = true;\n' },
      });

      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/cli-common'],
      });

      await bundleWorkspaceDeps({ repoRoot, happyCliDir });

      expect(existsSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'cli-common', 'package.json'))).toBe(true);
      expect(existsSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'agents', 'package.json'))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
