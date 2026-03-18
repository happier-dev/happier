import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { bundleWorkspaceDeps } from '../bundleWorkspaceDeps.mjs';

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('bundleWorkspaceDeps', () => {
  it('copies dist + writes a sanitized package.json without install scripts', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happy-bundle-workspace-deps-'));
    writeJson(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
    writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');

    // Hoisted runtime deps used by bundled workspaces (resolved from workspace package.json).
    mkdirSync(resolve(repoRoot, 'node_modules', 'base64-js'), { recursive: true });
    writeJson(resolve(repoRoot, 'node_modules', 'base64-js', 'package.json'), {
      name: 'base64-js',
      version: '1.5.1',
      main: 'index.js',
    });
    writeFileSync(resolve(repoRoot, 'node_modules', 'base64-js', 'index.js'), 'module.exports = {};\n', 'utf8');
    mkdirSync(resolve(repoRoot, 'node_modules', '@noble', 'hashes'), { recursive: true });
    writeJson(resolve(repoRoot, 'node_modules', '@noble', 'hashes', 'package.json'), {
      name: '@noble/hashes',
      version: '1.8.0',
      main: 'index.js',
    });
    writeFileSync(resolve(repoRoot, 'node_modules', '@noble', 'hashes', 'index.js'), 'module.exports = {};\n', 'utf8');
    mkdirSync(resolve(repoRoot, 'node_modules', 'tweetnacl'), { recursive: true });
    writeJson(resolve(repoRoot, 'node_modules', 'tweetnacl', 'package.json'), {
      name: 'tweetnacl',
      version: '1.0.3',
      main: 'nacl-fast.js',
    });
    writeFileSync(resolve(repoRoot, 'node_modules', 'tweetnacl', 'nacl-fast.js'), 'module.exports = {};', 'utf8');

    const agentsDir = resolve(repoRoot, 'packages', 'agents');
    const cliCommonDir = resolve(repoRoot, 'packages', 'cli-common');
    const connectionSupervisorDir = resolve(repoRoot, 'packages', 'connection-supervisor');
    const protocolDir = resolve(repoRoot, 'packages', 'protocol');
    const transfersDir = resolve(repoRoot, 'packages', 'transfers');
    const releaseRuntimeDir = resolve(repoRoot, 'packages', 'release-runtime');
    const happyCliDir = resolve(repoRoot, 'apps', 'cli');

    mkdirSync(resolve(agentsDir, 'dist'), { recursive: true });
    mkdirSync(resolve(cliCommonDir, 'dist'), { recursive: true });
    mkdirSync(resolve(connectionSupervisorDir, 'dist'), { recursive: true });
    mkdirSync(resolve(protocolDir, 'dist'), { recursive: true });
    mkdirSync(resolve(transfersDir, 'dist'), { recursive: true });
    mkdirSync(resolve(releaseRuntimeDir, 'dist'), { recursive: true });
    mkdirSync(happyCliDir, { recursive: true });
    writeJson(resolve(happyCliDir, 'package.json'), {
      name: '@happier-dev/cli',
      bundledDependencies: [
        '@happier-dev/agents',
        '@happier-dev/cli-common',
        '@happier-dev/connection-supervisor',
        '@happier-dev/protocol',
        '@happier-dev/transfers',
        '@happier-dev/release-runtime',
      ],
    });

    writeJson(resolve(agentsDir, 'package.json'), {
      name: '@happier-dev/agents',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      scripts: { postinstall: 'echo should-not-run' },
      devDependencies: { typescript: '^5' },
    });
    writeJson(resolve(protocolDir, 'package.json'), {
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      scripts: { postinstall: 'echo should-not-run' },
      dependencies: {
        'base64-js': '^1.5.1',
        '@noble/hashes': '^1.8.0',
        tweetnacl: '^1.0.3',
      },
    });
    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      scripts: { postinstall: 'echo should-not-run' },
    });
    writeJson(resolve(connectionSupervisorDir, 'package.json'), {
      name: '@happier-dev/connection-supervisor',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      scripts: { postinstall: 'echo should-not-run' },
    });
    writeJson(resolve(releaseRuntimeDir, 'package.json'), {
      name: '@happier-dev/release-runtime',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      scripts: { postinstall: 'echo should-not-run' },
      devDependencies: { typescript: '^5' },
    });
    writeJson(resolve(transfersDir, 'package.json'), {
      name: '@happier-dev/transfers',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      scripts: { postinstall: 'echo should-not-run' },
      dependencies: {
        '@happier-dev/protocol': '0.0.0',
      },
    });

    writeFileSync(resolve(agentsDir, 'dist', 'index.js'), 'export const x = 1;\n', 'utf8');
    writeFileSync(resolve(protocolDir, 'dist', 'index.js'), 'export const y = 2;\n', 'utf8');
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const z = 3;\n', 'utf8');
    writeFileSync(resolve(connectionSupervisorDir, 'dist', 'index.js'), 'export const q = 4;\n', 'utf8');
    writeFileSync(resolve(transfersDir, 'dist', 'index.js'), 'export const transfer = true;\n', 'utf8');
    writeFileSync(resolve(releaseRuntimeDir, 'dist', 'index.js'), 'export const w = 4;\n', 'utf8');

    bundleWorkspaceDeps({ repoRoot, happyCliDir });

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

    expect(bundledReleaseRuntimePkgJson.scripts).toBeUndefined();
    expect(bundledReleaseRuntimePkgJson.devDependencies).toBeUndefined();
    expect(bundledReleaseRuntimePkgJson.name).toBe('@happier-dev/release-runtime');
  });

  it('vendors the external runtime dependency tree for bundled workspace packages', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happy-bundle-workspace-deps-tree-'));
    writeJson(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
    writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');

    const protocolDir = resolve(repoRoot, 'packages', 'protocol');
    const releaseRuntimeDir = resolve(repoRoot, 'packages', 'release-runtime');
    const happyCliDir = resolve(repoRoot, 'apps', 'cli');

    const depADir = resolve(repoRoot, 'node_modules', 'dep-a');
    const depBDir = resolve(repoRoot, 'node_modules', 'dep-b');

    mkdirSync(resolve(protocolDir, 'dist'), { recursive: true });
    mkdirSync(resolve(releaseRuntimeDir, 'dist'), { recursive: true });
    mkdirSync(happyCliDir, { recursive: true });
    writeJson(resolve(happyCliDir, 'package.json'), {
      name: '@happier-dev/cli',
      bundledDependencies: ['@happier-dev/protocol', '@happier-dev/release-runtime'],
    });
    mkdirSync(depADir, { recursive: true });
    mkdirSync(depBDir, { recursive: true });

    writeJson(resolve(protocolDir, 'package.json'), {
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      dependencies: {
        'dep-a': '^1.0.0',
      },
    });
    writeFileSync(resolve(protocolDir, 'dist', 'index.js'), 'export const y = 2;\n', 'utf8');
    writeJson(resolve(releaseRuntimeDir, 'package.json'), {
      name: '@happier-dev/release-runtime',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    });
    writeFileSync(resolve(releaseRuntimeDir, 'dist', 'index.js'), 'export const w = 4;\n', 'utf8');

    writeJson(resolve(depADir, 'package.json'), {
      name: 'dep-a',
      version: '1.0.0',
      main: 'index.js',
      dependencies: {
        'dep-b': '^1.0.0',
      },
    });
    writeFileSync(resolve(depADir, 'index.js'), 'module.exports = { a: true };\n', 'utf8');

    writeJson(resolve(depBDir, 'package.json'), { name: 'dep-b', version: '1.0.0', main: 'index.js' });
    writeFileSync(resolve(depBDir, 'index.js'), 'module.exports = { b: true };\n', 'utf8');

    // Minimal stubs for other bundled workspace packages.
    for (const pkg of [
      { name: '@happier-dev/agents', dir: resolve(repoRoot, 'packages', 'agents') },
      { name: '@happier-dev/cli-common', dir: resolve(repoRoot, 'packages', 'cli-common') },
      { name: '@happier-dev/transfers', dir: resolve(repoRoot, 'packages', 'transfers') },
    ]) {
      mkdirSync(resolve(pkg.dir, 'dist'), { recursive: true });
      writeJson(resolve(pkg.dir, 'package.json'), {
        name: pkg.name,
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
        },
      });
      writeFileSync(resolve(pkg.dir, 'dist', 'index.js'), 'export const x = 1;\n', 'utf8');
    }

    bundleWorkspaceDeps({ repoRoot, happyCliDir });

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
  });

  it('derives bundled workspaces from the host package bundledDependencies manifest', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happy-bundle-manifest-'));
    writeJson(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
    writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');

    const agentsDir = resolve(repoRoot, 'packages', 'agents');
    const cliCommonDir = resolve(repoRoot, 'packages', 'cli-common');
    const happyCliDir = resolve(repoRoot, 'apps', 'cli');

    mkdirSync(resolve(agentsDir, 'dist'), { recursive: true });
    mkdirSync(resolve(cliCommonDir, 'dist'), { recursive: true });
    mkdirSync(happyCliDir, { recursive: true });

    writeJson(resolve(agentsDir, 'package.json'), {
      name: '@happier-dev/agents',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': { default: './dist/index.js' } },
    });
    writeJson(resolve(cliCommonDir, 'package.json'), {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': { default: './dist/index.js' } },
    });
    writeFileSync(resolve(agentsDir, 'dist', 'index.js'), 'export const agent = true;\n', 'utf8');
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const cliCommon = true;\n', 'utf8');

    writeJson(resolve(happyCliDir, 'package.json'), {
      name: '@happier-dev/cli',
      bundledDependencies: ['@happier-dev/cli-common'],
    });

    bundleWorkspaceDeps({ repoRoot, happyCliDir });

    expect(existsSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'cli-common', 'package.json'))).toBe(true);
    expect(existsSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'agents', 'package.json'))).toBe(false);
  });
});
