import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

    const agentsDir = resolve(repoRoot, 'packages', 'agents');
    const cliCommonDir = resolve(repoRoot, 'packages', 'cli-common');
    const protocolDir = resolve(repoRoot, 'packages', 'protocol');
    const happyCliDir = resolve(repoRoot, 'apps', 'cli');

    mkdirSync(resolve(agentsDir, 'dist'), { recursive: true });
    mkdirSync(resolve(cliCommonDir, 'dist'), { recursive: true });
    mkdirSync(resolve(protocolDir, 'dist'), { recursive: true });
    mkdirSync(happyCliDir, { recursive: true });

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

    writeFileSync(resolve(agentsDir, 'dist', 'index.js'), 'export const x = 1;\n', 'utf8');
    writeFileSync(resolve(protocolDir, 'dist', 'index.js'), 'export const y = 2;\n', 'utf8');
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const z = 3;\n', 'utf8');

    bundleWorkspaceDeps({ repoRoot, happyCliDir });

    const bundledAgentsPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'agents', 'package.json'), 'utf8'),
    );
    const bundledProtocolPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'protocol', 'package.json'), 'utf8'),
    );
    const bundledCommonPkgJson = JSON.parse(
      readFileSync(resolve(happyCliDir, 'node_modules', '@happier-dev', 'cli-common', 'package.json'), 'utf8'),
    );

    expect(bundledAgentsPkgJson.scripts).toBeUndefined();
    expect(bundledAgentsPkgJson.devDependencies).toBeUndefined();
    expect(bundledAgentsPkgJson.name).toBe('@happier-dev/agents');

    expect(bundledProtocolPkgJson.scripts).toBeUndefined();
    expect(bundledProtocolPkgJson.name).toBe('@happier-dev/protocol');

    expect(bundledCommonPkgJson.scripts).toBeUndefined();
    expect(bundledCommonPkgJson.name).toBe('@happier-dev/cli-common');
  });

  it('declares external runtime dependencies required by bundled workspace packages', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const cliPackageJson = JSON.parse(readFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), 'utf8'));
    const bundledWorkspacePackagePaths = [
      resolve(repoRoot, 'packages', 'agents', 'package.json'),
      resolve(repoRoot, 'packages', 'cli-common', 'package.json'),
      resolve(repoRoot, 'packages', 'protocol', 'package.json'),
    ];

    const cliDependencyNames = new Set(Object.keys(cliPackageJson.dependencies ?? {}));
    const requiredExternalDependencies = new Set<string>();
    for (const packageJsonPath of bundledWorkspacePackagePaths) {
      const bundledPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      for (const dependencyName of Object.keys(bundledPackageJson.dependencies ?? {})) {
        if (!dependencyName.startsWith('@happier-dev/')) {
          requiredExternalDependencies.add(dependencyName);
        }
      }
    }

    const missingDependencies = [...requiredExternalDependencies].filter((name) => !cliDependencyNames.has(name));
    expect(missingDependencies).toEqual([]);
  });
});
