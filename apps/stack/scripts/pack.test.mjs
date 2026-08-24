import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdtemp, writeFile, mkdir, realpath, rm, readFile, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as packModule from './pack.mjs';
import {
  assertPhysicalPathWithinApprovedRoot,
} from '@happier-dev/cli-common/workspaceRuntimeDependencies';
import {
  analyzeBundledWorkspaceTarList,
  analyzeTarList,
  createPackSandbox,
  exportPackSandboxTarball,
  findMonorepoRoot,
  resolvePackDirForComponent,
  resolvePackSandboxWorkspaceRelDirs,
} from './pack.mjs';
import { runApiGovernance } from '../../../scripts/api-governance/apiGovernance.mjs';

test('public toolchain pack staging derives its required external inputs from one generator-owned selector', async () => {
  const { resolvePublicToolchainRequiredInputStagingRelDirs } = await import(
    '../../../packages/plugin-sdk/scripts/generatePublicToolchainCompatibility.mjs'
  );

  assert.deepEqual(
    resolvePublicToolchainRequiredInputStagingRelDirs(),
    [
      'apps/cli/src/plugins/scaffold',
      'apps/docs/content/docs/plugins/manifest',
      'apps/docs/content/docs/plugins/packaging',
      'packages/tests/pluginSdkConsumers',
      'packages/tests/scripts/plugin-platform',
    ],
  );
});

test('createPackSandbox stages every available capability-matrix proving consumer through its owner selector', async () => {
  const capabilityMatrixCliUrl = new URL(
    '../../../packages/plugin-sdk/scripts/capabilityMatrixCli.mjs',
    import.meta.url,
  );
  const capabilityMatrixPackageRoot = fileURLToPath(new URL('../../../packages/plugin-sdk', import.meta.url));
  const { resolveAvailableCapabilityMatrixProvingConsumerSourcePaths } = await import(capabilityMatrixCliUrl.href);
  const sourcePaths = await resolveAvailableCapabilityMatrixProvingConsumerSourcePaths({
    packageRoot: capabilityMatrixPackageRoot,
  });

  assert.ok(sourcePaths.length > 0, 'the capability matrix must name available public proving consumers');
  const root = await mkdtemp(join(tmpdir(), 'pack-test-capability-matrix-proving-consumers-'));
  let sandboxRoot = '';
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    await mkdir(join(monorepoRoot, 'packages', 'plugin-sdk', 'scripts'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'packages', 'plugin-sdk', 'scripts', 'capabilityMatrixCli.mjs'),
      [
        `import { resolveAvailableCapabilityMatrixProvingConsumerSourcePaths as resolveSourcePaths } from ${JSON.stringify(capabilityMatrixCliUrl.href)};`,
        'export async function resolveAvailableCapabilityMatrixProvingConsumerSourcePaths() {',
        `  return await resolveSourcePaths({ packageRoot: ${JSON.stringify(capabilityMatrixPackageRoot)} });`,
        '}',
        '',
      ].join('\n'),
    );
    for (const sourcePath of sourcePaths) {
      const fixtureSourcePath = join(monorepoRoot, sourcePath);
      await mkdir(dirname(fixtureSourcePath), { recursive: true });
      await writeFile(fixtureSourcePath, 'export const capabilityMatrixProvingConsumer = true;\n');
    }
    await mkdir(join(monorepoRoot, 'packages', 'plugin-ui'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'packages', 'plugin-ui', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugin-ui',
        bundledDependencies: ['@happier-dev/plugin-sdk', '@happier-dev/protocol'],
      }),
    );

    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-ui',
    });

    for (const sourcePath of sourcePaths) {
      const stagedStats = await lstat(join(sandboxRoot, sourcePath)).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      assert.equal(
        stagedStats?.isFile(),
        true,
        `Plugin UI prepack must retain capability-matrix proving consumer source: ${sourcePath}`,
      );
    }
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

async function writeFixtureRuntimeDependencyOwner(monorepoRoot) {
  await writeFile(
    join(
      monorepoRoot,
      'packages',
      'cli-common',
      'workspaceRuntimeDependencies.mjs',
    ),
    `export * from ${JSON.stringify(new URL(
      '../../../packages/cli-common/workspaceRuntimeDependencies.mjs',
      import.meta.url,
    ).href)};\n`,
  );
}

