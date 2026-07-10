import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('apps/cli package publish contract', () => {
  const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const repoRoot = resolve(cliRoot, '..', '..');

  function readBundledPluginWorkspacePackageNames(): readonly string[] {
    const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
    if (!existsSync(pluginsRoot)) return [];

    const packageNames: string[] = [];
    for (const dirent of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      // Template/scaffold workspaces are not shipped in published artifacts.
      if (dirent.name.startsWith('_')) continue;
      const pluginId = dirent.name;
      const pkgJsonPath = resolve(pluginsRoot, pluginId, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;

      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
        name?: unknown;
        happier?: { pluginScaffold?: { shipping?: unknown } };
      };
      if (pkgJson.happier?.pluginScaffold?.shipping === 'reservation_only') continue;
      const expectedPackageName = `@happier-dev/plugins-${pluginId}`;
      expect(pkgJson.name).toBe(expectedPackageName);
      packageNames.push(expectedPackageName);
    }

    packageNames.sort((a, b) => a.localeCompare(b));
    return packageNames;
  }

  it('declares npm bin entrypoints for the published CLI', () => {
    const cliPackageJsonPath = resolve(cliRoot, 'package.json');
    const cliPackageJson = JSON.parse(readFileSync(cliPackageJsonPath, 'utf8')) as {
      bin?: unknown;
    };

    expect(cliPackageJson.bin).toEqual(expect.objectContaining({
      happier: './bin/happier.mjs',
      'happier-mcp': './bin/happier-mcp.mjs',
    }));
  });

  it('bundles internal workspaces and relies on protocol to declare its runtime deps', () => {
    const cliPackageJsonPath = resolve(cliRoot, 'package.json');
    const cliPackageJson = JSON.parse(readFileSync(cliPackageJsonPath, 'utf8')) as {
      bundledDependencies?: unknown;
      dependencies?: Record<string, string> | undefined;
    };

    const bundled = Array.isArray(cliPackageJson.bundledDependencies)
      ? cliPackageJson.bundledDependencies.map((v) => String(v))
      : [];

    expect(bundled).toContain('@happier-dev/agents');
    expect(bundled).toContain('@happier-dev/cli-common');
    expect(bundled).toContain('@happier-dev/connection-supervisor');
    expect(bundled).toContain('@happier-dev/plugin-sdk');
    expect(bundled).toContain('@happier-dev/peer-mediation');
    expect(bundled).toContain('@happier-dev/protocol');
    expect(bundled).toContain('@happier-dev/transfers');
    expect(bundled).toContain('@happier-dev/release-runtime');
    expect(bundled).toContain('tweetnacl');

    for (const pluginPackageName of readBundledPluginWorkspacePackageNames()) {
      expect(bundled).toContain(pluginPackageName);
      // Bundled dependencies should also be declared as dependencies so local tooling and
      // type/build steps can resolve the workspace packages deterministically.
      expect(cliPackageJson.dependencies?.[pluginPackageName]).toBeTruthy();
    }

    // External runtime deps used by protocol should be declared on protocol itself
    // (and vendored into the bundled protocol package during `prepack`).
    const protocolPackageJsonPath = resolve(cliRoot, '..', '..', 'packages', 'protocol', 'package.json');
    const protocolPackageJson = JSON.parse(readFileSync(protocolPackageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string> | undefined;
    };
    expect(protocolPackageJson.dependencies?.['base64-js']).toBeTruthy();
    expect(protocolPackageJson.dependencies?.['@noble/hashes']).toBeTruthy();
    expect(protocolPackageJson.dependencies?.['tweetnacl']).toBeTruthy();

    // Only deps used directly by the CLI should be declared on the CLI package itself.
    expect(cliPackageJson.dependencies?.['tweetnacl']).toBeTruthy();
    expect(cliPackageJson.dependencies?.['base64-js']).toBeFalsy();
    expect(cliPackageJson.dependencies?.['@noble/hashes']).toBeFalsy();
    expect(cliPackageJson.dependencies?.['@happier-dev/plugin-sdk']).toBeTruthy();
    expect(cliPackageJson.dependencies?.['@happier-dev/peer-mediation']).toBeTruthy();

  });

  it('explicitly includes generated dist outputs in npm publish inputs', () => {
    const cliPackageJsonPath = resolve(cliRoot, 'package.json');
    const cliNpmIgnorePath = resolve(cliRoot, '.npmignore');
    const cliPackageJson = JSON.parse(readFileSync(cliPackageJsonPath, 'utf8')) as {
      files?: unknown;
    };
    const cliNpmIgnore = readFileSync(cliNpmIgnorePath, 'utf8');

    const publishedFiles = Array.isArray(cliPackageJson.files) ? cliPackageJson.files.map((value) => String(value)) : [];

    expect(publishedFiles).toContain('package-dist');
    expect(publishedFiles).toContain('package-dist/**');
    expect(cliNpmIgnore).toContain('!dist/');
    expect(cliNpmIgnore).toContain('!dist/**');
  });

  it('does not publish build-only .mjs scripts that depend on repo-root workspace helpers', () => {
    const cliPackageJsonPath = resolve(cliRoot, 'package.json');
    const cliPackageJson = JSON.parse(readFileSync(cliPackageJsonPath, 'utf8')) as {
      files?: unknown;
    };

    const publishedFiles = Array.isArray(cliPackageJson.files) ? cliPackageJson.files.map((value) => String(value)) : [];

    expect(publishedFiles).not.toContain('scripts/**/*.mjs');
    expect(publishedFiles).toContain('scripts/**/*.cjs');
    expect(publishedFiles).toContain('scripts/shims/**');
  });
});
