import {
  atomicReplaceDirSync,
  bundleWorkspacePackage,
  hasBundledWorkspacePackagesHealthy,
} from './index';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
});

describe('hasBundledWorkspacePackagesHealthy', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('returns false when a bundled workspace runtime dependency tree is incomplete', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-'));

    const workspacePackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(workspacePackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: {
            depA: '^1.0.0',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(workspacePackageDir, 'dist/index.js'), 'export {};\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: workspacePackageDir,
      destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol'),
    });

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: rootDir,
        hostPackageDir,
      }),
    ).toBe(false);
  });

  it('returns false when repoRoot points at the host app package and a bundled workspace is incomplete', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-'));
    writeFileSync(resolve(rootDir, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2), 'utf8');
    writeFileSync(resolve(rootDir, 'yarn.lock'), '', 'utf8');

    const workspacePackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(workspacePackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: {
            depA: '^1.0.0',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(workspacePackageDir, 'dist/index.js'), 'export {};\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: workspacePackageDir,
      destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol'),
    });

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: hostPackageDir,
        hostPackageDir,
      }),
    ).toBe(false);
  });

  it('returns false when the source workspace package is unavailable but the bundled payload is incomplete', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-'));
    writeFileSync(resolve(rootDir, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2), 'utf8');
    writeFileSync(resolve(rootDir, 'yarn.lock'), '', 'utf8');

    const sourceWorkspaceDir = resolve(rootDir, 'external', 'protocol-source');
    mkdirSync(resolve(sourceWorkspaceDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(sourceWorkspaceDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: {
            depA: '^1.0.0',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(resolve(sourceWorkspaceDir, 'dist/index.js'), 'export {};\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: sourceWorkspaceDir,
      destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol'),
    });
    rmSync(resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'));

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: hostPackageDir,
        hostPackageDir,
      }),
    ).toBe(false);
  });

  it('returns true when bundled workspace outputs and runtime dependencies are healthy', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundled-health-'));

    const workspacePackageDir = resolve(rootDir, 'packages/protocol');
    mkdirSync(resolve(workspacePackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(workspacePackageDir, 'package.json'),
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
      'utf8',
    );
    writeFileSync(resolve(workspacePackageDir, 'dist/index.js'), 'export {};\n', 'utf8');

    const hostPackageDir = resolve(rootDir, 'apps/cli');
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          bundledDependencies: ['@happier-dev/protocol'],
        },
        null,
        2,
      ),
      'utf8',
    );

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: workspacePackageDir,
      destDir: resolve(hostPackageDir, 'node_modules', '@happier-dev', 'protocol'),
    });

    expect(
      hasBundledWorkspacePackagesHealthy({
        repoRoot: rootDir,
        hostPackageDir,
      }),
    ).toBe(true);
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
});