async function createHoistedRuntimePackFixture({
  root,
  symlinkRuntimeOutside = false,
  includeUndeclaredNestedRuntime = false,
  includeSiblingBorrowSymlink = false,
  includeBuildOnlyWorkspace = false,
}) {
  const monorepoRoot = join(root, 'repo');
  for (const relDir of [
    'apps/cli',
    'apps/ui',
    'apps/server',
    'packages/cli-common',
    'packages/plugin-sdk',
    'packages/protocol',
    'scripts/workspaces',
    'scripts/testing/process',
    'node_modules/.bin',
    'node_modules/unapproved-runtime',
  ]) {
    await mkdir(join(monorepoRoot, relDir), { recursive: true });
  }
  await writeFile(join(monorepoRoot, 'package.json'), JSON.stringify({
    name: 'monorepo',
    workspaces: ['apps/*', 'packages/*'],
  }));
  await writeFile(join(monorepoRoot, 'yarn.lock'), '# lock');
  await writeFile(
    join(monorepoRoot, 'apps', 'cli', 'package.json'),
    JSON.stringify({ name: '@happier-dev/cli' }),
  );
  await writeFile(
    join(monorepoRoot, 'apps', 'ui', 'package.json'),
    JSON.stringify({ name: '@happier-dev/app' }),
  );
  await writeFile(
    join(monorepoRoot, 'apps', 'server', 'package.json'),
    JSON.stringify({ name: '@happier-dev/server' }),
  );
  await writeFile(
    join(monorepoRoot, 'packages', 'cli-common', 'package.json'),
    JSON.stringify({ name: '@happier-dev/cli-common' }),
  );
  await writeFixtureRuntimeDependencyOwner(monorepoRoot);
  await writeFile(
    join(monorepoRoot, 'packages', 'plugin-sdk', 'package.json'),
    JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      bundledDependencies: ['@happier-dev/protocol'],
    }),
  );
  await writeFile(
    join(monorepoRoot, 'packages', 'protocol', 'package.json'),
    JSON.stringify({
      name: '@happier-dev/protocol',
      dependencies: {
        '@fixture/runtime': '^1.0.0',
      },
      ...(includeBuildOnlyWorkspace
        ? { devDependencies: { '@happier-dev/testkit': '0.0.0' } }
        : {}),
    }),
  );
  if (includeBuildOnlyWorkspace) {
    // A build-only internal workspace enters the sandbox copy set so prepack scripts can resolve
    // it, and it declares a runtime dependency on an unscoped workspace member that is linked into
    // the root dependency tree (the `privacy-kit` shape).
    await mkdir(join(monorepoRoot, 'packages', 'testkit'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'packages', 'testkit', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/testkit',
        dependencies: {
          'workspace-linked-runtime': '^1.0.0',
        },
      }),
    );
    const workspaceLinkedRuntimeDir = join(monorepoRoot, 'packages', 'workspace-linked-runtime');
    await mkdir(workspaceLinkedRuntimeDir, { recursive: true });
    await writeFile(
      join(workspaceLinkedRuntimeDir, 'package.json'),
      JSON.stringify({ name: 'workspace-linked-runtime', version: '1.0.0' }),
    );
    await writeFile(join(workspaceLinkedRuntimeDir, 'index.js'), 'export const linked = true;\n');
    await symlink(
      join('..', 'packages', 'workspace-linked-runtime'),
      join(monorepoRoot, 'node_modules', 'workspace-linked-runtime'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  await writeFile(join(monorepoRoot, 'scripts', 'workspaces', 'placeholder.mjs'), '');
  await writeFile(join(monorepoRoot, 'scripts', 'testing', 'process', 'placeholder.mjs'), '');
  await writeFile(
    join(monorepoRoot, 'node_modules', 'unapproved-runtime', 'package.json'),
    JSON.stringify({ name: 'unapproved-runtime', version: '1.0.0' }),
  );

  const runtimePackageDir = symlinkRuntimeOutside
    ? join(root, 'outside-runtime')
    : join(monorepoRoot, 'node_modules', '@fixture', 'runtime');
  await mkdir(runtimePackageDir, { recursive: true });
  await writeFile(
    join(runtimePackageDir, 'package.json'),
    JSON.stringify({
      name: '@fixture/runtime',
      version: '1.0.0',
      dependencies: {
        'runtime-transitive': '^2.0.0',
      },
    }),
  );
  await writeFile(join(runtimePackageDir, 'index.js'), 'export const runtime = true;\n');
  if (includeUndeclaredNestedRuntime) {
    const undeclaredNestedRuntimeDir = join(
      runtimePackageDir,
      'node_modules',
      'undeclared-nested-runtime',
    );
    await mkdir(undeclaredNestedRuntimeDir, { recursive: true });
    await writeFile(
      join(undeclaredNestedRuntimeDir, 'package.json'),
      JSON.stringify({
        name: 'undeclared-nested-runtime',
        version: '1.0.0',
      }),
    );
    await writeFile(
      join(undeclaredNestedRuntimeDir, 'secret.js'),
      'export const leaked = true;\n',
    );
    await symlink(
      'node_modules/undeclared-nested-runtime/secret.js',
      join(runtimePackageDir, 'borrowed-nested.js'),
      'file',
    );
  }
  if (includeSiblingBorrowSymlink) {
    const undeclaredSiblingDir = join(
      monorepoRoot,
      'node_modules',
      '@fixture',
      'undeclared-sibling-runtime',
    );
    await mkdir(undeclaredSiblingDir, { recursive: true });
    await writeFile(
      join(undeclaredSiblingDir, 'secret.js'),
      'export const leaked = true;\n',
    );
    await symlink(
      '../undeclared-sibling-runtime/secret.js',
      join(runtimePackageDir, 'borrowed.js'),
      'file',
    );
  }
  if (symlinkRuntimeOutside) {
    await mkdir(join(monorepoRoot, 'node_modules', '@fixture'), { recursive: true });
    await symlink(
      runtimePackageDir,
      join(monorepoRoot, 'node_modules', '@fixture', 'runtime'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  await mkdir(
    join(monorepoRoot, 'node_modules', 'runtime-transitive'),
    { recursive: true },
  );
  await writeFile(
    join(monorepoRoot, 'node_modules', 'runtime-transitive', 'package.json'),
    JSON.stringify({
      name: 'runtime-transitive',
      version: '2.0.0',
    }),
  );
  await writeFile(
    join(monorepoRoot, 'node_modules', 'runtime-transitive', 'index.js'),
    'export const transitive = true;\n',
  );
  return monorepoRoot;
}

test('exportPackSandboxTarball persists exact validated bytes and returns path-free bounded metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-export-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'packages', 'plugin-sdk');
  const destinationDir = join(root, 'destination');
  const tarballName = 'happier-dev-plugin-sdk-0.0.0.tgz';
  const tarballBytes = Buffer.from('exact-packed-bytes');
  const inheritedLease = 'lease-value-without-path-exposure';
  const calls = [];
  try {
    await mkdir(sandboxPackDir, { recursive: true });
    await mkdir(destinationDir);
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
    }));

    const metadata = await exportPackSandboxTarball({
      monorepoRoot: join(root, 'workspace-must-not-leak'),
      packageRelDir: 'packages/plugin-sdk',
      destinationDir,
      env: {
        HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: inheritedLease,
      },
      createPackSandboxImpl: async () => sandboxRoot,
      runCaptureImpl: async (command, args, options) => {
        calls.push({ command, args, options });
        if (command === 'npm' && args.includes('--dry-run')) return 'dry-run output';
        if (command === 'npm') {
          await writeFile(join(sandboxPackDir, tarballName), tarballBytes);
          return `npm notice\n${tarballName}\n`;
        }
        if (command === 'tar') {
          return [
            'package/package.json',
            'package/dist/index.js',
          ].join('\n');
        }
        throw new Error(`unexpected command: ${command}`);
      },
    });

    assert.deepEqual(await readFile(join(destinationDir, tarballName)), tarballBytes);
    assert.equal(existsSync(sandboxRoot), false);
    assert.equal(
      calls
        .filter((call) => call.command === 'npm')
        .every((call) => (
          call.options.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD === inheritedLease
        )),
      true,
    );
    assert.deepEqual(metadata, {
      ok: true,
      package: {
        name: '@happier-dev/plugin-sdk',
        version: '0.0.0',
      },
      tarball: {
        name: tarballName,
        sizeBytes: tarballBytes.length,
      },
      bundled: {
        agents: false,
        cliCommon: false,
        protocol: false,
      },
      bundledWorkspaces: {
        ok: true,
        present: {},
        missing: [],
      },
      enforcement: {
        bundledDeps: false,
      },
      dryRun: {
        ok: true,
      },
    });
    const serialized = JSON.stringify(metadata);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes(sandboxRoot), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball applies an explicit qualified version only inside the pack sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-version-override-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'apps', 'cli');
  const sourceRoot = join(root, 'source');
  const sourcePackageJsonPath = join(sourceRoot, 'apps', 'cli', 'package.json');
  const destinationDir = join(root, 'destination');
  const sourceVersion = '0.2.10';
  const candidateVersion = '0.2.10-dev.1770000000.42';
  const tarballName = `happier-dev-cli-${candidateVersion}.tgz`;
  try {
    await mkdir(sandboxPackDir, { recursive: true });
    await mkdir(dirname(sourcePackageJsonPath), { recursive: true });
    await mkdir(destinationDir);
    await writeFile(sourcePackageJsonPath, JSON.stringify({
      name: '@happier-dev/cli',
      version: sourceVersion,
    }));
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: sourceVersion,
    }));

    const metadata = await exportPackSandboxTarball({
      monorepoRoot: sourceRoot,
      packageRelDir: 'apps/cli',
      destinationDir,
      packageVersion: candidateVersion,
      createPackSandboxImpl: async () => sandboxRoot,
      runCaptureImpl: async (command, args) => {
        if (command === 'npm') {
          const packedManifest = JSON.parse(
            await readFile(join(sandboxPackDir, 'package.json'), 'utf8'),
          );
          assert.equal(packedManifest.version, candidateVersion);
          if (args.includes('--dry-run')) return 'dry-run';
          await writeFile(join(sandboxPackDir, tarballName), 'qualified-candidate');
          return tarballName;
        }
        if (command === 'tar') return 'package/package.json\n';
        throw new Error(`unexpected command: ${command}`);
      },
    });

    assert.equal(metadata.package.version, candidateVersion);
    assert.equal(metadata.tarball.name, tarballName);
    assert.equal(
      JSON.parse(await readFile(sourcePackageJsonPath, 'utf8')).version,
      sourceVersion,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball transforms and validates a public SDK tarball only inside its sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-public-sdk-publication-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'packages', 'plugin-ui');
  const sandboxPluginSdkDir = join(sandboxRoot, 'packages', 'plugin-sdk');
  const sourceRoot = join(root, 'source');
  const sourcePackageJsonPath = join(sourceRoot, 'packages', 'plugin-ui', 'package.json');
  const destinationDir = join(root, 'destination');
  const candidateVersion = '0.1.0-preview.7';
  const tarballName = `happier-dev-plugin-ui-${candidateVersion}.tgz`;
  try {
    await mkdir(sandboxPackDir, { recursive: true });
    await mkdir(sandboxPluginSdkDir, { recursive: true });
    await mkdir(dirname(sourcePackageJsonPath), { recursive: true });
    await mkdir(destinationDir);
    const sourceManifest = {
      name: '@happier-dev/plugin-ui',
      version: '0.0.0',
      private: true,
      happier: {
        publicSdkRelease: {
          posture: 'prepublish_hold',
          supportPolicy: 'README.md#plugin-ui-release-posture',
          externalPublicationRequiresApproval: true,
        },
      },
      dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      peerDependencies: { react: '19.2.0' },
    };
    await writeFile(sourcePackageJsonPath, JSON.stringify(sourceManifest));
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify(sourceManifest));
    await writeFile(
      join(sandboxPluginSdkDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/plugin-sdk', version: '0.0.0' }),
    );
    await writeFile(join(sandboxPackDir, 'release-contract.test.mjs'), 'export {}\n');

    const metadata = await exportPackSandboxTarball({
      monorepoRoot: sourceRoot,
      packageRelDir: 'packages/plugin-ui',
      destinationDir,
      packageVersion: candidateVersion,
      publication: {
        expectedPackageName: '@happier-dev/plugin-ui',
        dependencyVersions: { '@happier-dev/plugin-sdk': candidateVersion },
        requiredFiles: ['API.md', 'api-declarations.md'],
        expectedPeerDependencies: { react: '19.2.0' },
      },
      createPackSandboxImpl: async () => sandboxRoot,
      runCaptureImpl: async (command, args) => {
        if (command === 'npm') {
          const packedManifest = JSON.parse(await readFile(join(sandboxPackDir, 'package.json'), 'utf8'));
          assert.equal(packedManifest.version, candidateVersion);
          assert.equal(packedManifest.private, undefined);
          assert.deepEqual(packedManifest.happier, {
            publicSdkRelease: {
              posture: 'developer_preview',
              supportPolicy: 'README.md#plugin-ui-release-posture',
              externalPublicationRequiresApproval: true,
            },
          });
          assert.equal(packedManifest.publishConfig.access, 'public');
          assert.equal(packedManifest.dependencies['@happier-dev/plugin-sdk'], candidateVersion);
          assert.equal(existsSync(join(sandboxPackDir, 'release-contract.test.mjs')), false);
          if (args.includes('--dry-run')) return 'dry-run';
          await writeFile(join(sandboxPackDir, tarballName), 'public-candidate');
          return tarballName;
        }
        if (command === 'tar' && args[0] === '-tf') {
          return [
            'package/package.json',
            'package/dist/index.js',
            'package/API.md',
            'package/api-declarations.md',
          ].join('\n');
        }
        if (command === 'tar' && args[0] === '-xOf') {
          return JSON.stringify({
            name: '@happier-dev/plugin-ui',
            version: candidateVersion,
            happier: {
              publicSdkRelease: {
                posture: 'developer_preview',
                supportPolicy: 'README.md#plugin-ui-release-posture',
                externalPublicationRequiresApproval: true,
              },
            },
            publishConfig: { access: 'public' },
            dependencies: { '@happier-dev/plugin-sdk': candidateVersion },
            peerDependencies: { react: '19.2.0' },
          });
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    });

    assert.equal(metadata.package.version, candidateVersion);
    assert.deepEqual(metadata.publication, {
      name: '@happier-dev/plugin-ui',
      version: candidateVersion,
      publicAccess: true,
      testFilesExcluded: true,
    });
    assert.deepEqual(JSON.parse(await readFile(sourcePackageJsonPath, 'utf8')), sourceManifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball aligns the staged Plugin SDK manifest before Plugin UI candidate preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-plugin-ui-candidate-alignment-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'packages', 'plugin-ui');
  const sandboxPluginSdkDir = join(sandboxRoot, 'packages', 'plugin-sdk');
  const sourceRoot = join(root, 'source');
  const destinationDir = join(root, 'destination');
  const candidateVersion = '0.1.0-preview.10';
  const tarballName = `happier-dev-plugin-ui-${candidateVersion}.tgz`;
  const candidateProjectionPath = join(
    sandboxPluginSdkDir,
    'src',
    'ui',
    'build',
    'publicToolchainCompatibility.generated.ts',
  );
  const phases = [];
  const pluginUiManifest = {
    name: '@happier-dev/plugin-ui',
    version: '0.0.0',
    private: true,
    happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
    dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
  };
  const pluginSdkManifest = {
    name: '@happier-dev/plugin-sdk',
    version: '0.0.0',
  };
  try {
    await mkdir(sandboxPackDir, { recursive: true });
    await mkdir(sandboxPluginSdkDir, { recursive: true });
    await mkdir(join(sourceRoot, 'packages', 'plugin-ui'), { recursive: true });
    await mkdir(join(sourceRoot, 'packages', 'plugin-sdk'), { recursive: true });
    await mkdir(destinationDir);
    await writeFile(
      join(sourceRoot, 'packages', 'plugin-ui', 'package.json'),
      JSON.stringify(pluginUiManifest),
    );
    await writeFile(
      join(sourceRoot, 'packages', 'plugin-sdk', 'package.json'),
      JSON.stringify(pluginSdkManifest),
    );
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify(pluginUiManifest));
    await writeFile(join(sandboxPluginSdkDir, 'package.json'), JSON.stringify(pluginSdkManifest));

    await exportPackSandboxTarball({
      monorepoRoot: sourceRoot,
      packageRelDir: 'packages/plugin-ui',
      destinationDir,
      packageVersion: candidateVersion,
      publication: {
        expectedPackageName: '@happier-dev/plugin-ui',
        dependencyVersions: { '@happier-dev/plugin-sdk': candidateVersion },
        requiredFiles: ['API.md', 'api-declarations.md', 'api-surface.json'],
        apiGovernance: { profileId: 'plugin-ui' },
      },
      createPackSandboxImpl: async () => sandboxRoot,
      validatePublicationApiGovernanceImpl: async () => ({ status: 'current' }),
      preparePublicationApiGovernanceImpl: async () => {
        await writeFile(join(sandboxPackDir, 'API.md'), '# generated\n');
        await writeFile(join(sandboxPackDir, 'api-declarations.md'), '# declarations\n');
        await writeFile(join(sandboxPackDir, 'api-surface.json'), '{"symbols":[]}\n');
        return {
          summary: {
            status: 'dormant_pre_baseline',
            previousVersion: null,
            removedSymbolsAreBreaking: false,
            humanReviewRequired: false,
          },
        };
      },
      runCaptureImpl: async (command, args, options) => {
        if (command === process.execPath) {
          assert.deepEqual(args, ['./scripts/generatePublicToolchainCompatibility.mjs', '--write']);
          assert.equal(options.cwd, sandboxPluginSdkDir);
          const stagedPluginSdkManifest = JSON.parse(
            await readFile(join(sandboxPluginSdkDir, 'package.json'), 'utf8'),
          );
          assert.equal(stagedPluginSdkManifest.version, candidateVersion);
          await mkdir(dirname(candidateProjectionPath), { recursive: true });
          await writeFile(candidateProjectionPath, 'export const candidateProjection = true;\n');
          phases.push('candidate-projection');
          return '';
        }
        if (command === 'npm' && args[0] === 'run') {
          assert.deepEqual(
            phases,
            ['candidate-projection'],
            'candidate projection must be refreshed before Plugin UI prepared-check',
          );
          assert.equal(existsSync(candidateProjectionPath), true);
          const preparedPluginUiManifest = JSON.parse(
            await readFile(join(sandboxPackDir, 'package.json'), 'utf8'),
          );
          const preparedPluginSdkManifest = JSON.parse(
            await readFile(join(sandboxPluginSdkDir, 'package.json'), 'utf8'),
          );
          assert.equal(preparedPluginUiManifest.version, candidateVersion);
          assert.equal(
            preparedPluginUiManifest.dependencies['@happier-dev/plugin-sdk'],
            candidateVersion,
          );
          assert.equal(
            preparedPluginSdkManifest.version,
            candidateVersion,
            'Plugin UI preparation must observe the same staged Plugin SDK candidate version',
          );
          phases.push('candidate-prepared');
          return '';
        }
        if (command === 'npm') {
          if (args.includes('--dry-run')) return 'dry-run';
          await writeFile(join(sandboxPackDir, tarballName), 'candidate');
          return tarballName;
        }
        if (command === 'tar' && args[0] === '-tf') {
          return [
            'package/package.json',
            'package/API.md',
            'package/api-declarations.md',
            'package/api-surface.json',
          ].join('\n');
        }
        if (command === 'tar' && args[0] === '-xOf') {
          return JSON.stringify({
            name: '@happier-dev/plugin-ui',
            version: candidateVersion,
            happier: { publicSdkRelease: { posture: 'developer_preview' } },
            publishConfig: { access: 'public' },
            dependencies: { '@happier-dev/plugin-sdk': candidateVersion },
          });
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    });

    assert.deepEqual(
      JSON.parse(await readFile(join(sourceRoot, 'packages', 'plugin-ui', 'package.json'), 'utf8')),
      pluginUiManifest,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(sourceRoot, 'packages', 'plugin-sdk', 'package.json'), 'utf8')),
      pluginSdkManifest,
    );
    assert.deepEqual(phases, ['candidate-projection', 'candidate-prepared']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball requires canonical Developer Preview metadata for a public SDK package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-public-sdk-preview-metadata-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'packages', 'plugin-ui');
  const destinationDir = join(root, 'destination');
  try {
    await mkdir(sandboxPackDir, { recursive: true });
    await mkdir(destinationDir);
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-ui',
      version: '0.0.0',
      private: true,
    }));

    await assert.rejects(
      () => exportPackSandboxTarball({
        monorepoRoot: root,
        packageRelDir: 'packages/plugin-ui',
        destinationDir,
        packageVersion: '0.1.0-preview.9',
        publication: {
          expectedPackageName: '@happier-dev/plugin-ui',
          requiredFiles: ['API.md'],
        },
        createPackSandboxImpl: async () => sandboxRoot,
        runCaptureImpl: async () => {
          throw new Error('npm pack must not run without Developer Preview metadata');
        },
      }),
      /canonical Developer Preview metadata/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball runs public API governance against the transformed sandbox candidate before packing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-public-api-governance-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'packages', 'plugin-ui');
  const sourceRoot = join(root, 'source');
  const destinationDir = join(root, 'destination');
  const candidateVersion = '0.1.0-preview.8';
  const tarballName = `happier-dev-plugin-ui-${candidateVersion}.tgz`;
  const calls = [];
  const phases = [];
  try {
    await mkdir(sandboxPackDir, { recursive: true });
    await mkdir(destinationDir);
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-ui',
      version: '0.0.0',
      private: true,
      happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
    }));

    const metadata = await exportPackSandboxTarball({
      monorepoRoot: sourceRoot,
      packageRelDir: 'packages/plugin-ui',
      destinationDir,
      packageVersion: candidateVersion,
      publication: {
        expectedPackageName: '@happier-dev/plugin-ui',
        requiredFiles: ['API.md', 'api-declarations.md', 'api-surface.json'],
        apiGovernance: { profileId: 'plugin-ui' },
      },
      createPackSandboxImpl: async () => sandboxRoot,
      validatePublicationApiGovernanceImpl: async () => ({ status: 'current' }),
      preparePublicationApiGovernanceImpl: async (input) => {
        assert.equal(phases.at(-1), 'candidate-prepared');
        phases.push('governance');
        calls.push(input);
        const transformed = JSON.parse(await readFile(join(sandboxPackDir, 'package.json'), 'utf8'));
        assert.equal(transformed.version, candidateVersion);
        assert.equal(transformed.private, undefined);
        assert.equal(transformed.happier.publicSdkRelease.posture, 'developer_preview');
        assert.equal(transformed.publishConfig.access, 'public');
        await writeFile(join(sandboxPackDir, 'API.md'), '# generated\n');
        await writeFile(join(sandboxPackDir, 'api-declarations.md'), '# declarations\n');
        await writeFile(join(sandboxPackDir, 'api-surface.json'), '{"symbols":[]}\n');
        return {
          summary: {
            status: 'dormant_pre_baseline',
            previousVersion: null,
            removedSymbolsAreBreaking: false,
            humanReviewRequired: false,
          },
          log: '[pipeline] public API comparison: dormant pre-baseline\n',
        };
      },
      runCaptureImpl: async (command, args) => {
        if (command === 'npm') {
          if (args[0] === 'run') {
            assert.deepEqual(args, ['run', '--silent', 'prepare:api-governance']);
            phases.push('candidate-prepared');
            return '';
          }
          assert.equal(calls.length, 1, 'governance must finish before npm pack observes the sandbox');
          assert.equal(phases.at(-1), 'governance');
          assert.equal(args.includes('--ignore-scripts'), true, 'packing must not rebuild the prepared candidate');
          if (args.includes('--dry-run')) return 'dry-run';
          await writeFile(join(sandboxPackDir, tarballName), 'candidate');
          return tarballName;
        }
        if (command === 'tar' && args[0] === '-tf') {
          return [
            'package/package.json',
            'package/API.md',
            'package/api-declarations.md',
            'package/api-surface.json',
          ].join('\n');
        }
        if (command === 'tar' && args[0] === '-xOf') {
          return JSON.stringify({
            name: '@happier-dev/plugin-ui',
            version: candidateVersion,
            happier: { publicSdkRelease: { posture: 'developer_preview' } },
            publishConfig: { access: 'public' },
          });
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    });

    assert.deepEqual(calls, [{
      profileId: 'plugin-ui',
      packageName: '@happier-dev/plugin-ui',
      packageRoot: sandboxPackDir,
      candidateVersion,
      repositoryRoot: sourceRoot,
      env: process.env,
    }]);
    assert.deepEqual(phases, ['candidate-prepared', 'governance']);
    assert.deepEqual(metadata.publication.apiGovernance, {
      status: 'dormant_pre_baseline',
      previousVersion: null,
      removedSymbolsAreBreaking: false,
      humanReviewRequired: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball rejects API declaration drift introduced only in the exact final tarball', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-final-api-governance-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'packages', 'plugin-ui');
  const destinationDir = join(root, 'destination');
  const archiveRoot = join(root, 'archive');
  const archivePackageDir = join(archiveRoot, 'package');
  const candidateVersion = '0.1.0-preview.12';
  const tarballName = `happier-dev-plugin-ui-${candidateVersion}.tgz`;
  const tarballPath = join(sandboxPackDir, tarballName);
  const runTar = (args, options = {}) => {
    const result = spawnSync('tar', args, {
      cwd: options.cwd,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || `tar exited ${result.status}`);
    }
    return result.stdout;
  };
  try {
    await mkdir(join(sandboxPackDir, 'dist'), { recursive: true });
    await mkdir(destinationDir);
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-ui',
      version: '0.0.0',
      private: true,
      type: 'module',
      happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
    }));
    await writeFile(
      join(sandboxPackDir, 'dist', 'index.d.ts'),
      'export interface Candidate { value: string; }\n',
    );
    await writeFile(join(sandboxPackDir, 'dist', 'index.js'), 'export {};\n');

    await assert.rejects(
      () => exportPackSandboxTarball({
        monorepoRoot: root,
        packageRelDir: 'packages/plugin-ui',
        destinationDir,
        packageVersion: candidateVersion,
        publication: {
          expectedPackageName: '@happier-dev/plugin-ui',
          requiredFiles: ['API.md', 'api-declarations.md', 'api-surface.json'],
          apiGovernance: { profileId: 'plugin-ui' },
        },
        createPackSandboxImpl: async () => sandboxRoot,
        preparePublicationApiGovernanceImpl: async () => {
          const report = await runApiGovernance({
            profileId: 'plugin-ui',
            packageRoot: sandboxPackDir,
            packageRootKind: 'source-complete-publication-sandbox',
            write: true,
          });
          return {
            summary: {
              status: report.status,
              previousVersion: null,
              removedSymbolsAreBreaking: false,
              humanReviewRequired: false,
            },
          };
        },
        runCaptureImpl: async (command, args, options) => {
          if (command === 'npm' && args[0] === 'run') return '';
          if (command === 'npm' && args.includes('--dry-run')) return 'dry-run';
          if (command === 'npm') {
            await writeFile(
              join(sandboxPackDir, 'dist', 'index.d.ts'),
              'export interface Candidate { value: number; }\n',
            );
            await mkdir(archivePackageDir, { recursive: true });
            for (const relativePath of [
              'package.json',
              'API.md',
              'api-declarations.md',
              'api-surface.json',
              'dist',
            ]) {
              await cp(join(sandboxPackDir, relativePath), join(archivePackageDir, relativePath), {
                recursive: true,
              });
            }
            runTar(['-czf', tarballPath, '-C', archiveRoot, 'package']);
            return tarballName;
          }
          if (command === 'tar') return runTar(args, options);
          throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        },
      }),
      /exact final tarball API governance.*drift/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball runs the declared public candidate lifecycle before governance and ignored-script packing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-public-sdk-prepack-lifecycle-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'packages', 'sdk');
  const destinationDir = join(root, 'destination');
  const candidateVersion = '0.1.0-preview.11';
  const tarballName = `happier-dev-sdk-${candidateVersion}.tgz`;
  const phases = [];
  try {
    await mkdir(sandboxPackDir, { recursive: true });
    await mkdir(destinationDir);
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/sdk',
      version: '0.0.0',
      private: true,
      happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
      bundledDependencies: ['@happier-dev/protocol'],
      dependencies: { '@happier-dev/protocol': '0.0.0' },
    }));

    await exportPackSandboxTarball({
      monorepoRoot: root,
      packageRelDir: 'packages/sdk',
      destinationDir,
      packageVersion: candidateVersion,
      publication: {
        expectedPackageName: '@happier-dev/sdk',
        requiredFiles: ['API.md', 'api-declarations.md', 'api-surface.json'],
        apiGovernance: { profileId: 'sdk', candidatePreparation: 'prepack' },
      },
      createPackSandboxImpl: async () => sandboxRoot,
      validatePublicationApiGovernanceImpl: async () => ({ status: 'current' }),
      preparePublicationApiGovernanceImpl: async () => {
        assert.deepEqual(phases, ['prepack']);
        phases.push('governance');
        await writeFile(join(sandboxPackDir, 'API.md'), '# generated\n');
        await writeFile(join(sandboxPackDir, 'api-declarations.md'), '# declarations\n');
        await writeFile(join(sandboxPackDir, 'api-surface.json'), '{"symbols":[]}\n');
        return {
          summary: {
            status: 'dormant_pre_baseline',
            previousVersion: null,
            removedSymbolsAreBreaking: false,
            humanReviewRequired: false,
          },
        };
      },
      runCaptureImpl: async (command, args) => {
        if (command === 'npm' && args[0] === 'run') {
          assert.deepEqual(
            args,
            ['run', '--silent', 'prepack'],
            'the SDK publication config must select its canonical artifact lifecycle',
          );
          phases.push('prepack');
          return '';
        }
        if (command === 'npm') {
          assert.deepEqual(phases, ['prepack', 'governance']);
          assert.equal(args.includes('--ignore-scripts'), true, 'packing must not rerun the lifecycle');
          if (args.includes('--dry-run')) return 'dry-run';
          await writeFile(join(sandboxPackDir, tarballName), 'candidate');
          return tarballName;
        }
        if (command === 'tar' && args[0] === '-tf') {
          return [
            'package/package.json',
            'package/API.md',
            'package/api-declarations.md',
            'package/api-surface.json',
            'package/node_modules/@happier-dev/protocol/package.json',
          ].join('\n');
        }
        if (command === 'tar' && args[0] === '-xOf') {
          return JSON.stringify({
            name: '@happier-dev/sdk',
            version: candidateVersion,
            happier: { publicSdkRelease: { posture: 'developer_preview' } },
            publishConfig: { access: 'public' },
            dependencies: { '@happier-dev/protocol': '0.0.0' },
          });
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    });

    assert.deepEqual(phases, ['prepack', 'governance']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball removes declaration-test inputs before candidate preparation and rejects emitted survivors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-declaration-test-artifacts-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'packages', 'plugin-ui');
  const destinationDir = join(root, 'destination');
  const candidateVersion = '0.1.0-preview.8';
  const tarballName = `happier-dev-plugin-ui-${candidateVersion}.tgz`;
  const declarationTestFiles = [
    'src/direct.test-d.ts',
    'src/direct.test-d.tsx',
    'dist/direct.test-d.js',
    'dist/direct.test-d.d.ts',
    'dist/direct.test-d.js.map',
    'dist/direct.test-d.d.ts.map',
    'node_modules/@happier-dev/protocol/dist/transitive.contract.test-d.js',
  ];
  const postPreparationTestFile = 'node_modules/@happier-dev/protocol/dist/post-preparation.contract.test-d.js';
  try {
    await mkdir(sandboxPackDir, { recursive: true });
    await mkdir(destinationDir);
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-ui',
      version: '0.0.0',
      private: true,
      happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
    }));
    for (const relativePath of declarationTestFiles) {
      const filePath = join(sandboxPackDir, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, 'declaration-test artifact\n');
    }

    await assert.rejects(
      () => exportPackSandboxTarball({
        monorepoRoot: root,
        packageRelDir: 'packages/plugin-ui',
        destinationDir,
        packageVersion: candidateVersion,
        publication: {
          expectedPackageName: '@happier-dev/plugin-ui',
          requiredFiles: ['API.md'],
          apiGovernance: { profileId: 'plugin-ui' },
        },
        createPackSandboxImpl: async () => sandboxRoot,
        validatePublicationApiGovernanceImpl: async () => ({ status: 'current' }),
        preparePublicationApiGovernanceImpl: async () => ({
          summary: {
            status: 'dormant_pre_baseline',
            previousVersion: null,
            removedSymbolsAreBreaking: false,
            humanReviewRequired: false,
          },
        }),
        runCaptureImpl: async (command, args) => {
          if (command === 'npm') {
            if (args[0] === 'run') {
              for (const relativePath of declarationTestFiles) {
                assert.equal(
                  existsSync(join(sandboxPackDir, relativePath)),
                  false,
                  `declaration-test input must be removed before candidate preparation: ${relativePath}`,
                );
              }
              const postPreparationTestPath = join(sandboxPackDir, postPreparationTestFile);
              await mkdir(dirname(postPreparationTestPath), { recursive: true });
              await writeFile(postPreparationTestPath, 'declaration-test artifact emitted by preparation\n');
              return '';
            }
            assert.equal(
              existsSync(join(sandboxPackDir, postPreparationTestFile)),
              false,
              'declaration-test output must be removed after candidate preparation',
            );
            if (args.includes('--dry-run')) return 'dry-run';
            await writeFile(join(sandboxPackDir, tarballName), 'candidate');
            return tarballName;
          }
          if (command === 'tar' && args[0] === '-tf') {
            return [
              'package/package.json',
              'package/API.md',
              'package/dist/reintroduced.test-d.d.ts.map',
            ].join('\n');
          }
          throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        },
      }),
      /public tarball must not include test file: package\/dist\/reintroduced\.test-d\.d\.ts\.map/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball materializes plugin-sdk governance in a source-complete publication sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-plugin-sdk-publication-governance-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'packages', 'plugin-sdk');
  const destinationDir = join(root, 'destination');
  const candidateVersion = '0.1.0-preview.9';
  const tarballName = `happier-dev-plugin-sdk-${candidateVersion}.tgz`;
  const monorepoRoot = await findMonorepoRoot(dirname(fileURLToPath(import.meta.url)));
  try {
    await mkdir(join(sandboxPackDir, 'scripts'), { recursive: true });
    await mkdir(destinationDir);
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      private: true,
      type: 'module',
      happier: { publicSdkRelease: { posture: 'prepublish_hold' } },
    }));
    await writeFile(
      join(sandboxPackDir, 'scripts', 'apiSurfaceCli.mjs'),
      [
        "import { writeFile } from 'node:fs/promises';",
        "import { join } from 'node:path';",
        'export async function runApiSurfaceCli(options) {',
        "  if (!options.write) throw new Error('publication governance must write candidate records');",
        "  await writeFile(join(options.packageRoot, 'API.md'), '# Plugin SDK API\\n');",
        "  await writeFile(join(options.packageRoot, 'api-declarations.md'), '# Plugin SDK declarations\\n');",
        '  await writeFile(join(options.packageRoot, \'api-surface.json\'), `${JSON.stringify({',
        '    schemaVersion: 1,',
        "    packageName: '@happier-dev/plugin-sdk',",
        '    entrypoints: [],',
        '    symbols: [],',
        '  }, null, 2)}\\n`);',
        "  await writeFile(join(options.packageRoot, 'capability-matrix.json'), '{}\\n');",
        '  return {',
        "    mode: 'write',",
        "    status: 'current',",
        '    summary: { plannedFiles: 4, changedFiles: 4, writtenFiles: 4 },',
        '    files: [],',
        '  };',
        '}',
        '',
      ].join('\n'),
    );

    const metadata = await exportPackSandboxTarball({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
      destinationDir,
      packageVersion: candidateVersion,
      publication: {
        expectedPackageName: '@happier-dev/plugin-sdk',
        requiredFiles: [
          'API.md',
          'api-declarations.md',
          'api-surface.json',
          'capability-matrix.json',
        ],
        apiGovernance: { profileId: 'plugin-sdk' },
      },
      createPackSandboxImpl: async () => sandboxRoot,
      validatePublicationApiGovernanceImpl: async () => ({ status: 'current' }),
      runCaptureImpl: async (command, args) => {
        if (command === 'npm') {
          if (args[0] === 'run') {
            assert.deepEqual(args, ['run', '--silent', 'prepare:api-governance']);
            return '';
          }
          const inventory = JSON.parse(await readFile(join(sandboxPackDir, 'api-surface.json'), 'utf8'));
          assert.equal(inventory.packageName, '@happier-dev/plugin-sdk');
          assert.equal(args.includes('--ignore-scripts'), true);
          if (args.includes('--dry-run')) return 'dry-run';
          await writeFile(join(sandboxPackDir, tarballName), 'candidate');
          return tarballName;
        }
        if (command === 'tar' && args[0] === '-tf') {
          return [
            'package/package.json',
            'package/API.md',
            'package/api-declarations.md',
            'package/api-surface.json',
            'package/capability-matrix.json',
          ].join('\n');
        }
        if (command === 'tar' && args[0] === '-xOf') {
          return JSON.stringify({
            name: '@happier-dev/plugin-sdk',
            version: candidateVersion,
            happier: { publicSdkRelease: { posture: 'developer_preview' } },
            publishConfig: { access: 'public' },
          });
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    });

    assert.deepEqual(metadata.publication.apiGovernance, {
      status: 'dormant_pre_baseline',
      previousVersion: null,
      removedSymbolsAreBreaking: false,
      humanReviewRequired: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball rejects symlink destinations before sandbox allocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-export-symlink-'));
  const realDestinationDir = join(root, 'real-destination');
  const symlinkDestinationDir = join(root, 'symlink-destination');
  let allocated = false;
  try {
    await mkdir(realDestinationDir);
    await symlink(
      realDestinationDir,
      symlinkDestinationDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      exportPackSandboxTarball({
        monorepoRoot: root,
        packageRelDir: 'packages/plugin-sdk',
        destinationDir: symlinkDestinationDir,
        createPackSandboxImpl: async () => {
          allocated = true;
          return join(root, 'sandbox');
        },
      }),
      /destination directory must not resolve through a symbolic link/i,
    );
    assert.equal(allocated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball never overwrites an existing destination and cleans only its sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-export-existing-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'apps', 'cli');
  const destinationDir = join(root, 'destination');
  const tarballName = 'happier-dev-cli-0.2.10.tgz';
  const destinationPath = join(destinationDir, tarballName);
  try {
    await mkdir(sandboxPackDir, { recursive: true });
    await mkdir(destinationDir);
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
    }));
    await writeFile(destinationPath, 'pre-existing-artifact');

    await assert.rejects(
      exportPackSandboxTarball({
        monorepoRoot: root,
        packageRelDir: 'apps/cli',
        destinationDir,
        createPackSandboxImpl: async () => sandboxRoot,
        runCaptureImpl: async (command, args) => {
          if (command === 'npm' && args.includes('--dry-run')) return 'dry-run';
          if (command === 'npm') {
            await writeFile(join(sandboxPackDir, tarballName), 'new-artifact');
            return tarballName;
          }
          if (command === 'tar') return 'package/package.json\n';
          throw new Error(`unexpected command: ${command}`);
        },
      }),
      /destination already exists/i,
    );
    assert.equal(await readFile(destinationPath, 'utf8'), 'pre-existing-artifact');
    assert.equal(existsSync(sandboxRoot), false);
    assert.equal(existsSync(destinationDir), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('analyzeTarList detects bundled workspace deps in tar listing', () => {
  const { hasAgents, hasCliCommon, hasProtocol } = analyzeTarList([
    'package/dist/index.mjs',
    'package/node_modules/@happier-dev/agents/package.json',
    'package/node_modules/@happier-dev/agents/dist/index.js',
    'package/node_modules/@happier-dev/cli-common/package.json',
    'package/node_modules/@happier-dev/protocol/package.json',
  ]);
  assert.equal(hasAgents, true);
  assert.equal(hasCliCommon, true);
  assert.equal(hasProtocol, true);
});

test('analyzeBundledWorkspaceTarList checks every internal bundled workspace from the package manifest', () => {
  const analysis = analyzeBundledWorkspaceTarList([
    'package/node_modules/@happier-dev/plugin-sdk/package.json',
    'package/node_modules/@happier-dev/plugins-cursor/dist/index.js',
    'package/node_modules/@happier-dev/protocol/package.json',
  ], [
    '@happier-dev/plugin-sdk',
    '@happier-dev/plugins-cursor',
    '@happier-dev/protocol',
    'tweetnacl',
  ]);

  assert.deepEqual(analysis, {
    ok: true,
    present: {
      '@happier-dev/plugin-sdk': true,
      '@happier-dev/plugins-cursor': true,
      '@happier-dev/protocol': true,
    },
    missing: [],
  });
});

test('assertBundledWorkspaceTarballComplete fails the pack when enforced bundled workspaces are missing', () => {
  assert.equal(typeof packModule.assertBundledWorkspaceTarballComplete, 'function');
  assert.throws(
    () => packModule.assertBundledWorkspaceTarballComplete({
      enforce: true,
      analysis: {
        ok: false,
        present: {
          '@happier-dev/protocol': false,
        },
        missing: ['@happier-dev/protocol'],
      },
    }),
    /missing bundled deps in tarball: @happier-dev\/protocol/,
  );
});

test('resolvePackSandboxWorkspaceRelDirs derives plugin and internal workspace directories from bundledDependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-workspace-closure-'));
  try {
    const packDir = join(root, 'apps', 'cli');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await mkdir(join(root, 'apps', 'ui'), { recursive: true });
    await mkdir(join(root, 'apps', 'server'), { recursive: true });
    await writeFile(join(root, 'apps', 'ui', 'package.json'), JSON.stringify({ name: '@happier-dev/app' }));
    await writeFile(join(root, 'apps', 'server', 'package.json'), JSON.stringify({ name: '@happier-dev/server' }));
    await writeFile(
      join(packDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: [
          '@happier-dev/agents',
          '@happier-dev/plugin-sdk',
          '@happier-dev/plugins-cursor',
          'tweetnacl',
        ],
      }),
    );

    const dirs = await resolvePackSandboxWorkspaceRelDirs({
      monorepoRoot: root,
      packageRelDir: 'apps/cli',
    });

    assert.deepEqual(dirs, [
      'apps/cli',
      'packages/agents',
      'packages/plugin-sdk',
      'packages/plugins/cursor',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolvePackSandboxWorkspaceRelDirs derives and validates transitive internal workspace closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-transitive-closure-'));
  try {
    const packDir = join(root, 'apps', 'stack');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await writeFile(
      join(packDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/stack',
        bundledDependencies: [
          '@happier-dev/cli-common',
          '@happier-dev/agents',
          '@happier-dev/protocol',
        ],
      }),
    );

    await mkdir(join(root, 'packages', 'cli-common'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli-common',
        dependencies: {
          '@happier-dev/agents': '0.0.0',
        },
      }),
    );
    await writeFixtureRuntimeDependencyOwner(root);
    await mkdir(join(root, 'packages', 'agents'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'agents', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
        },
      }),
    );
    await mkdir(join(root, 'packages', 'protocol'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'protocol', 'package.json'),
      JSON.stringify({ name: '@happier-dev/protocol' }),
    );

    const dirs = await resolvePackSandboxWorkspaceRelDirs({
      monorepoRoot: root,
      packageRelDir: 'apps/stack',
    });

    assert.deepEqual(dirs, [
      'apps/stack',
      'packages/agents',
      'packages/cli-common',
      'packages/protocol',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolvePackSandboxWorkspaceRelDirs fails when bundledDependencies omit transitive internal closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-missing-transitive-closure-'));
  try {
    const packDir = join(root, 'apps', 'stack');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await writeFile(
      join(packDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/stack',
        bundledDependencies: ['@happier-dev/cli-common'],
      }),
    );

    await mkdir(join(root, 'packages', 'cli-common'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli-common',
        dependencies: {
          '@happier-dev/agents': '0.0.0',
        },
      }),
    );
    await mkdir(join(root, 'packages', 'agents'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'agents', 'package.json'),
      JSON.stringify({ name: '@happier-dev/agents' }),
    );

    await assert.rejects(
      () => resolvePackSandboxWorkspaceRelDirs({
        monorepoRoot: root,
        packageRelDir: 'apps/stack',
      }),
      /Missing bundled internal workspace dependencies/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plugin SDK declares its complete transitive internal runtime bundle closure', async () => {
  const monorepoRoot = fileURLToPath(new URL('../../..', import.meta.url));

  const dirs = await resolvePackSandboxWorkspaceRelDirs({
    monorepoRoot,
    packageRelDir: 'packages/plugin-sdk',
  });

  assert.deepEqual(dirs, [
    'packages/agents',
    'packages/cli-common',
    'packages/plugin-sdk',
    'packages/protocol',
    'packages/release-runtime',
  ]);
});

test('createPackSandbox copies every internal workspace required by the packed package closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-sandbox-closure-'));
  const originalPath = process.env.PATH;
  let sandboxRoot;
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'],
    }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    for (const [appDir, packageName] of [
      ['ui', '@happier-dev/app'],
      ['server', '@happier-dev/server'],
    ]) {
      await mkdir(join(root, 'apps', appDir), { recursive: true });
      await writeFile(
        join(root, 'apps', appDir, 'package.json'),
        JSON.stringify({ name: packageName }),
      );
    }
    await mkdir(join(root, 'scripts', 'workspaces'), { recursive: true });
    await writeFile(
      join(root, 'scripts', 'workspaces', 'workspaceBundleLock.mjs'),
      'export function withWorkspaceBundleLock() {}\n',
    );
    await mkdir(join(root, 'scripts', 'testing', 'process'), { recursive: true });
    await writeFile(
      join(root, 'scripts', 'testing', 'process', 'managedChildLifecycle.mjs'),
      'export function runManagedChildCommand() {}\n',
    );
    const workspaceBuildSupportFiles = [
      'apps/stack/scripts/utils/fs/atomic_dir_swap.mjs',
      'apps/stack/scripts/utils/fs/fs.mjs',
      'apps/stack/scripts/utils/paths/canonical_home.mjs',
      'apps/stack/scripts/utils/paths/paths.mjs',
      'apps/stack/scripts/utils/proc/cliDistBuildLock.mjs',
      'apps/stack/scripts/utils/proc/workspace_package_manifests.mjs',
      'apps/stack/scripts/utils/proc/workspace_tool_bins.mjs',
    ];
    for (const relPath of workspaceBuildSupportFiles) {
      await mkdir(join(root, relPath, '..'), { recursive: true });
      await writeFile(join(root, relPath), `// ${relPath}\n`);
    }
    await mkdir(join(root, 'node_modules', '@typescript', 'native'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', '@typescript', 'native', 'package.json'),
      JSON.stringify({ name: '@typescript/native', version: '7.0.0-dev' }),
    );
    await writeFile(join(root, 'node_modules', '.yarn-integrity'), '{}\n');
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(root, 'node_modules', '@react-native-community', '.bin'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', '@react-native-community', '.bin', 'react-native-community-tool'),
      'transient scoped bin shim\n',
    );
    await mkdir(join(root, 'packages', 'cli-common'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli-common',
        dependencies: { '@happier-dev/release-runtime': '0.0.0' },
      }),
    );
    await writeFixtureRuntimeDependencyOwner(root);
    await writeFile(
      join(root, 'packages', 'cli-common', 'workspaceBundleLock.mjs'),
      'export function withWorkspaceBundleLock() {}\n',
    );
    await mkdir(join(root, 'apps', 'cli', 'src', 'plugins', 'scaffold'), { recursive: true });
    await writeFile(
      join(root, 'apps', 'cli', 'src', 'plugins', 'scaffold', 'scaffold.ts'),
      'export const publicToolchainScaffoldConsumer = true;\n',
    );
    await mkdir(join(root, 'packages', 'release-runtime'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'release-runtime', 'package.json'),
      JSON.stringify({ name: '@happier-dev/release-runtime' }),
    );

    const packageRelDir = 'apps/cli';
    const workspaceRelDirs = [
      packageRelDir,
      'packages/agents',
      'packages/plugin-sdk',
      'packages/plugins/cursor',
      'packages/plugins/inspector',
    ];
    const packageNamesByRelDir = {
      [packageRelDir]: '@happier-dev/cli',
      'packages/agents': '@happier-dev/agents',
      'packages/plugin-sdk': '@happier-dev/plugin-sdk',
      'packages/plugins/cursor': '@happier-dev/plugins-cursor',
      'packages/plugins/inspector': '@happier-dev/plugins-inspector',
    };
    for (const relDir of workspaceRelDirs) {
      await mkdir(join(root, relDir), { recursive: true });
      await writeFile(join(root, relDir, 'package.json'), JSON.stringify({ name: packageNamesByRelDir[relDir] }));
    }
    await writeFile(
      join(root, 'packages', 'agents', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        dependencies: { zod: 'test' },
      }),
    );
    await mkdir(join(root, 'packages', 'agents', 'node_modules', 'zod'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'agents', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: 'test' }),
    );
    await writeFile(
      join(root, 'packages', 'agents', 'node_modules', 'zod', 'index.js'),
      'export const z = true;\n',
    );
    const pluginBuildBin = join(root, 'packages', 'plugin-sdk', 'dist', 'ui', 'build', 'bin.js');
    await mkdir(join(root, 'packages', 'plugin-sdk', 'dist', 'ui', 'build'), { recursive: true });
    await writeFile(pluginBuildBin, '#!/usr/bin/env node\n');
    await writeFile(
      join(root, 'packages', 'plugin-sdk', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        bin: {
          'happier-plugin-build-ui': './dist/ui/build/bin.js',
        },
        devDependencies: {
          zod: 'test',
        },
      }),
    );
    await writeFile(
      join(root, 'packages', 'plugins', 'inspector', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-inspector',
        dependencies: {
          '@happier-dev/plugin-sdk': '0.0.0',
        },
      }),
    );
    await mkdir(join(root, 'node_modules', '@happier-dev'), { recursive: true });
    await symlink(
      join(root, 'packages', 'plugin-sdk'),
      join(root, 'node_modules', '@happier-dev', 'plugin-sdk'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const absoluteRootShim = [
      '#!/bin/sh',
      `exec "${process.execPath}" "${pluginBuildBin}" "$@"`,
      '',
    ].join('\n');
    await writeFile(
      join(root, 'node_modules', '.bin', 'happier-plugin-build-ui'),
      absoluteRootShim,
    );
    await writeFile(
      join(root, 'packages', 'plugins', 'cursor', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-cursor',
        devDependencies: { '@happier-dev/dev-only-build-fixture': '0.0.0' },
      }),
    );
    await mkdir(join(root, 'packages', 'dev-only-build-fixture'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'dev-only-build-fixture', 'package.json'),
      JSON.stringify({ name: '@happier-dev/dev-only-build-fixture' }),
    );
    await mkdir(join(root, 'packages', 'plugin-sdk', 'node_modules', '@happier-dev', 'agents'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'plugin-sdk', 'node_modules', '@happier-dev', 'agents', 'package.json'),
      JSON.stringify({ name: '@happier-dev/agents', version: 'stale-publication-output' }),
    );
    await mkdir(join(root, 'packages', 'plugin-sdk', 'node_modules', 'zod'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'plugin-sdk', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({
        name: 'zod',
        version: 'test-dependency',
        dependencies: { 'zod-transitive': 'test' },
      }),
    );
    await mkdir(join(root, 'packages', 'plugin-sdk', 'node_modules', 'zod-transitive'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'plugin-sdk', 'node_modules', 'zod-transitive', 'package.json'),
      JSON.stringify({ name: 'zod-transitive', version: 'test-transitive-dependency' }),
    );
    await mkdir(join(root, packageRelDir, 'node_modules', '.vite-temp'), { recursive: true });
    await writeFile(
      join(root, packageRelDir, 'node_modules', '.vite-temp', 'transient-config.mjs'),
      'export default {};\n',
    );
    await mkdir(join(root, packageRelDir, 'dist.staging.1234'), { recursive: true });
    await writeFile(join(root, packageRelDir, 'dist.staging.1234', 'stale.js'), 'stale\n');
    await writeFile(join(root, packageRelDir, 'stale-pack.tgz'), 'stale\n');
    await mkdir(join(root, packageRelDir, 'tools', 'unpacked'), { recursive: true });
    await writeFile(join(root, packageRelDir, 'tools', 'unpacked', 'stale-tool'), 'stale\n');
    await mkdir(join(root, 'packages', 'plugin-sdk', '.dist.build.1234'), { recursive: true });
    await writeFile(join(root, 'packages', 'plugin-sdk', '.dist.build.1234', 'stale.js'), 'stale\n');
    await writeFile(
      join(root, packageRelDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: [
          '@happier-dev/agents',
          '@happier-dev/plugin-sdk',
          '@happier-dev/plugins-cursor',
          '@happier-dev/plugins-inspector',
          'tweetnacl',
        ],
      }),
    );

    process.env.PATH = '';
    sandboxRoot = await createPackSandbox({ monorepoRoot: root, packageRelDir });
    process.env.PATH = originalPath;

    assert.equal(existsSync(join(sandboxRoot, 'packages', 'agents', 'package.json')), true);
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugin-sdk', 'package.json')), true);
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugins', 'cursor', 'package.json')), true);
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugins', 'inspector', 'package.json')), true);
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'dev-only-build-fixture', 'package.json')),
      true,
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'cli-common', 'workspaceBundleLock.mjs')),
      true,
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'release-runtime', 'package.json')),
      true,
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'scripts', 'workspaces', 'workspaceBundleLock.mjs')),
      true,
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'scripts', 'testing', 'process', 'managedChildLifecycle.mjs')),
      true,
    );
    for (const relPath of workspaceBuildSupportFiles) {
      assert.equal(
        existsSync(join(sandboxRoot, relPath)),
        true,
        `workspace build support must be copied into the pack sandbox: ${relPath}`,
      );
    }
    assert.equal(
      existsSync(join(sandboxRoot, 'apps', 'cli', 'src', 'plugins', 'scaffold', 'scaffold.ts')),
      true,
      'public toolchain scaffold consumer source must be copied into the pack sandbox',
    );
    assert.equal(
      await realpath(join(sandboxRoot, 'node_modules', '@typescript', 'native')),
      await realpath(join(root, 'node_modules', '@typescript', 'native')),
    );
    assert.equal((await lstat(join(sandboxRoot, 'node_modules', '.yarn-integrity'))).isSymbolicLink(), false);
    assert.equal(
      existsSync(join(sandboxRoot, 'node_modules', '@react-native-community', '.bin')),
      false,
      'scoped package bin directories should not be treated as package dependencies',
    );
    assert.equal(
      await realpath(join(sandboxRoot, 'node_modules', '@happier-dev', 'plugin-sdk')),
      await realpath(join(sandboxRoot, 'packages', 'plugin-sdk')),
    );
    assert.equal(
      await realpath(join(sandboxRoot, 'node_modules', '@happier-dev', 'dev-only-build-fixture')),
      await realpath(join(sandboxRoot, 'packages', 'dev-only-build-fixture')),
    );
    assert.equal(
      (await lstat(join(sandboxRoot, 'packages', 'plugin-sdk', 'node_modules', 'zod'))).isSymbolicLink(),
      true,
      'external build dependencies should be linked instead of recursively copied',
    );
    assert.equal(
      (await lstat(join(
        sandboxRoot,
        'packages',
        'plugin-sdk',
        'node_modules',
        'zod-transitive',
      ))).isSymbolicLink(),
      true,
      'transitive external build dependencies should remain resolvable in the isolated sandbox',
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'plugin-sdk', 'node_modules', '@happier-dev')),
      false,
    );
    assert.equal(
      (await lstat(join(sandboxRoot, 'packages', 'agents', 'node_modules', 'zod'))).isSymbolicLink(),
      false,
      'workspace-local runtime dependencies should materialize as sandbox-owned bytes',
    );
    assert.equal(
      await readFile(
        join(sandboxRoot, 'packages', 'agents', 'node_modules', 'zod', 'index.js'),
        'utf8',
      ),
      'export const z = true;\n',
    );
    assert.equal(
      existsSync(join(sandboxRoot, packageRelDir, 'node_modules', '.vite-temp')),
      false,
    );
    assert.equal(existsSync(join(sandboxRoot, packageRelDir, 'dist.staging.1234')), false);
    assert.equal(existsSync(join(sandboxRoot, packageRelDir, 'stale-pack.tgz')), false);
    assert.equal(existsSync(join(sandboxRoot, packageRelDir, 'tools', 'unpacked')), false);
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugin-sdk', '.dist.build.1234')), false);
    const expectedSandboxPluginBuildBin = await realpath(join(
      sandboxRoot,
      'packages',
      'plugin-sdk',
      'dist',
      'ui',
      'build',
      'bin.js',
    ));
    const sandboxPluginBuildBin = join(
      sandboxRoot,
      'node_modules',
      '.bin',
      'happier-plugin-build-ui',
    );
    if (process.platform === 'win32') {
      const commandShim = await readFile(`${sandboxPluginBuildBin}.cmd`, 'utf8');
      assert.match(commandShim, /packages\\plugin-sdk\\dist\\ui\\build\\bin\.js/);
      assert.equal(commandShim.includes(root), false);
    } else {
      const commandShim = await readFile(sandboxPluginBuildBin, 'utf8');
      assert.match(commandShim, /packages\/plugin-sdk\/dist\/ui\/build\/bin\.js/);
      assert.equal(commandShim.includes(root), false);
      assert.equal(commandShim.includes(expectedSandboxPluginBuildBin), true);
    }
    assert.equal(
      existsSync(join(
        sandboxRoot,
        'packages',
        'plugins',
        'inspector',
        'node_modules',
        '.bin',
        'happier-plugin-build-ui',
      )),
      false,
      'the canonical workspace bin owner should provide one root shim instead of a package-local copy',
    );
  } finally {
    process.env.PATH = originalPath;
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox materializes only the declared root-hoisted runtime closure inside the sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-hoisted-runtime-'));
  let sandboxRoot;
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    const runtimePackageDir = join(
      sandboxRoot,
      'packages',
      'protocol',
      'node_modules',
      '@fixture',
      'runtime',
    );
    const transitivePackageDir = join(
      runtimePackageDir,
      'node_modules',
      'runtime-transitive',
    );
    assert.equal((await lstat(runtimePackageDir)).isSymbolicLink(), false);
    assert.equal((await lstat(transitivePackageDir)).isSymbolicLink(), false);
    assert.doesNotThrow(() => assertPhysicalPathWithinApprovedRoot({
      approvedRootDir: sandboxRoot,
      sourcePath: runtimePackageDir,
      dependencyName: '@fixture/runtime',
    }));
    assert.doesNotThrow(() => assertPhysicalPathWithinApprovedRoot({
      approvedRootDir: sandboxRoot,
      sourcePath: transitivePackageDir,
      dependencyName: 'runtime-transitive',
    }));

    const unapprovedPackageDir = join(
      sandboxRoot,
      'node_modules',
      'unapproved-runtime',
    );
    assert.equal((await lstat(unapprovedPackageDir)).isSymbolicLink(), true);
    assert.throws(
      () => assertPhysicalPathWithinApprovedRoot({
        approvedRootDir: sandboxRoot,
        sourcePath: unapprovedPackageDir,
        dependencyName: 'unapproved-runtime',
      }),
      /outside the caller-approved root/i,
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox materializes a staged build workspace runtime closure without expanding the target bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-build-workspace-runtime-'));
  let sandboxRoot;
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    await mkdir(join(monorepoRoot, 'packages', 'plugin-ui'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'packages', 'plugin-ui', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugin-ui',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }),
    );
    assert.deepEqual(
      await resolvePackSandboxWorkspaceRelDirs({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      ['packages/plugin-sdk', 'packages/protocol'],
    );

    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-ui',
    });

    const pluginSdkBuildRuntimeDir = join(
      sandboxRoot,
      'packages',
      'protocol',
      'node_modules',
      '@fixture',
      'runtime',
    );
    assert.equal(
      (await lstat(pluginSdkBuildRuntimeDir)).isSymbolicLink(),
      false,
      'a staged Plugin SDK build must resolve its Protocol runtime closure from sandbox-owned bytes',
    );
    assert.doesNotThrow(() => assertPhysicalPathWithinApprovedRoot({
      approvedRootDir: sandboxRoot,
      sourcePath: pluginSdkBuildRuntimeDir,
      dependencyName: '@fixture/runtime',
    }));
    assert.equal(
      existsSync(join(
        sandboxRoot,
        'packages',
        'plugin-ui',
        'node_modules',
        '@fixture',
        'runtime',
      )),
      false,
      'the build-only closure must not become a target-package runtime dependency',
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox does not copy the Plugin UI manifest for self-contained Plugin SDK prepack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-plugin-ui-toolchain-manifest-'));
  let sandboxRoot = '';
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    await mkdir(join(monorepoRoot, 'packages', 'plugin-ui'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'packages', 'plugin-ui', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugin-ui',
        devDependencies: { 'react-native': '0.83.5' },
      }),
    );

    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'plugin-ui', 'package.json')),
      false,
      'Plugin SDK prepack must validate its generated compatibility input without sibling manifests',
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox copies the public toolchain scaffold consumer source for Plugin UI prepack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-public-toolchain-scaffold-'));
  let sandboxRoot = '';
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    await mkdir(join(monorepoRoot, 'apps', 'cli', 'src', 'plugins', 'scaffold'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'src', 'plugins', 'scaffold', 'scaffold.ts'),
      'export const publicToolchainScaffoldConsumer = true;\n',
    );
    await mkdir(join(monorepoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'packaging'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'packaging', 'versioning-compat.mdx'),
      '# Versioning compatibility\n',
    );
    await mkdir(join(monorepoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'manifest'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'manifest', 'index.mdx'),
      '# Plugin manifest\n',
    );
    await mkdir(join(monorepoRoot, 'packages', 'plugin-sdk', 'scripts'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'packages', 'plugin-sdk', 'scripts', 'generatePublicToolchainCompatibility.mjs'),
      `export { resolvePublicToolchainRequiredInputStagingRelDirs } from ${JSON.stringify(
        new URL('../../../packages/plugin-sdk/scripts/generatePublicToolchainCompatibility.mjs', import.meta.url).href,
      )};\n`,
    );
    await mkdir(join(monorepoRoot, 'packages', 'plugin-ui'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'packages', 'plugin-ui', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugin-ui',
        bundledDependencies: ['@happier-dev/plugin-sdk', '@happier-dev/protocol'],
      }),
    );

    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-ui',
    });

    assert.equal(
      existsSync(join(sandboxRoot, 'apps', 'cli', 'src', 'plugins', 'scaffold', 'scaffold.ts')),
      true,
      'Plugin UI prepack must retain the public toolchain scaffold consumer source',
    );
    for (const relativePath of [
      'apps/docs/content/docs/plugins/packaging/versioning-compat.mdx',
      'apps/docs/content/docs/plugins/manifest/index.mdx',
    ]) {
      assert.equal(
        existsSync(join(sandboxRoot, relativePath)),
        true,
        `Plugin UI prepack must retain public toolchain documentation source: ${relativePath}`,
      );
    }
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball reaches a canonical CLI prepack owner without the migration publisher tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-canonical-prepack-owner-'));
  const destinationDir = join(root, 'destination');
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const migrationPublisherDir = join(monorepoRoot, 'scripts', 'migrations', 'extensions');
    await mkdir(migrationPublisherDir, { recursive: true });
    await writeFile(
      join(migrationPublisherDir, 'legacy-publisher.mjs'),
      'export const legacyPublisher = true;\n',
    );
    const cliBuildOwnerDir = join(monorepoRoot, 'apps', 'cli', 'scripts', 'build-owned');
    await mkdir(cliBuildOwnerDir, { recursive: true });
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'scripts', 'buildSharedDeps.mjs'),
      [
        "import { publishCanonicalPrepackProof } from './build-owned/prepackPublisher.mjs';",
        "await publishCanonicalPrepackProof({ packageRoot: process.cwd() });",
        '',
      ].join('\n'),
    );
    await writeFile(
      join(cliBuildOwnerDir, 'prepackPublisher.mjs'),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        "import { resolve } from 'node:path';",
        'export function publishCanonicalPrepackProof({ packageRoot }) {',
        "  if (existsSync(resolve(packageRoot, '../../scripts/migrations/extensions'))) {",
        "    throw new Error('private migration publisher tree was copied into the pack sandbox');",
        '  }',
        "  writeFileSync(resolve(packageRoot, 'prepack-proof.txt'), 'canonical-build-owner\\n');",
        '}',
        '',
      ].join('\n'),
    );
    const packageRoot = join(monorepoRoot, 'packages', 'plugin-sdk');
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await writeFile(join(packageRoot, 'dist', 'index.js'), 'export const packed = true;\n');
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        version: '0.0.0',
        files: ['dist', 'prepack-proof.txt'],
        scripts: {
          prepack: 'node ../../apps/cli/scripts/buildSharedDeps.mjs',
        },
      }),
    );

    await mkdir(destinationDir, { recursive: true });
    const metadata = await exportPackSandboxTarball({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
      destinationDir,
    });

    assert.equal(metadata.ok, true);
    assert.equal(metadata.dryRun.ok, true);
    assert.equal(metadata.tarball.name, 'happier-dev-plugin-sdk-0.0.0.tgz');
    assert.equal(existsSync(join(destinationDir, metadata.tarball.name)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball runs the SDK prepack through copied canonical API-governance bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-api-governance-prepack-owner-'));
  const destinationDir = join(root, 'destination');
  let sandboxRoot = '';
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const governanceOwnerDir = join(monorepoRoot, 'scripts', 'api-governance');
    const governanceOwnerPath = join(governanceOwnerDir, 'cli.mjs');
    const governanceOwnerBytes = [
      "import { writeFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      "await writeFile(join(process.cwd(), 'governance-proof.txt'), 'canonical-api-governance\\n');",
      '',
    ].join('\n');
    await mkdir(governanceOwnerDir, { recursive: true });
    await writeFile(governanceOwnerPath, governanceOwnerBytes);

    const packageRoot = join(monorepoRoot, 'packages', 'sdk');
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await writeFile(join(packageRoot, 'dist', 'index.js'), 'export const packed = true;\n');
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/sdk',
        version: '0.0.0',
        files: ['dist', 'governance-proof.txt'],
        scripts: {
          prepack: 'node ../../scripts/api-governance/cli.mjs --profile sdk --check',
        },
      }),
    );

    await mkdir(destinationDir, { recursive: true });
    const metadata = await exportPackSandboxTarball({
      monorepoRoot,
      packageRelDir: 'packages/sdk',
      destinationDir,
      createPackSandboxImpl: async (input) => {
        sandboxRoot = await createPackSandbox(input);
        return sandboxRoot;
      },
      removeTempDir: async () => {},
    });

    assert.equal(metadata.ok, true);
    assert.equal(metadata.dryRun.ok, true);
    assert.equal(metadata.tarball.name, 'happier-dev-sdk-0.0.0.tgz');
    assert.equal(existsSync(join(destinationDir, metadata.tarball.name)), true);
    assert.equal(
      await readFile(join(sandboxRoot, 'scripts', 'api-governance', 'cli.mjs'), 'utf8'),
      governanceOwnerBytes,
      'the SDK prepack must use canonical governance bytes copied into its isolated sandbox',
    );
    assert.equal(
      await readFile(join(sandboxRoot, 'packages', 'sdk', 'governance-proof.txt'), 'utf8'),
      'canonical-api-governance\n',
      'the copied governance owner must run for both sandbox pack invocations',
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball runs the SDK bundler through the root workspace owner without Plugin SDK internals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-sdk-bundler-owner-'));
  const destinationDir = join(root, 'destination');
  let sandboxRoot = '';
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const workspaceScriptsDir = join(monorepoRoot, 'scripts', 'workspaces');
    const canonicalBundlerPath = join(workspaceScriptsDir, 'bundleWorkspacePackageDependencies.mjs');
    const canonicalBundlerBytes = [
      "import { writeFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      'export async function bundleWorkspacePackageDependencies({ hostPackageDir }) {',
      "  await writeFile(join(hostPackageDir, 'bundler-proof.txt'), 'canonical-workspace-bundler\\n');",
      '}',
      '',
    ].join('\n');
    await mkdir(workspaceScriptsDir, { recursive: true });
    await writeFile(canonicalBundlerPath, canonicalBundlerBytes);
    const pluginSdkScriptsDir = join(monorepoRoot, 'packages', 'plugin-sdk', 'scripts');
    await mkdir(join(monorepoRoot, 'packages', 'plugin-sdk', 'src'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'packages', 'plugin-sdk', 'src', 'unrelated-plugin-source.ts'),
      'export const mustNotStageEntirePluginSdk = true;\n',
    );

    const packageRoot = join(monorepoRoot, 'packages', 'sdk');
    const sdkBundlerScriptPath = join(packageRoot, 'scripts', 'bundleWorkspaceDeps.mjs');
    await mkdir(dirname(sdkBundlerScriptPath), { recursive: true });
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await writeFile(join(packageRoot, 'dist', 'index.js'), 'export const packed = true;\n');
    await writeFile(
      sdkBundlerScriptPath,
      [
        "import { bundleWorkspacePackageDependencies } from '../../../scripts/workspaces/bundleWorkspacePackageDependencies.mjs';",
        'await bundleWorkspacePackageDependencies({ hostPackageDir: process.cwd() });',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/sdk',
        version: '0.0.0',
        files: ['dist', 'bundler-proof.txt'],
        scripts: {
          prepack: 'node ./scripts/bundleWorkspaceDeps.mjs --artifact',
        },
      }),
    );

    await mkdir(destinationDir, { recursive: true });
    const metadata = await exportPackSandboxTarball({
      monorepoRoot,
      packageRelDir: 'packages/sdk',
      destinationDir,
      createPackSandboxImpl: async (input) => {
        sandboxRoot = await createPackSandbox(input);
        return sandboxRoot;
      },
      removeTempDir: async () => {},
    });

    assert.equal(metadata.ok, true);
    assert.equal(metadata.dryRun.ok, true);
    assert.equal(metadata.tarball.name, 'happier-dev-sdk-0.0.0.tgz');
    assert.equal(existsSync(join(destinationDir, metadata.tarball.name)), true);
    assert.equal(
      await readFile(join(sandboxRoot, 'scripts', 'workspaces', 'bundleWorkspacePackageDependencies.mjs'), 'utf8'),
      canonicalBundlerBytes,
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'plugin-sdk', 'scripts', 'bundleWorkspaceDeps.mjs')),
      false,
      'the SDK sandbox must not stage Plugin SDK private build scripts',
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'plugin-sdk', 'src', 'unrelated-plugin-source.ts')),
      false,
      'the SDK sandbox must not stage the unrelated Plugin SDK package source',
    );
    assert.equal(
      await readFile(join(sandboxRoot, 'packages', 'sdk', 'bundler-proof.txt'), 'utf8'),
      'canonical-workspace-bundler\n',
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox excludes undeclared nested node_modules while retaining declared transitive runtime packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-undeclared-nested-runtime-'));
  let sandboxRoot;
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({
      root,
      includeUndeclaredNestedRuntime: true,
    });
    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    const runtimePackageDir = join(
      sandboxRoot,
      'packages',
      'protocol',
      'node_modules',
      '@fixture',
      'runtime',
    );
    assert.equal(
      existsSync(join(
        runtimePackageDir,
        'node_modules',
        'undeclared-nested-runtime',
        'secret.js',
      )),
      false,
    );
    assert.equal(existsSync(join(runtimePackageDir, 'borrowed-nested.js')), false);
    assert.equal(
      existsSync(join(
        runtimePackageDir,
        'node_modules',
        'runtime-transitive',
        'index.js',
      )),
      true,
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects a declared runtime package that borrows undeclared sibling bytes through a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-runtime-sibling-borrow-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({
      root,
      includeSiblingBorrowSymlink: true,
    });

    await assert.rejects(
      () => createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /escapes copy source root/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox loads the basis-owned cli-common runtime dependency owner after operation entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-lazy-runtime-owner-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const hookPath = join(root, 'poison-runtime-owner-hook.mjs');
    await writeFile(hookPath, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@happier-dev/cli-common/workspaceRuntimeDependencies') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,throw new Error("poisoned mutable Stack cli-common copy")',
    };
  }
  return nextResolve(specifier, context);
}
`);
    const bootstrapPath = join(root, 'run-pack-with-poisoned-fallback.mjs');
    const packModuleUrl = `${pathToFileURL(join(
      import.meta.dirname,
      'pack.mjs',
    )).href}?lazy-owner-test=${Date.now()}`;
    await writeFile(bootstrapPath, `
import { register } from 'node:module';
import { rm } from 'node:fs/promises';
register(${JSON.stringify(pathToFileURL(hookPath).href)}, import.meta.url);
const { createPackSandbox } = await import(${JSON.stringify(packModuleUrl)});
const sandboxRoot = await createPackSandbox({
  monorepoRoot: ${JSON.stringify(monorepoRoot)},
  packageRelDir: 'packages/plugin-sdk',
});
await rm(sandboxRoot, { recursive: true, force: true });
`);

    const result = spawnSync(process.execPath, [bootstrapPath], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `pack operation resolved the poisoned pre-operation fallback:\n${result.stderr}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox fails closed when the source cli-common owner module is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-missing-runtime-owner-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    await rm(join(
      monorepoRoot,
      'packages',
      'cli-common',
      'workspaceRuntimeDependencies.mjs',
    ));

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /source cli-common workspace is missing its runtime dependency owner/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects a declared runtime package symlinked outside the monorepo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-runtime-symlink-escape-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({
      root,
      symlinkRuntimeOutside: true,
    });
    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /runtime dependency.*outside.*approved dependency roots/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox vendors runtime dependencies only for the declared runtime bundle closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-build-only-runtime-'));
  let sandboxRoot = '';
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({
      root,
      includeBuildOnlyWorkspace: true,
    });

    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    // The build-only workspace source is still copied so prepack scripts can resolve it.
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'testkit', 'package.json')),
      true,
      'expected the build-only internal workspace source to stay in the pack sandbox',
    );
    // Its runtime dependency tree is tooling-only and must not be vendored into the sandbox.
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'testkit', 'node_modules', 'workspace-linked-runtime')),
      false,
      'expected a build-only workspace runtime dependency to stay out of the vendored closure',
    );
    // The declared runtime bundle closure is still vendored.
    assert.equal(
      existsSync(join(
        sandboxRoot,
        'packages',
        'protocol',
        'node_modules',
        '@fixture',
        'runtime',
        'package.json',
      )),
      true,
      'expected the declared runtime bundle closure to remain vendored',
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects malformed declared dependency names without a local node_modules directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-runtime-name-traversal-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    await rm(
      join(monorepoRoot, 'packages', 'protocol', 'node_modules'),
      { recursive: true, force: true },
    );
    await writeFile(
      join(monorepoRoot, 'packages', 'protocol', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        dependencies: {
          '../../../../outside-runtime': '1.0.0',
        },
      }),
    );

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /invalid package dependency name/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [
  linkKind,
  linkName,
] of [
  ['file', 'linked-source.js'],
  ['directory', 'linked-source-dir'],
]) {
  test(`createPackSandbox rejects a nested source ${linkKind} symlink outside its copied workspace root`, async () => {
  const root = await mkdtemp(join(tmpdir(), `pack-test-source-${linkKind}-escape-`));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const outsidePath = join(root, `outside-source-${linkKind}`);
    if (linkKind === 'directory') {
      await mkdir(outsidePath, { recursive: true });
      await writeFile(join(outsidePath, 'secret.js'), 'outside directory bytes\n');
    } else {
      await writeFile(outsidePath, 'outside file bytes\n');
    }
    await symlink(
      outsidePath,
      join(monorepoRoot, 'packages', 'protocol', linkName),
      linkKind === 'directory'
        ? (process.platform === 'win32' ? 'junction' : 'dir')
        : 'file',
    );

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /dereferenced symlink target escapes copy source root/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  });
}

