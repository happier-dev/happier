import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { syncBundledPluginWorkspaces } from '../syncBundledPluginWorkspaces.mjs';
import {
  createPackageLayoutSandbox,
  writeCliBundledHostPackage,
  writeWorkspacePackageFixture,
} from './testkit/packageLayoutSandbox';

describe('syncBundledPluginWorkspaces', () => {
  it('adds plugin workspaces to apps/cli package.json bundledDependencies and dependencies', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-sync-bundled-plugins-');

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
        workspacePath: 'packages/plugins/acme',
        packageName: '@happier-dev/plugins-acme',
        files: {
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "acme", runtime: { capabilities: ["agents"] }, contributes: {} });\n',
          'src/agent/definition.ts': 'export const AGENT_DEFINITION = Object.freeze({ id: "acme" });\n',
        },
      });
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/zen',
        packageName: '@happier-dev/plugins-zen',
        files: {
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "zen", runtime: { capabilities: ["agents"] }, contributes: {} });\n',
          'src/agent/definition.ts': 'export const AGENT_DEFINITION = Object.freeze({ id: "zen" });\n',
        },
      });

      syncBundledPluginWorkspaces({ repoRoot, happyCliDir });

      const raw = JSON.parse(readFileSync(resolve(happyCliDir, 'package.json'), 'utf8')) as {
        bundledDependencies?: unknown;
        dependencies?: Record<string, string> | undefined;
      };

      const bundled = Array.isArray(raw.bundledDependencies) ? raw.bundledDependencies.map(String) : [];
      expect(bundled).toContain('@happier-dev/plugins-acme');
      expect(bundled).toContain('@happier-dev/plugins-zen');
      expect(raw.dependencies?.['@happier-dev/plugins-acme']).toBeTruthy();
      expect(raw.dependencies?.['@happier-dev/plugins-zen']).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('ignores reservation-only plugin workspace directories', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-sync-bundled-plugins-missing-definition-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/protocol'],
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
        },
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
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/zen',
        packageName: '@happier-dev/plugins-zen',
        files: {
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "zen", runtime: { capabilities: ["agents"] }, contributes: {} });\n',
          'src/agent/definition.ts': 'export const AGENT_DEFINITION = Object.freeze({ id: "zen" });\n',
        },
      });

      syncBundledPluginWorkspaces({ repoRoot, happyCliDir });

      const raw = JSON.parse(readFileSync(resolve(happyCliDir, 'package.json'), 'utf8')) as {
        bundledDependencies?: unknown;
        dependencies?: Record<string, string> | undefined;
      };

      const bundled = Array.isArray(raw.bundledDependencies) ? raw.bundledDependencies.map(String) : [];
      expect(bundled).not.toContain('@happier-dev/plugins-acme');
      expect(bundled).toContain('@happier-dev/plugins-zen');
      expect(raw.dependencies?.['@happier-dev/plugins-acme']).toBeUndefined();
      expect(raw.dependencies?.['@happier-dev/plugins-zen']).toBe('0.0.0');
    } finally {
      cleanup();
    }
  });

  it('adds non-agent plugin workspaces without agent definitions', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-sync-bundled-plugins-non-agent-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/protocol'],
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
        },
      });

      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/scm-github',
        packageName: '@happier-dev/plugins-scm-github',
        files: {
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "scm-github", runtime: { capabilities: ["scmHostingProviders"] } });\n',
        },
      });

      syncBundledPluginWorkspaces({ repoRoot, happyCliDir });

      const raw = JSON.parse(readFileSync(resolve(happyCliDir, 'package.json'), 'utf8')) as {
        bundledDependencies?: unknown;
        dependencies?: Record<string, string> | undefined;
      };

      const bundled = Array.isArray(raw.bundledDependencies) ? raw.bundledDependencies.map(String) : [];
      expect(bundled).toContain('@happier-dev/plugins-scm-github');
      expect(raw.dependencies?.['@happier-dev/plugins-scm-github']).toBe('0.0.0');
    } finally {
      cleanup();
    }
  });

  it('fails for unmarked plugin workspace directories without manifests', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-sync-bundled-plugins-unmarked-missing-definition-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/protocol'],
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
        },
      });

      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/acme',
        packageName: '@happier-dev/plugins-acme',
      });

      expect(() => syncBundledPluginWorkspaces({ repoRoot, happyCliDir })).toThrow(/missing required plugin manifest/i);
    } finally {
      cleanup();
    }
  });

  it('removes stale plugin dependencies that are no longer shippable while keeping current ones', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-sync-bundled-plugins-prune-stale-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/protocol', '@happier-dev/plugins-acme', '@happier-dev/plugins-zen'],
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
          '@happier-dev/plugins-acme': '0.0.0',
          '@happier-dev/plugins-zen': '0.0.0',
        },
      });

      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/zen',
        packageName: '@happier-dev/plugins-zen',
        files: {
          'src/manifest.ts': 'export const PLUGIN_MANIFEST = Object.freeze({ id: "zen", runtime: { capabilities: ["agents"] }, contributes: {} });\n',
          'src/agent/definition.ts': 'export const AGENT_DEFINITION = Object.freeze({ id: "zen" });\n',
        },
      });

      syncBundledPluginWorkspaces({ repoRoot, happyCliDir });

      const raw = JSON.parse(readFileSync(resolve(happyCliDir, 'package.json'), 'utf8')) as {
        bundledDependencies?: unknown;
        dependencies?: Record<string, string> | undefined;
      };

      const bundled = Array.isArray(raw.bundledDependencies) ? raw.bundledDependencies.map(String) : [];
      expect(bundled).not.toContain('@happier-dev/plugins-acme');
      expect(bundled).toContain('@happier-dev/plugins-zen');
      expect(raw.dependencies?.['@happier-dev/plugins-acme']).toBeUndefined();
      expect(raw.dependencies?.['@happier-dev/plugins-zen']).toBe('0.0.0');
    } finally {
      cleanup();
    }
  });

  it('removes stale plugin dependencies when no shippable plugins remain', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-sync-bundled-plugins-prune-all-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/protocol', '@happier-dev/plugins-acme'],
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
          '@happier-dev/plugins-acme': '0.0.0',
        },
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

      syncBundledPluginWorkspaces({ repoRoot, happyCliDir });

      const raw = JSON.parse(readFileSync(resolve(happyCliDir, 'package.json'), 'utf8')) as {
        bundledDependencies?: unknown;
        dependencies?: Record<string, string> | undefined;
      };

      const bundled = Array.isArray(raw.bundledDependencies) ? raw.bundledDependencies.map(String) : [];
      expect(bundled).not.toContain('@happier-dev/plugins-acme');
      expect(raw.dependencies?.['@happier-dev/plugins-acme']).toBeUndefined();
      expect(raw.dependencies?.['@happier-dev/protocol']).toBe('0.0.0');
    } finally {
      cleanup();
    }
  });

  it('ignores underscore-prefixed plugin workspace directories', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-sync-bundled-plugins-underscore-');

    try {
      writeCliBundledHostPackage({
        happyCliDir,
        bundledDependencies: ['@happier-dev/protocol', 'tweetnacl'],
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
          tweetnacl: '^1.0.3',
        },
      });

      // `_template` is a scaffolding directory and must never be treated as a bundled plugin package.
      writeWorkspacePackageFixture({
        repoRoot,
        workspacePath: 'packages/plugins/_template',
        packageName: '@happier-dev/plugins-_template',
      });

      const before = readFileSync(resolve(happyCliDir, 'package.json'), 'utf8');
      syncBundledPluginWorkspaces({ repoRoot, happyCliDir });
      const after = readFileSync(resolve(happyCliDir, 'package.json'), 'utf8');
      expect(after).toBe(before);
    } finally {
      cleanup();
    }
  });

  it('no-ops when packages/plugins is absent', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-sync-bundled-plugins-empty-');

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
      syncBundledPluginWorkspaces({ repoRoot, happyCliDir });
      const after = readFileSync(resolve(happyCliDir, 'package.json'), 'utf8');
      expect(after).toBe(before);
    } finally {
      cleanup();
    }
  });
});
