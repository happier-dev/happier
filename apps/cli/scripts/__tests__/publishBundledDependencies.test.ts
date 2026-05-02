import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(testDir, '..', '..');

describe('apps/cli package publish contract', () => {
  it('declares npm bin entrypoints for the published CLI', () => {
    const cliPackageJsonPath = resolve(cliDir, 'package.json');
    const cliPackageJson = JSON.parse(readFileSync(cliPackageJsonPath, 'utf8')) as {
      bin?: unknown;
    };

    expect(cliPackageJson.bin).toEqual({
      happier: './bin/happier.mjs',
      'happier-dev': './bin/happier-dev.mjs',
      'happier-mcp': './bin/happier-mcp.mjs',
    });
  });

  it('bundles internal workspaces and relies on protocol to declare its runtime deps', () => {
    const cliPackageJsonPath = resolve(cliDir, 'package.json');
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
    expect(bundled).toContain('@happier-dev/protocol');
    expect(bundled).toContain('@happier-dev/transfers');
    expect(bundled).toContain('@happier-dev/release-runtime');
    expect(bundled).toContain('tweetnacl');

    // External runtime deps used by protocol should be declared on protocol itself
    // (and vendored into the bundled protocol package during `prepack`).
    const protocolPackageJsonPath = resolve(cliDir, '..', '..', 'packages', 'protocol', 'package.json');
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

  });

  it('explicitly includes generated dist outputs in npm publish inputs', () => {
    const cliPackageJsonPath = resolve(cliDir, 'package.json');
    const cliNpmIgnorePath = resolve(cliDir, '.npmignore');
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
