import { atomicReplaceDirSync, bundleWorkspacePackage, copyDirSafeSync } from './index';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('bundleWorkspacePackage', () => {
  let rootDir: string | undefined;
  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('removes legacy dist staging dirs when rebundling into an existing destination', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const srcPackageDir = resolve(rootDir, 'packages/protocol');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    mkdirSync(srcDistDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');

    const destPackageDir = resolve(rootDir, 'apps/stack/node_modules/@happier-dev/protocol');
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    const legacyTmpDir = resolve(destPackageDir, 'dist.__sync_tmp__.old-staging');
    const legacyBackupDir = resolve(destPackageDir, 'dist.__sync_backup__.old-staging');
    mkdirSync(legacyTmpDir, { recursive: true });
    mkdirSync(legacyBackupDir, { recursive: true });

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(() => readdirSync(legacyTmpDir)).toThrow();
    expect(() => readdirSync(legacyBackupDir)).toThrow();

    const destPackageJsonPath = resolve(destPackageDir, 'package.json');
    const destPackageJson = JSON.parse(readFileSync(destPackageJsonPath, 'utf8'));
    expect(destPackageJson).toEqual(
      expect.objectContaining({
        name: '@happier-dev/protocol',
        private: true,
        exports: { '.': { default: './dist/index.js' } },
      }),
    );

    expect(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8')).toBe('export {};');

    const destParent = resolve(destPackageDir, '..');
    const siblingNames = readdirSync(destParent);
    expect(siblingNames.some((name) => name.startsWith('.protocol.__sync_tmp__.'))).toBe(false);
    expect(siblingNames.some((name) => name.startsWith('.protocol.__sync_backup__.'))).toBe(false);
  });

  it('bundles external runtime dependencies inside the same workspace replacement', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const bundleWorkspacePackageWithRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).bundleWorkspacePackageWithRuntimeDependencies;
    expect(bundleWorkspacePackageWithRuntimeDependencies).toBeTypeOf('function');

    const srcPackageDir = resolve(rootDir, 'packages/agents');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    const zodPackageDir = resolve(srcPackageDir, 'node_modules/zod');
    mkdirSync(srcDistDir, { recursive: true });
    mkdirSync(resolve(zodPackageDir, 'v4/core'), { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { zod: '4.3.6' },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');
    writeFileSync(
      resolve(zodPackageDir, 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', type: 'module', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(zodPackageDir, 'v4/core/schemas.js'), 'export const schemas = {};\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/agents');

    (bundleWorkspacePackageWithRuntimeDependencies as (params: {
      packageName: string;
      srcDir: string;
      destDir: string;
    }) => void)({
      packageName: '@happier-dev/agents',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8')).toBe('export {};');
    expect(readFileSync(resolve(destPackageDir, 'node_modules/zod/v4/core/schemas.js'), 'utf8')).toBe(
      'export const schemas = {};\n',
    );
  });

  it('skips vendoring an excluded runtime dependency of a workspace bundle while still vendoring the rest', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const bundleWorkspacePackageWithRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).bundleWorkspacePackageWithRuntimeDependencies;
    expect(bundleWorkspacePackageWithRuntimeDependencies).toBeTypeOf('function');

    const srcPackageDir = resolve(rootDir, 'packages/protocol');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    const tweetnaclPackageDir = resolve(srcPackageDir, 'node_modules/tweetnacl');
    const nobleHashesPackageDir = resolve(srcPackageDir, 'node_modules/@noble/hashes');
    mkdirSync(srcDistDir, { recursive: true });
    mkdirSync(tweetnaclPackageDir, { recursive: true });
    mkdirSync(nobleHashesPackageDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { tweetnacl: '1.0.3', '@noble/hashes': '1.8.0' },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');
    writeFileSync(
      resolve(tweetnaclPackageDir, 'package.json'),
      JSON.stringify({ name: 'tweetnacl', version: '1.0.3', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(tweetnaclPackageDir, 'nacl.js'), 'module.exports = {};\n');
    writeFileSync(
      resolve(nobleHashesPackageDir, 'package.json'),
      JSON.stringify({ name: '@noble/hashes', version: '1.8.0', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(nobleHashesPackageDir, 'sha256.js'), 'module.exports = {};\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');

    (bundleWorkspacePackageWithRuntimeDependencies as (params: {
      packageName: string;
      srcDir: string;
      destDir: string;
      excludePackageNames?: ReadonlySet<string>;
    }) => void)({
      packageName: '@happier-dev/protocol',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
      excludePackageNames: new Set(['tweetnacl']),
    });

    expect(existsSync(resolve(destPackageDir, 'node_modules/tweetnacl'))).toBe(false);
    expect(readFileSync(resolve(destPackageDir, 'node_modules/@noble/hashes/sha256.js'), 'utf8')).toBe(
      'module.exports = {};\n',
    );
  });

  it('vendors every declared runtime dependency of a workspace bundle when no exclusion set is provided', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const bundleWorkspacePackageWithRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).bundleWorkspacePackageWithRuntimeDependencies;
    expect(bundleWorkspacePackageWithRuntimeDependencies).toBeTypeOf('function');

    const srcPackageDir = resolve(rootDir, 'packages/protocol');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    const tweetnaclPackageDir = resolve(srcPackageDir, 'node_modules/tweetnacl');
    mkdirSync(srcDistDir, { recursive: true });
    mkdirSync(tweetnaclPackageDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { tweetnacl: '1.0.3' },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');
    writeFileSync(
      resolve(tweetnaclPackageDir, 'package.json'),
      JSON.stringify({ name: 'tweetnacl', version: '1.0.3', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(tweetnaclPackageDir, 'nacl.js'), 'module.exports = {};\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');

    (bundleWorkspacePackageWithRuntimeDependencies as (params: {
      packageName: string;
      srcDir: string;
      destDir: string;
    }) => void)({
      packageName: '@happier-dev/protocol',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(readFileSync(resolve(destPackageDir, 'node_modules/tweetnacl/nacl.js'), 'utf8')).toBe(
      'module.exports = {};\n',
    );
  });

  it('copies non-dist package export targets so the bundled public surface remains loadable', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const srcPackageDir = resolve(rootDir, 'packages/cli-common');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    mkdirSync(srcDistDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli-common',
          version: '0.0.0',
          type: 'module',
          exports: {
            '.': { default: './dist/index.js' },
            './workspaceLockLease': { default: './workspaceLockLease.mjs' },
            './workspaceBundleLock': { default: './workspaceBundleLock.mjs' },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};\n');
    writeFileSync(resolve(srcPackageDir, 'workspaceLockLease.mjs'), 'export const lease = "canonical";\n');
    writeFileSync(
      resolve(srcPackageDir, 'workspaceBundleLock.mjs'),
      'export { lease } from "./workspaceLockLease.mjs";\n',
    );

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/cli-common');
    bundleWorkspacePackage({
      packageName: '@happier-dev/cli-common',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(readFileSync(resolve(destPackageDir, 'workspaceBundleLock.mjs'), 'utf8')).toContain(
      './workspaceLockLease.mjs',
    );
    expect(readFileSync(resolve(destPackageDir, 'workspaceLockLease.mjs'), 'utf8')).toContain('canonical');
  });

  it('dedupes an identical name@version runtime dependency vendored twice via a diamond dependency, symlinking the second copy instead of recopying', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const bundleWorkspacePackageWithRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).bundleWorkspacePackageWithRuntimeDependencies;
    expect(bundleWorkspacePackageWithRuntimeDependencies).toBeTypeOf('function');

    // Diamond shape mirroring @modelcontextprotocol/sdk being a direct dep of apps/cli AND a
    // transitive dep of @anthropic-ai/claude-agent-sdk (also a direct dep of apps/cli): the shared
    // dependency is resolved and vendored twice within the same vendorRuntimeDependencyTree walk.
    const srcPackageDir = resolve(rootDir, 'packages/agents');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    const sharedDepDir = resolve(srcPackageDir, 'node_modules/shared-dep');
    const consumerDepDir = resolve(srcPackageDir, 'node_modules/consumer-dep');
    const nestedSharedDepDir = resolve(consumerDepDir, 'node_modules/shared-dep');

    mkdirSync(srcDistDir, { recursive: true });
    mkdirSync(sharedDepDir, { recursive: true });
    mkdirSync(consumerDepDir, { recursive: true });
    mkdirSync(nestedSharedDepDir, { recursive: true });

    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { 'shared-dep': '1.2.3', 'consumer-dep': '1.0.0' },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');

    writeFileSync(
      resolve(sharedDepDir, 'package.json'),
      JSON.stringify({ name: 'shared-dep', version: '1.2.3', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(sharedDepDir, 'index.js'), 'module.exports = "shared";\n');

    writeFileSync(
      resolve(consumerDepDir, 'package.json'),
      JSON.stringify({ name: 'consumer-dep', version: '1.0.0', dependencies: { 'shared-dep': '1.2.3' } }, null, 2),
    );
    writeFileSync(resolve(consumerDepDir, 'index.js'), 'module.exports = "consumer";\n');

    // The nested copy is resolvable independently (npm-style: consumer-dep's own node_modules)
    // and is byte-identical to the top-level copy, matching the real-world duplication shape.
    writeFileSync(
      resolve(nestedSharedDepDir, 'package.json'),
      JSON.stringify({ name: 'shared-dep', version: '1.2.3', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(nestedSharedDepDir, 'index.js'), 'module.exports = "shared";\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/agents');

    (bundleWorkspacePackageWithRuntimeDependencies as (params: {
      packageName: string;
      srcDir: string;
      destDir: string;
    }) => void)({
      packageName: '@happier-dev/agents',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    const vendoredSharedDepDir = resolve(destPackageDir, 'node_modules/shared-dep');
    const vendoredNestedSharedDepDir = resolve(
      destPackageDir,
      'node_modules/consumer-dep/node_modules/shared-dep',
    );

    // First occurrence is vendored normally as a real directory.
    expect(lstatSync(vendoredSharedDepDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(resolve(vendoredSharedDepDir, 'index.js'), 'utf8')).toBe('module.exports = "shared";\n');

    // Second occurrence (same name@version) is a symlink, not a full recopy. The link is written
    // as a relative path (so it survives the atomic staging-dir rename that happens inside
    // bundleWorkspacePackageWithRuntimeDependencies), but by the time that function returns,
    // destPackageDir is already the final real path -- so resolving the link here points at the
    // exact same directory as the surviving copy, not just something with a matching basename.
    expect(lstatSync(vendoredNestedSharedDepDir).isSymbolicLink()).toBe(true);
    const linkTarget = readlinkSync(vendoredNestedSharedDepDir);
    const resolvedLinkTarget = resolve(dirname(vendoredNestedSharedDepDir), linkTarget);
    expect(resolvedLinkTarget).toBe(vendoredSharedDepDir);
    expect(readFileSync(resolve(vendoredNestedSharedDepDir, 'index.js'), 'utf8')).toBe(
      'module.exports = "shared";\n',
    );
  });

  it('vendors two different versions of the same package name independently, never deduping by name alone', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const bundleWorkspacePackageWithRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).bundleWorkspacePackageWithRuntimeDependencies;
    expect(bundleWorkspacePackageWithRuntimeDependencies).toBeTypeOf('function');

    // Same diamond shape as the name@version dedup test above, but the nested copy declares a
    // DIFFERENT version of shared-dep. The dedupeByNameVersion map is keyed by "name@version", so
    // this must never even reach the equivalence check -- a name-only key would incorrectly treat
    // these as the same dependency.
    const srcPackageDir = resolve(rootDir, 'packages/agents');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    const sharedDepDir = resolve(srcPackageDir, 'node_modules/shared-dep');
    const consumerDepDir = resolve(srcPackageDir, 'node_modules/consumer-dep');
    const nestedSharedDepDir = resolve(consumerDepDir, 'node_modules/shared-dep');

    mkdirSync(srcDistDir, { recursive: true });
    mkdirSync(sharedDepDir, { recursive: true });
    mkdirSync(consumerDepDir, { recursive: true });
    mkdirSync(nestedSharedDepDir, { recursive: true });

    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { 'shared-dep': '1.2.3', 'consumer-dep': '1.0.0' },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');

    writeFileSync(
      resolve(sharedDepDir, 'package.json'),
      JSON.stringify({ name: 'shared-dep', version: '1.2.3', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(sharedDepDir, 'index.js'), 'module.exports = "shared-v1";\n');

    writeFileSync(
      resolve(consumerDepDir, 'package.json'),
      JSON.stringify({ name: 'consumer-dep', version: '1.0.0', dependencies: { 'shared-dep': '2.0.0' } }, null, 2),
    );
    writeFileSync(resolve(consumerDepDir, 'index.js'), 'module.exports = "consumer";\n');

    // Different version (2.0.0, not 1.2.3) and different content -- must be vendored as its own
    // real directory, not symlinked to the v1.2.3 copy.
    writeFileSync(
      resolve(nestedSharedDepDir, 'package.json'),
      JSON.stringify({ name: 'shared-dep', version: '2.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(nestedSharedDepDir, 'index.js'), 'module.exports = "shared-v2";\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/agents');

    (bundleWorkspacePackageWithRuntimeDependencies as (params: {
      packageName: string;
      srcDir: string;
      destDir: string;
    }) => void)({
      packageName: '@happier-dev/agents',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    const vendoredSharedDepDir = resolve(destPackageDir, 'node_modules/shared-dep');
    const vendoredNestedSharedDepDir = resolve(
      destPackageDir,
      'node_modules/consumer-dep/node_modules/shared-dep',
    );

    // Both versions are vendored as real, independent directories -- no symlink either direction.
    expect(lstatSync(vendoredSharedDepDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(vendoredNestedSharedDepDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(resolve(vendoredSharedDepDir, 'index.js'), 'utf8')).toBe('module.exports = "shared-v1";\n');
    expect(readFileSync(resolve(vendoredNestedSharedDepDir, 'index.js'), 'utf8')).toBe(
      'module.exports = "shared-v2";\n',
    );
  });

  it('does not dedupe two resolved directories that share name@version but differ in content', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const bundleWorkspacePackageWithRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).bundleWorkspacePackageWithRuntimeDependencies;
    expect(bundleWorkspacePackageWithRuntimeDependencies).toBeTypeOf('function');

    // Same diamond shape as the dedup test above, but the nested copy's file content differs from
    // the top-level copy despite declaring the identical name@version -- name@version alone must
    // not be trusted as proof of equivalence.
    const srcPackageDir = resolve(rootDir, 'packages/agents');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    const sharedDepDir = resolve(srcPackageDir, 'node_modules/shared-dep');
    const consumerDepDir = resolve(srcPackageDir, 'node_modules/consumer-dep');
    const nestedSharedDepDir = resolve(consumerDepDir, 'node_modules/shared-dep');

    mkdirSync(srcDistDir, { recursive: true });
    mkdirSync(sharedDepDir, { recursive: true });
    mkdirSync(consumerDepDir, { recursive: true });
    mkdirSync(nestedSharedDepDir, { recursive: true });

    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { 'shared-dep': '1.2.3', 'consumer-dep': '1.0.0' },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');

    writeFileSync(
      resolve(sharedDepDir, 'package.json'),
      JSON.stringify({ name: 'shared-dep', version: '1.2.3', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(sharedDepDir, 'index.js'), 'module.exports = "shared";\n');

    writeFileSync(
      resolve(consumerDepDir, 'package.json'),
      JSON.stringify({ name: 'consumer-dep', version: '1.0.0', dependencies: { 'shared-dep': '1.2.3' } }, null, 2),
    );
    writeFileSync(resolve(consumerDepDir, 'index.js'), 'module.exports = "consumer";\n');

    // Declares the same name@version as the top-level copy, but its file content is different
    // (longer file, different bytes) -- a mismatched-closure scenario a version string alone
    // cannot rule out.
    writeFileSync(
      resolve(nestedSharedDepDir, 'package.json'),
      JSON.stringify({ name: 'shared-dep', version: '1.2.3', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(nestedSharedDepDir, 'index.js'), 'module.exports = "shared-but-actually-different";\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/agents');

    (bundleWorkspacePackageWithRuntimeDependencies as (params: {
      packageName: string;
      srcDir: string;
      destDir: string;
    }) => void)({
      packageName: '@happier-dev/agents',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    const vendoredSharedDepDir = resolve(destPackageDir, 'node_modules/shared-dep');
    const vendoredNestedSharedDepDir = resolve(
      destPackageDir,
      'node_modules/consumer-dep/node_modules/shared-dep',
    );

    // Both occurrences must be real, independent directories -- the mismatch must prevent the
    // symlink dedup, even though name@version matches.
    expect(lstatSync(vendoredSharedDepDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(vendoredNestedSharedDepDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(resolve(vendoredSharedDepDir, 'index.js'), 'utf8')).toBe('module.exports = "shared";\n');
    expect(readFileSync(resolve(vendoredNestedSharedDepDir, 'index.js'), 'utf8')).toBe(
      'module.exports = "shared-but-actually-different";\n',
    );
  });

  it('does not abort vendoring when a resolved package tree contains a dangling symlink', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const bundleWorkspacePackageWithRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).bundleWorkspacePackageWithRuntimeDependencies;
    expect(bundleWorkspacePackageWithRuntimeDependencies).toBeTypeOf('function');

    // Same diamond shape again, but the top-level shared-dep tree contains a symlink pointing at
    // a path that doesn't exist -- a realistic node_modules artifact (e.g. a broken .bin shim, or
    // an optional dependency that failed to install). The equivalence check must tolerate this
    // instead of letting a raw statSync ENOENT abort the whole vendoring run.
    const srcPackageDir = resolve(rootDir, 'packages/agents');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    const sharedDepDir = resolve(srcPackageDir, 'node_modules/shared-dep');
    const consumerDepDir = resolve(srcPackageDir, 'node_modules/consumer-dep');
    const nestedSharedDepDir = resolve(consumerDepDir, 'node_modules/shared-dep');

    mkdirSync(srcDistDir, { recursive: true });
    mkdirSync(sharedDepDir, { recursive: true });
    mkdirSync(consumerDepDir, { recursive: true });
    mkdirSync(nestedSharedDepDir, { recursive: true });

    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { 'shared-dep': '1.2.3', 'consumer-dep': '1.0.0' },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');

    writeFileSync(
      resolve(sharedDepDir, 'package.json'),
      JSON.stringify({ name: 'shared-dep', version: '1.2.3', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(sharedDepDir, 'index.js'), 'module.exports = "shared";\n');
    symlinkSync(resolve(sharedDepDir, 'does-not-exist'), resolve(sharedDepDir, 'dangling-link'));

    writeFileSync(
      resolve(consumerDepDir, 'package.json'),
      JSON.stringify({ name: 'consumer-dep', version: '1.0.0', dependencies: { 'shared-dep': '1.2.3' } }, null, 2),
    );
    writeFileSync(resolve(consumerDepDir, 'index.js'), 'module.exports = "consumer";\n');

    writeFileSync(
      resolve(nestedSharedDepDir, 'package.json'),
      JSON.stringify({ name: 'shared-dep', version: '1.2.3', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(nestedSharedDepDir, 'index.js'), 'module.exports = "shared";\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/agents');

    // Must not throw despite the dangling symlink in the top-level copy's tree.
    expect(() =>
      (bundleWorkspacePackageWithRuntimeDependencies as (params: {
        packageName: string;
        srcDir: string;
        destDir: string;
      }) => void)({
        packageName: '@happier-dev/agents',
        srcDir: srcPackageDir,
        destDir: destPackageDir,
      }),
    ).not.toThrow();

    const vendoredSharedDepDir = resolve(destPackageDir, 'node_modules/shared-dep');
    const vendoredNestedSharedDepDir = resolve(
      destPackageDir,
      'node_modules/consumer-dep/node_modules/shared-dep',
    );

    // The dangling symlink makes the two trees compare as non-equivalent (its size can't be
    // determined), so both copies are vendored as real, independent directories rather than
    // deduped -- conservative fallback, not a crash.
    expect(lstatSync(vendoredSharedDepDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(vendoredNestedSharedDepDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(resolve(vendoredSharedDepDir, 'index.js'), 'utf8')).toBe('module.exports = "shared";\n');
    expect(readFileSync(resolve(vendoredNestedSharedDepDir, 'index.js'), 'utf8')).toBe(
      'module.exports = "shared";\n',
    );
  });

  it('skips vendoring a specific excluded package while still vendoring the rest', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const vendorBundledPackageRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).vendorBundledPackageRuntimeDependencies;
    expect(vendorBundledPackageRuntimeDependencies).toBeTypeOf('function');

    const cliDir = resolve(rootDir, 'apps/cli');
    const zodPackageDir = resolve(cliDir, 'node_modules/zod');
    const sharpPackageDir = resolve(cliDir, 'node_modules/sharp');
    mkdirSync(zodPackageDir, { recursive: true });
    mkdirSync(sharpPackageDir, { recursive: true });

    writeFileSync(
      resolve(cliDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          dependencies: { zod: '4.3.6', sharp: '0.34.3' },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      resolve(zodPackageDir, 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(zodPackageDir, 'index.js'), 'module.exports = {};\n');
    writeFileSync(
      resolve(sharpPackageDir, 'package.json'),
      JSON.stringify({ name: 'sharp', version: '0.34.3', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(sharpPackageDir, 'index.js'), 'module.exports = {};\n');

    const payloadDir = resolve(rootDir, 'payload');

    (vendorBundledPackageRuntimeDependencies as (params: {
      srcPackageJsonPath: string;
      resolveFromPackageJsonPath?: string;
      destPackageDir: string;
      excludePackageNames?: ReadonlySet<string>;
    }) => void)({
      srcPackageJsonPath: resolve(cliDir, 'package.json'),
      destPackageDir: payloadDir,
      excludePackageNames: new Set(['zod']),
    });

    expect(existsSync(resolve(payloadDir, 'node_modules/zod'))).toBe(false);
    expect(readFileSync(resolve(payloadDir, 'node_modules/sharp/index.js'), 'utf8')).toBe(
      'module.exports = {};\n',
    );
  });

  it('vendors every declared dependency when no exclusion set is provided', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const vendorBundledPackageRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).vendorBundledPackageRuntimeDependencies;
    expect(vendorBundledPackageRuntimeDependencies).toBeTypeOf('function');

    const cliDir = resolve(rootDir, 'apps/cli');
    const zodPackageDir = resolve(cliDir, 'node_modules/zod');
    mkdirSync(zodPackageDir, { recursive: true });

    writeFileSync(
      resolve(cliDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          dependencies: { zod: '4.3.6' },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      resolve(zodPackageDir, 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(zodPackageDir, 'index.js'), 'module.exports = {};\n');

    const payloadDir = resolve(rootDir, 'payload');

    (vendorBundledPackageRuntimeDependencies as (params: {
      srcPackageJsonPath: string;
      resolveFromPackageJsonPath?: string;
      destPackageDir: string;
    }) => void)({
      srcPackageJsonPath: resolve(cliDir, 'package.json'),
      destPackageDir: payloadDir,
    });

    expect(readFileSync(resolve(payloadDir, 'node_modules/zod/index.js'), 'utf8')).toBe(
      'module.exports = {};\n',
    );
  });
});

describe('atomicReplaceDirSync', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('retries a staged swap when the destination briefly reappears during the rename', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const tempFileName = 'next.txt';
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';
    let renameFailures = 0;

    atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, tempFileName), 'new');
      },
      fsOps: {
        renameSync(source, target) {
          if (source === stagedDir && target === destDir && renameFailures === 0) {
            renameFailures += 1;
            const error = new Error('ENOTEMPTY');
            Reflect.set(error, 'code', 'ENOTEMPTY');
            throw error;
          }

          return renameSync(source, target);
        },
      },
    });

    expect(renameFailures).toBe(1);
    expect(readFileSync(resolve(destDir, tempFileName), 'utf8')).toBe('new');
    expect(existsSync(resolve(destDir, previousFileName))).toBe(false);
  });

  it('continues when the destination disappears after the existence check', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const tempFileName = 'next.txt';
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';
    let existsChecks = 0;
    let renameCalls = 0;

    atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, tempFileName), 'new');
      },
      fsOps: {
        existsSync(targetPath) {
          if (targetPath === destDir) {
            existsChecks += 1;
            return existsChecks === 1 ? true : existsSync(targetPath);
          }
          return existsSync(targetPath);
        },
        renameSync(source, target) {
          if (source === destDir && target !== destDir && renameCalls === 0) {
            renameCalls += 1;
            rmSync(destDir, { recursive: true, force: true });
            const error = new Error('ENOENT');
            Reflect.set(error, 'code', 'ENOENT');
            throw error;
          }
          return renameSync(source, target);
        },
      },
    });

    expect(renameCalls).toBe(1);
    expect(readFileSync(resolve(destDir, tempFileName), 'utf8')).toBe('new');
    expect(existsSync(resolve(destDir, previousFileName))).toBe(false);
  });

  it('does not remove the live destination when backup rename is blocked', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';

    expect(() => atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, 'next.txt'), 'new');
      },
      fsOps: {
        renameSync(source, target) {
          if (source === destDir && target !== destDir) {
            const error = new Error('EPERM');
            Reflect.set(error, 'code', 'EPERM');
            throw error;
          }
          return renameSync(source, target);
        },
      },
    })).toThrow(/EPERM/);

    expect(existsSync(stagedDir)).toBe(false);
    expect(readFileSync(resolve(destDir, previousFileName), 'utf8')).toBe('old');
  });
});

describe('copyDirSafeSync', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('retries a transient ENOENT while copying a directory tree', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-copy-dir-'));

    const srcDir = resolve(rootDir, 'packages/protocol/dist');
    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol/dist');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(resolve(srcDir, 'index.js'), 'export const ok = true;\n');

    let attempts = 0;

    copyDirSafeSync(srcDir, destDir, {
      retries: 1,
      delayMs: 0,
      cpSyncImpl(source, target, options) {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('ENOENT');
          Reflect.set(error, 'code', 'ENOENT');
          throw error;
        }

        return cpSync(source, target, options);
      },
    });

    expect(attempts).toBe(2);
    expect(readFileSync(resolve(destDir, 'index.js'), 'utf8')).toBe('export const ok = true;\n');
  });
});
