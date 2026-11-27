import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBundledPluginPackageNames } from '../build-owned/bundledPluginMembership.ts';

describe('apps/cli package publish contract', () => {
  const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const repoRoot = resolve(cliRoot, '..', '..');

  it('keeps the local embeddings runtime optional so a failed onnxruntime-node postinstall cannot fail npm install', () => {
    // onnxruntime-node@1.21.0 (via @huggingface/transformers) downloads a Linux x64 CUDA archive on install that now
    // returns 404, so a required edge fails `npm install -g @happier-dev/cli` on Linux x64. The daemon already falls
    // back when the package is missing.
    const cliPackageJson = JSON.parse(readFileSync(resolve(cliRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    expect(cliPackageJson.dependencies?.['@huggingface/transformers']).toBeUndefined();
    expect(cliPackageJson.optionalDependencies?.['@huggingface/transformers']).toBeDefined();
  });

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

    // The internal workspace closure itself (every reachable workspace bundled, and the
    // canonical resolver agreeing with this manifest) is owned by sourceDevBundledPluginClosure.test.ts.
    expect(bundled).not.toContain('@happier-dev/bundled-voice-runtime-contract');
    // The daemon imports this workspace at runtime (apiMachine.ts) and no other bundled
    // workspace requires it, so the closure guard cannot notice it leaving the bundle.
    expect(bundled).toContain('@happier-dev/transfers');
    expect(bundled).toContain('proper-lockfile');
    expect(bundled).toContain('tweetnacl');

    for (const packageName of bundled.filter((name) => name.startsWith('@happier-dev/'))) {
      expect(cliPackageJson.dependencies?.[packageName]).toBeTruthy();
    }

    for (const pluginPackageName of readBundledPluginPackageNames(repoRoot)) {
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
    expect(cliPackageJson.dependencies?.['proper-lockfile']).toBeTruthy();
    expect(cliPackageJson.dependencies?.['tweetnacl']).toBeTruthy();
    expect(cliPackageJson.dependencies?.['base64-js']).toBeFalsy();
    expect(cliPackageJson.dependencies?.['@noble/hashes']).toBeFalsy();
    for (const packageName of ['ai', '@stablelib/base64', 'http-proxy-middleware', 'tmp']) {
      expect(cliPackageJson.dependencies?.[packageName]).toBeFalsy();
    }
    expect(cliPackageJson.dependencies?.['@happier-dev/plugin-sdk']).toBeTruthy();
    expect(cliPackageJson.dependencies?.['@happier-dev/peer-mediation']).toBeTruthy();
    expect(cliPackageJson.dependencies?.typescript).toBe('5.9.3');
    expect(bundled).toContain('typescript');

  });

  it('keeps React external so Ink and bundled plugins share the host singleton', () => {
    const cliPackageJson = JSON.parse(
      readFileSync(resolve(cliRoot, 'package.json'), 'utf8'),
    ) as {
      bundledDependencies?: unknown;
      dependencies?: Record<string, string> | undefined;
    };
    const bundled = Array.isArray(cliPackageJson.bundledDependencies)
      ? cliPackageJson.bundledDependencies.map((value) => String(value))
      : [];

    expect(cliPackageJson.dependencies?.react).toBeTruthy();
    expect(bundled).not.toContain('react');

    const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
    for (const pluginPackageName of readBundledPluginPackageNames(repoRoot)) {
      const pluginId = pluginPackageName.slice('@happier-dev/plugins-'.length);
      const pluginPackageJson = JSON.parse(
        readFileSync(resolve(pluginsRoot, pluginId, 'package.json'), 'utf8'),
      ) as {
        dependencies?: Record<string, string> | undefined;
      };
      expect(
        pluginPackageJson.dependencies?.react,
        `${pluginPackageName} must consume the host React singleton instead of installing a private copy`,
      ).toBeFalsy();
    }
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
    expect(publishedFiles).not.toContain('scripts/shims/**');
    expect(publishedFiles).toContain('scripts/shims/git');
    expect(publishedFiles).toContain('scripts/shims/rg');
  });
});