test('createPackSandbox materializes a contained relative source symlink as sandbox-owned bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-contained-source-symlink-'));
  let sandboxRoot;
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const protocolSourceDir = join(monorepoRoot, 'packages', 'protocol');
    await writeFile(join(protocolSourceDir, 'owned-source.js'), 'owned source bytes\n');
    await symlink('owned-source.js', join(protocolSourceDir, 'linked-source.js'), 'file');

    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    const copiedLinkPath = join(
      sandboxRoot,
      'packages',
      'protocol',
      'linked-source.js',
    );
    assert.equal((await lstat(copiedLinkPath)).isSymbolicLink(), false);
    assert.equal(await readFile(copiedLinkPath, 'utf8'), 'owned source bytes\n');
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox excludes nested transient build bytes omitted from the candidate basis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-nested-transient-build-'));
  let sandboxRoot;
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const transientSourceDir = join(
      monorepoRoot,
      'packages',
      'protocol',
      'native',
      'helper',
      '.build',
    );
    await mkdir(transientSourceDir, { recursive: true });
    await writeFile(join(transientSourceDir, 'unattested-sentinel'), 'must not enter prepack\n');

    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    assert.equal(
      existsSync(join(
        sandboxRoot,
        'packages',
        'protocol',
        'native',
        'helper',
        '.build',
        'unattested-sentinel',
      )),
      false,
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox excludes TypeScript compiler work trees without excluding ordinary .happier package input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-typescript-compiler-work-tree-'));
  let sandboxRoot;
  try {
    assert.equal(
      packModule.shouldIncludePackSandboxSourcePath(
        '.happier\\typescript-package-build\\cache-key\\dist\\host\\registration\\staticRegistrationSnapshots.d.ts.map',
        { workspaceRelDir: 'packages/plugin-sdk' },
      ),
      false,
    );
    assert.equal(
      packModule.shouldIncludePackSandboxSourcePath(
        '.happier\\plugin.json',
        { workspaceRelDir: 'packages/plugin-sdk' },
      ),
      true,
    );

    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const pluginSdkRoot = join(monorepoRoot, 'packages', 'plugin-sdk');
    const compilerMapPath = join(
      pluginSdkRoot,
      '.happier',
      'typescript-package-build',
      'cache-key',
      'dist',
      'host',
      'registration',
      'staticRegistrationSnapshots.d.ts.map',
    );
    const ordinaryHappierInputPath = join(pluginSdkRoot, '.happier', 'plugin.json');
    await mkdir(dirname(compilerMapPath), { recursive: true });
    await writeFile(compilerMapPath, 'transient compiler map\n');
    await writeFile(ordinaryHappierInputPath, 'ordinary package input\n');

    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    assert.equal(
      existsSync(join(
        sandboxRoot,
        'packages',
        'plugin-sdk',
        '.happier',
        'typescript-package-build',
        'cache-key',
        'dist',
        'host',
        'registration',
        'staticRegistrationSnapshots.d.ts.map',
      )),
      false,
    );
    assert.equal(
      await readFile(
        join(sandboxRoot, 'packages', 'plugin-sdk', '.happier', 'plugin.json'),
        'utf8',
      ),
      'ordinary package input\n',
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox preserves Plugin SDK example sources but excludes their nested generated dist outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-plugin-sdk-example-output-'));
  let sandboxRoot;
  try {
    assert.equal(
      packModule.shouldIncludePackSandboxSourcePath(
        'examples\\react-native-panel\\dist\\ui\\stale-entry.mjs',
        { workspaceRelDir: 'packages/plugin-sdk' },
      ),
      false,
    );
    assert.equal(
      packModule.shouldIncludePackSandboxSourcePath('dist\\index.js', { workspaceRelDir: 'packages/plugin-sdk' }),
      true,
    );
    assert.equal(
      packModule.shouldIncludePackSandboxSourcePath(
        'examples\\react-native-panel\\dist\\ui\\stale-entry.mjs',
        { workspaceRelDir: 'packages/plugin-ui' },
      ),
      true,
    );
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const pluginSdkRoot = join(monorepoRoot, 'packages', 'plugin-sdk');
    const exampleRoot = join(
      pluginSdkRoot,
      'examples',
      'react-native-panel',
    );
    await mkdir(join(pluginSdkRoot, 'dist'), { recursive: true });
    await mkdir(join(exampleRoot, 'src'), { recursive: true });
    await mkdir(join(exampleRoot, 'dist', 'ui'), { recursive: true });
    await writeFile(join(pluginSdkRoot, 'API.md'), '# Public API\n');
    await writeFile(join(pluginSdkRoot, 'dist', 'index.js'), 'export const packagedSdk = true;\n');
    await writeFile(join(exampleRoot, 'src', 'surface.tsx'), 'export const sourceExample = true;\n');
    await writeFile(join(exampleRoot, 'dist', 'ui', 'stale-entry.mjs'), 'stale generated bytes\n');

    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    assert.equal(
      await readFile(
        join(sandboxRoot, 'packages', 'plugin-sdk', 'examples', 'react-native-panel', 'src', 'surface.tsx'),
        'utf8',
      ),
      'export const sourceExample = true;\n',
    );
    assert.equal(
      await readFile(join(sandboxRoot, 'packages', 'plugin-sdk', 'API.md'), 'utf8'),
      '# Public API\n',
    );
    assert.equal(
      await readFile(join(sandboxRoot, 'packages', 'plugin-sdk', 'dist', 'index.js'), 'utf8'),
      'export const packagedSdk = true;\n',
    );
    assert.equal(
      existsSync(
        join(
          sandboxRoot,
          'packages',
          'plugin-sdk',
          'examples',
          'react-native-panel',
          'dist',
          'ui',
          'stale-entry.mjs',
        ),
      ),
      false,
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects a workspace package manifest symlink before it can change closure discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-workspace-manifest-symlink-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const protocolPackageJsonPath = join(
      monorepoRoot,
      'packages',
      'protocol',
      'package.json',
    );
    const outsideManifestPath = join(root, 'outside-protocol-package.json');
    await writeFile(outsideManifestPath, JSON.stringify({
      name: '@happier-dev/protocol',
      dependencies: {
        '@fixture/runtime': '^1.0.0',
      },
    }));
    await rm(protocolPackageJsonPath);
    await symlink(outsideManifestPath, protocolPackageJsonPath, 'file');

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /json source must be a regular file/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [
  relativePath,
  outsideContents,
] of [
  ['package.json', JSON.stringify({ name: 'monorepo' })],
  ['yarn.lock', '# outside lock\n'],
]) {
  test(`createPackSandbox rejects a symlinked root ${relativePath} before copying outside bytes`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-root-file-symlink-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const sourcePath = join(monorepoRoot, relativePath);
    const outsidePath = join(root, `outside-${relativePath.replaceAll('/', '-')}`);
    await writeFile(outsidePath, outsideContents);
    await rm(sourcePath);
    await symlink(outsidePath, sourcePath, 'file');

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /pack source file must be a regular file/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  });
}

test('createPackSandbox ignores inherited package bin links outside the declared dependency graph', async () => {
  for (const mode of ['absolute', 'relative']) {
    const root = await mkdtemp(join(tmpdir(), `pack-test-bin-escape-${mode}-`));
    const monorepoRoot = join(root, 'repo');
    const outsideTarget = join(root, 'outside-bin.js');
    let sandboxRoot;
    try {
      await mkdir(join(monorepoRoot, 'apps', 'cli', 'node_modules', '.bin'), { recursive: true });
      await mkdir(join(monorepoRoot, 'packages', 'cli-common'), { recursive: true });
      await mkdir(join(monorepoRoot, 'scripts', 'workspaces'), { recursive: true });
      await mkdir(join(monorepoRoot, 'scripts', 'testing', 'process'), { recursive: true });
      await mkdir(join(monorepoRoot, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(monorepoRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
      await writeFile(join(monorepoRoot, 'yarn.lock'), '# lock');
      await writeFile(
        join(monorepoRoot, 'apps', 'cli', 'package.json'),
        JSON.stringify({ name: '@happier-dev/cli' }),
      );
      await writeFile(
        join(monorepoRoot, 'packages', 'cli-common', 'package.json'),
        JSON.stringify({ name: '@happier-dev/cli-common' }),
      );
      await writeFixtureRuntimeDependencyOwner(monorepoRoot);
      await writeFile(join(monorepoRoot, 'scripts', 'workspaces', 'placeholder.mjs'), '');
      await writeFile(join(monorepoRoot, 'scripts', 'testing', 'process', 'placeholder.mjs'), '');
      await writeFile(outsideTarget, '#!/usr/bin/env node\n');

      const binDir = join(monorepoRoot, 'apps', 'cli', 'node_modules', '.bin');
      await symlink(
        mode === 'absolute' ? outsideTarget : relative(binDir, outsideTarget),
        join(binDir, 'escaped-tool'),
        process.platform === 'win32' ? 'file' : undefined,
      );

      sandboxRoot = await createPackSandbox({ monorepoRoot, packageRelDir: 'apps/cli' });
      assert.equal(
        existsSync(join(sandboxRoot, 'apps', 'cli', 'node_modules', '.bin', 'escaped-tool')),
        false,
      );
    } finally {
      if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('createPackSandbox removes its allocated sandbox when construction fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-sandbox-cleanup-'));
  const sandboxRoot = join(root, 'allocated-sandbox');
  try {
    await mkdir(join(root, 'apps', 'cli'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await writeFile(join(root, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
    await mkdir(sandboxRoot, { recursive: true });

    await assert.rejects(
      () => createPackSandbox({
        monorepoRoot: root,
        packageRelDir: 'apps/cli',
        createTempDir: async () => sandboxRoot,
      }),
      /missing repository dependencies/i,
    );
    assert.equal(existsSync(sandboxRoot), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects traversal and symlinked package roots before allocating a sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-sandbox-containment-'));
  const monorepoRoot = join(root, 'repo');
  const outsidePackageDir = join(root, 'outside-package');
  let allocated = false;
  const createTempDir = async () => {
    allocated = true;
    return join(root, 'allocated-sandbox');
  };
  try {
    await mkdir(join(monorepoRoot, 'apps'), { recursive: true });
    await mkdir(outsidePackageDir, { recursive: true });
    await symlink(
      outsidePackageDir,
      join(monorepoRoot, 'apps', 'escaped-package'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await assert.rejects(
      () => createPackSandbox({
        monorepoRoot,
        packageRelDir: '../outside-package',
        createTempDir,
      }),
      /relative workspace path under apps\/ or packages\//i,
    );
    await assert.rejects(
      () => createPackSandbox({
        monorepoRoot,
        packageRelDir: 'apps/escaped-package',
        createTempDir,
      }),
      /must not resolve through a symbolic link/i,
    );
    assert.equal(allocated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects dependency-derived workspace traversal without reading or writing outside its roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-dependency-traversal-'));
  const monorepoRoot = join(root, 'repo');
  const outsideSourceDir = join(root, 'outside-source');
  const sandboxRoot = join(root, 'sandbox-parent', 'sandbox');
  const escapedDestinationDir = join(root, 'sandbox-parent', 'outside-source');
  try {
    for (const relDir of [
      'apps/cli',
      'packages/cli-common',
      'scripts/workspaces',
      'scripts/testing/process',
      'node_modules',
    ]) {
      await mkdir(join(monorepoRoot, relDir), { recursive: true });
    }
    await writeFile(join(monorepoRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(monorepoRoot, 'yarn.lock'), '# lock');
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: ['@happier-dev/plugins-../../../outside-source'],
      }),
    );
    await writeFile(
      join(monorepoRoot, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli-common' }),
    );
    await writeFixtureRuntimeDependencyOwner(monorepoRoot);
    await writeFile(join(monorepoRoot, 'scripts', 'workspaces', 'placeholder.mjs'), '');
    await writeFile(join(monorepoRoot, 'scripts', 'testing', 'process', 'placeholder.mjs'), '');
    await mkdir(outsideSourceDir);
    await writeFile(
      join(outsideSourceDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/plugins-../../../outside-source' }),
    );
    await writeFile(join(outsideSourceDir, 'sentinel.txt'), 'outside source bytes');

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'apps/cli',
        createTempDir: async () => {
          await mkdir(sandboxRoot, { recursive: true });
          return sandboxRoot;
        },
      }),
      /invalid internal workspace package name/i,
    );
    assert.equal(existsSync(escapedDestinationDir), false);
    assert.equal(await readFile(join(outsideSourceDir, 'sentinel.txt'), 'utf8'), 'outside source bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects a symlinked dependency workspace without copying its external target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-dependency-symlink-'));
  const monorepoRoot = join(root, 'repo');
  const outsideWorkspaceDir = join(root, 'outside-plugin');
  const sandboxRoot = join(root, 'sandbox');
  try {
    for (const relDir of [
      'apps/cli',
      'packages/cli-common',
      'packages/plugins',
      'scripts/workspaces',
      'scripts/testing/process',
      'node_modules',
    ]) {
      await mkdir(join(monorepoRoot, relDir), { recursive: true });
    }
    await writeFile(join(monorepoRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(monorepoRoot, 'yarn.lock'), '# lock');
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: ['@happier-dev/plugins-escaped'],
      }),
    );
    await writeFile(
      join(monorepoRoot, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli-common' }),
    );
    await writeFixtureRuntimeDependencyOwner(monorepoRoot);
    await writeFile(join(monorepoRoot, 'scripts', 'workspaces', 'placeholder.mjs'), '');
    await writeFile(join(monorepoRoot, 'scripts', 'testing', 'process', 'placeholder.mjs'), '');
    await mkdir(outsideWorkspaceDir);
    await writeFile(
      join(outsideWorkspaceDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/plugins-escaped' }),
    );
    await writeFile(join(outsideWorkspaceDir, 'sentinel.txt'), 'external target bytes');
    await symlink(
      outsideWorkspaceDir,
      join(monorepoRoot, 'packages', 'plugins', 'escaped'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'apps/cli',
        createTempDir: async () => {
          await mkdir(sandboxRoot, { recursive: true });
          return sandboxRoot;
        },
      }),
      /dependency workspace must not resolve through a symbolic link/i,
    );
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugins', 'escaped')), false);
    assert.equal(
      await readFile(join(outsideWorkspaceDir, 'sentinel.txt'), 'utf8'),
      'external target bytes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects external dependency traversal before node_modules source or destination joins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-node-modules-traversal-'));
  const monorepoRoot = join(root, 'repo');
  const outsideSourceDir = join(root, 'outside-external');
  const sandboxRoot = join(root, 'sandbox-parent', 'sandbox');
  const escapedDestinationDir = join(root, 'sandbox-parent', 'outside-external');
  try {
    for (const relDir of [
      'apps/cli/node_modules',
      'packages/cli-common',
      'scripts/workspaces',
      'scripts/testing/process',
      'node_modules',
    ]) {
      await mkdir(join(monorepoRoot, relDir), { recursive: true });
    }
    await writeFile(join(monorepoRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(monorepoRoot, 'yarn.lock'), '# lock');
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        dependencies: {
          '../../../../outside-external': '1.0.0',
        },
      }),
    );
    await writeFile(
      join(monorepoRoot, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli-common' }),
    );
    await writeFixtureRuntimeDependencyOwner(monorepoRoot);
    await writeFile(join(monorepoRoot, 'scripts', 'workspaces', 'placeholder.mjs'), '');
    await writeFile(join(monorepoRoot, 'scripts', 'testing', 'process', 'placeholder.mjs'), '');
    await mkdir(outsideSourceDir);
    await writeFile(
      join(outsideSourceDir, 'package.json'),
      JSON.stringify({ name: 'outside-external' }),
    );
    await writeFile(join(outsideSourceDir, 'sentinel.txt'), 'outside dependency bytes');

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'apps/cli',
        createTempDir: async () => {
          await mkdir(sandboxRoot, { recursive: true });
          return sandboxRoot;
        },
      }),
      /invalid package dependency name/i,
    );
    assert.equal(existsSync(escapedDestinationDir), false);
    assert.equal(
      await readFile(join(outsideSourceDir, 'sentinel.txt'), 'utf8'),
      'outside dependency bytes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findMonorepoRoot finds nearest package.json + yarn.lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await mkdir(join(root, 'packages', 'happy-cli'), { recursive: true });

    const nested = join(root, 'packages', 'happy-cli');
    const found = await findMonorepoRoot(nested);
    assert.equal(found, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolvePackDirForComponent maps monorepo root to apps/cli', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await mkdir(join(root, 'apps', 'cli'), { recursive: true });

    const resolved = await resolvePackDirForComponent({
      component: 'happy-cli',
      componentDir: root,
      explicitDir: null,
    });
    assert.equal(resolve(resolved), resolve(join(root, 'apps', 'cli')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolvePackDirForComponent keeps a repo-local hstack pack in its own monorepo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-local-owner-'));
  try {
    const localRoot = join(root, 'dev');
    const inheritedStackRoot = join(root, 'remote-dev');
    await mkdir(localRoot, { recursive: true });
    await writeFile(join(localRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(localRoot, 'yarn.lock'), '# local lock');
    await mkdir(join(localRoot, 'apps', 'stack'), { recursive: true });
    await mkdir(join(localRoot, 'apps', 'cli'), { recursive: true });
    await mkdir(inheritedStackRoot, { recursive: true });
    await writeFile(join(inheritedStackRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(inheritedStackRoot, 'yarn.lock'), '# inherited lock');
    await mkdir(join(inheritedStackRoot, 'apps', 'cli'), { recursive: true });

    const resolved = await resolvePackDirForComponent({
      component: 'happy-cli',
      componentDir: join(inheritedStackRoot, 'apps', 'cli'),
      explicitDir: null,
      rootDir: join(localRoot, 'apps', 'stack'),
    });
    assert.equal(resolve(resolved), resolve(join(localRoot, 'apps', 'cli')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolvePackDirForComponent prefers explicitDir override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-explicit-'));
  try {
    const explicit = join(root, 'custom-pack-dir');
    await mkdir(explicit, { recursive: true });
    const resolved = await resolvePackDirForComponent({
      component: 'happy-cli',
      componentDir: root,
      explicitDir: explicit,
    });
    assert.equal(resolve(resolved), resolve(explicit));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stack package exposes happier as a published binary', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.bin, {
    hstack: './bin/hstack.mjs',
    happier: './bin/happier.mjs',
  });
});

test('stack package excludes the WSREPL Lima test shims from published files', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(pkg.files), 'expected stack package to declare published files');
  assert.ok(
    pkg.files.includes('!scripts/provision/macos-lima-wsrepl-matrix.sh'),
    'expected WSREPL Lima matrix shim to be excluded from the published stack package',
  );
  assert.ok(
    pkg.files.includes('!scripts/provision/macos-lima-vm.sh'),
    'expected WSREPL Lima VM shim to be excluded from the published stack package',
  );
});

test('stack package keeps the Expo heap helper local to the packaged scripts tree', async () => {
  const commandMjs = await readFile(new URL('./utils/expo/command.mjs', import.meta.url), 'utf8');
  assert.match(commandMjs, /from '\.\/expoNodeHeapEnv\.mjs';/);
  assert.doesNotMatch(commandMjs, /scripts\/expo\/expoNodeHeapEnv\.mjs/);
});
