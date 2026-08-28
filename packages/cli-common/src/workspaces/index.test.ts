import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bundleInstalledPackageWithRuntimeDependencies,
  bundleWorkspacePackageWithRuntimeDependencies,
  materializePrepublicationWorkspacePackageRoots,
  sanitizeBundledPackageJson,
  vendorBundledPackageRuntimeDependencies,
} from './index';

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writePackage(
  packageDir: string,
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>> = { 'index.js': 'module.exports = {};\n' },
): void {
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  for (const [relativePath, contents] of Object.entries(files)) {
    const targetPath = join(packageDir, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, contents, 'utf8');
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('sanitizeBundledPackageJson', () => {
  it('preserves the exact prepublication author file inventory while stripping ordinary package files', () => {
    const declaredAuthorFiles = [
      'dist',
      'package.json',
      'API.md',
      'api-surface.json',
      'capability-matrix.json',
      'examples/public-authoring/index.ts',
      'scripts/validate-authoring.mjs',
      'API.md',
    ];

    expect(sanitizeBundledPackageJson({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      files: declaredAuthorFiles,
      happier: { publicSdkRelease: { posture: 'developer_preview' } },
    }).files).toEqual([
      'dist',
      'package.json',
      'API.md',
      'api-surface.json',
      'capability-matrix.json',
      'examples/public-authoring/index.ts',
      'scripts/validate-authoring.mjs',
    ]);

    expect(sanitizeBundledPackageJson({
      name: '@happier-dev/plugins-example',
      version: '0.0.0',
      files: ['dist', 'README.md'],
    })).not.toHaveProperty('files');
  });

  it('keeps the executable entrypoint declaration for every bundled workspace package', () => {
    // `bin` is the only thing that makes a bundled package's dist executable
    // discoverable. The Plugin SDK's `happier-plugin-build-ui` is exactly that:
    // strip it and no `--ui` author can run `plugins dev build` from either
    // the packaged CLI's own bundled copy or a materialized prepublication root.
    expect(sanitizeBundledPackageJson({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      bin: { 'happier-plugin-build-ui': './dist/ui/build/bin.js' },
      happier: { publicSdkRelease: { posture: 'developer_preview' } },
    }).bin).toEqual({ 'happier-plugin-build-ui': './dist/ui/build/bin.js' });

    expect(sanitizeBundledPackageJson({
      name: '@happier-dev/plugins-example',
      version: '0.0.0',
      bin: { 'example-tool': './dist/bin.js' },
    }).bin).toEqual({ 'example-tool': './dist/bin.js' });

    expect(sanitizeBundledPackageJson({
      name: '@happier-dev/plugins-example',
      version: '0.0.0',
    })).not.toHaveProperty('bin');
  });

  it.each([
    ['a traversal path', '../outside.md'],
    ['a glob path', 'examples/**'],
    ['a Windows path', 'scripts\\validate.mjs'],
  ])('rejects a marked prepublication manifest with %s', (_description, declaredFile) => {
    expect(() => sanitizeBundledPackageJson({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      files: ['dist', declaredFile],
      happier: { publicSdkRelease: { posture: 'developer_preview' } },
    })).toThrow(/exact relative path/u);
  });
});

describe('bundleWorkspacePackageWithRuntimeDependencies', () => {
  it('validates the complete staged package before replacing last-green', () => {
    const repositoryRoot = createTempRoot('cli-common-workspace-stage-validation-');
    const sourceDir = join(repositoryRoot, 'packages', 'plugins', 'fixture');
    const destinationDir = join(
      repositoryRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'plugins-fixture',
    );
    writePackage(sourceDir, {
      name: '@happier-dev/plugins-fixture',
      version: '0.0.0',
      type: 'module',
      exports: { '.': './dist/index.js' },
      dependencies: {},
    }, {
      'dist/index.js': 'export const generation = "current";\n',
    });
    writePackage(destinationDir, {
      name: '@happier-dev/plugins-fixture',
      version: '0.0.0',
      type: 'module',
      exports: { '.': './dist/index.js' },
      dependencies: {},
    }, {
      'dist/index.js': 'export const generation = "last-green";\n',
    });

    expect(() => bundleWorkspacePackageWithRuntimeDependencies({
      packageName: '@happier-dev/plugins-fixture',
      srcDir: sourceDir,
      destDir: destinationDir,
      dereferenceRootDir: repositoryRoot,
      validatePreparedPackage: ({ packageName, packageDir }) => {
        expect(packageName).toBe('@happier-dev/plugins-fixture');
        expect(readFileSync(join(packageDir, 'dist', 'index.js'), 'utf8'))
          .toBe('export const generation = "current";\n');
        throw new Error('fixture staged package rejected');
      },
    })).toThrow(/fixture staged package rejected/u);

    expect(readFileSync(join(destinationDir, 'dist', 'index.js'), 'utf8'))
      .toBe('export const generation = "last-green";\n');
  });
});

describe('materializePrepublicationWorkspacePackageRoots', () => {
  it('materializes only requested packages carrying the canonical public author classification', () => {
    const root = createTempRoot('cli-common-public-author-roots-');
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    const writePublicPackage = (packageName: string, directoryName: string) => {
      const packageRoot = join(sourceRoot, directoryName);
      writePackage(packageRoot, {
        name: packageName,
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        files: ['dist', 'package.json'],
        happier: {
          publicSdkRelease: {
            posture: 'developer_preview',
            externalPublicationRequiresApproval: true,
          },
        },
      }, {
        'dist/index.js': 'export const packageMarker = true;\n',
        'dist/index.d.ts': 'export declare const packageMarker: true;\n',
      });
      return {
        packageName,
        srcDir: packageRoot,
        destDir: join(destinationRoot, 'node_modules', ...packageName.split('/')),
      };
    };
    const sdk = writePublicPackage('@happier-dev/plugin-sdk', 'plugin-sdk');
    const channels = writePublicPackage('@happier-dev/channels-protocol', 'channels-protocol');

    materializePrepublicationWorkspacePackageRoots({
      bundles: [sdk, channels],
      rootPackageNames: ['@happier-dev/channels-protocol'],
    });

    expect(existsSync(join(channels.destDir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(sdk.destDir)).toBe(false);
    expect(() => materializePrepublicationWorkspacePackageRoots({
      bundles: [sdk, channels],
      rootPackageNames: ['@happier-dev/protocol'],
    })).toThrow(/not classified for public author use/u);
  });
});

describe('bundleInstalledPackageWithRuntimeDependencies', () => {
  it('rejects a resolved root package outside the caller-approved repository root', () => {
    const ancestorRoot = createTempRoot('cli-common-outside-root-package-');
    const repositoryRoot = join(ancestorRoot, 'repository');
    const hostPackageJsonPath = join(repositoryRoot, 'apps', 'host', 'package.json');
    const outsidePackageDir = join(ancestorRoot, 'node_modules', 'root-pkg');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    mkdirSync(dirname(hostPackageJsonPath), { recursive: true });
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(outsidePackageDir, {
      name: 'root-pkg',
      version: '1.0.0',
      main: 'index.js',
    });

    expect(() => bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'root-pkg',
      declaredSpec: '^1.0.0',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
      dereferenceRootDir: repositoryRoot,
    })).toThrow(/resolved runtime dependency root-pkg.*outside.*approved root/i);
    expect(existsSync(join(destNodeModulesDir, 'root-pkg'))).toBe(false);
  });

  it.each([
    {
      label: 'file',
      createLink(packageDir: string, outsideRoot: string) {
        const outsideFile = join(outsideRoot, 'secret.txt');
        writeFileSync(outsideFile, 'outside-file\n', 'utf8');
        symlinkSync(outsideFile, join(packageDir, 'linked-secret.txt'), 'file');
      },
    },
    {
      label: 'directory',
      createLink(packageDir: string, outsideRoot: string) {
        const outsideDir = join(outsideRoot, 'secret-dir');
        mkdirSync(outsideDir, { recursive: true });
        writeFileSync(join(outsideDir, 'secret.txt'), 'outside-directory\n', 'utf8');
        symlinkSync(
          outsideDir,
          join(packageDir, 'linked-secret-dir'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
    },
  ])('rejects a dereferenced $label symlink whose target escapes the caller-approved root', ({ createLink }) => {
    const repositoryRoot = createTempRoot('cli-common-symlink-repository-');
    const outsidePackageRoot = createTempRoot('cli-common-symlink-outside-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const packageDir = join(repositoryRoot, 'node_modules', 'root-pkg');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    mkdirSync(outsidePackageRoot, { recursive: true });
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(packageDir, {
      name: 'root-pkg',
      version: '1.0.0',
      main: 'index.js',
    });
    createLink(packageDir, outsidePackageRoot);

    expect(() => bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'root-pkg',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
      dereferenceRootDir: repositoryRoot,
    })).toThrow(/dereferenced symlink target escapes copy source root/i);
  });

  it('allows a hoisted package-manager bin symlink within the caller-approved repository root', () => {
    const repositoryRoot = createTempRoot('cli-common-hoisted-bin-symlink-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const packageDir = join(repositoryRoot, 'node_modules', 'livekit-client');
    const hoistedTargetDir = join(repositoryRoot, 'node_modules', 'sdp-transform');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(packageDir, {
      name: 'livekit-client',
      version: '1.0.0',
      main: 'index.js',
    });
    writePackage(hoistedTargetDir, {
      name: 'sdp-transform',
      version: '1.0.0',
      main: 'checker.js',
    }, {
      'checker.js': 'module.exports = "checker";\n',
    });
    mkdirSync(join(packageDir, 'node_modules', '.bin'), { recursive: true });
    symlinkSync(
      join(hoistedTargetDir, 'checker.js'),
      join(packageDir, 'node_modules', '.bin', 'sdp-verify'),
      'file',
    );

    bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'livekit-client',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
      dereferenceRootDir: repositoryRoot,
    });

    expect(readFileSync(
      join(destNodeModulesDir, 'livekit-client', 'node_modules', '.bin', 'sdp-verify'),
      'utf8',
    )).toBe('module.exports = "checker";\n');
  });

  it('allows a dereferenced file symlink whose target stays within the package root', () => {
    const repositoryRoot = createTempRoot('cli-common-contained-symlink-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const packageDir = join(repositoryRoot, 'node_modules', 'root-pkg');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(packageDir, {
      name: 'root-pkg',
      version: '1.0.0',
      main: 'index.js',
    }, {
      'index.js': 'module.exports = {};\n',
      'owned-target.txt': 'owned-content\n',
    });
    symlinkSync(
      join(packageDir, 'owned-target.txt'),
      join(packageDir, 'linked-owned-target.txt'),
      'file',
    );

    bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'root-pkg',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
    });

    expect(readFileSync(
      join(destNodeModulesDir, 'root-pkg', 'linked-owned-target.txt'),
      'utf8',
    )).toBe('owned-content\n');
  });

  it('rejects a contained directory symlink cycle on active physical ancestry', () => {
    const repositoryRoot = createTempRoot('cli-common-contained-symlink-cycle-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const packageDir = join(repositoryRoot, 'node_modules', 'root-pkg');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(packageDir, {
      name: 'root-pkg',
      version: '1.0.0',
      main: 'index.js',
    });
    symlinkSync(
      packageDir,
      join(packageDir, 'self'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'root-pkg',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
    })).toThrow(/dereferenced directory symlink cycle detected/i);
  });

  it('terminates cyclic dependency ancestry by physical source identity', () => {
    const repositoryRoot = createTempRoot('cli-common-cycle-repository-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const packageADir = join(repositoryRoot, 'node_modules', 'package-a');
    const packageBDir = join(repositoryRoot, 'node_modules', 'package-b');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(packageADir, {
      name: 'package-a',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'package-b': '^1.0.0' },
    });
    writePackage(packageBDir, {
      name: 'package-b',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'package-a': '^1.0.0' },
    });

    expect(() => bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'package-a',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
    })).not.toThrow();
    expect(JSON.parse(readFileSync(
      join(destNodeModulesDir, 'package-a', 'node_modules', 'package-b', 'package.json'),
      'utf8',
    ))).toMatchObject({ name: 'package-b', version: '1.0.0' });
    expect(existsSync(join(
      destNodeModulesDir,
      'package-a',
      'node_modules',
      'package-b',
      'node_modules',
      'package-a',
    ))).toBe(false);
  });

  it('preserves conflicting transitive package placements across sibling ancestry branches', () => {
    const repositoryRoot = createTempRoot('cli-common-conflicting-branches-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const rootPackageDir = join(repositoryRoot, 'node_modules', 'root-pkg');
    const leftPackageDir = join(repositoryRoot, 'node_modules', 'left-pkg');
    const rightPackageDir = join(repositoryRoot, 'node_modules', 'right-pkg');
    const leftSharedDir = join(leftPackageDir, 'node_modules', 'shared-pkg');
    const rightSharedDir = join(rightPackageDir, 'node_modules', 'shared-pkg');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(rootPackageDir, {
      name: 'root-pkg',
      version: '1.0.0',
      main: 'index.js',
      dependencies: {
        'left-pkg': '^1.0.0',
        'right-pkg': '^1.0.0',
      },
    });
    writePackage(leftPackageDir, {
      name: 'left-pkg',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'shared-pkg': '^1.0.0' },
    });
    writePackage(rightPackageDir, {
      name: 'right-pkg',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'shared-pkg': '^2.0.0' },
    });
    writePackage(leftSharedDir, {
      name: 'shared-pkg',
      version: '1.0.0',
      main: 'index.js',
    });
    writePackage(rightSharedDir, {
      name: 'shared-pkg',
      version: '2.0.0',
      main: 'index.js',
    });

    bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'root-pkg',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
    });

    expect(JSON.parse(readFileSync(join(
      destNodeModulesDir,
      'root-pkg',
      'node_modules',
      'left-pkg',
      'node_modules',
      'shared-pkg',
      'package.json',
    ), 'utf8'))).toMatchObject({ version: '1.0.0' });
    expect(JSON.parse(readFileSync(join(
      destNodeModulesDir,
      'root-pkg',
      'node_modules',
      'right-pkg',
      'node_modules',
      'shared-pkg',
      'package.json',
    ), 'utf8'))).toMatchObject({ version: '2.0.0' });
  });
});

