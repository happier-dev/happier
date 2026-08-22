import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import {
  bundleWorkspaceDeps,
  loadCliCommonWorkspacesModule,
} from '../bundleWorkspaceDeps.mjs';
import { materializePrepublicationWorkspacePackageRoots } from '../../../../packages/cli-common/src/workspaces/index';
import {
  createPackageLayoutSandbox,
  writeCliBundledHostPackage,
  writeRuntimeDependencyStub,
  writeWorkspacePackageFixture,
} from './testkit/packageLayoutSandbox';
import { writeSandboxTextFile } from './testkit/cliBinPreflightSandbox';

function sha256Digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function collectSandboxPackageTreeFiles(packageDir: string): readonly string[] {
  const found: string[] = [];
  const visit = (relativePath: string): void => {
    const absolutePath = relativePath ? resolve(packageDir, ...relativePath.split('/')) : packageDir;
    const entries = readdirSync(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!relativePath && entry.name === 'node_modules') continue;
      const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(childPath);
      else if (entry.isFile()) found.push(childPath);
    }
  };
  visit('');
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function writeBundledPluginArtifactInventory(options: {
  repoRoot: string;
  packageName: string;
  pluginId: string;
  files: readonly { relativePath: string; bytes: Buffer }[];
}): void {
  const inventoryPath = resolve(
    options.repoRoot,
    'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts',
  );
  mkdirSync(dirname(inventoryPath), { recursive: true });
  const immutableArtifacts = [{
    packageEntryRelativePath: 'dist/index.js',
    packageName: options.packageName,
    record: {
      createdAtMs: 0,
      files: options.files.map((file) => ({
        byteLength: file.bytes.byteLength,
        relativePath: file.relativePath,
      })),
      manifestRelativePath: '.happier-plugin/plugin.json',
      pluginId: options.pluginId,
      schemaVersion: 1,
      t: 'happier_plugin_generation_v1',
    },
  }];
  const sourceArtifactIntegrities = [{
    packageName: options.packageName,
    files: options.files.map((file) => ({
      byteLength: file.bytes.byteLength,
      digest: sha256Digest(file.bytes),
      relativePath: file.relativePath,
    })),
  }];
  writeFileSync(
    inventoryPath,
    [
      "import type { BundledImmutablePluginArtifact } from '../../../store/registry/generationStore';",
      '',
      'export const BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS = Object.freeze(',
      `${JSON.stringify(immutableArtifacts, null, 2)} satisfies readonly BundledImmutablePluginArtifact[]);`,
      '',
      'export type BundledFirstPartySourceArtifactIntegrity = Readonly<{',
      '  packageName: string;',
      '  files: readonly Readonly<{ relativePath: string; byteLength: number; digest: string }>[];',
      '}>;',
      '',
      'export const BUNDLED_FIRST_PARTY_SOURCE_ARTIFACT_INTEGRITIES = Object.freeze(',
      `${JSON.stringify(sourceArtifactIntegrities, null, 2)} satisfies readonly BundledFirstPartySourceArtifactIntegrity[]);`,
      '',
    ].join('\n'),
    'utf8',
  );
}

