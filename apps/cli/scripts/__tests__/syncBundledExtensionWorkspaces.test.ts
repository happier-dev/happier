import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { syncBundledExtensionWorkspaces } from '../syncBundledExtensionWorkspaces.mjs';
import {
  createPackageLayoutSandbox,
  writeCliBundledHostPackage,
  writeWorkspacePackageFixture,
} from './testkit/packageLayoutSandbox';

describe('syncBundledExtensionWorkspaces', () => {
  it('adds extension workspaces to apps/cli package.json bundledDependencies and dependencies', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-sync-bundled-extensions-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/protocol', 'tweetnacl'],
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
          tweetnacl: '^1.0.3',
        },
      });

      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/extensions/acme',
        packageName: '@happier-dev/extensions-acme',
      });
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/extensions/zen',
        packageName: '@happier-dev/extensions-zen',
      });

      syncBundledExtensionWorkspaces({ repoRoot, happyCliDir });

      const raw = JSON.parse(readFileSync(resolve(happyCliDir, 'package.json'), 'utf8')) as {
        bundledDependencies?: unknown;
        dependencies?: Record<string, string> | undefined;
      };

      const bundled = Array.isArray(raw.bundledDependencies) ? raw.bundledDependencies.map(String) : [];
      expect(bundled).toContain('@happier-dev/extensions-acme');
      expect(bundled).toContain('@happier-dev/extensions-zen');
      expect(raw.dependencies?.['@happier-dev/extensions-acme']).toBeTruthy();
      expect(raw.dependencies?.['@happier-dev/extensions-zen']).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('ignores underscore-prefixed extension workspace directories', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-sync-bundled-extensions-underscore-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/protocol', 'tweetnacl'],
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
          tweetnacl: '^1.0.3',
        },
      });

      // `_template` is a scaffolding directory and must never be treated as a bundled extension package.
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/extensions/_template',
        packageName: '@happier-dev/extensions-_template',
      });

      const before = readFileSync(resolve(happyCliDir, 'package.json'), 'utf8');
      syncBundledExtensionWorkspaces({ repoRoot, happyCliDir });
      const after = readFileSync(resolve(happyCliDir, 'package.json'), 'utf8');
      expect(after).toBe(before);
    } finally {
      cleanup();
    }
  });

  it('no-ops when packages/extensions is absent', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-sync-bundled-extensions-empty-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/protocol', 'tweetnacl'],
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
          tweetnacl: '^1.0.3',
        },
      });

      const before = readFileSync(resolve(happyCliDir, 'package.json'), 'utf8');
      syncBundledExtensionWorkspaces({ repoRoot, happyCliDir });
      const after = readFileSync(resolve(happyCliDir, 'package.json'), 'utf8');
      expect(after).toBe(before);
    } finally {
      cleanup();
    }
  });
});
