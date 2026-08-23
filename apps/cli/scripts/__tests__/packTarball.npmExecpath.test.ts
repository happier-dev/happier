import fs, { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  bundleInstalledPackageWithRuntimeDependencies as canonicalBundleInstalledPackageWithRuntimeDependencies,
} from '../../../../packages/cli-common/src/workspaces/index';
import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { packTarball as packTarballImpl } from '../packTarball.mjs';

const loadCliCommonWorkspacesModuleFromSource = async () => ({
  bundleInstalledPackageWithRuntimeDependencies:
    canonicalBundleInstalledPackageWithRuntimeDependencies,
});

const packTarball = (options: Parameters<typeof packTarballImpl>[0]) => packTarballImpl({
  ...options,
  npmCliExistsSync: options.npmCliExistsSync ?? (() => true),
  assertInputCurrentnessImpl: async () => undefined,
  // These cases drive npm invocation and artifact sanitization against a synthetic
  // filesystem, so there is no promoted closure to compare; publication-closure
  // identity has its own coverage in `publicationClosureIdentity.test.ts`.
  assertPublicationClosureIdentityImpl: () => undefined,
  loadCliCommonWorkspacesModuleImpl:
    options.loadCliCommonWorkspacesModuleImpl ?? loadCliCommonWorkspacesModuleFromSource,
});

const noopBundleWorkspaceDeps = async () => undefined;

function preserveCommandInvocation(params: Readonly<{ command: string; args: string[] }>) {
  return { command: params.command, args: params.args };
}

function createPackageDistFsAdapter(baseExists: (targetPath: unknown) => boolean) {
  const syntheticPaths = new Set<string>();
  const key = (targetPath: unknown) => String(targetPath);

  return {
    existsSync(targetPath: unknown) {
      return syntheticPaths.has(key(targetPath)) || baseExists(targetPath);
    },
    cpSync(_sourcePath: unknown, targetPath: unknown) {
      syntheticPaths.add(key(targetPath));
    },
    mkdirSync() {
      return undefined;
    },
    renameSync(sourcePath: unknown, targetPath: unknown) {
      syntheticPaths.delete(key(sourcePath));
      syntheticPaths.add(key(targetPath));
    },
    rmSync(targetPath: unknown) {
      syntheticPaths.delete(key(targetPath));
    },
    bundleWorkspaceDeps: noopBundleWorkspaceDeps,
  };
}

function createRealArtifactFsAdapter(packageRoot: string) {
  return createPackageDistFsAdapter((targetPath) => (
    String(targetPath) === join(packageRoot, 'dist') || existsSync(String(targetPath))
  ));
}