describe('bundleWorkspaceDeps', () => {
  it('admits an existing cli-common dist before importing the implementation helper', async () => {
    const { repoRoot, cleanup } = createPackageLayoutSandbox('happy-bundle-workspace-helper-admission-');

    try {
      const cliCommonDir = writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/cli-common',
        packageName: '@happier-dev/cli-common',
        files: {
          'dist/workspaces/index.js': 'export const implementationMarker = "stale";\n',
        },
      });
      const implementationPath = resolve(cliCommonDir, 'dist', 'workspaces', 'index.js');
      const ensureWorkspacePackagesBuiltByName = vi.fn(async () => {
        expect(readFileSync(implementationPath, 'utf8')).toContain('"stale"');
        writeFileSync(implementationPath, 'export const implementationMarker = "fresh";\n', 'utf8');
      });

      const implementation = await loadCliCommonWorkspacesModule(
        repoRoot,
        {},
        ensureWorkspacePackagesBuiltByName,
      );

      expect(ensureWorkspacePackagesBuiltByName).toHaveBeenCalledWith(
        repoRoot,
        ['@happier-dev/cli-common'],
        { quiet: false, env: {}, includeDevDependencies: false },
      );
      expect(implementation.implementationMarker).toBe('fresh');
    } finally {
      cleanup();
    }
  });

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
	          '@happier-dev/plugin-sdk',
	          '@happier-dev/plugins-claude',
	          '@happier-dev/peer-mediation',
	          '@happier-dev/protocol',
          '@happier-dev/transfers',
          '@happier-dev/release-runtime',
        ],
        dependencies: {
          '@happier-dev/plugins-claude': '0.0.0',
        },
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
      workspacePath: 'packages/plugin-sdk',
      packageName: '@happier-dev/plugin-sdk',
      manifestOverrides: {
        scripts: { postinstall: 'echo should-not-run' },
        devDependencies: { typescript: '^5' },
      },
      files: { 'dist/index.js': 'export const sdk = true;\n' },
    });
    writeWorkspacePackageFixture({
      repoRoot,
      workspacePath: 'packages/peer-mediation',
      packageName: '@happier-dev/peer-mediation',
      manifestOverrides: {
        scripts: { postinstall: 'echo should-not-run' },
        dependencies: {
          '@happier-dev/peer-mediation': '0.0.0',
          '@happier-dev/protocol': '0.0.0',
        },
      },
      files: { 'dist/index.js': 'export const peer = true;\n' },
    });
    writeWorkspacePackageFixture({
      repoRoot,
      workspacePath: 'packages/plugins/claude',
      packageName: '@happier-dev/plugins-claude',
      manifestOverrides: { scripts: { postinstall: 'echo should-not-run' } },
      files: {
        'dist/index.js': 'export const bundledPlugin = true;\n',
        'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "claude", runtime: { apiVersion: 1 }, contributes: {} });\n',
        'src/agent/definition.ts': 'export const AGENT_DEFINITION = Object.freeze({ id: "claude" });\n',
      },
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
    const bundledPluginSdkPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'plugin-sdk', 'package.json'), 'utf8'),
    );
    const bundledPluginPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'plugins-claude', 'package.json'), 'utf8'),
    );
    const bundledPeerMediationPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'peer-mediation', 'package.json'), 'utf8'),
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

    expect(bundledPluginSdkPkgJson.scripts).toBeUndefined();
    expect(bundledPluginSdkPkgJson.devDependencies).toBeUndefined();
    expect(bundledPluginSdkPkgJson.name).toBe('@happier-dev/plugin-sdk');
    expect(bundledPluginSdkPkgJson.dependencies?.['@happier-dev/agents']).toBeUndefined();
    expect(bundledPluginSdkPkgJson.dependencies?.['@happier-dev/protocol']).toBeUndefined();

    expect(bundledPluginPkgJson.scripts).toBeUndefined();
    expect(bundledPluginPkgJson.name).toBe('@happier-dev/plugins-claude');

    expect(bundledPeerMediationPkgJson.scripts).toBeUndefined();
    expect(bundledPeerMediationPkgJson.name).toBe('@happier-dev/peer-mediation');
    expect(bundledPeerMediationPkgJson.dependencies?.['@happier-dev/protocol']).toBeUndefined();

    expect(bundledTransfersPkgJson.scripts).toBeUndefined();
    expect(bundledTransfersPkgJson.name).toBe('@happier-dev/transfers');
    expect(bundledTransfersPkgJson.dependencies?.['@happier-dev/peer-mediation']).toBeUndefined();
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
	      { name: '@happier-dev/plugin-sdk', workspacePath: 'packages/plugin-sdk' },
	      { name: '@happier-dev/peer-mediation', workspacePath: 'packages/peer-mediation' },
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

  it('fails fast if packages/plugins contains plugin workspaces that are not declared as bundledDependencies', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-missing-plugin-dep-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: [],
      });

      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/acme',
        packageName: '@happier-dev/plugins-acme',
        manifestOverrides: { exports: { '.': { default: './dist/index.js' } } },
        files: {
          'dist/index.js': 'export const bundledPlugin = true;\n',
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "acme", runtime: { apiVersion: 1 }, contributes: {} });\n',
          'src/agent/definition.ts': 'export const AGENT_DEFINITION = Object.freeze({ id: "acme" });\n',
        },
      });

      await expect(bundleWorkspaceDeps({ repoRoot, happyCliDir })).rejects.toThrow(
        'Missing bundled plugin workspace dependencies',
      );
    } finally {
      cleanup();
    }
  });

  it('fails fast if a bundled plugin workspace is absent from CLI dependencies', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-missing-plugin-runtime-dep-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/plugins-grok'],
        dependencies: {},
      });

      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/grok',
        packageName: '@happier-dev/plugins-grok',
        files: {
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "grok", runtime: { apiVersion: 1 }, contributes: {} });\n',
          'src/agent/definition.ts': 'export const AGENT_DEFINITION = Object.freeze({ id: "grok" });\n',
        },
      });

      await expect(bundleWorkspaceDeps({ repoRoot, happyCliDir })).rejects.toThrow(
        'Missing CLI runtime dependencies for bundled plugin workspaces',
      );
    } finally {
      cleanup();
    }
  });

  it('materializes Inspector UI artifacts and their internal runtime closure into the artifact tree', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-plugin-closure-');
    // This fixture already supplies the complete built package trees. The
    // contract under test is the host's closure/materialization, not a real
    // workspace compiler (which is covered by the source-dev integration
    // boundary that invokes this bundler with its normal builder).
    const ensureWorkspacePackagesBuiltByName = async (_repoRoot: string, names: readonly string[]) => ({
      ok: true,
      built: [...names],
      skipped: [] as string[],
    });

    try {
      const bundledDependencies = [
        '@happier-dev/plugin-sdk',
        '@happier-dev/plugin-ui',
        '@happier-dev/plugins-grok',
        '@happier-dev/plugins-inspector',
      ];
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies,
        dependencies: {
          '@happier-dev/plugin-ui': '0.0.0',
          '@happier-dev/plugins-grok': '0.0.0',
          '@happier-dev/plugins-inspector': '0.0.0',
        },
      });

      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugin-sdk',
        packageName: '@happier-dev/plugin-sdk',
        files: {
          'dist/index.js': 'export const sdk = true;\n',
          'dist/index.d.ts': 'export declare const sdk: true;\n',
        },
      });
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugin-ui',
        packageName: '@happier-dev/plugin-ui',
        files: {
          'dist/index.js': 'export const surface = true;\n',
          'dist/index.d.ts': 'export declare const surface: true;\n',
        },
      });
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/grok',
        packageName: '@happier-dev/plugins-grok',
        manifestOverrides: {
          dependencies: {
            '@happier-dev/plugin-sdk': '0.0.0',
            '@happier-dev/plugin-ui': '0.0.0',
          },
        },
        files: {
          'dist/index.js': "export { sdk } from '@happier-dev/plugin-sdk';\nexport { surface } from '@happier-dev/plugin-ui';\n",
          'dist/index.d.ts': "export { sdk } from '@happier-dev/plugin-sdk';\nexport { surface } from '@happier-dev/plugin-ui';\n",
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "grok", runtime: { apiVersion: 1 }, contributes: {} });\n',
        },
      });
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/inspector',
        packageName: '@happier-dev/plugins-inspector',
        manifestOverrides: {
          dependencies: {
            '@happier-dev/plugin-sdk': '0.0.0',
          },
          scripts: {
            'build:ui': 'happier-plugin-build-ui',
          },
        },
        files: {
          'dist/index.js': "export { sdk } from '@happier-dev/plugin-sdk';\n",
          'dist/index.d.ts': "export { sdk } from '@happier-dev/plugin-sdk';\n",
          'dist/happier-plugin-ui/ui-artifacts.json': '{"version":1,"entries":[]}\n',
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "inspector", runtime: { apiVersion: 1 }, contributes: {} });\n',
        },
      });

      await bundleWorkspaceDeps({
        repoRoot,
        happyCliDir,
        publicationMode: 'artifact',
        ensureWorkspacePackagesBuiltByName,
      });

      const bundledScopeDir = resolve(happyCliDir, 'node_modules', '@happier-dev');
      expect(existsSync(resolve(bundledScopeDir, 'plugin-sdk', 'dist', 'index.js'))).toBe(true);
      expect(existsSync(resolve(bundledScopeDir, 'plugin-ui', 'dist', 'index.js'))).toBe(true);
      expect(existsSync(resolve(bundledScopeDir, 'plugins-grok', 'dist', 'index.js'))).toBe(true);
      expect(
        existsSync(resolve(
          bundledScopeDir,
          'plugins-inspector',
          'dist',
          'happier-plugin-ui',
          'ui-artifacts.json',
        )),
      ).toBe(true);

      for (const packageName of ['plugins-grok', 'plugins-inspector']) {
        const packageJson = JSON.parse(
          readFileSync(resolve(bundledScopeDir, packageName, 'package.json'), 'utf8'),
        ) as { dependencies?: Record<string, string>; scripts?: Record<string, string> };
        expect(packageJson.dependencies?.['@happier-dev/plugin-sdk']).toBeUndefined();
        expect(packageJson.dependencies?.['@happier-dev/plugin-ui']).toBeUndefined();
        expect(packageJson.scripts).toBeUndefined();
      }
    } finally {
      cleanup();
    }
  });

  it('keeps prepublication package metadata flat in the CLI and materializes an independently installable author tree', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-prepublication-closure-');
    const ensureWorkspacePackagesBuiltByName = async (_repoRoot: string, names: readonly string[]) => ({
      ok: true,
      built: [...names],
      skipped: [] as string[],
    });

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: [
          '@happier-dev/plugin-sdk',
          '@happier-dev/plugin-ui',
          '@happier-dev/protocol',
        ],
        dependencies: {
          '@happier-dev/plugin-sdk': '0.0.0',
          '@happier-dev/plugin-ui': '0.0.0',
          '@happier-dev/protocol': '0.0.0',
        },
      });
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/protocol',
        packageName: '@happier-dev/protocol',
        manifestOverrides: {
          exports: {
            '.': { default: './dist/index.js', types: './dist/index.d.ts' },
            './plugins/ui/client': {
              default: './dist/plugins/ui/client.js',
              types: './dist/plugins/ui/client.d.ts',
            },
          },
        },
        files: {
          'dist/index.js': 'export const protocol = true;\n',
          'dist/plugins/ui/client.js': 'export const protocolUiClient = true;\n',
        },
      });
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugin-sdk',
        packageName: '@happier-dev/plugin-sdk',
        manifestOverrides: {
          dependencies: { '@happier-dev/protocol': '0.0.0' },
          optionalDependencies: { '@happier-dev/protocol': '0.0.0' },
          bundledDependencies: ['@happier-dev/protocol'],
          files: [
            'dist',
            'package.json',
            'README.md',
            'API.md',
            'api-declarations.md',
            'api-surface.json',
            'capability-matrix.json',
            'examples/public-authoring/index.ts',
            'scripts/validate-authoring.mjs',
          ],
          exports: {
            '.': { default: './dist/index.js', types: './dist/index.d.ts' },
            './composer': { default: './dist/composer.js', types: './dist/composer.d.ts' },
          },
          happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
        },
        files: {
          'dist/index.js': 'export const sdk = true;\n',
          'dist/composer.js': "export { protocolUiClient } from '@happier-dev/protocol/plugins/ui/client';\n",
          'README.md': '# Plugin SDK\n',
          'API.md': '# API\n',
          'api-declarations.md': '# Declarations\n',
          'api-surface.json': '{"api":"current"}\n',
          'capability-matrix.json': '{"capability":"authoring"}\n',
          'examples/public-authoring/index.ts': 'export const authoringExample = true;\n',
          'scripts/validate-authoring.mjs': 'export const validate = true;\n',
        },
      });
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugin-ui',
        packageName: '@happier-dev/plugin-ui',
        manifestOverrides: {
          dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
          files: [
            'dist',
            'package.json',
            'README.md',
            'api-declarations.md',
          ],
          happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
        },
        files: {
          'dist/index.js': "export { sdk } from '@happier-dev/plugin-sdk';\n",
          'README.md': '# Plugin UI\n',
          'api-declarations.md': '# UI declarations\n',
        },
      });

      await bundleWorkspaceDeps({
        repoRoot,
        happyCliDir,
        publicationMode: 'artifact',
        ensureWorkspacePackagesBuiltByName,
      });

      const bundledScopeDir = resolve(happyCliDir, 'node_modules', '@happier-dev');
      const bundledSdkDir = resolve(bundledScopeDir, 'plugin-sdk');
      const bundledUiDir = resolve(bundledScopeDir, 'plugin-ui');
      const sdkPackageJson = JSON.parse(readFileSync(resolve(bundledSdkDir, 'package.json'), 'utf8')) as {
        bundledDependencies?: string[];
        dependencies?: Record<string, string>;
        files?: string[];
        optionalDependencies?: Record<string, string>;
        happier?: { publicSdkRelease?: { posture?: string } };
      };
      const uiPackageJson = JSON.parse(readFileSync(resolve(bundledUiDir, 'package.json'), 'utf8')) as {
        bundledDependencies?: string[];
        dependencies?: Record<string, string>;
        files?: string[];
        happier?: { publicSdkRelease?: { posture?: string } };
      };

      // The packed CLI retains the source-declared authoring contract, but remains
      // flat so it does not duplicate the SDK closure into its tarball.
      expect(sdkPackageJson.happier?.publicSdkRelease?.posture).toBe('prepublish_hold');
      expect(sdkPackageJson.dependencies).toEqual({ '@happier-dev/protocol': '0.0.0' });
      expect(sdkPackageJson.optionalDependencies).toEqual({ '@happier-dev/protocol': '0.0.0' });
      expect(sdkPackageJson.bundledDependencies).toEqual(['@happier-dev/protocol']);
      expect(sdkPackageJson.files).toEqual([
        'dist',
        'package.json',
        'README.md',
        'API.md',
        'api-declarations.md',
        'api-surface.json',
        'capability-matrix.json',
        'examples/public-authoring/index.ts',
        'scripts/validate-authoring.mjs',
      ]);
      expect(
        existsSync(resolve(bundledSdkDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'plugins', 'ui', 'client.js')),
      ).toBe(false);
      expect(uiPackageJson.happier?.publicSdkRelease?.posture).toBe('prepublish_hold');
      expect(uiPackageJson.dependencies).toEqual({ '@happier-dev/plugin-sdk': '0.0.0' });
      expect(uiPackageJson.bundledDependencies ?? []).toEqual([]);
      expect(uiPackageJson.files).toEqual([
        'dist',
        'package.json',
        'README.md',
        'api-declarations.md',
      ]);
      expect(existsSync(resolve(bundledUiDir, 'node_modules', '@happier-dev', 'plugin-sdk'))).toBe(false);

      const transientAuthorScopeDir = resolve(repoRoot, 'transient-author', 'node_modules', '@happier-dev');
      const bundleDescriptors = [
        ['@happier-dev/protocol', 'protocol'],
        ['@happier-dev/plugin-sdk', 'plugin-sdk'],
        ['@happier-dev/plugin-ui', 'plugin-ui'],
      ].map(([packageName, directoryName]) => ({
        packageName,
        srcDir: resolve(bundledScopeDir, directoryName),
        destDir: resolve(transientAuthorScopeDir, directoryName),
      }));
      materializePrepublicationWorkspacePackageRoots({ bundles: bundleDescriptors });

      const transientSdkDir = resolve(transientAuthorScopeDir, 'plugin-sdk');
      const transientUiDir = resolve(transientAuthorScopeDir, 'plugin-ui');
      const transientSdkPackageJson = JSON.parse(readFileSync(resolve(transientSdkDir, 'package.json'), 'utf8')) as {
        bundledDependencies?: string[];
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      expect(transientSdkPackageJson.dependencies).toEqual({ '@happier-dev/protocol': '0.0.0' });
      expect(transientSdkPackageJson.optionalDependencies).toEqual({ '@happier-dev/protocol': '0.0.0' });
      expect(transientSdkPackageJson.bundledDependencies).toEqual(['@happier-dev/protocol']);
      expect(
        existsSync(resolve(transientSdkDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'plugins', 'ui', 'client.js')),
      ).toBe(true);
      for (const relativePath of [
        'API.md',
        'api-declarations.md',
        'api-surface.json',
        'capability-matrix.json',
        'examples/public-authoring/index.ts',
        'scripts/validate-authoring.mjs',
      ]) {
        expect(existsSync(resolve(transientSdkDir, ...relativePath.split('/')))).toBe(true);
      }
      expect(existsSync(resolve(transientUiDir, 'api-declarations.md'))).toBe(true);

      // A detached author package resolves Protocol from the transient SDK closure,
      // rather than from the CLI's flattened runtime tree.
      const detachedSdkRequire = createRequire(resolve(transientSdkDir, 'package.json'));
      expect(detachedSdkRequire.resolve('@happier-dev/protocol/plugins/ui/client')).toBe(
        realpathSync(resolve(transientSdkDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'plugins', 'ui', 'client.js')),
      );

      // The UI package intentionally uses the sibling prepublication SDK instead of
      // a second nested SDK copy; its manifest still carries the normal dependency edge.
      expect(existsSync(resolve(transientUiDir, 'node_modules', '@happier-dev', 'plugin-sdk'))).toBe(false);
      const detachedUiRequire = createRequire(resolve(transientUiDir, 'package.json'));
      expect(detachedUiRequire.resolve('@happier-dev/plugin-sdk')).toBe(
        realpathSync(resolve(transientAuthorScopeDir, 'plugin-sdk', 'dist', 'index.js')),
      );
    } finally {
      cleanup();
    }
  });

  it('refuses artifact publication when a bundled plugin tree disagrees with the generated artifact inventory', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-plugin-inventory-');
    // Workspace package building spawns real per-package builds; the inventory binding this
    // test asserts is decided by the bundled tree, not by that build boundary.
    const ensureWorkspacePackagesBuiltByName = async (_repoRoot: string, names: readonly string[]) => ({
      ok: true,
      built: [...names],
      skipped: [] as string[],
    });

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/plugins-grok'],
        dependencies: { '@happier-dev/plugins-grok': '0.0.0' },
      });
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/grok',
        packageName: '@happier-dev/plugins-grok',
        files: {
          'dist/index.js': 'export const grok = true;\n',
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "grok", runtime: { apiVersion: 1 }, contributes: {} });\n',
        },
      });

      // The inventory the tarball ships publishes a chunked runtime entry; the built
      // tree carries a stub entry and no chunk, which is exactly the disagreement that
      // reached released tarballs before this assertion existed.
      const inventoryPath = resolve(
        repoRoot,
        'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts',
      );
      const immutableArtifacts = [{
        packageEntryRelativePath: 'dist/index.js',
        packageName: '@happier-dev/plugins-grok',
        record: {
          createdAtMs: 0,
          files: [
            { byteLength: 44, relativePath: 'dist/.happier-chunks/chunk-GROK0001.js' },
            { byteLength: 61, relativePath: 'dist/index.js' },
          ],
          manifestRelativePath: '.happier-plugin/plugin.json',
          pluginId: 'grok',
          schemaVersion: 1,
          t: 'happier_plugin_generation_v1',
        },
      }];
      const sourceArtifactIntegrities = [{
        packageName: '@happier-dev/plugins-grok',
        files: [
          {
            byteLength: 44,
            digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
            relativePath: 'dist/.happier-chunks/chunk-GROK0001.js',
          },
          {
            byteLength: 61,
            digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000002',
            relativePath: 'dist/index.js',
          },
        ],
      }];
      mkdirSync(dirname(inventoryPath), { recursive: true });
      writeFileSync(
        inventoryPath,
        [
          "import type { BundledImmutablePluginArtifact } from '../../../store/registry/generationStore';",
          '',
          'export const BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS = Object.freeze(',
          `${JSON.stringify(immutableArtifacts, null, 2)} satisfies readonly BundledImmutablePluginArtifact[]);`,
          '',
          'export type BundledFirstPartySourceArtifactIntegrity = Readonly<{',
          '  packageName: string;',
          '  files: readonly Readonly<{ relativePath: string; byteLength: number; digest: string }>[];',
          '}>;',
          '',
          'export const BUNDLED_FIRST_PARTY_SOURCE_ARTIFACT_INTEGRITIES = Object.freeze(',
          `${JSON.stringify(sourceArtifactIntegrities, null, 2)} satisfies readonly BundledFirstPartySourceArtifactIntegrity[]);`,
          '',
        ].join('\n'),
        'utf8',
      );

      await expect(bundleWorkspaceDeps({
        repoRoot,
        happyCliDir,
        publicationMode: 'artifact',
        ensureWorkspacePackagesBuiltByName,
      })).rejects.toThrow(
        /Bundled plugin files disagree with generatedBundledPluginArtifacts\.ts[\s\S]*missing: dist\/\.happier-chunks\/chunk-GROK0001\.js[\s\S]*mismatched: dist\/index\.js/,
      );

      // Live source-dev publication intentionally retains prior generation targets, so it
      // has no exact tree to bind and must stay usable while a plugin is being rebuilt.
      await expect(bundleWorkspaceDeps({
        repoRoot,
        happyCliDir,
        ensureWorkspacePackagesBuiltByName,
      })).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('consumes the canonical bundled plugin runtime tree already emitted before packing', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-plugin-canonical-output-');
    const packageName = '@happier-dev/plugins-grok';
    const nonPluginPackageName = '@happier-dev/protocol';
    const stagedEntrySource = "import './.happier-chunks/chunk-GROK0001.js';\nexport const grokDaemon = true;\n";
    const stagedChunkSource = 'export const grokRuntimeChunk = true;\n';

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: [nonPluginPackageName, packageName],
        dependencies: {
          [nonPluginPackageName]: '0.0.0',
          [packageName]: '0.0.0',
        },
      });
      const pluginPackageDir = writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/grok',
        packageName,
        files: {
          'dist/index.js': stagedEntrySource,
          'dist/.happier-chunks/chunk-GROK0001.js': stagedChunkSource,
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "grok", runtime: { apiVersion: 1 }, contributes: {} });\n',
        },
      });
      const nonPluginPackageDir = writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/protocol',
        packageName: nonPluginPackageName,
        files: {
          'dist/index.js': 'export const protocol = "prepack";\n',
        },
      });

      // Any generator found in this pack workspace would be an invalid second publication
      // owner. The canonical build/publisher has already emitted the exact runtime tree above;
      // the dependency bundler must only copy and verify those bytes.
      writeSandboxTextFile(
        resolve(repoRoot, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts'),
        'export async function publishAnotherRuntimeTree() { throw new Error(\'second publication owner invoked\'); }\n',
      );

      const artifactBuildAdmissions: Array<{ names: string[]; force: boolean }> = [];
      let artifactBundlePhase = false;
      const ensureWorkspacePackagesBuiltByName = async (
        targetRoot: string,
        names: readonly string[],
        options: { force?: boolean } = {},
      ) => {
        if (targetRoot === repoRoot && artifactBundlePhase) {
          artifactBuildAdmissions.push({ names: [...names], force: options.force === true });
          // Any ordinary workspace admission can decide that the staged bundle
          // is not the compiler-owned output and replace it with the small
          // TypeScript re-export tree. Generator-owned package output is
          // therefore immutable throughout pack-time copying, not merely
          // exempt from force builds.
          if (names.includes(packageName)) {
            writeFileSync(resolve(pluginPackageDir, 'dist', 'index.js'), 'export { grok } from "./grok.js";\n');
            rmSync(resolve(pluginPackageDir, 'dist', '.happier-chunks'), { recursive: true, force: true });
          }
          if (options.force === true && names.includes(nonPluginPackageName)) {
            writeFileSync(resolve(nonPluginPackageDir, 'dist', 'index.js'), 'export const protocol = "artifact";\n');
          }
        }
        return { ok: true, built: [...names], skipped: [] };
      };

      // Bind the inventory to the exact canonical tree before invoking the pack-time copier.
      await bundleWorkspaceDeps({ repoRoot, happyCliDir, ensureWorkspacePackagesBuiltByName });
      const bundledPackageDir = resolve(happyCliDir, 'node_modules', '@happier-dev', 'plugins-grok');
      writeBundledPluginArtifactInventory({
        repoRoot,
        packageName,
        pluginId: 'grok',
        files: collectSandboxPackageTreeFiles(bundledPackageDir).map((relativePath) => ({
          relativePath,
          bytes: readFileSync(resolve(bundledPackageDir, ...relativePath.split('/'))),
        })),
      });

      artifactBundlePhase = true;
      await expect(bundleWorkspaceDeps({
        repoRoot,
        happyCliDir,
        publicationMode: 'artifact',
        ensureWorkspacePackagesBuiltByName,
      })).resolves.toBeUndefined();

      expect(readFileSync(resolve(bundledPackageDir, 'dist', 'index.js'), 'utf8')).toBe(stagedEntrySource);
      expect(
        readFileSync(resolve(bundledPackageDir, 'dist', '.happier-chunks', 'chunk-GROK0001.js'), 'utf8'),
      ).toBe(stagedChunkSource);
      expect(
        artifactBuildAdmissions
          .filter((admission) => admission.force)
          .flatMap((admission) => admission.names),
      ).not.toContain(packageName);
      expect(
        artifactBuildAdmissions
          .filter((admission) => admission.force)
          .flatMap((admission) => admission.names),
      ).toContain(nonPluginPackageName);
      expect(
        artifactBuildAdmissions
          .flatMap((admission) => admission.names),
      ).not.toContain(packageName);
      expect(
        readFileSync(
          resolve(happyCliDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'),
          'utf8',
        ),
      ).toBe('export const protocol = "artifact";\n');
    } finally {
      cleanup();
    }
  });

  it('ignores underscore-prefixed plugin workspace directories when validating bundledDependencies', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-missing-plugin-dep-underscore-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: [],
      });

      // `_template` is a scaffolding directory and must never be treated as a shippable bundled plugin.
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/_template',
        packageName: '@happier-dev/plugins-_template',
      });

      await expect(bundleWorkspaceDeps({ repoRoot, happyCliDir })).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('ignores reservation-only plugin workspace directories when validating bundledDependencies', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-missing-plugin-definition-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: [],
      });

      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/acme',
        packageName: '@happier-dev/plugins-acme',
        manifestOverrides: {
          happier: {
            pluginScaffold: {
              shipping: 'reservation_only',
              plannedStage: 'E.99',
            },
          },
        },
      });

      await expect(bundleWorkspaceDeps({ repoRoot, happyCliDir })).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('allows non-agent plugin workspace directories without agent definitions when validating bundledDependencies', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-non-agent-plugin-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/plugins-scm-github'],
        dependencies: {
          '@happier-dev/plugins-scm-github': '0.0.0',
        },
      });

      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/scm-github',
        packageName: '@happier-dev/plugins-scm-github',
        files: {
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "scm-github", runtime: { apiVersion: 1 } });\n',
        },
      });

      await expect(bundleWorkspaceDeps({ repoRoot, happyCliDir })).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('fails for unmarked plugin workspace directories without manifests when validating bundledDependencies', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-unmarked-missing-plugin-definition-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: [],
      });

      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/acme',
        packageName: '@happier-dev/plugins-acme',
      });

      await expect(bundleWorkspaceDeps({ repoRoot, happyCliDir })).rejects.toThrow('Missing required plugin manifest');
    } finally {
      cleanup();
    }
  });

  it('preserves non-dist export targets for bundled workspaces', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-nondist-exports-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/release-runtime'],
      });

      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/release-runtime',
        packageName: '@happier-dev/release-runtime',
        manifestOverrides: {
          exports: {
            '.': { default: './dist/index.js' },
            './releaseRings': {
              import: './dist/releaseRings.js',
              require: './releaseRings.cjs',
              default: './dist/releaseRings.js',
            },
          },
        },
        files: {
          'dist/index.js': 'export const release = true;\n',
          'dist/releaseRings.js': 'export const releaseRings = true;\n',
          'releaseRings.cjs': 'module.exports = { releaseRings: true };\n',
        },
      });

      await bundleWorkspaceDeps({ repoRoot, happyCliDir });

      expect(
        readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'release-runtime', 'releaseRings.cjs'), 'utf8'),
      ).toContain('releaseRings');
    } finally {
      cleanup();
    }
  });
});
