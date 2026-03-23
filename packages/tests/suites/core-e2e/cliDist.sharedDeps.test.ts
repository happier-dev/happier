import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const CLI_SHARED_DEP_PACKAGE_NAMES = ['agents', 'cli-common', 'protocol', 'release-runtime'] as const;

type RunLoggedCommand = (params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
}) => Promise<void>;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

async function writeSharedWorkspaceOutputs(repoRoot: string, protocolMarker = 'protocol-from-workspace'): Promise<void> {
  await createBundledWorkspacePackageDirs(repoRoot);

  const outputEntries = CLI_SHARED_DEP_PACKAGE_NAMES.map((packageName) => ({
    packageName,
    path: resolve(repoRoot, 'packages', packageName, 'dist', 'index.js'),
    contents: packageName === 'protocol' ? `export const marker = '${protocolMarker}';\n` : 'export {};\n',
  }));

  for (const entry of outputEntries) {
    await mkdir(resolve(entry.path, '..'), { recursive: true });
    await writeFile(entry.path, entry.contents, 'utf8');

    const bundledPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', entry.packageName);
    await writeFile(
      resolve(bundledPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: `@happier-dev/${entry.packageName}`,
          type: 'module',
          main: './dist/index.js',
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await mkdir(resolve(bundledPackageDir, 'dist'), { recursive: true });
    await writeFile(resolve(bundledPackageDir, 'dist', 'index.js'), entry.contents, 'utf8');
  }
}

async function createBundledWorkspacePackageDirs(repoRoot: string): Promise<void> {
  for (const packageName of CLI_SHARED_DEP_PACKAGE_NAMES) {
    await mkdir(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', packageName), { recursive: true });
  }
}

describe('core e2e: cli dist build', () => {
  let dir: string | undefined;
  let extraDir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
    if (extraDir) {
      await rm(extraDir, { recursive: true, force: true });
      extraDir = undefined;
    }
  });

  it('builds shared workspace deps before returning a usable CLI dist entrypoint', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-'));
    const repoRoot = dir;

    const cliDistDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    await mkdir(cliDistDir, { recursive: true });
    await writeFile(resolve(cliDistDir, 'index.mjs'), "export {};\n", 'utf8');

    const runCommand = vi.fn<RunLoggedCommand>(async () => {
      await writeSharedWorkspaceOutputs(repoRoot);
    });

    vi.resetModules();
    const { ensureCliDistBuilt } = await import('../../src/testkit/process/cliDist');

    const entrypoint = await ensureCliDistBuilt(
      { testDir: repoRoot, env: { ...process.env, CI: '1' } },
      {
        repoRoot,
        runCommand,
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    expect(entrypoint).toBe(resolve(cliDistDir, 'index.mjs'));
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(await exists(resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js'))).toBe(true);
    expect(await exists(resolve(repoRoot, 'packages', 'release-runtime', 'dist', 'index.js'))).toBe(true);
  });

  it('creates a stable CLI dist snapshot for spawned processes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-snapshot-'));
    const repoRoot = dir;

    const cliDistDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    await mkdir(cliDistDir, { recursive: true });
    await writeFile(resolve(cliDistDir, 'index.mjs'), "export {};\n", 'utf8');

    const runCommand = vi.fn<RunLoggedCommand>(async () => {
      await writeSharedWorkspaceOutputs(repoRoot);
    });

    vi.resetModules();
    const { ensureCliDistSnapshotEntrypoint } = await import('../../src/testkit/process/cliDist');

    const snapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const entrypoint = await ensureCliDistSnapshotEntrypoint(
      { testDir: repoRoot, env: { ...process.env, CI: '1' } },
      {
        repoRoot,
        runCommand,
        snapshotDir,
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    expect(entrypoint).toBe(resolve(snapshotDir, 'dist', 'index.mjs'));
    expect(await exists(entrypoint)).toBe(true);

    const entrypoint2 = await ensureCliDistSnapshotEntrypoint(
      { testDir: repoRoot, env: { ...process.env, CI: '1' } },
      {
        repoRoot,
        runCommand,
        snapshotDir,
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    expect(entrypoint2).toBe(entrypoint);
  });

  it('launches the CLI dist snapshot from an arbitrary cwd with bundled workspace packages available', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-snapshot-launch-'));
    const repoRoot = dir;

    const cliDistDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const cliNodeModulesProtocolDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    const arbitraryCwd = resolve(repoRoot, 'workspace');

    await createBundledWorkspacePackageDirs(repoRoot);
    await mkdir(cliDistDir, { recursive: true });
    await mkdir(resolve(cliNodeModulesProtocolDir, 'dist'), { recursive: true });
    await mkdir(arbitraryCwd, { recursive: true });

    await writeFile(resolve(cliDistDir, 'index.mjs'), "import { marker } from './chunk-hash.mjs'; console.log(marker);\n", 'utf8');
    await writeFile(resolve(cliDistDir, 'chunk-hash.mjs'), "import { marker } from '@happier-dev/protocol'; export { marker };\n", 'utf8');
    await writeSharedWorkspaceOutputs(repoRoot);
    await writeFile(
      resolve(cliNodeModulesProtocolDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          type: 'module',
          main: './dist/index.js',
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(resolve(cliNodeModulesProtocolDir, 'dist', 'index.js'), "export const marker = 'protocol-ok';\n", 'utf8');

    const runCommand = vi.fn<RunLoggedCommand>(async () => {});

    vi.resetModules();
    const { resolveCliTestLaunchSpec } = await import('../../src/testkit/process/cliLaunchSpec');

    const launchSpec = await resolveCliTestLaunchSpec(
      { testDir: repoRoot, env: { ...process.env, CI: '1' } },
      {
        repoRoot,
        runCommand,
        snapshotDir: resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot'),
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    const execution = await execFileAsync(launchSpec.command, launchSpec.args, {
      cwd: arbitraryCwd,
      env: {
        ...process.env,
        ...(launchSpec.env ?? {}),
      },
    });

    expect(execution.stdout.trim()).toBe('protocol-ok');
  });

  it('launches the CLI dist snapshot with hoisted root runtime deps alongside CLI-local bundled packages', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-snapshot-hoisted-launch-'));
    const repoRoot = dir;
    extraDir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-external-snapshot-'));
    const externalSnapshotRoot = extraDir;

    const cliDistDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    const cliNodeModulesProtocolDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    const rootAxiosDir = resolve(repoRoot, 'node_modules', 'axios');
    const arbitraryCwd = resolve(repoRoot, 'workspace');

    await mkdir(cliDistDir, { recursive: true });
    await mkdir(resolve(cliNodeModulesProtocolDir, 'dist'), { recursive: true });
    await mkdir(rootAxiosDir, { recursive: true });
    await mkdir(arbitraryCwd, { recursive: true });
    await createBundledWorkspacePackageDirs(repoRoot);

    await writeFile(
      resolve(cliDistDir, 'index.mjs'),
      "import axios from 'axios'; import { marker } from './chunk-hash.mjs'; console.log(`${marker}:${axios.hoisted}`);\n",
      'utf8',
    );
    await writeFile(resolve(cliDistDir, 'chunk-hash.mjs'), "import { marker } from '@happier-dev/protocol'; export { marker };\n", 'utf8');
    await writeSharedWorkspaceOutputs(repoRoot);
    await writeFile(
      resolve(cliNodeModulesProtocolDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          type: 'module',
          main: './dist/index.js',
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(resolve(cliNodeModulesProtocolDir, 'dist', 'index.js'), "export const marker = 'protocol-ok';\n", 'utf8');
    await writeFile(
      resolve(rootAxiosDir, 'package.json'),
      JSON.stringify({
        name: 'axios',
        main: './index.js',
      }, null, 2),
      'utf8',
    );
    await writeFile(resolve(rootAxiosDir, 'index.js'), "module.exports = { hoisted: 'axios-ok' };\n", 'utf8');

    const runCommand = vi.fn<RunLoggedCommand>(async () => {});

    vi.resetModules();
    const { resolveCliTestLaunchSpec } = await import('../../src/testkit/process/cliLaunchSpec');

    const launchSpec = await resolveCliTestLaunchSpec(
      { testDir: repoRoot, env: { ...process.env, CI: '1' } },
      {
        repoRoot,
        runCommand,
        snapshotDir: resolve(externalSnapshotRoot, 'cli-dist-snapshot'),
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    const execution = await execFileAsync(launchSpec.command, launchSpec.args, {
      cwd: arbitraryCwd,
      env: {
        ...process.env,
        ...(launchSpec.env ?? {}),
      },
    });

    expect(execution.stdout.trim()).toBe('protocol-ok:axios-ok');
  });

  it('launches the CLI source entrypoint from the snapshot root when source mode is enabled', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-source-snapshot-launch-'));
    const repoRoot = dir;

    const cliSrcDir = resolve(repoRoot, 'apps', 'cli', 'src');
    const cliNodeModulesProtocolDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    const snapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
    const arbitraryCwd = resolve(repoRoot, 'workspace');

    await createBundledWorkspacePackageDirs(repoRoot);
    await mkdir(cliSrcDir, { recursive: true });
    await mkdir(resolve(cliNodeModulesProtocolDir, 'dist'), { recursive: true });
    await mkdir(arbitraryCwd, { recursive: true });

    await writeFile(resolve(cliSrcDir, 'index.ts'), "import { marker } from '@happier-dev/protocol'; console.log(marker);\n", 'utf8');
    await writeFile(
      resolve(cliNodeModulesProtocolDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          type: 'module',
          main: './dist/index.js',
          exports: {
            '.': {
              default: './dist/index.js',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(resolve(cliNodeModulesProtocolDir, 'dist', 'index.js'), "export const marker = 'protocol-ok';\n", 'utf8');
    await writeFile(resolve(repoRoot, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}', 'utf8');
    await writeFile(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
    await writeSharedWorkspaceOutputs(repoRoot);

    const runCommand = vi.fn<RunLoggedCommand>(async () => {});

    vi.resetModules();
    const { resolveCliTestLaunchSpec } = await import('../../src/testkit/process/cliLaunchSpec');

    const launchSpec = await resolveCliTestLaunchSpec(
      { testDir: repoRoot, env: { ...process.env, CI: '1', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' } },
      {
        repoRoot,
        runCommand,
        snapshotDir,
        lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      },
    );

    expect(launchSpec.cwd).toBe(snapshotDir);
    expect(launchSpec.args).toEqual(
      expect.arrayContaining([
        '--import',
        expect.stringContaining('tsx/dist/esm/index.mjs'),
        expect.stringContaining(resolve(snapshotDir, 'src', 'index.ts')),
      ]),
    );
  });

  it('retries CLI dist snapshot copy when dist files change during the first copy attempt', async () => {
    dir = await mkdtemp(join(tmpdir(), 'happier-cli-dist-snapshot-retry-'));
    const repoRoot = dir;

    const cliDistDir = resolve(repoRoot, 'apps', 'cli', 'dist');
    await mkdir(cliDistDir, { recursive: true });
    await writeFile(resolve(cliDistDir, 'index.mjs'), "export { value } from './copilotCliAuthSpec-hash.mjs';\n", 'utf8');
    await writeFile(resolve(cliDistDir, 'copilotCliAuthSpec-hash.mjs'), "export const value = 1;\n", 'utf8');

    const runCommand = vi.fn<RunLoggedCommand>(async () => {
      await writeSharedWorkspaceOutputs(repoRoot);
    });

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let shouldFailOnce = true;
      return {
        ...actual,
        cp: vi.fn(async (...args: Parameters<typeof actual.cp>) => {
          if (shouldFailOnce) {
            shouldFailOnce = false;
            const error = Object.assign(new Error('simulated dist race'), {
              code: 'ENOENT',
              path: resolve(cliDistDir, 'copilotCliAuthSpec-hash.mjs'),
            });
            throw error;
          }
          return await actual.cp(...args);
        }),
      };
    });

    try {
      const { ensureCliDistSnapshotEntrypoint } = await import('../../src/testkit/process/cliDist');

      const snapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
      const entrypoint = await ensureCliDistSnapshotEntrypoint(
        { testDir: repoRoot, env: { ...process.env, CI: '1' } },
        {
          repoRoot,
          runCommand,
          snapshotDir,
          lockPath: resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
        },
      );

      expect(entrypoint).toBe(resolve(snapshotDir, 'dist', 'index.mjs'));
      expect(await exists(entrypoint)).toBe(true);
      expect(await exists(resolve(snapshotDir, 'dist', 'copilotCliAuthSpec-hash.mjs'))).toBe(true);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });
});
