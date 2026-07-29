import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleWorkspaceDeps } from './bundleWorkspaceDeps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('bundleWorkspaceDeps', () => {
  it('bundles the support workspace dependencies into the published package tree', async () => {
    const sandbox = mkdtempSync(resolve(tmpdir(), 'happier-support-bundle-'));
    try {
      writeJson(resolve(sandbox, 'package.json'), { private: true });
      writeFileSync(resolve(sandbox, 'yarn.lock'), '', 'utf8');
      writeJson(resolve(sandbox, 'packages', 'support', 'package.json'), {
        name: '@happier-dev/support',
        version: '0.0.0',
        bundledDependencies: [
          '@happier-dev/agents',
          '@happier-dev/cli-common',
          '@happier-dev/protocol',
          '@happier-dev/release-runtime',
        ],
      });

      for (const workspaceName of ['agents', 'protocol', 'release-runtime', 'cli-common']) {
        writeJson(resolve(sandbox, 'packages', workspaceName, 'package.json'), {
          name: `@happier-dev/${workspaceName}`,
          version: '0.0.0',
          type: 'module',
          dependencies: workspaceName === 'cli-common'
            ? {
                '@happier-dev/agents': '0.0.0',
                '@happier-dev/release-runtime': '0.0.0',
              }
            : {},
        });
        mkdirSync(resolve(sandbox, 'packages', workspaceName, 'dist'), { recursive: true });
        writeFileSync(resolve(sandbox, 'packages', workspaceName, 'dist', 'index.js'), `export const ${workspaceName.replace(/-/g, '')} = true;\n`, 'utf8');
      }

      mkdirSync(resolve(sandbox, 'packages', 'cli-common', 'dist', 'workspaces'), { recursive: true });
      writeFileSync(
        resolve(sandbox, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js'),
        `import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
         import { dirname, resolve } from 'node:path';
         function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
         export function resolveWorkspaceBundlesFromPackageJson({ repoRoot, hostPackageDir }) {
           const host = readJson(resolve(hostPackageDir, 'package.json'));
           return (host.bundledDependencies ?? [])
             .filter((name) => typeof name === 'string' && name.startsWith('@happier-dev/'))
             .map((name) => {
               const leaf = name.slice('@happier-dev/'.length);
               return {
                 packageName: name,
                 srcDir: resolve(repoRoot, 'packages', leaf),
                 destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', leaf),
               };
             });
         }
         export function bundleWorkspacePackages({ bundles }) {
           for (const bundle of bundles) {
             const pkg = readJson(resolve(bundle.srcDir, 'package.json'));
             const destDist = resolve(bundle.destDir, 'dist');
             mkdirSync(destDist, { recursive: true });
             cpSync(resolve(bundle.srcDir, 'dist'), destDist, { recursive: true });
             writeFileSync(resolve(bundle.destDir, 'package.json'), JSON.stringify({ ...pkg, private: true }, null, 2) + '\\n', 'utf8');
           }
         }
         export function vendorBundledPackageRuntimeDependencies({ destPackageDir }) {
           writeFileSync(resolve(destPackageDir, 'vendor.txt'), 'vendored\\n', 'utf8');
         }
         export function bundleWorkspacePackagesWithRuntimeDependencies({ bundles }) {
           bundleWorkspacePackages({ bundles });
           for (const bundle of bundles) {
             vendorBundledPackageRuntimeDependencies({ destPackageDir: bundle.destDir });
           }
         }`,
        'utf8',
      );

      await bundleWorkspaceDeps({ repoRoot: sandbox, supportDir: resolve(sandbox, 'packages', 'support') });

      for (const workspaceName of ['agents', 'cli-common', 'protocol', 'release-runtime']) {
        const bundledDir = resolve(sandbox, 'packages', 'support', 'node_modules', '@happier-dev', workspaceName);
        expect(existsSync(resolve(bundledDir, 'dist', 'index.js'))).toBe(true);
        expect(readFileSync(resolve(bundledDir, 'package.json'), 'utf8')).toContain(`"@happier-dev/${workspaceName}"`);
        expect(existsSync(resolve(bundledDir, 'vendor.txt'))).toBe(true);
      }

      const releaseRuntimeDir = resolve(sandbox, 'packages', 'release-runtime');
      const releaseRuntimeSourcePath = resolve(releaseRuntimeDir, 'src', 'index.ts');
      const releaseRuntimeDistPath = resolve(releaseRuntimeDir, 'dist', 'index.js');
      mkdirSync(dirname(releaseRuntimeSourcePath), { recursive: true });
      writeFileSync(releaseRuntimeSourcePath, 'export const generation = "current";\n', 'utf8');
      writeFileSync(releaseRuntimeDistPath, 'export const generation = "stale";\n', 'utf8');
      const now = Date.now();
      utimesSync(releaseRuntimeSourcePath, new Date(now), new Date(now));
      utimesSync(releaseRuntimeDistPath, new Date(now + 10_000), new Date(now + 10_000));

      const liveAdmissionCalls: Array<{ packageNames: string[]; force: boolean | undefined }> = [];
      await bundleWorkspaceDeps({
        repoRoot: sandbox,
        supportDir: resolve(sandbox, 'packages', 'support'),
        publicationMode: 'live',
        ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
          liveAdmissionCalls.push({ packageNames, force: options?.force });
          return { ok: true, built: [], skipped: packageNames };
        },
      });
      expect(
        readFileSync(
          resolve(
            sandbox,
            'packages',
            'support',
            'node_modules',
            '@happier-dev',
            'release-runtime',
            'dist',
            'index.js',
          ),
          'utf8',
        ),
      ).toBe('export const generation = "stale";\n');
      expect(liveAdmissionCalls.every(({ force }) => force === undefined)).toBe(true);

      const artifactAdmissionCalls: Array<{ packageNames: string[]; force: boolean | undefined }> = [];
      await bundleWorkspaceDeps({
        repoRoot: sandbox,
        supportDir: resolve(sandbox, 'packages', 'support'),
        publicationMode: 'artifact',
        ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
          artifactAdmissionCalls.push({ packageNames, force: options?.force });
          if (options?.force === true && packageNames.includes('@happier-dev/release-runtime')) {
            writeFileSync(releaseRuntimeDistPath, 'export const generation = "current";\n', 'utf8');
          }
          return { ok: true, built: options?.force === true ? packageNames : [], skipped: [] };
        },
      });
      expect(
        readFileSync(
          resolve(
            sandbox,
            'packages',
            'support',
            'node_modules',
            '@happier-dev',
            'release-runtime',
            'dist',
            'index.js',
          ),
          'utf8',
        ),
      ).toBe('export const generation = "current";\n');
      expect(
        artifactAdmissionCalls.some(
          ({ packageNames, force }) => (
            packageNames.length === 1
            && packageNames[0] === '@happier-dev/cli-common'
            && force === true
          ),
        ),
      ).toBe(true);
      expect(
        artifactAdmissionCalls.some(
          ({ packageNames, force }) => (
            packageNames.includes('@happier-dev/release-runtime')
            && force === true
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
