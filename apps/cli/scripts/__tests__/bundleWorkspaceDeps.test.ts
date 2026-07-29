import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  bundleWorkspaceDeps,
  loadCliCommonWorkspacesModule,
} from '../bundleWorkspaceDeps.mjs';
import {
  createPackageLayoutSandbox,
  writeCliBundledHostPackage,
  writeRuntimeDependencyStub,
  writeWorkspacePackageFixture,
} from './testkit/packageLayoutSandbox';

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

  it('materializes Inspector UI artifacts and the Grok internal runtime closure into the artifact tree', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-bundle-plugin-closure-');

    try {
      const bundledDependencies = [
        '@happier-dev/plugin-sdk',
        '@happier-dev/plugins-grok',
        '@happier-dev/plugins-inspector',
      ];
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies,
        dependencies: {
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
        workspacePath: 'packages/plugins/grok',
        packageName: '@happier-dev/plugins-grok',
        manifestOverrides: {
          dependencies: {
            '@happier-dev/plugin-sdk': '0.0.0',
          },
        },
        files: {
          'dist/index.js': "export { sdk } from '@happier-dev/plugin-sdk';\n",
          'dist/index.d.ts': "export { sdk } from '@happier-dev/plugin-sdk';\n",
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

      await bundleWorkspaceDeps({ repoRoot, happyCliDir, publicationMode: 'artifact' });

      const bundledScopeDir = resolve(happyCliDir, 'node_modules', '@happier-dev');
      expect(existsSync(resolve(bundledScopeDir, 'plugin-sdk', 'dist', 'index.js'))).toBe(true);
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
        expect(packageJson.scripts).toBeUndefined();
      }
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