function createArtifactWorkspaceManifestAdmissionAttempt({
  manifests,
  packageFiles = {},
  onPackSnapshot,
}: Readonly<{
  manifests: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  packageFiles?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  onPackSnapshot?: (snapshotRoot: string) => void;
}>) {
  const repoRoot = createTempDirSync('happier-cli-prepublication-artifact-admission-repo-');
  const packageRoot = join(repoRoot, 'apps', 'cli');
  const destDir = createTempDirSync('happier-cli-prepublication-artifact-admission-dest-');
  const tarballName = 'artifact.tgz';
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@happier-dev/cli',
    version: '0.2.10',
    files: ['package-dist', 'package-dist/**', 'package.json'],
    bundledDependencies: Object.keys(manifests),
  })}\n`, 'utf8');

  const bundleWorkspaceDeps = vi.fn(async ({ packageRoot: artifactPackageRoot }: { packageRoot: string }) => {
    for (const [packageName, manifest] of Object.entries(manifests)) {
      const artifactPackagePath = join(
        artifactPackageRoot,
        'node_modules',
        ...packageName.split('/'),
      );
      const artifactManifestPath = join(artifactPackagePath, 'package.json');
      mkdirSync(join(artifactManifestPath, '..'), { recursive: true });
      writeFileSync(artifactManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
      for (const [relativePath, contents] of Object.entries(packageFiles[packageName] ?? {})) {
        const artifactFilePath = join(artifactPackagePath, ...relativePath.split('/'));
        mkdirSync(dirname(artifactFilePath), { recursive: true });
        writeFileSync(artifactFilePath, contents, 'utf8');
      }
    }
  });
  const spawn = vi.fn((_command: unknown, _args: unknown, options: { cwd: string }) => {
    onPackSnapshot?.(options.cwd);
    writeFileSync(join(destDir, tarballName), '', 'utf8');
    return { status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' };
  });

  return {
    spawn,
    result: packTarball({
      packageRoot,
      repoRoot,
      destDir,
      bundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    }),
  };
}

describe('packTarball (npmExecpath)', () => {
  it('rejects a CLI dist whose recorded runtime inputs do not match the current source tree', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const distDir = join(packageRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package.json'],
    }), 'utf8');
    writeFileSync(join(distDir, 'index.mjs'), 'export const built = true;\n', 'utf8');
    const cliDistManifest = await import('../../../../packages/cli-common/cliDistBuildManifest.cjs');
    cliDistManifest.default.writeCliDistBuildManifest(join(distDir, 'index.mjs'), {
      outputDir: distDir,
      inputFingerprint: 'a'.repeat(64),
    });
    const spawn = vi.fn();

    await expect(packTarballImpl({
      packageRoot,
      destDir,
      bundleWorkspaceDeps: noopBundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    })).rejects.toThrow(/runtime input fingerprint.*does not match/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses bounded npm filename output and still requires a zero process status for the exact artifact', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');
    writeFileSync(join(destDir, 'unrelated-existing.tgz'), '', 'utf8');

    const spawn = vi.fn((_command: unknown, args: unknown) => {
      expect(args).toEqual(expect.arrayContaining(['pack', '--silent', '--ignore-scripts']));
      expect(args).not.toEqual(expect.arrayContaining(['--json']));
      return { status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' };
    });

    const result = await packTarball({
      packageRoot,
      destDir,
      spawnSync: spawn,
      ...createPackageDistFsAdapter(() => true),
      env: {},
    });
    expect(result.tarballName).toBe(tarballName);
    expect(result.tarballPath).toBe(join(destDir, tarballName));

    await expect(packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({ status: 9, signal: null, stdout: `${tarballName}\n`, stderr: '' }),
      ...createPackageDistFsAdapter(() => true),
      env: {},
    })).rejects.toThrow(/status: 9/);
  });

  it('rejects a signaled npm pack process even when stdout names an existing tarball', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    await expect(packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({
        status: null,
        signal: 'SIGTERM',
        error: undefined,
        stdout: `${tarballName}\n`,
        stderr: '',
      }),
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/signal: SIGTERM/);
  });

  it('rejects npm output that traverses outside the requested destination', async () => {
    const packRoot = createTempDirSync('happier-cli-pack-tarball-parent-');
    const destDir = join(packRoot, 'destination');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    writeFileSync(join(packRoot, 'outside.tgz'), '', 'utf8');

    await expect(packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({
        status: 0,
        signal: null,
        stdout: '../outside.tgz\n',
        stderr: '',
      }),
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/outside.*destination/i);
  });

  it('rejects a tarball path that escapes the destination through a directory symlink', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const outsideDir = createTempDirSync('happier-cli-pack-tarball-outside-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const linkedDirName = 'linked-outside';
    writeFileSync(join(outsideDir, 'artifact.tgz'), '', 'utf8');
    symlinkSync(
      outsideDir,
      join(destDir, linkedDirName),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({
        status: 0,
        signal: null,
        stdout: `${linkedDirName}/artifact.tgz\n`,
        stderr: '',
      }),
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/outside.*destination/i);
  });

  it('rejects a tarball path reached through a directory symlink inside the destination', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const realArtifactDir = join(destDir, 'real-artifacts');
    const linkedArtifactDir = join(destDir, 'linked-artifacts');
    mkdirSync(realArtifactDir);
    writeFileSync(join(realArtifactDir, 'artifact.tgz'), '', 'utf8');
    symlinkSync(
      realArtifactDir,
      linkedArtifactDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({ status: 0, signal: null, stdout: 'linked-artifacts/artifact.tgz\n', stderr: '' }),
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/regular file|symbolic link/i);
  });

  it('rejects a directory even when npm reports it with a tarball filename', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    mkdirSync(join(destDir, tarballName));

    await expect(packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({ status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' }),
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/regular file/i);
  });

  it('rejects a regular non-tarball file reported by npm', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    writeFileSync(join(destDir, 'package.json'), '{}', 'utf8');

    await expect(packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({ status: 0, signal: null, stdout: 'package.json\n', stderr: '' }),
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/tarball/i);
  });

  it('rejects a symlink even when it points to a regular file inside the destination', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    const targetPath = join(destDir, 'target.tgz');
    writeFileSync(targetPath, '', 'utf8');
    symlinkSync(targetPath, join(destDir, tarballName), 'file');

    await expect(packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({ status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' }),
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/regular file/i);
  });

  it('accepts absolute npm output when the artifact is owned by the destination', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballPath = join(destDir, 'artifact.tgz');
    writeFileSync(tarballPath, '', 'utf8');

    const result = await packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({ status: 0, signal: null, stdout: `${tarballPath}\n`, stderr: '' }),
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    });

    expect(result.tarballPath).toBe(tarballPath);
  });

  it('rejects absolute npm output in a sibling directory with a shared prefix', async () => {
    const packRoot = createTempDirSync('happier-cli-pack-tarball-parent-');
    const destDir = join(packRoot, 'destination');
    const siblingDir = join(packRoot, 'destination-sibling');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    mkdirSync(siblingDir, { recursive: true });
    const siblingTarballPath = join(siblingDir, 'artifact.tgz');
    writeFileSync(siblingTarballPath, '', 'utf8');

    await expect(packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({ status: 0, signal: null, stdout: `${siblingTarballPath}\n`, stderr: '' }),
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/outside.*destination/i);
  });

  it('rejects backslash traversal regardless of the host path separator', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    writeFileSync(join(destDir, '..\\outside.tgz'), '', 'utf8');

    await expect(packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({ status: 0, signal: null, stdout: '..\\outside.tgz\n', stderr: '' }),
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/outside.*destination/i);
  });

  it('uses the npm CLI owned by the active Node runtime and strips ambient package-authoring injection', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    const nodeExecPath = '/owned/runtime/bin/node';
    const ownedNpmCliPath = '/owned/runtime/lib/node_modules/npm/bin/npm-cli.js';
    const hostileNpmCliPath = '/attacker/npm-cli.js';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' }));

    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: hostileNpmCliPath,
      platform: 'linux',
      processExecPath: nodeExecPath,
      npmCliExistsSync: (targetPath: unknown) => String(targetPath) === ownedNpmCliPath,
      resolveCommandInvocation: preserveCommandInvocation,
      spawnSync: spawn,
      ...createPackageDistFsAdapter(() => true),
      env: {
        PATH: '/owned/runtime/bin:/usr/bin',
        HOME: '/home/builder',
        TMPDIR: '/tmp/builder',
        HTTPS_PROXY: 'https://proxy.example',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/private-ca.pem',
        HAPPIER_SERVER_URL: 'https://api.example',
        NODE_OPTIONS: '--import /attacker/inject.mjs',
        dyld_insert_libraries: '/attacker/inject.dylib',
        LD_PRELOAD: '/attacker/inject.so',
        OPENSSL_CONF: '/attacker/openssl.cnf',
        openssl_modules: '/attacker/providers',
        npm_config_userconfig: '/attacker/npmrc',
        NPM_CONFIG__AUTHTOKEN: 'must-not-leak',
        NODE_AUTH_TOKEN: 'must-not-leak',
        NPM_TOKEN: 'must-not-leak',
        npm_execpath: hostileNpmCliPath,
        npm_lifecycle_event: 'prepack',
        COREPACK_HOME: '/attacker/corepack',
        COREPACK_ENABLE_STRICT: '0',
        YARN_RC_FILENAME: '/attacker/yarnrc',
        YARN_WRAP_OUTPUT: 'false',
        BUN_OPTIONS: '--preload=/attacker/inject.mjs',
        happier_cli_subprocess_node_options: '--require=/attacker/inject.cjs',
      },
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe(nodeExecPath);
    expect(args).toEqual([
      ownedNpmCliPath,
      'pack',
      '--silent',
      '--ignore-scripts',
      '--pack-destination',
      expect.stringContaining(destDir),
    ]);
    expect(args).not.toContain(hostileNpmCliPath);
    const childEnv = options.env as Record<string, string>;
    expect(childEnv).toEqual(expect.objectContaining({
      PATH: '/owned/runtime/bin:/usr/bin',
      HOME: '/home/builder',
      TMPDIR: '/tmp/builder',
      HTTPS_PROXY: 'https://proxy.example',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/private-ca.pem',
      HAPPIER_SERVER_URL: 'https://api.example',
      npm_lifecycle_event: 'prepack',
      COREPACK_ENABLE_STRICT: '0',
      YARN_WRAP_OUTPUT: 'false',
    }));
    const normalizedChildKeys = Object.keys(childEnv).map((key) => key.toUpperCase());
    for (const hostileKey of [
      'NODE_OPTIONS',
      'DYLD_INSERT_LIBRARIES',
      'LD_PRELOAD',
      'OPENSSL_CONF',
      'OPENSSL_MODULES',
      'NPM_CONFIG_USERCONFIG',
      'NPM_CONFIG__AUTHTOKEN',
      'NODE_AUTH_TOKEN',
      'NPM_TOKEN',
      'NPM_EXECPATH',
      'COREPACK_HOME',
      'YARN_RC_FILENAME',
      'BUN_OPTIONS',
      'HAPPIER_CLI_SUBPROCESS_NODE_OPTIONS',
    ]) {
      expect(normalizedChildKeys).not.toContain(hostileKey);
    }
    expect(isAbsolute(childEnv.npm_config_cache)).toBe(true);
  });

  it('ignores non-npm npm_execpath values and uses the npm CLI beside the active Node runtime', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    const nodeExecPath = '/owned/runtime/bin/node';
    const npmCliPath = '/owned/runtime/lib/node_modules/npm/bin/npm-cli.js';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: `${tarballName}\n`, stderr: '' }));

    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      platform: 'linux',
      processExecPath: nodeExecPath,
      resolveCommandInvocation: preserveCommandInvocation,
      spawnSync: spawn,
      ...createPackageDistFsAdapter(() => true),
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      nodeExecPath,
      [npmCliPath, 'pack', '--silent', '--ignore-scripts', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('ignores a basename-matching ambient npm_execpath outside the active Node runtime', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    const nodeExecPath = '/owned/runtime/bin/node';
    const ownedNpmCliPath = '/owned/runtime/lib/node_modules/npm/bin/npm-cli.js';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: `${tarballName}\n`, stderr: '' }));

    const npmCliPath = '/somewhere/node_modules/npm/bin/npm-cli.js';
    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: npmCliPath,
      platform: 'linux',
      processExecPath: nodeExecPath,
      resolveCommandInvocation: preserveCommandInvocation,
      spawnSync: spawn,
      ...createPackageDistFsAdapter(() => true),
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      nodeExecPath,
      [ownedNpmCliPath, 'pack', '--silent', '--ignore-scripts', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('uses the active Windows Node installation instead of an explicit ambient npm-cli.js', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    const nodeExecPath = 'C:\\Managed Runtime\\node.exe';
    const npmCliPath = 'C:\\Custom npm\\npm-cli.js';
    const ownedNpmCliPath = 'C:\\Managed Runtime\\node_modules\\npm\\bin\\npm-cli.js';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: `${tarballName}\n`, stderr: '' }));
    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: npmCliPath,
      platform: 'win32',
      processExecPath: nodeExecPath,
      resolveCommandInvocation: preserveCommandInvocation,
      spawnSync: spawn,
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      nodeExecPath,
      [ownedNpmCliPath, 'pack', '--silent', '--ignore-scripts', '--pack-destination', destDir],
      expect.any(Object),
    );
  });

  it('uses node + npm-cli.js on Windows when npm_execpath points to a non-npm runner', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: `${tarballName}\n`, stderr: '' }));
    const nodeExecPath = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCliPath = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      platform: 'win32',
      processExecPath: nodeExecPath,
      spawnSync: spawn,
      ...createPackageDistFsAdapter((targetPath) => {
        const normalized = String(targetPath).replaceAll('\\', '/').toLowerCase();
        const normalizedNpmCli = npmCliPath.replaceAll('\\', '/').toLowerCase();
        return normalized === normalizedNpmCli || normalized.endsWith(`/${tarballName}`) || normalized.endsWith('/dist');
      }),
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      nodeExecPath,
      [npmCliPath, 'pack', '--silent', '--ignore-scripts', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('uses Windows path semantics for a forward-slash Windows executable path', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    const nodeExecPath = 'C:/Managed Runtime/node.exe';
    const npmCliPath = 'C:\\Managed Runtime\\node_modules\\npm\\bin\\npm-cli.js';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: `${tarballName}\n`, stderr: '' }));
    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      platform: 'win32',
      processExecPath: nodeExecPath,
      resolveCommandInvocation: preserveCommandInvocation,
      spawnSync: spawn,
      ...createPackageDistFsAdapter((targetPath) => (
        String(targetPath) === npmCliPath
        || String(targetPath) === join(packageRoot, 'dist')
        || existsSync(String(targetPath))
      )),
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      nodeExecPath,
      [npmCliPath, 'pack', '--silent', '--ignore-scripts', '--pack-destination', destDir],
      expect.any(Object),
    );
  });

  it('fails closed on Windows when npm-cli.js cannot be resolved from node.exe', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: `${tarballName}\n`, stderr: '' }));

    await expect(packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      platform: 'win32',
      processExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      npmCliExistsSync: () => false,
      spawnSync: spawn,
      ...createPackageDistFsAdapter((targetPath) => {
        const normalized = String(targetPath).replaceAll('\\', '/').toLowerCase();
        return normalized.endsWith(`/${tarballName}`) || normalized.endsWith('/dist');
      }),
      env: {},
    })).rejects.toThrow(/npm CLI owned by the active Node runtime is unavailable/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('routes the owned Windows Node invocation through the canonical command resolver', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const nodeExecPath = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCliPath = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    const wrappedArgs = [npmCliPath, 'pack'];
    const resolveCommandInvocation = vi.fn(() => ({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: wrappedArgs,
      windowsVerbatimArguments: true,
    }));
    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' }));

    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: '/somewhere/yarn.js',
      platform: 'win32',
      processExecPath: nodeExecPath,
      resolveCommandInvocation,
      spawnSync: spawn,
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    });

    expect(resolveCommandInvocation).toHaveBeenCalledWith(expect.objectContaining({
      command: nodeExecPath,
      args: [npmCliPath, 'pack', '--silent', '--ignore-scripts', '--pack-destination', destDir],
      resolveCommandOnPath: false,
    }));
    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      wrappedArgs,
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
  });

  it('uses node + npm-cli.js on Windows when npm_execpath is missing', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: `${tarballName}\n`, stderr: '' }));
    const nodeExecPath = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCliPath = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

    await packTarball({
      packageRoot,
      destDir,
      npmExecpath: '',
      platform: 'win32',
      processExecPath: nodeExecPath,
      spawnSync: spawn,
      ...createPackageDistFsAdapter((targetPath) => {
        const normalized = String(targetPath).replaceAll('\\', '/').toLowerCase();
        const normalizedNpmCli = npmCliPath.replaceAll('\\', '/').toLowerCase();
        return normalized === normalizedNpmCli || normalized.endsWith(`/${tarballName}`) || normalized.endsWith('/dist');
      }),
      env: {},
    });

    expect(spawn).toHaveBeenCalledWith(
      nodeExecPath,
      [npmCliPath, 'pack', '--silent', '--ignore-scripts', '--pack-destination', expect.stringContaining(destDir)],
      expect.any(Object),
    );
  });

  it('rejects malformed npm stdout that merely mentions an existing tarball', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({
      status: 0,
      stdout: `warning: retained previous ${tarballName}\n`,
      stderr: '',
    }));

    await expect(packTarball({
      packageRoot,
      destDir,
      npmInvocation: { command: 'npm', args: [] },
      spawnSync: spawn,
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/did not report a tarball filename/i);
  });

  it('rejects an arbitrary JSON log object that names an existing tarball', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    await expect(packTarball({
      packageRoot,
      destDir,
      spawnSync: () => ({
        status: 0,
        signal: null,
        stdout: JSON.stringify({ level: 'warn', filename: tarballName }),
        stderr: '',
      }),
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/did not report a tarball filename/i);
  });

  it('applies a bounded timeout to npm pack invocations to prevent indefinite hangs', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: `${tarballName}\n`, stderr: '' }));

    await packTarball({
      packageRoot,
      destDir,
      spawnSync: spawn,
      ...createPackageDistFsAdapter(() => true),
      env: {
        HAPPIER_CLI_PACK_TARBALL_TIMEOUT_MS: '123456',
      },
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        timeout: 123_456,
      }),
    );
  });

  it('uses an explicit npm cache directory instead of an inherited npm_config_cache', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const explicitCacheDir = join(destDir, 'explicit-cache');
    const inheritedCacheDir = join(destDir, 'inherited-cache');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' }));
    await packTarball({
      packageRoot,
      destDir,
      npmCacheDir: explicitCacheDir,
      spawnSync: spawn,
      ...createRealArtifactFsAdapter(packageRoot),
      env: {
        npm_config_cache: inheritedCacheDir,
        NPM_CONFIG_CACHE: `${inheritedCacheDir}-uppercase`,
      },
    });

    const spawnEnv = spawn.mock.calls[0]?.[2]?.env as Readonly<Record<string, string>>;
    expect(spawnEnv.npm_config_cache).toBe(explicitCacheDir);
    expect(Object.keys(spawnEnv).filter((key) => key.toLowerCase() === 'npm_config_cache'))
      .toEqual(['npm_config_cache']);
  });

  it('resolves an explicit relative npm cache once before creation and spawn', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const existingCacheDir = createTempDirSync('happier-cli-pack-explicit-cache-');
    const relativeCacheDir = relative(process.cwd(), existingCacheDir);
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' }));
    await packTarball({
      packageRoot,
      destDir,
      npmCacheDir: relativeCacheDir,
      spawnSync: spawn,
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    });

    const spawnEnv = spawn.mock.calls[0]?.[2]?.env as Readonly<Record<string, string>>;
    expect(isAbsolute(spawnEnv.npm_config_cache)).toBe(true);
    expect(spawnEnv.npm_config_cache).toBe(resolve(relativeCacheDir));
  });

  it('ignores ambient cache variants and removes an owned cache outside the pack destination by default', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const ambientCacheDir = join(destDir, 'ambient-cache');
    const ambientUppercaseCacheDir = join(destDir, 'ambient-uppercase-cache');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    let observedCacheDir = '';
    const spawn = vi.fn((_command: unknown, _args: unknown, options: { env: Record<string, unknown> }) => {
      observedCacheDir = String(options.env.npm_config_cache);
      expect(observedCacheDir).not.toBe(ambientCacheDir);
      expect(observedCacheDir).not.toBe(ambientUppercaseCacheDir);
      expect(Object.keys(options.env).filter((key) => key.toLowerCase() === 'npm_config_cache'))
        .toEqual(['npm_config_cache']);
      expect(existsSync(observedCacheDir)).toBe(true);
      return { status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' };
    });
    await packTarball({
      packageRoot,
      destDir,
      spawnSync: spawn,
      ...createRealArtifactFsAdapter(packageRoot),
      env: {
        npm_config_cache: ambientCacheDir,
        NPM_CONFIG_CACHE: ambientUppercaseCacheDir,
      },
    });

    const cacheRelativeToDestination = relative(destDir, observedCacheDir);
    expect(cacheRelativeToDestination === '..' || cacheRelativeToDestination.startsWith(`..${sep}`)).toBe(true);
    expect(observedCacheDir).toContain('happier-npm-cache-');
    expect(existsSync(observedCacheDir)).toBe(false);
    expect(existsSync(ambientCacheDir)).toBe(false);
    expect(existsSync(ambientUppercaseCacheDir)).toBe(false);
  });

  it('preserves the primary npm failure when owned-cache cleanup also fails', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    let observedCacheDir = '';
    const removeOwnedCacheDir = fs.rmSync;
    const removeOwnedCacheSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('cache-cleanup-locked');
    });
    let error: unknown = null;
    try {
      error = await packTarball({
        packageRoot,
        destDir,
        spawnSync: (_command: unknown, _args: unknown, options: { env: Record<string, unknown> }) => {
          observedCacheDir = String(options.env.npm_config_cache);
          return {
            status: 9,
            signal: null,
            stdout: '',
            stderr: 'primary-pack-diagnostic',
          };
        },
        ...createRealArtifactFsAdapter(packageRoot),
        env: {},
      }).then(
        () => null,
        (rejection: unknown) => rejection,
      );
    } finally {
      removeOwnedCacheSpy.mockRestore();
      if (observedCacheDir) {
        removeOwnedCacheDir(observedCacheDir, { recursive: true, force: true });
      }
    }

    expect(error).toBeInstanceOf(AggregateError);
    expect(String((error as Error).message)).toContain('status: 9');
    expect(String((error as Error).message)).toContain('primary-pack-diagnostic');
    expect(String((error as Error).message)).toContain('cache-cleanup-locked');
  });

  it('surfaces an owned-cache cleanup failure after an otherwise successful pack', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');
    let observedCacheDir = '';
    const removeOwnedCacheDir = fs.rmSync;
    const removeOwnedCacheSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('cache-cleanup-locked-after-success');
    });
    let error: unknown = null;
    try {
      error = await packTarball({
        packageRoot,
        destDir,
        spawnSync: (_command: unknown, _args: unknown, options: { env: Record<string, unknown> }) => {
          observedCacheDir = String(options.env.npm_config_cache);
          return { status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' };
        },
        ...createRealArtifactFsAdapter(packageRoot),
        env: {},
      }).then(
        () => null,
        (rejection: unknown) => rejection,
      );
    } finally {
      removeOwnedCacheSpy.mockRestore();
      if (observedCacheDir) {
        removeOwnedCacheDir(observedCacheDir, { recursive: true, force: true });
      }
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(String((error as Error).message)).toContain('cache-cleanup-locked-after-success');
  });

  it('rejects an owned cache temp root inside the package source tree', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const nestedTempRoot = join(packageRoot, '.tmp');
    const tarballName = 'artifact.tgz';
    mkdirSync(nestedTempRoot);
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' }));
    await expect(packTarball({
      packageRoot,
      destDir,
      tmpdir: () => nestedTempRoot,
      spawnSync: spawn,
      ...createRealArtifactFsAdapter(packageRoot),
      env: {},
    })).rejects.toThrow(/cache.*outside|temporary.*outside/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs the canonical bundled workspace dependency closure before npm pack', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const events: string[] = [];
    const spawn = vi.fn(() => {
      events.push('pack');
      return { status: 0, stdout: `${tarballName}\n`, stderr: '' };
    });
    const bundleWorkspaceDeps = vi.fn(async () => {
      events.push('bundle');
    });

    await packTarball({
      packageRoot,
      destDir,
      spawnSync: spawn,
      ...createPackageDistFsAdapter(() => true),
      bundleWorkspaceDeps,
      env: {},
    });

    expect(bundleWorkspaceDeps).toHaveBeenCalledWith(expect.objectContaining({
      publicationMode: 'artifact',
      repoRoot: resolve(packageRoot, '..', '..'),
    }));
    expect(bundleWorkspaceDeps.mock.calls[0]?.[0]?.packageRoot).not.toBe(packageRoot);
    expect(events).toEqual(['bundle', 'pack']);
  });

  it('packs a private sanitized snapshot when a source sync wins immediately after artifact bundling', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    const lockPath = join(packageRoot, '.workspace-bundle.lock');
    const inspectorPackageJsonPath = join(
      packageRoot,
      'node_modules',
      '@happier-dev',
      'plugins-inspector',
      'package.json',
    );
    const tweetnaclPackageJsonPath = join(packageRoot, 'node_modules', 'tweetnacl', 'package.json');
    const rawInspectorPackageJson = {
      name: '@happier-dev/plugins-inspector',
      version: '0.0.0',
      scripts: { build: 'tsx scripts/build.ts' },
      dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
    };
    const sanitizedInspectorPackageJson = {
      name: '@happier-dev/plugins-inspector',
      version: '0.2.10',
      dependencies: {},
    };

    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(join(packageRoot, 'package-dist'), { recursive: true });
    mkdirSync(join(packageRoot, 'tools', 'archives'), { recursive: true });
    mkdirSync(join(packageRoot, 'tools', 'unpacked'), { recursive: true });
    mkdirSync(join(packageRoot, 'node_modules', '@happier-dev', 'undeclared'), { recursive: true });
    mkdirSync(join(inspectorPackageJsonPath, '..'), { recursive: true });
    mkdirSync(join(tweetnaclPackageJsonPath, '..'), { recursive: true });
    writeFileSync(join(packageRoot, 'tools', 'archives', 'runtime.tar.gz'), 'packed', 'utf8');
    writeFileSync(join(packageRoot, 'tools', 'unpacked', 'runtime'), 'must-not-snapshot', 'utf8');
    writeFileSync(
      join(packageRoot, 'node_modules', '@happier-dev', 'undeclared', 'package.json'),
      '{"name":"@happier-dev/undeclared"}\n',
      'utf8',
    );
    writeFileSync(tweetnaclPackageJsonPath, '{"name":"tweetnacl","version":"1.0.3"}\n', 'utf8');
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'tools/archives', 'package.json'],
      dependencies: { tweetnacl: '^1.0.3' },
      bundledDependencies: ['@happier-dev/plugins-inspector', 'tweetnacl'],
    })}\n`, 'utf8');

    const bundleWorkspaceDeps = vi.fn(async ({
      env,
      packageRoot: bundlePackageRoot,
    }: {
      env: Record<string, string>;
      packageRoot: string;
    }) => {
      expect(existsSync(lockPath)).toBe(true);
      expect(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD).toBeTruthy();
      expect(bundlePackageRoot).not.toBe(packageRoot);
      const bundledInspectorPackageJsonPath = join(
        bundlePackageRoot,
        'node_modules',
        '@happier-dev',
        'plugins-inspector',
        'package.json',
      );
      mkdirSync(join(bundledInspectorPackageJsonPath, '..'), { recursive: true });
      writeFileSync(
        bundledInspectorPackageJsonPath,
        `${JSON.stringify(sanitizedInspectorPackageJson)}\n`,
        'utf8',
      );
      queueMicrotask(() => {
        writeFileSync(inspectorPackageJsonPath, `${JSON.stringify(rawInspectorPackageJson)}\n`, 'utf8');
      });
    });
    const spawn = vi.fn((_command: unknown, _args: unknown, options: { cwd: string }) => {
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(join(options.cwd, 'tools', 'archives', 'runtime.tar.gz'))).toBe(true);
      expect(existsSync(join(options.cwd, 'tools', 'unpacked', 'runtime'))).toBe(false);
      expect(existsSync(join(
        options.cwd,
        'node_modules',
        '@happier-dev',
        'undeclared',
        'package.json',
      ))).toBe(false);
      expect(existsSync(join(options.cwd, 'node_modules', 'tweetnacl', 'package.json'))).toBe(true);
      expect(JSON.parse(readFileSync(inspectorPackageJsonPath, 'utf8'))).toEqual(rawInspectorPackageJson);
      const packedInspectorPackageJson = JSON.parse(
        readFileSync(join(
          options.cwd,
          'node_modules',
          '@happier-dev',
          'plugins-inspector',
          'package.json',
        ), 'utf8'),
      );
      expect(packedInspectorPackageJson).toEqual(sanitizedInspectorPackageJson);
      writeFileSync(join(destDir, tarballName), '', 'utf8');
      return { status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' };
    });

    await packTarball({
      packageRoot,
      destDir,
      lockPath,
      bundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    });
  });

  it('fails closed before npm pack when artifact workspace publication leaves a raw package manifest', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'package.json'],
      bundledDependencies: ['@happier-dev/plugins-inspector'],
    })}\n`, 'utf8');

    const bundleWorkspaceDeps = vi.fn(async ({ packageRoot: bundlePackageRoot }: { packageRoot: string }) => {
      const bundledInspectorDir = join(
        bundlePackageRoot,
        'node_modules',
        '@happier-dev',
        'plugins-inspector',
      );
      mkdirSync(bundledInspectorDir, { recursive: true });
      writeFileSync(join(bundledInspectorDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-inspector',
        version: '0.0.0',
        scripts: { build: 'must-not-pack' },
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
        devDependencies: { vite: '7.3.1' },
      }), 'utf8');
    });
    const spawn = vi.fn();

    await expect(packTarball({
      packageRoot,
      destDir,
      bundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    })).rejects.toThrow(/unsanitized.*artifact workspace publication.*plugins-inspector/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('admits marked flattened prepublication SDK and UI manifests before npm pack', async () => {
    const sdkPackageName = '@happier-dev/plugin-sdk';
    const uiPackageName = '@happier-dev/plugin-ui';
    const protocolPackageName = '@happier-dev/protocol';
    const sdkManifest = {
      name: sdkPackageName,
      version: '0.2.10',
      dependencies: {
        [protocolPackageName]: '0.0.0',
        zod: '4.3.6',
      },
      bundledDependencies: [protocolPackageName],
      files: [
        'dist',
        'package.json',
        'API.md',
        'api-surface.json',
        'capability-matrix.json',
        'examples/public-authoring/index.ts',
        'scripts/validate-authoring.mjs',
      ],
      happier: {
        publicSdkRelease: {
          posture: 'prepublish_hold',
          supportPolicy: 'README.md#public-sdk-release-posture',
          externalPublicationRequiresApproval: true,
        },
      },
    };
    const uiManifest = {
      name: uiPackageName,
      version: '0.2.10',
      dependencies: {
        [sdkPackageName]: '0.0.0',
      },
      bundledDependencies: [],
      files: ['dist', 'package.json', 'api-declarations.md'],
      happier: {
        publicSdkRelease: {
          posture: 'prepublish_hold',
          supportPolicy: 'README.md#plugin-ui-release-posture',
          externalPublicationRequiresApproval: true,
        },
      },
    };
    const protocolManifest = {
      name: protocolPackageName,
      version: '0.2.10',
      dependencies: {},
    };

    const { result, spawn } = createArtifactWorkspaceManifestAdmissionAttempt({
      manifests: {
        [sdkPackageName]: sdkManifest,
        [uiPackageName]: uiManifest,
        [protocolPackageName]: protocolManifest,
      },
      packageFiles: {
        [sdkPackageName]: {
          'dist/index.js': 'export const sdk = true;\n',
          'API.md': '# API\n',
          'api-surface.json': '{"api":"current"}\n',
          'capability-matrix.json': '{"capability":"authoring"}\n',
          'examples/public-authoring/index.ts': 'export const example = true;\n',
          'scripts/validate-authoring.mjs': 'export const validate = true;\n',
        },
        [uiPackageName]: {
          'dist/index.js': 'export const ui = true;\n',
          'api-declarations.md': '# UI declarations\n',
        },
        [protocolPackageName]: {
          'dist/index.js': 'export const protocol = true;\n',
        },
      },
      onPackSnapshot: (snapshotRoot) => {
        expect(readFileSync(join(
          snapshotRoot,
          'node_modules',
          '@happier-dev',
          'plugin-sdk',
          'package.json',
        ), 'utf8')).toContain('prepublish_hold');
        expect(existsSync(join(
          snapshotRoot,
          'node_modules',
          '@happier-dev',
          'plugin-sdk',
          'node_modules',
        ))).toBe(false);
        expect(existsSync(join(
          snapshotRoot,
          'node_modules',
          '@happier-dev',
          'plugin-ui',
          'node_modules',
        ))).toBe(false);
        expect(existsSync(join(
          snapshotRoot,
          'node_modules',
          '@happier-dev',
          'protocol',
          'package.json',
        ))).toBe(true);
      },
    });

    await expect(result).resolves.toMatchObject({ tarballName: 'artifact.tgz' });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it.each([
    ['a traversal entry', ['dist', '../outside.md'], { 'dist/index.js': 'export {};\n' }],
    ['a glob entry', ['dist', 'examples/**'], { 'dist/index.js': 'export {};\n' }],
    ['a missing entry', ['dist', 'API.md'], { 'dist/index.js': 'export {};\n' }],
  ])('fails closed before npm pack when a marked preserved inventory has %s', async (_description, files, packageFiles) => {
    const packageName = '@happier-dev/plugin-sdk';
    const { result, spawn } = createArtifactWorkspaceManifestAdmissionAttempt({
      manifests: {
        [packageName]: {
          name: packageName,
          version: '0.2.10',
          files,
          dependencies: {},
          bundledDependencies: [],
          happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
        },
      },
      packageFiles: { [packageName]: packageFiles },
    });

    await expect(result).rejects.toThrow(/unsanitized.*artifact workspace publication/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed before npm pack when a marked closure has no flat physical sibling', async () => {
    const packageName = '@happier-dev/plugin-sdk';
    const { result, spawn } = createArtifactWorkspaceManifestAdmissionAttempt({
      manifests: {
        [packageName]: {
          name: packageName,
          version: '0.2.10',
          dependencies: { '@happier-dev/protocol': '0.0.0' },
          bundledDependencies: ['@happier-dev/protocol'],
          happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
        },
      },
    });

    await expect(result).rejects.toThrow(/unsanitized.*artifact workspace publication/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed before npm pack when a marked internal edge is neither closure nor marked sibling root', async () => {
    const sdkPackageName = '@happier-dev/plugin-sdk';
    const protocolPackageName = '@happier-dev/protocol';
    const cliCommonPackageName = '@happier-dev/cli-common';
    const { result, spawn } = createArtifactWorkspaceManifestAdmissionAttempt({
      manifests: {
        [sdkPackageName]: {
          name: sdkPackageName,
          version: '0.2.10',
          dependencies: {
            [protocolPackageName]: '0.0.0',
            [cliCommonPackageName]: '0.0.0',
          },
          bundledDependencies: [protocolPackageName],
          happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
        },
        [protocolPackageName]: {
          name: protocolPackageName,
          version: '0.2.10',
          dependencies: {},
        },
        [cliCommonPackageName]: {
          name: cliCommonPackageName,
          version: '0.2.10',
          dependencies: {},
        },
      },
    });

    await expect(result).rejects.toThrow(/unsanitized.*artifact workspace publication/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed before npm pack when a marked UI manifest lacks its marked SDK sibling root', async () => {
    const packageName = '@happier-dev/plugin-ui';
    const { result, spawn } = createArtifactWorkspaceManifestAdmissionAttempt({
      manifests: {
        [packageName]: {
          name: packageName,
          version: '0.2.10',
          dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
          bundledDependencies: [],
          happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
        },
      },
    });

    await expect(result).rejects.toThrow(/unsanitized.*artifact workspace publication/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'an unmarked workspace',
      manifest: {
        name: '@happier-dev/plugins-inspector',
        version: '0.2.10',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
        optionalDependencies: { '@happier-dev/protocol': '0.0.0' },
        bundledDependencies: ['@happier-dev/protocol'],
      },
    },
    {
      name: 'a malformed prepublication marker',
      manifest: {
        name: '@happier-dev/plugin-sdk',
        version: '0.2.10',
        dependencies: { '@happier-dev/protocol': '0.0.0' },
        bundledDependencies: ['@happier-dev/protocol'],
        happier: { publicSdkRelease: { posture: 'prepublish-ready' } },
      },
    },
    {
      name: 'a malformed prepublication closure',
      manifest: {
        name: '@happier-dev/plugin-sdk',
        version: '0.2.10',
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
          zod: '4.3.6',
        },
        bundledDependencies: ['@happier-dev/protocol', 'zod'],
        happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
      },
    },
    {
      name: 'a malformed prepublication dependency declaration',
      manifest: {
        name: '@happier-dev/plugin-sdk',
        version: '0.2.10',
        dependencies: { '@happier-dev/protocol': '' },
        bundledDependencies: ['@happier-dev/protocol'],
        happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
      },
    },
  ])('fails closed before npm pack for $name', async ({ manifest }) => {
    const packageName = String(manifest.name);
    const { result, spawn } = createArtifactWorkspaceManifestAdmissionAttempt({
      manifests: { [packageName]: manifest },
    });

    await expect(result).rejects.toThrow(/unsanitized.*artifact workspace publication/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed before npm pack when a declared bundled dependency is missing from the artifact tree', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'package.json'],
      bundledDependencies: ['missing-runtime'],
    })}\n`, 'utf8');
    writeFileSync(join(destDir, tarballName), '', 'utf8');
    const spawn = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: `${tarballName}\n`,
      stderr: '',
    }));

    await expect(packTarball({
      packageRoot,
      destDir,
      bundleWorkspaceDeps: noopBundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    })).rejects.toThrow(/missing.*bundled dependency.*missing-runtime/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed when a non-workspace bundle has no dependency declaration', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const bundledPackageRoot = join(packageRoot, 'node_modules', 'tweetnacl');
    const tarballName = 'artifact.tgz';
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(bundledPackageRoot, { recursive: true });
    writeFileSync(join(bundledPackageRoot, 'package.json'), JSON.stringify({
      name: 'tweetnacl',
      version: '1.0.3',
      main: 'index.js',
    }), 'utf8');
    writeFileSync(join(bundledPackageRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'package.json'],
      bundledDependencies: ['tweetnacl'],
    })}\n`, 'utf8');
    const spawn = vi.fn(() => {
      writeFileSync(join(destDir, tarballName), '', 'utf8');
      return {
        status: 0,
        signal: null,
        stdout: `${tarballName}\n`,
        stderr: '',
      };
    });

    await expect(packTarball({
      packageRoot,
      destDir,
      bundleWorkspaceDeps: noopBundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    })).rejects.toThrow(/missing.*dependency declaration.*tweetnacl/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('localizes a hoisted non-workspace bundled dependency and its production closure', async () => {
    const repoRoot = createTempDirSync('happier-cli-pack-tarball-repo-');
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = join(repoRoot, 'apps', 'cli');
    const hoistedLockRoot = join(repoRoot, 'node_modules', 'proper-lockfile');
    const hoistedGracefulFsRoot = join(repoRoot, 'node_modules', 'graceful-fs');
    const hoistedRetryRoot = join(repoRoot, 'node_modules', 'retry');
    const hoistedRetryHelperRoot = join(repoRoot, 'node_modules', 'retry-helper');
    const hoistedSignalExitRoot = join(repoRoot, 'node_modules', 'signal-exit');
    const tarballName = 'artifact.tgz';
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(hoistedLockRoot, { recursive: true });
    mkdirSync(hoistedGracefulFsRoot, { recursive: true });
    mkdirSync(hoistedRetryRoot, { recursive: true });
    mkdirSync(hoistedRetryHelperRoot, { recursive: true });
    mkdirSync(hoistedSignalExitRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'package.json'],
      dependencies: { 'proper-lockfile': '4.1.2' },
      bundledDependencies: ['proper-lockfile'],
    })}\n`, 'utf8');
    writeFileSync(join(hoistedLockRoot, 'package.json'), `${JSON.stringify({
      name: 'proper-lockfile',
      version: '4.1.2',
      main: 'index.js',
      dependencies: {
        'graceful-fs': '^4.2.4',
        retry: '^0.12.0',
        'signal-exit': '^3.0.2',
      },
    })}\n`, 'utf8');
    writeFileSync(join(hoistedLockRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(join(hoistedGracefulFsRoot, 'package.json'), `${JSON.stringify({
      name: 'graceful-fs',
      version: '4.2.11',
      main: 'index.js',
    })}\n`, 'utf8');
    writeFileSync(join(hoistedGracefulFsRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(join(hoistedRetryRoot, 'package.json'), `${JSON.stringify({
      name: 'retry',
      version: '0.12.0',
      main: 'index.js',
      dependencies: { 'retry-helper': '^1.0.0' },
    })}\n`, 'utf8');
    writeFileSync(join(hoistedRetryRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(join(hoistedRetryHelperRoot, 'package.json'), `${JSON.stringify({
      name: 'retry-helper',
      version: '1.0.0',
      main: 'index.js',
    })}\n`, 'utf8');
    writeFileSync(join(hoistedRetryHelperRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(join(hoistedSignalExitRoot, 'package.json'), `${JSON.stringify({
      name: 'signal-exit',
      version: '3.0.7',
      main: 'index.js',
    })}\n`, 'utf8');
    writeFileSync(join(hoistedSignalExitRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
    const loadCliCommonWorkspacesModule = vi.fn(async () => ({
      bundleInstalledPackageWithRuntimeDependencies:
        canonicalBundleInstalledPackageWithRuntimeDependencies,
    }));
    const spawn = vi.fn((_command: unknown, _args: unknown, options: { cwd: string }) => {
      expect(JSON.parse(readFileSync(
        join(options.cwd, 'node_modules', 'proper-lockfile', 'package.json'),
        'utf8',
      ))).toMatchObject({ name: 'proper-lockfile', version: '4.1.2' });
      expect(JSON.parse(readFileSync(
        join(
          options.cwd,
          'node_modules',
          'proper-lockfile',
          'node_modules',
          'graceful-fs',
          'package.json',
        ),
        'utf8',
      ))).toMatchObject({ name: 'graceful-fs', version: '4.2.11' });
      expect(JSON.parse(readFileSync(
        join(
          options.cwd,
          'node_modules',
          'proper-lockfile',
          'node_modules',
          'retry',
          'package.json',
        ),
        'utf8',
      ))).toMatchObject({ name: 'retry', version: '0.12.0' });
      expect(JSON.parse(readFileSync(
        join(
          options.cwd,
          'node_modules',
          'proper-lockfile',
          'node_modules',
          'retry',
          'node_modules',
          'retry-helper',
          'package.json',
        ),
        'utf8',
      ))).toMatchObject({ name: 'retry-helper', version: '1.0.0' });
      expect(JSON.parse(readFileSync(
        join(
          options.cwd,
          'node_modules',
          'proper-lockfile',
          'node_modules',
          'signal-exit',
          'package.json',
        ),
        'utf8',
      ))).toMatchObject({ name: 'signal-exit', version: '3.0.7' });
      writeFileSync(join(destDir, tarballName), '', 'utf8');
      return { status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' };
    });

    await packTarball({
      packageRoot,
      repoRoot,
      destDir,
      bundleWorkspaceDeps: noopBundleWorkspaceDeps,
      loadCliCommonWorkspacesModuleImpl: loadCliCommonWorkspacesModule,
      spawnSync: spawn,
      env: {},
    });
    expect(loadCliCommonWorkspacesModule).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('accepts an npm alias declaration when the canonical package identity satisfies its target spec', async () => {
    const repoRoot = createTempDirSync('happier-cli-pack-tarball-repo-');
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = join(repoRoot, 'apps', 'cli');
    const aliasPackageRoot = join(repoRoot, 'node_modules', 'string-width-cjs');
    const tarballName = 'artifact.tgz';
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(aliasPackageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'package.json'],
      dependencies: { 'string-width-cjs': 'npm:string-width@^4.2.0' },
      bundledDependencies: ['string-width-cjs'],
    })}\n`, 'utf8');
    writeFileSync(join(aliasPackageRoot, 'package.json'), `${JSON.stringify({
      name: 'string-width',
      version: '4.2.3',
      main: 'index.js',
    })}\n`, 'utf8');
    writeFileSync(join(aliasPackageRoot, 'index.js'), 'module.exports = () => 0;\n', 'utf8');
    const spawn = vi.fn((_command: unknown, _args: unknown, options: { cwd: string }) => {
      expect(JSON.parse(readFileSync(
        join(options.cwd, 'node_modules', 'string-width-cjs', 'package.json'),
        'utf8',
      ))).toMatchObject({ name: 'string-width', version: '4.2.3' });
      writeFileSync(join(destDir, tarballName), '', 'utf8');
      return { status: 0, signal: null, stdout: `${tarballName}\n`, stderr: '' };
    });

    await packTarball({
      packageRoot,
      repoRoot,
      destDir,
      bundleWorkspaceDeps: noopBundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('fails closed when the canonical bundler resolves a package outside the source repository', async () => {
    const repoRoot = createTempDirSync('happier-cli-pack-tarball-repo-');
    const outsideRoot = createTempDirSync('happier-cli-pack-tarball-outside-');
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = join(repoRoot, 'apps', 'cli');
    const bundledPackageRoot = join(repoRoot, 'node_modules', 'proper-lockfile');
    const linkedTransitivePackageRoot = join(repoRoot, 'node_modules', 'retry');
    const tarballName = 'artifact.tgz';
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(bundledPackageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'package.json'],
      dependencies: { 'proper-lockfile': '4.1.2' },
      bundledDependencies: ['proper-lockfile'],
    })}\n`, 'utf8');
    writeFileSync(join(bundledPackageRoot, 'package.json'), `${JSON.stringify({
      name: 'proper-lockfile',
      version: '4.1.2',
      main: 'index.js',
      dependencies: { retry: '^0.12.0' },
    })}\n`, 'utf8');
    writeFileSync(join(bundledPackageRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(join(outsideRoot, 'package.json'), `${JSON.stringify({
      name: 'retry',
      version: '0.12.0',
      main: 'index.js',
    })}\n`, 'utf8');
    writeFileSync(join(outsideRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
    symlinkSync(
      outsideRoot,
      linkedTransitivePackageRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const spawn = vi.fn(() => {
      writeFileSync(join(destDir, tarballName), '', 'utf8');
      return {
        status: 0,
        signal: null,
        stdout: `${tarballName}\n`,
        stderr: '',
      };
    });

    await expect(packTarball({
      packageRoot,
      repoRoot,
      destDir,
      bundleWorkspaceDeps: noopBundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    })).rejects.toThrow(/bundled dependency.*outside.*source repository.*retry/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed when a bundled package contains a dereferenced symlink outside the repository', async () => {
    const repoRoot = createTempDirSync('happier-cli-pack-tarball-repo-');
    const outsideRoot = createTempDirSync('happier-cli-pack-tarball-outside-');
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = join(repoRoot, 'apps', 'cli');
    const bundledPackageRoot = join(repoRoot, 'node_modules', 'proper-lockfile');
    const outsideFile = join(outsideRoot, 'secret.txt');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(bundledPackageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'package.json'],
      dependencies: { 'proper-lockfile': '4.1.2' },
      bundledDependencies: ['proper-lockfile'],
    })}\n`, 'utf8');
    writeFileSync(join(bundledPackageRoot, 'package.json'), `${JSON.stringify({
      name: 'proper-lockfile',
      version: '4.1.2',
      main: 'index.js',
    })}\n`, 'utf8');
    writeFileSync(join(bundledPackageRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(outsideFile, 'must-not-pack\n', 'utf8');
    symlinkSync(outsideFile, join(bundledPackageRoot, 'linked-secret.txt'), 'file');
    const spawn = vi.fn();

    await expect(packTarball({
      packageRoot,
      repoRoot,
      destDir,
      bundleWorkspaceDeps: noopBundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    })).rejects.toThrow(/bundled dependency.*dereferenced symlink target.*escapes copy source root/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed before npm pack when a non-workspace bundled dependency has the wrong package identity', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const bundledPackageRoot = join(packageRoot, 'node_modules', 'tweetnacl');
    const tarballName = 'artifact.tgz';
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(bundledPackageRoot, { recursive: true });
    writeFileSync(join(bundledPackageRoot, 'package.json'), JSON.stringify({
      name: 'not-tweetnacl',
      version: '1.0.3',
    }), 'utf8');
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'package.json'],
      dependencies: { tweetnacl: '^1.0.3' },
      bundledDependencies: ['tweetnacl'],
    })}\n`, 'utf8');
    writeFileSync(join(destDir, tarballName), '', 'utf8');
    const spawn = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: `${tarballName}\n`,
      stderr: '',
    }));

    await expect(packTarball({
      packageRoot,
      destDir,
      bundleWorkspaceDeps: noopBundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    })).rejects.toThrow(/bundled dependency identity.*tweetnacl/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed before npm pack when a non-workspace bundled dependency version violates its declaration', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const bundledPackageRoot = join(packageRoot, 'node_modules', 'tweetnacl');
    const tarballName = 'artifact.tgz';
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(bundledPackageRoot, { recursive: true });
    writeFileSync(join(bundledPackageRoot, 'package.json'), JSON.stringify({
      name: 'tweetnacl',
      version: '2.0.0',
    }), 'utf8');
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'package.json'],
      dependencies: { tweetnacl: '^1.0.3' },
      bundledDependencies: ['tweetnacl'],
    })}\n`, 'utf8');
    writeFileSync(join(destDir, tarballName), '', 'utf8');
    const spawn = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: `${tarballName}\n`,
      stderr: '',
    }));

    await expect(packTarball({
      packageRoot,
      destDir,
      bundleWorkspaceDeps: noopBundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    })).rejects.toThrow(/bundled dependency identity.*tweetnacl.*2\.0\.0.*\^1\.0\.3/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed when artifact bundling omits a declared internal workspace classification', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    const inspectorPackageJsonPath = join(
      packageRoot,
      'node_modules',
      '@happier-dev',
      'plugins-inspector',
      'package.json',
    );
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(join(inspectorPackageJsonPath, '..'), { recursive: true });
    writeFileSync(inspectorPackageJsonPath, JSON.stringify({
      name: '@happier-dev/plugins-inspector',
      version: '0.0.0',
      scripts: { build: 'must-not-copy-live' },
    }), 'utf8');
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'package.json'],
      bundledDependencies: ['@happier-dev/plugins-inspector'],
    })}\n`, 'utf8');
    writeFileSync(join(destDir, tarballName), '', 'utf8');
    const spawn = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: `${tarballName}\n`,
      stderr: '',
    }));

    await expect(packTarball({
      packageRoot,
      destDir,
      bundleWorkspaceDeps: noopBundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    })).rejects.toThrow(/missing.*artifact workspace publication.*plugins-inspector/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a malformed declared bundled dependency before snapshot writes or npm pack', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      files: ['package-dist', 'package-dist/**', 'package.json'],
      bundledDependencies: ['../../escape'],
    })}\n`, 'utf8');
    writeFileSync(join(destDir, tarballName), '', 'utf8');
    const spawn = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: `${tarballName}\n`,
      stderr: '',
    }));

    await expect(packTarball({
      packageRoot,
      destDir,
      bundleWorkspaceDeps: noopBundleWorkspaceDeps,
      spawnSync: spawn,
      env: {},
    })).rejects.toThrow(/invalid.*bundled dependency/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not mask incomplete package-dist filesystem adapters', async () => {
    const destDir = createTempDirSync('happier-cli-pack-tarball-dest-');
    const packageRoot = createTempDirSync('happier-cli-pack-tarball-root-');
    const tarballName = 'artifact.tgz';
    writeFileSync(join(destDir, tarballName), '', 'utf8');

    const spawn = vi.fn(() => ({ status: 0, stdout: `${tarballName}\n`, stderr: '' }));

    await expect(
      packTarball({
        packageRoot,
        destDir,
        spawnSync: spawn,
        existsSync(targetPath) {
          return String(targetPath).endsWith('/dist') || String(targetPath).endsWith(`/${tarballName}`);
        },
        cpSync() {
          return undefined;
        },
        env: {},
      }),
    ).rejects.toThrow(/incomplete filesystem adapter/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