describe('vendorBundledPackageRuntimeDependencies', () => {
  it('rejects a malformed runtime dependency name before resolving or writing it', () => {
    const repositoryRoot = createTempRoot('cli-common-runtime-name-traversal-');
    const srcPackageDir = join(repositoryRoot, 'packages', 'workspace-pkg');
    const srcPackageJsonPath = join(srcPackageDir, 'package.json');
    const destPackageDir = join(repositoryRoot, 'artifact', 'workspace-pkg');
    writePackage(srcPackageDir, {
      name: 'workspace-pkg',
      version: '1.0.0',
      dependencies: {
        '../../../../outside-runtime': '1.0.0',
      },
    });

    expect(() => vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath,
      destPackageDir,
      dereferenceRootDir: repositoryRoot,
    })).toThrow(/invalid package dependency name/i);
    expect(existsSync(join(repositoryRoot, 'outside-runtime'))).toBe(false);
  });

  it.each([
    ['required', 'dependencies'],
    ['optional', 'optionalDependencies'],
  ] as const)('rejects a %s runtime package resolved outside the caller-approved repository root', (
    _dependencyKind,
    dependencyField,
  ) => {
    const ancestorRoot = createTempRoot('cli-common-outside-transitive-package-');
    const repositoryRoot = join(ancestorRoot, 'repository');
    const srcPackageDir = join(repositoryRoot, 'packages', 'workspace-pkg');
    const srcPackageJsonPath = join(srcPackageDir, 'package.json');
    const outsidePackageDir = join(ancestorRoot, 'node_modules', 'outside-dep');
    const destPackageDir = join(repositoryRoot, 'artifact', 'workspace-pkg');
    writePackage(srcPackageDir, {
      name: 'workspace-pkg',
      version: '1.0.0',
      [dependencyField]: { 'outside-dep': '^1.0.0' },
    });
    writePackage(outsidePackageDir, {
      name: 'outside-dep',
      version: '1.0.0',
      main: 'index.js',
    });

    expect(() => vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath,
      destPackageDir,
      dereferenceRootDir: repositoryRoot,
    })).toThrow(/resolved runtime dependency outside-dep.*outside.*approved root/i);
    expect(existsSync(join(destPackageDir, 'node_modules', 'outside-dep'))).toBe(false);
  });
});
