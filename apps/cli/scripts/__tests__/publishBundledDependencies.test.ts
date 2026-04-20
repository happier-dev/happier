import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('apps/cli package publish contract', () => {
  const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const repoRoot = resolve(cliRoot, '..', '..');

  function readBundledExtensionWorkspacePackageNames(): readonly string[] {
    const extensionsRoot = resolve(repoRoot, 'packages', 'extensions');
    if (!existsSync(extensionsRoot)) return [];

    const packageNames: string[] = [];
    for (const dirent of readdirSync(extensionsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      // Template/scaffold workspaces are not shipped in published artifacts.
      if (dirent.name.startsWith('_')) continue;
      const extensionId = dirent.name;
      const pkgJsonPath = resolve(extensionsRoot, extensionId, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;

      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown };
      const expectedPackageName = `@happier-dev/extensions-${extensionId}`;
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
    expect(bundled).toContain('@happier-dev/extension-sdk');
    expect(bundled).toContain('@happier-dev/protocol');
    expect(bundled).toContain('@happier-dev/transfers');
    expect(bundled).toContain('@happier-dev/release-runtime');
    expect(bundled).toContain('tweetnacl');

    for (const extensionPackageName of readBundledExtensionWorkspacePackageNames()) {
      expect(bundled).toContain(extensionPackageName);
      // Bundled dependencies should also be declared as dependencies so local tooling and
      // type/build steps can resolve the workspace packages deterministically.
      expect(cliPackageJson.dependencies?.[extensionPackageName]).toBeTruthy();
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
    expect(cliPackageJson.dependencies?.['@happier-dev/extension-sdk']).toBeTruthy();

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
});
