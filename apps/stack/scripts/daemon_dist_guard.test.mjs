import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  applyDaemonDistClosureRuntimeEnv,
  assertFinalSourceDaemonDistAdmission,
  checkDaemonState,
  checkDaemonStatePingAware,
  createDaemonStartAttemptLogPath,
  ensureHappierCliDistExists,
  getDaemonEnv,
  resolveDaemonDistRestartReason,
  resolveGuardedLocalCliDistEntrypoint,
  startLocalDaemonWithAuth,
  stopLocalDaemon,
} from './daemon.mjs';
import { resolveStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { recordStackRuntimeStart } from './utils/stack/runtime_state.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { writeWorkspacePackageBuildOwnerStub } from './testkit/core/workspace_package_build_owner.mjs';

function runGit(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function buildDaemonDistGuardEnv(overrides = {}) {
  return {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: '',
    HAPPIER_STACK_CLI_ROOT_DIR: '',
    HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '',
    HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: '',
    HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: '',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_LOG_TEE_DIR: '',
    ...overrides,
  };
}

test('watch startup admits a validated prior CLI publication without waiting for freshness build', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-last-green-cli-startup-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  await writeDistBuildManifestForTest(distEntrypoint, 'abcdef1234567890');
  const probes = [];

  const result = await ensureHappierCliDistExists(
    {
      cliBin,
      admitPriorDistImmediately: true,
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir },
    },
    {
      ensureCliBuiltImpl: async () => {
        throw new Error('freshness build must run in the background reload owner');
      },
      probeCliDistRuntimeImportImpl: async (entrypoint) => {
        probes.push(entrypoint);
      },
    },
  );

  assert.deepEqual(probes, [distEntrypoint]);
  assert.equal(result.ok, true);
  assert.equal(result.current, true);
  assert.equal(result.built, false);
  assert.equal(result.reason, 'admitted-prior-dist-for-watch-startup');
  assert.equal(result.fallbackFingerprint, 'abcdef1234567890');
});

test('watch startup retries a transient atomic CLI publication gap before waiting on the shared build lock', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-last-green-cli-publication-gap-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  let buildCalls = 0;
  let sleepCalls = 0;

  const result = await ensureHappierCliDistExists(
    {
      cliBin,
      admitPriorDistImmediately: true,
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir },
    },
    {
      ensureCliBuiltImpl: async () => {
        buildCalls += 1;
        throw new Error('startup must not wait on the shared build lock');
      },
      sleepImpl: async () => {
        sleepCalls += 1;
        await writeDistBuildManifestForTest(distEntrypoint, 'abcdef1234567890');
      },
      probeCliDistRuntimeImportImpl: async () => {},
    },
  );

  assert.equal(result.reason, 'admitted-prior-dist-for-watch-startup');
  assert.equal(buildCalls, 0);
  assert.equal(sleepCalls, 1);
});

test('source admission forces one last-chance build when builds are disabled and dist is invalid', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-disabled-cli-bootstrap-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  const calls = [];

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_CLI_BUILD: '0' } },
    {
      ensureCliBuiltImpl: async (_cliDir, options) => {
        calls.push(options.buildCli);
        if (options.buildCli) {
          await mkdir(dirname(distEntrypoint), { recursive: true });
          await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
          await writeDistBuildManifestForTest(distEntrypoint, 'abcdef1234567890');
          return { built: true, current: true, reason: 'changed' };
        }
        return { built: false, current: false, reason: 'disabled' };
      },
    },
  );

  assert.deepEqual(calls, [false, true]);
  assert.equal(result.ok, true);
  assert.equal(result.current, true);
  assert.equal(result.built, true);
});

test('source admission does not force a disabled build when prior dist is valid', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-disabled-cli-valid-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  await writeDistBuildManifestForTest(distEntrypoint, 'abcdef1234567890');
  const calls = [];
  const probes = [];

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_CLI_BUILD: '0' } },
    {
      ensureCliBuiltImpl: async (_cliDir, options) => {
        calls.push(options.buildCli);
        return { built: false, current: false, reason: 'disabled' };
      },
      probeCliDistRuntimeImportImpl: async (entrypoint) => {
        probes.push(entrypoint);
      },
    },
  );

  assert.deepEqual(calls, [false]);
  assert.deepEqual(probes, [distEntrypoint]);
  assert.equal(result.ok, true);
  assert.equal(result.current, false);
  assert.equal(result.built, false);
  assert.equal(result.degraded, true);
  assert.equal(result.fallbackFingerprint, 'abcdef1234567890');
});

test('source admission exposes an unchanged runnable prior dist as degraded when the current build fails', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-cli-build-failed-fallback-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  await writeDistBuildManifestForTest(distEntrypoint, 'abcdef1234567890');
  const probes = [];

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => {
        throw new Error('yarn failed (code=47)');
      },
      probeCliDistRuntimeImportImpl: async (entrypoint, options) => {
        probes.push({ entrypoint, timeoutMs: options.timeoutMs });
      },
    },
  );

  assert.deepEqual(probes, [{ entrypoint: distEntrypoint, timeoutMs: 120_000 }]);
  assert.equal(result.ok, true);
  assert.equal(result.current, false);
  assert.equal(result.degraded, true);
  assert.equal(result.fallbackFingerprint, 'abcdef1234567890');
  assert.match(result.reason, /build_failed:yarn failed \(code=47\)/);
});

test('source admission uses a successful current build without entering degraded fallback', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-cli-current-build-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  await writeDistBuildManifestForTest(distEntrypoint, 'abcdef1234567890');

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => ({ built: true, current: true, reason: 'changed' }),
      probeCliDistRuntimeImportImpl: async () => {
        throw new Error('current build must not enter prior-dist probing');
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.current, true);
  assert.notEqual(result.degraded, true);
  assert.equal(result.reason, 'changed');
});

test('source admission exposes a successful but superseded build as degraded without rebuilding or reproving it', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-cli-superseded-build-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  await writeDistBuildManifestForTest(distEntrypoint, 'abcdef1234567890');

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => ({
        built: true,
        current: false,
        reason: 'inputs_changed_during_build',
      }),
      probeCliDistRuntimeImportImpl: async () => {
        throw new Error('the successful build owner already proved the published artifact');
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.current, false);
  assert.equal(result.built, true);
  assert.equal(result.degraded, true);
  assert.equal(result.fallbackFingerprint, 'abcdef1234567890');
  assert.equal(result.reason, 'inputs_changed_during_build');
});

test('source admission never promotes a different dist identity from a failed rebuild', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-cli-build-failed-mutated-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  await writeDistBuildManifestForTest(distEntrypoint, 'aaaaaaaaaaaaaaaa');
  let probes = 0;

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => {
        await writeDistBuildManifestForTest(distEntrypoint, 'bbbbbbbbbbbbbbbb');
        throw new Error('build failed after publication attempt');
      },
      probeCliDistRuntimeImportImpl: async () => {
        probes += 1;
      },
    },
  );

  assert.equal(probes, 0);
  assert.notEqual(result.degraded, true);
  assert.equal(result.current, false);
  assert.equal(result.fallbackRejectedReason, 'dist_identity_changed_during_failed_build');
  assert.match(result.reason, /build_failed/);
});

test('source admission rejects a manifest-valid prior dist when its runtime import probe fails', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-cli-build-failed-probe-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, "import './missing-chunk.mjs';\n", 'utf-8');
  await writeDistBuildManifestForTest(distEntrypoint, 'abcdef1234567890');

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => {
        throw new Error('yarn failed (code=47)');
      },
      probeCliDistRuntimeImportImpl: async () => {
        throw new Error('runtime import failed');
      },
    },
  );

  assert.notEqual(result.degraded, true);
  assert.match(result.fallbackRejectedReason, /^runtime_probe_failed:runtime import failed/);
});

test('source admission fails closed when the disabled-build recovery cannot produce valid dist', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-disabled-cli-failed-bootstrap-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  const calls = [];

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_CLI_BUILD: '0' } },
    { ensureCliBuiltImpl: async (_cliDir, options) => {
      calls.push(options.buildCli);
      if (options.buildCli) throw new Error('forced build failed');
      return { built: false, current: false, reason: 'disabled' };
    } },
  );

  assert.deepEqual(calls, [false, true]);
  assert.equal(result.ok, false);
  assert.equal(result.current, false);
  assert.equal(result.fallbackRejectedReason, 'no_usable_prior_dist');
  assert.match(result.reason, /forced build failed/);
});

test('source daemon admission reuses an exact watcher-admitted dist without a second always build', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-watcher-admitted-cli-build-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  await writeDistBuildManifestForTest(distEntrypoint, 'abcdef1234567890');
  let buildCalls = 0;

  const result = await ensureHappierCliDistExists(
    {
      cliBin,
      admittedDistClosureFingerprint: 'abcdef1234567890',
      env: {
        ...process.env,
        HAPPIER_STACK_REPO_DIR: repoDir,
        HAPPIER_STACK_CLI_BUILD_MODE: 'always',
      },
    },
    {
      ensureCliBuiltImpl: async () => {
        buildCalls += 1;
        return { built: true, current: true, reason: 'always' };
      },
    },
  );

  assert.equal(buildCalls, 0, 'the watcher build is the sole full-build admission for this generation');
  assert.equal(result.ok, true);
  assert.equal(result.current, true);
  assert.equal(result.built, false);
  assert.equal(result.reason, 'admitted-dist-closure');

  const mismatch = await ensureHappierCliDistExists(
    {
      cliBin,
      admittedDistClosureFingerprint: '1111111111111111',
      env: {
        ...process.env,
        HAPPIER_STACK_REPO_DIR: repoDir,
        HAPPIER_STACK_CLI_BUILD_MODE: 'always',
      },
    },
    {
      ensureCliBuiltImpl: async () => {
        buildCalls += 1;
        return { built: true, current: true, reason: 'always' };
      },
    },
  );
  assert.equal(buildCalls, 0, 'a mismatched watcher proof must fail closed instead of admitting a second build');
  assert.equal(mismatch.ok, true);
  assert.equal(mismatch.current, false);
  assert.match(mismatch.reason, /admitted_dist_mismatch/);
});

test('source daemon final launch rejects an admitted fingerprint replaced under the lifecycle lock', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hstack-source-final-admission-race-'));
  t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
  const daemonModuleUrl = new URL('./daemon.mjs', import.meta.url).href;
  const cliDistBuildLockModuleUrl = new URL('./utils/proc/cliDistBuildLock.mjs', import.meta.url).href;
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';

const { resolveCliDistBuildLockPath, withCliDistBuildLock } = await import(${JSON.stringify(cliDistBuildLockModuleUrl)});

const root = ${JSON.stringify(fixtureRoot)};
const repoDir = join(root, 'repo');
const cliDir = join(repoDir, 'apps', 'cli');
const cliBin = join(cliDir, 'bin', 'happier.mjs');
const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
const manifestPath = join(cliDir, 'dist', '.build-manifest.json');
const cliHomeDir = join(root, 'home');
const spawnMarker = join(root, 'spawned.txt');
const admittedFingerprint = 'aaaaaaaaaaaaaaaa';
const replacementFingerprint = 'bbbbbbbbbbbbbbbb';
const manifest = (fingerprint) => JSON.stringify({ fingerprint, fileCount: 1 }) + '\\n';

fs.mkdirSync(dirname(cliBin), { recursive: true });
fs.mkdirSync(dirname(distEntrypoint), { recursive: true });
fs.writeFileSync(cliBin, '#!/usr/bin/env node\\n', 'utf-8');
fs.writeFileSync(
  distEntrypoint,
  'import { appendFileSync } from "node:fs"; appendFileSync(process.env.SPAWN_MARKER, process.argv.join(" ") + "\\\\n");',
  'utf-8',
);
fs.writeFileSync(manifestPath, manifest(admittedFingerprint), 'utf-8');

const originalReadFileSync = fs.readFileSync;
let manifestReads = 0;
let replacedUnderLifecycleLock = false;
fs.readFileSync = function patchedReadFileSync(path, ...args) {
  const result = originalReadFileSync.call(this, path, ...args);
  if (String(path) === manifestPath) {
    manifestReads += 1;
    if (manifestReads === 3) {
      const lockFiles = fs.existsSync(join(cliHomeDir, 'locks'))
        ? fs.readdirSync(join(cliHomeDir, 'locks')).filter((name) => name.startsWith('daemon-lifecycle-'))
        : [];
      assert.equal(lockFiles.length, 1, 'preliminary admission must be inside the existing lifecycle lock');
      fs.writeFileSync(manifestPath, manifest(replacementFingerprint), 'utf-8');
      replacedUnderLifecycleLock = true;
    }
  }
  return result;
};
syncBuiltinESMExports();

const { startLocalDaemonWithAuth } = await import(${JSON.stringify(daemonModuleUrl)});
let failure = null;
try {
  await startLocalDaemonWithAuth({
    cliBin,
    cliHomeDir,
    internalServerUrl: 'http://127.0.0.1:43123',
    publicServerUrl: 'http://localhost:43123',
    isShuttingDown: () => false,
    env: {
      ...process.env,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '100',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '10',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      SPAWN_MARKER: spawnMarker,
    },
    stackName: 'dev',
    admittedDistClosureFingerprint: admittedFingerprint,
  });
} catch (error) {
  failure = error;
}

assert.equal(replacedUnderLifecycleLock, true);
assert.equal(failure?.code, 'ECLIDISTSTALECOLDSTART');
assert.equal(fs.existsSync(spawnMarker), false, 'no daemon stop/start command may spawn after final admission fails');
const remainingLifecycleLocks = fs.existsSync(join(cliHomeDir, 'locks'))
  ? fs.readdirSync(join(cliHomeDir, 'locks')).filter((name) => name.startsWith('daemon-lifecycle-'))
  : [];
assert.deepEqual(remainingLifecycleLocks, [], 'typed admission failure must release the existing lifecycle lock');
`;

  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf-8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('source daemon final admission uses a validated fallback when the explicit fingerprint is whitespace', () => {
  const fallbackFingerprint = '1111111111111111';

  assert.equal(
    assertFinalSourceDaemonDistAdmission({
      admittedDistClosureFingerprint: '   ',
      fallbackFingerprint,
      finalFingerprint: fallbackFingerprint,
    }),
    fallbackFingerprint,
  );

  let spawned = false;
  assert.throws(
    () => {
      assertFinalSourceDaemonDistAdmission({
        admittedDistClosureFingerprint: '   ',
        fallbackFingerprint,
        finalFingerprint: '2222222222222222',
      });
      spawned = true;
    },
    (error) => error?.code === 'ECLIDISTSTALECOLDSTART',
  );
  assert.equal(spawned, false, 'a changed final manifest must be rejected before daemon spawn');
});

test('source daemon lifecycle commands run after the CLI publication lock is released', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hstack-source-lifecycle-outside-build-lock-'));
  t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
  const repoDir = join(fixtureRoot, 'repo');
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  const lockPath = join(repoDir, '.project', 'tmp', 'cli-dist-build.lock');
  const eventsPath = join(fixtureRoot, 'events.jsonl');
  const cliHomeDir = join(fixtureRoot, 'home');
  const fingerprint = 'aaaaaaaaaaaaaaaa';

  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await mkdir(join(repoDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoDir, 'apps', 'server'), { recursive: true });
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf-8');
  await writeFile(join(repoDir, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/ui"}\n', 'utf-8');
  await writeFile(join(repoDir, 'apps', 'server', 'package.json'), '{"name":"@happier-dev/server"}\n', 'utf-8');
  await writeFile(cliBin, '#!/usr/bin/env node\n', 'utf-8');
  await writeFile(
    distEntrypoint,
    [
      "import { appendFileSync, existsSync } from 'node:fs';",
      'appendFileSync(process.env.EVENTS_PATH, JSON.stringify({',
      '  args: process.argv.slice(2),',
      '  publicationLockHeld: existsSync(process.env.PUBLICATION_LOCK_PATH),',
      "  publicationLockLease: process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD || null,",
      "}) + '\\n');",
      "if (process.argv[2] === 'start') process.exit(1);",
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8',
  );
  await writeDistBuildManifestForTest(distEntrypoint, fingerprint);
  await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
  await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

  await assert.rejects(
    () => startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:43123',
      publicServerUrl: 'http://localhost:43123',
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_REPO_DIR: repoDir,
        HAPPIER_STACK_TUI: '0',
        HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '20',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        EVENTS_PATH: eventsPath,
        PUBLICATION_LOCK_PATH: lockPath,
      }),
      stackName: 'dev',
      admittedDistClosureFingerprint: fingerprint,
    }),
    /Failed to start daemon/,
  );

  const events = (await readFile(eventsPath, 'utf-8'))
    .trim()
    .split(/\n+/)
    .map((line) => JSON.parse(line));
  assert.ok(events.some(({ args }) => args[0] === 'daemon' && args[1] === 'start'));
  assert.ok(
    events.every(({ publicationLockHeld }) => publicationLockHeld === false),
    `daemon command ran while publication lock was held:\n${JSON.stringify(events, null, 2)}`,
  );
  assert.ok(
    events.every(({ publicationLockLease }) => publicationLockLease === null),
    `daemon command inherited a publication-lock lease:\n${JSON.stringify(events, null, 2)}`,
  );
});

test('applyDaemonDistClosureRuntimeEnv exposes the current stack dist fingerprint to source daemon child spawns', () => {
  const env = { KEEP_ME: '1' };

  const nextEnv = applyDaemonDistClosureRuntimeEnv(env, {
    runtimeStatePath: '/tmp/happier/stack.runtime.json',
    distEntrypoint: '/repo/apps/cli/dist/index.mjs',
    distClosureFingerprint: 'abc123def4567890',
  });

  assert.equal(nextEnv, env);
  assert.equal(nextEnv.KEEP_ME, '1');
  assert.equal(nextEnv.HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH, '/tmp/happier/stack.runtime.json');
  assert.equal(nextEnv.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, '/repo/apps/cli/dist/index.mjs');
  assert.equal(nextEnv.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT, 'abc123def4567890');
  assert.equal(nextEnv.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, undefined);
});

test('applyDaemonDistClosureRuntimeEnv marks an admitted runtime-backed daemon and preserves its immutable fingerprint', () => {
  const env = {};

  applyDaemonDistClosureRuntimeEnv(env, {
    runtimeStatePath: '/tmp/happier/stack.runtime.json',
    distEntrypoint: '/tmp/happier/runtime/builds/snap-1/cli/package-dist/index.mjs',
    distClosureFingerprint: 'abc123def4567890',
    runtimeBacked: true,
  });

  assert.equal(env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, '1');
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, '/tmp/happier/runtime/builds/snap-1/cli/package-dist/index.mjs');
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT, 'abc123def4567890');
});

test('applyDaemonDistClosureRuntimeEnv clears the dist runner fast path when the fingerprint is missing', () => {
  const env = {
    HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: '/tmp/happier/stack.runtime.json',
    HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '/repo/apps/cli/dist/index.mjs',
    HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: 'abc123def4567890',
    HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
  };

  applyDaemonDistClosureRuntimeEnv(env, {
    runtimeStatePath: '/tmp/happier/stack.runtime.json',
    distEntrypoint: '/repo/apps/cli/dist/index.mjs',
    distClosureFingerprint: null,
  });

  assert.equal(env.HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH, undefined);
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, undefined);
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT, undefined);
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, undefined);
});

test('applyDaemonDistClosureRuntimeEnv pins detached daemon launch without a runtime projection path', () => {
  const env = {};

  applyDaemonDistClosureRuntimeEnv(env, {
    runtimeStatePath: null,
    distEntrypoint: '/repo/apps/cli/dist/index.mjs',
    distClosureFingerprint: 'abc123def4567890',
  });

  assert.equal(env.HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH, undefined);
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, '/repo/apps/cli/dist/index.mjs');
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT, 'abc123def4567890');
});

test('daemon dist guard does not restart when only dist mtimes are newer than daemon startup', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-mtime-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const fingerprint = 'abc123def4567890';
  await writeFile(
    runtimeStatePath,
    JSON.stringify({ daemon: { distClosureFingerprint: fingerprint } }),
    'utf-8',
  );

  const reason = resolveDaemonDistRestartReason({
    distEntrypoint: join(tmp, 'cli', 'dist', 'index.mjs'),
    distClosure: {
      ok: true,
      fingerprint,
      maxMtimeMs: 2_000,
    },
    runtimeStatePath,
  });

  assert.equal(reason, null);
});

test('runtime-backed daemon adoption requires a valid authenticated fingerprint equal to the admitted closure', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-runtime-daemon-authenticated-fingerprint-'));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const admittedFingerprint = 'bbbbbbbbbbbbbbbb';
  await writeFile(
    runtimeStatePath,
    JSON.stringify({ daemon: { distClosureFingerprint: admittedFingerprint } }) + '\n',
    'utf-8',
  );
  const input = {
    distEntrypoint: join(tmp, 'runtime', 'builds', 'snap-b', 'cli', 'package-dist', 'index.mjs'),
    distClosure: { ok: true, fingerprint: admittedFingerprint },
    runtimeStatePath,
    runtimeBacked: true,
  };

  assert.match(resolveDaemonDistRestartReason({
    ...input,
    observedDaemonDistFingerprint: 'aaaaaaaaaaaaaaaa',
  }), /different|mismatch|invalid/i);
  assert.match(resolveDaemonDistRestartReason({
    ...input,
    observedDaemonDistFingerprint: null,
  }), /missing|invalid|fingerprint/i);
  assert.match(resolveDaemonDistRestartReason({
    ...input,
    observedDaemonDistFingerprint: 'not-a-fingerprint',
  }), /missing|invalid|fingerprint/i);
  assert.equal(resolveDaemonDistRestartReason({
    ...input,
    observedDaemonDistFingerprint: admittedFingerprint,
  }), null);
});

async function reserveLoopbackServerUrls() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string', 'expected loopback listener to expose a numeric port');
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return {
    internalServerUrl: `http://127.0.0.1:${port}`,
    publicServerUrl: `http://localhost:${port}`,
  };
}

function overrideProcessReleaseNameForTest(nextName) {
  const descriptor = Object.getOwnPropertyDescriptor(process.release, 'name');
  assert.ok(descriptor?.configurable, 'process.release.name must be configurable for test');
  Object.defineProperty(process.release, 'name', {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    writable: descriptor.writable ?? false,
    value: nextName,
  });
  return () => {
    Object.defineProperty(process.release, 'name', {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      writable: descriptor.writable ?? false,
      value: descriptor.value,
    });
  };
}

const FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT = `
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const statePath = process.argv[1];
if (!statePath) process.exit(2);

const server = http.createServer((req, res) => {
  if (req.url === '/ping') {
    const distClosureFingerprint = String(
      process.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT || '',
    ).trim();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      ...(/^[a-f0-9]{16}$/.test(distClosureFingerprint) ? { distClosureFingerprint } : {}),
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not-found' }));
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      pid: process.pid,
      httpPort: address.port,
      controlToken: '',
      startTime: new Date().toISOString(),
    }),
    'utf-8',
  );
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 50).unref();
});

setInterval(() => {}, 1000);
`;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function fakePingAwareDaemonSpawnerSource() {
  return `
const FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT = ${JSON.stringify(FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT)};

function startFakePingAwareDaemon(statePath) {
  const forcedDistClosureFingerprint = String(
    process.env.HAPPIER_TEST_DAEMON_CHILD_DIST_FINGERPRINT || '',
  ).trim();
  const child = spawn(process.execPath, ['-e', FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT, statePath, 'daemon', 'start'], {
    detached: true,
    env: {
      ...process.env,
      ...(forcedDistClosureFingerprint
        ? { HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: forcedDistClosureFingerprint }
        : {}),
    },
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}
`;
}

async function writeStubHappyCli({ cliDir }) {
  // Dist entrypoint exists, but package.json intentionally has no build script.
  // startLocalDaemonWithAuth should launch the daemon via dist (not via bin/happier.mjs).
  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'daemon') process.exit(0);
if (args[1] === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    // If the implementation accidentally invokes bin/happier.mjs instead of dist/index.mjs, fail loudly.
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function writeSlowStartStubHappyCli({ cliDir }) {
  const distScript = `
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
const eventsPath = process.env.HAPPIER_TEST_DAEMON_EVENTS_PATH;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

function event(name) {
  if (eventsPath) appendFileSync(eventsPath, name + '\\n', 'utf-8');
}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  event('stop');
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  event('start');
  await delay(400);
  startFakePingAwareDaemon(state);
  await delay(100);
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function writeDelayedStopStubHappyCli({ cliDir }) {
  const distScript = `
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
const eventsPath = process.env.HAPPIER_TEST_DAEMON_EVENTS_PATH;
if (!home) process.exit(2);
const lifecycleScopeId = String(process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID || '').trim();
const state = lifecycleScopeId
  ? join(home, 'servers', lifecycleScopeId, 'daemon.state.json')
  : join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

function event(name) {
  if (eventsPath) appendFileSync(eventsPath, name + '\\n', 'utf-8');
}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  event('stop');
  await delay(250);
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  event('start');
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function writePidOnlyFalseReadyStubHappyCli({ cliDir }) {
  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'daemon', 'start'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(state, JSON.stringify({ pid: child.pid, httpPort: 0, startTime: new Date().toISOString() }), 'utf-8');
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

test('pid-only false-ready fixture publishes daemon command identity and cleans up its child', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-pid-only-identity-'));
  let fixturePid = null;
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writePidOnlyFalseReadyStubHappyCli({ cliDir });
    const cliEntrypoint = join(cliDir, 'dist', 'index.mjs');
    const cliHomeDir = join(tmp, 'cli-home');
    await mkdir(cliHomeDir, { recursive: true });
    const env = {
      ...process.env,
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_PROCESS_KIND: 'daemon',
    };

    execFileSync(process.execPath, [cliEntrypoint, 'daemon', 'start'], { env, stdio: 'ignore' });
    fixturePid = await readDaemonPid(join(cliHomeDir, 'daemon.state.json'));
    const command = execFileSync('ps', ['-p', String(fixturePid), '-o', 'command='], { encoding: 'utf8' });
    assert.match(command, /daemon start/);

    execFileSync(process.execPath, [cliEntrypoint, 'daemon', 'stop'], { env, stdio: 'ignore' });
    assert.equal(await waitForProcessExit(fixturePid), true, `expected fixture daemon pid ${fixturePid} to exit`);
    fixturePid = null;
  } finally {
    if (fixturePid) {
      try { process.kill(fixturePid, 'SIGKILL'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

async function writeRuntimeSnapshotHappyCli({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  await mkdir(cliDir, { recursive: true });
  const implPath = join(cliDir, 'runtime-cli.mjs');
  const cliBin = join(cliDir, 'happier');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;
  await writeFile(implPath, distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, `#!/bin/sh\nexec "${process.execPath}" "${implPath}" "$@"\n`, 'utf-8');
  await chmod(cliBin, 0o755);
  return cliBin;
}

async function writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  const packageDistDir = join(cliDir, 'package-dist');
  await mkdir(packageDistDir, { recursive: true });
  const cliBin = join(cliDir, 'happier');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start-sync' || sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;

  await writeFile(join(packageDistDir, 'index.mjs'), distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, 'exit 42\n', 'utf-8');
  await chmod(cliBin, 0o755);
  return {
    cliBin,
    cliNodeEntrypoint: join(packageDistDir, 'index.mjs'),
  };
}

async function writeRuntimeSnapshotHappyCliJsCommand({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  await mkdir(cliDir, { recursive: true });
  const cliBin = join(cliDir, 'happier');
  const cliCommand = join(cliDir, 'happier.mjs');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'start-sync' || sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;

  await writeFile(cliCommand, distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, 'exit 42\n', 'utf-8');
  await chmod(cliBin, 0o755);
  return {
    cliBin,
    cliCommand,
  };
}

async function writePathResolvedRuntimeCommand({
  binDir,
  stopMode = 'kill-state',
  preStartObservationPath = '',
  preStartStatePath = '',
  preStartLockPath = '',
} = {}) {
  await mkdir(binDir, { recursive: true });
  const commandPath = join(binDir, 'happier-runtime-cmd');
  const observedStatePathLine = preStartStatePath
    ? `STATE=${shellQuote(preStartStatePath)}`
    : '';
  const preStartObservation = preStartObservationPath
    ? `"${process.execPath}" -e ${shellQuote(`
const fs = require('node:fs');
const readExact = (path) => {
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
};
fs.writeFileSync(
  process.argv[3],
  JSON.stringify({
    stateRaw: readExact(process.argv[1]),
    lockRaw: readExact(process.argv[2]),
  }),
  'utf-8',
);
`)} ${shellQuote(preStartStatePath)} ${shellQuote(preStartLockPath)} ${shellQuote(preStartObservationPath)} || exit $?`
    : '';
  const script = `#!/bin/sh
HOME_DIR="${'$'}{HAPPIER_HOME_DIR:-${'$'}{HAPPIER_STACK_CLI_HOME_DIR:-}}"
if [ -z "$HOME_DIR" ]; then
  exit 2
fi
STATE="$HOME_DIR/daemon.state.json"
${observedStatePathLine}
case "$1" in
  daemon)
    case "$2" in
      start)
        ${preStartObservation}
        "${process.execPath}" -e ${shellQuote(FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT)} "$STATE" daemon start >/dev/null 2>&1 &
        exit 0
        ;;
      stop)
        if [ "${stopMode}" = "kill-state" ] && [ -f "$STATE" ]; then
          pid=$("${process.execPath}" -e "const fs=require('node:fs');const raw=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(raw.pid ?? ''));" "$STATE")
          if [ -n "$pid" ]; then
            kill "$pid" >/dev/null 2>&1 || true
          fi
          rm -f "$STATE"
        fi
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  *)
    exit 0
    ;;
esac
`;
  await writeFile(commandPath, script, 'utf-8');
  await chmod(commandPath, 0o755);
  return { cliCommand: 'happier-runtime-cmd', commandPath };
}

async function readDaemonPid(statePath) {
  return Number(JSON.parse(await readFile(statePath, 'utf-8')).pid);
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function writeDistBuildManifestForTest(distEntrypoint, fingerprint) {
  await writeFile(
    join(dirname(distEntrypoint), '.build-manifest.json'),
    JSON.stringify({
      fingerprint,
      builtAt: '2026-07-09T00:00:00.000Z',
      fileCount: 1,
      toolVersion: '1',
    }) + '\n',
    'utf-8',
  );
}

async function spawnReplacementDaemonForTest({ statePath, env, previousPid }) {
  const child = spawn(process.execPath, ['-e', FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT, statePath], {
    detached: true,
    env,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const pid = await readDaemonPid(statePath);
      if (pid === child.pid && pid !== previousPid) return pid;
    } catch {
      // Replacement has not published its state yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('test replacement daemon did not publish a successor state');
}

async function spawnUnreachableDaemonForTest({ statePath, env }) {
  const script = `
const fs = require('node:fs');
const path = require('node:path');
const statePath = process.argv[1];
fs.mkdirSync(path.dirname(statePath), { recursive: true });
fs.writeFileSync(statePath, JSON.stringify({
  pid: process.pid,
  httpPort: 1,
  controlToken: 'unknown-control-owner',
  startTime: new Date().toISOString(),
}), 'utf-8');
setInterval(() => {}, 1000);
`;
  const child = spawn(process.execPath, ['-e', script, statePath], {
    detached: true,
    env,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (await readDaemonPid(statePath) === child.pid) return child.pid;
    } catch {
      // The unreachable fixture has not published state yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('test unreachable daemon did not publish state');
}

test('startLocalDaemonWithAuth requires daemon control ping before accepting running daemon state', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-ping-ready-'));
  let fixturePid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writePidOnlyFalseReadyStubHappyCli({ cliDir });
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '250',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    });

    await assert.rejects(
      () =>
        startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName: 'dev',
          cliIdentity: 'default',
        }),
      /Failed to start daemon|daemon failed to start/i,
    );
    fixturePid = await readDaemonPid(join(cliHomeDir, 'daemon.state.json'));

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
    assert.equal(await waitForProcessExit(fixturePid), true, `expected fixture daemon pid ${fixturePid} to exit`);
    fixturePid = null;
  } finally {
    if (fixturePid) {
      try { process.kill(fixturePid, 'SIGKILL'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not require a second CLI build when dist/index.mjs already exists', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-guard-'));
  let fixturePid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
    });

    // If startLocalDaemonWithAuth tries to rebuild, this will fail because package.json has no build script.
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    fixturePid = await readDaemonPid(join(cliHomeDir, 'daemon.state.json'));

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
    assert.equal(await waitForProcessExit(fixturePid), true, `expected fixture daemon pid ${fixturePid} to exit`);
    fixturePid = null;

    assert.ok(true);
  } finally {
    if (fixturePid) {
      try { process.kill(fixturePid, 'SIGKILL'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth cold-starts runnable prior dist and preserves the exact live daemon', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-stale-cold-start-'));

  const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
  const cliDir = join(tmp, 'apps', 'cli');
  const cliBin = await writeStubHappyCli({ cliDir });
  for (const app of ['ui', 'server']) {
    await mkdir(join(tmp, 'apps', app), { recursive: true });
    await writeFile(join(tmp, 'apps', app, 'package.json'), `{ "name": "${app}-test" }\n`, 'utf-8');
  }
  await writeFile(join(tmp, 'package.json'), '{ "private": true }\n', 'utf-8');
  await writeWorkspacePackageBuildOwnerStub(tmp);
  await writeFile(join(tmp, 'yarn.lock'), '# root yarn\n', 'utf-8');
  await mkdir(join(tmp, 'node_modules'), { recursive: true });
  await writeFile(join(tmp, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const cliHomeDir = join(tmp, 'stack', 'cli');
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
  await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

  const env = buildDaemonDistGuardEnv({
    HAPPIER_STACK_REPO_DIR: tmp,
    HAPPIER_STACK_HOME_DIR: join(tmp, 'hstack-home'),
    HAPPIER_STACK_CLI_BUILD: '0',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
  });
  t.after(async () => {
    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
      stackName: 'dev',
    }).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  });

  await startLocalDaemonWithAuth({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: false,
    env,
    stackName: 'dev',
    cliIdentity: 'default',
  });
  const livePid = checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env }).pid;
  assert.ok(Number(livePid) > 1);

  await startLocalDaemonWithAuth({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: false,
    env: {
      ...env,
      HAPPIER_STACK_REPO_DIR: '',
      HAPPIER_STACK_CLI_ROOT_DIR: tmp,
    },
    stackName: 'dev',
    cliIdentity: 'default',
  });
  assert.equal(
    checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env }).pid,
    livePid,
    'an unavailable current build must preserve the exact already-live daemon',
  );

  await stopLocalDaemon({
    cliBin,
    internalServerUrl,
    cliHomeDir,
    env,
    stackName: 'dev',
  });
  const binDir = join(tmp, 'bin');
  const yarnPath = join(binDir, 'yarn');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'lsof'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_LISTEN_PID"\n', 'utf-8');
  await writeFile(join(binDir, 'ps'), `#!/bin/sh
case "$*" in
  *"pgid="*) printf "%s\\n" "$FAKE_LISTEN_PID" ;;
  *"eww -p $FAKE_LISTEN_PID"*)
    printf "PID COMMAND\\n"
    printf "%s node HAPPIER_STACK_STACK=%s HAPPIER_STACK_ENV_FILE=%s HAPPIER_STACK_PROCESS_KIND=server\\n" \
      "$FAKE_LISTEN_PID" "$FAKE_STACK_NAME" "$FAKE_STACK_ENV_FILE"
    ;;
  *) exec /bin/ps "$@" ;;
esac
`, 'utf-8');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "--version" ]; then echo "1.22.22"; fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(join(binDir, 'lsof'), 0o755);
  await chmod(join(binDir, 'ps'), 0o755);
  await chmod(yarnPath, 0o755);
  const buildEnv = {
    ...env,
    PATH: `${binDir}:/usr/bin:/bin`,
    HAPPIER_STACK_CLI_BUILD: '1',
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
  };
  await startLocalDaemonWithAuth({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: false,
    env: buildEnv,
    stackName: 'dev',
    cliIdentity: 'default',
  });
  await stopLocalDaemon({
    cliBin,
    internalServerUrl,
    cliHomeDir,
    env: buildEnv,
    stackName: 'dev',
  });
  const upToDateEnv = { ...buildEnv, HAPPIER_STACK_CLI_BUILD_MODE: 'auto' };
  await startLocalDaemonWithAuth({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: false,
    env: upToDateEnv,
    stackName: 'dev',
    cliIdentity: 'default',
  });
  assert.equal(
    checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env: upToDateEnv }).status,
    'running',
    'an up-to-date admitted dist must remain launchable',
  );
});

test('source stack start uses an unchanged runnable prior dist when the current CLI build fails', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-run-stale-cold-start-'));
  const repoDir = join(tmp, 'repo');
  const cliDir = join(repoDir, 'apps', 'cli');
  await writeStubHappyCli({ cliDir });
  const cliHomeDir = join(tmp, 'cli-home');
  const stackName = `stale-cold-${process.pid}`;
  const envPath = join(tmp, 'stacks', stackName, 'env');
  const runtimeStatePath = join(tmp, 'stacks', stackName, 'stack.runtime.json');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, '\n', 'utf-8');
  const healthServer = spawn(process.execPath, ['-e', `
    const { createServer } = require('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `], {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'server',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const healthServerExit = new Promise((resolve) => healthServer.once('exit', resolve));
  const serverPort = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for health server port')), 2_000);
    healthServer.stdout.on('data', (chunk) => {
      output += String(chunk);
      const value = Number(output.trim().split(/\s+/)[0]);
      if (Number.isInteger(value) && value > 0) {
        clearTimeout(timer);
        resolve(value);
      }
    });
    healthServer.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`health server exited before readiness (code=${code}, signal=${signal})`));
    });
  });
  const internalServerUrl = `http://127.0.0.1:${serverPort}`;

  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await mkdir(join(repoDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoDir, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoDir, 'package.json'), '{ "private": true }\n', 'utf-8');
  await writeWorkspacePackageBuildOwnerStub(repoDir);
  await writeFile(join(repoDir, 'yarn.lock'), '# test lock\n', 'utf-8');
  const binDir = join(tmp, 'bin');
  const yarnPath = join(binDir, 'yarn');
  const ownershipLogPath = join(tmp, 'listener-ownership.log');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, 'lsof'),
    '#!/bin/sh\nprintf "lsof\\n" >> "$FAKE_OWNERSHIP_LOG"\nprintf "%s\\n" "$FAKE_LISTEN_PID"\n',
    'utf-8',
  );
  await writeFile(join(binDir, 'ps'), `#!/bin/sh
printf "ps\\n" >> "$FAKE_OWNERSHIP_LOG"
case "$*" in
  *"pgid="*) printf "%s\\n" "$FAKE_LISTEN_PID" ;;
  *"eww -p $FAKE_LISTEN_PID"*)
    printf "PID COMMAND\\n"
    printf "%s node HAPPIER_STACK_STACK=%s HAPPIER_STACK_ENV_FILE=%s HAPPIER_STACK_PROCESS_KIND=server\\n" \
      "$FAKE_LISTEN_PID" "$FAKE_STACK_NAME" "$FAKE_STACK_ENV_FILE"
    ;;
  *) exec /bin/ps "$@" ;;
esac
`, 'utf-8');
  await writeFile(
    yarnPath,
    `#!${process.execPath}\n` +
      `if (process.argv.includes('--version')) { console.log('1.22.22'); process.exit(0); }\n` +
      `if (process.argv.includes('build')) process.exit(47);\n` +
      `process.exit(0);\n`,
    'utf-8',
  );
  await chmod(join(binDir, 'lsof'), 0o755);
  await chmod(join(binDir, 'ps'), 0o755);
  await chmod(yarnPath, 0o755);
  await writeFile(
    join(cliDir, 'package.json'),
    JSON.stringify({
      name: 'fake-cli',
      private: true,
      scripts: {
        build: `${JSON.stringify(process.execPath)} -e "process.exit(47)"`,
      },
    }) + '\n',
    'utf-8',
  );
  await writeFile(join(repoDir, 'apps', 'ui', 'package.json'), '{ "name": "fake-ui" }\n', 'utf-8');
  await writeFile(
    join(repoDir, 'apps', 'server', 'package.json'),
    JSON.stringify({ name: 'fake-server', private: true, scripts: { start: 'node server.mjs' } }) + '\n',
    'utf-8',
  );
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
  await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

  const env = buildDaemonDistGuardEnv({
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    HAPPIER_STACK_HOME_DIR: join(tmp, 'hstack-home'),
    HAPPIER_STACK_STORAGE_DIR: join(tmp, 'stacks'),
    HAPPIER_STACK_STACK: '',
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
    HAPPIER_STACK_RUNTIME_MODE: 'source',
    HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    HAPPIER_STACK_SERVER_PORT: String(serverPort),
    HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
    HAPPIER_STACK_MANAGED_INFRA: '0',
    HAPPIER_STACK_CLI_BUILD: '1',
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
    HAPPIER_STACK_SERVE_UI: '0',
    HAPPIER_STACK_NO_BROWSER: '1',
    FAKE_LISTEN_PID: String(healthServer.pid),
    FAKE_STACK_NAME: stackName,
    FAKE_STACK_ENV_FILE: envPath,
    FAKE_OWNERSHIP_LOG: ownershipLogPath,
    PATH: `${binDir}:${process.env.PATH}`,
  });
  const priorDistSource = await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8');
  const priorDistManifest = await readFile(join(cliDir, 'dist', '.build-manifest.json'), 'utf-8');
  const runPath = join(dirname(fileURLToPath(import.meta.url)), 'run.mjs');
  const runner = spawn(process.execPath, [runPath, '--source', '--server=happier-server-light', '--no-ui', '--no-browser'], {
    cwd: repoDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  runner.stdout.on('data', (chunk) => { stdout += String(chunk); });
  runner.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const runnerExit = new Promise((resolve) => runner.once('exit', (code, signal) => resolve({ code, signal })));

  t.after(async () => {
    if (runner.exitCode == null && runner.signalCode == null) runner.kill('SIGTERM');
    await Promise.race([runnerExit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (runner.exitCode == null && runner.signalCode == null) {
      runner.kill('SIGKILL');
      await Promise.race([runnerExit, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    const runtimeState = JSON.parse(await readFile(runtimeStatePath, 'utf-8').catch(() => '{}'));
    const cleanupServerUrl = Number(runtimeState?.ports?.server) > 0
      ? `http://127.0.0.1:${runtimeState.ports.server}`
      : internalServerUrl;
    const remainingDaemon = checkDaemonState(cliHomeDir, { serverUrl: cleanupServerUrl, env });
    if (Number(remainingDaemon?.pid) > 1) {
      try { process.kill(remainingDaemon.pid, 'SIGTERM'); } catch {}
    }
    if (healthServer.exitCode == null && healthServer.signalCode == null) healthServer.kill('SIGTERM');
    await Promise.race([healthServerExit, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await rm(tmp, { recursive: true, force: true });
  });

  const deadline = Date.now() + 60_000;
  let state = null;
  let observedServerUrl = internalServerUrl;
  while (Date.now() < deadline) {
    const runtimeState = JSON.parse(await readFile(runtimeStatePath, 'utf-8').catch(() => '{}'));
    observedServerUrl = Number(runtimeState?.ports?.server) > 0
      ? `http://127.0.0.1:${runtimeState.ports.server}`
      : internalServerUrl;
    state = checkDaemonState(cliHomeDir, { serverUrl: observedServerUrl, env });
    if (state.status === 'running') break;
    if (runner.exitCode != null || runner.signalCode != null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(
    state?.status,
    'running',
    `source start did not launch the prior usable dist after current build failure\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  assert.match(
    await readFile(ownershipLogPath, 'utf-8'),
    /lsof/,
    'the admission fixture must use its deterministic listener adapter',
  );
  assert.match(
    `${stdout}\n${stderr}`,
    /WARNING: happier-cli current build failed .*starting the daemon from the last usable dist.*Source changes are not active/s,
  );
  assert.equal(await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'), priorDistSource);
  assert.equal(await readFile(join(cliDir, 'dist', '.build-manifest.json'), 'utf-8'), priorDistManifest);
});

test('startLocalDaemonWithAuth ignores unreachable stale dist chunks when the entrypoint closure is complete', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-stale-unused-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    await writeFile(join(cliDir, 'dist', 'stale-unused.mjs'), "import './missing-old-chunk.mjs';\n", 'utf-8');

    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(tmp, 'yarn.lock'), '# yarn lockfile v1\n', 'utf-8');
    await writeDistBuildManifestForTest(join(cliDir, 'dist', 'index.mjs'), 'abcdef1234567890');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_REPO_DIR: tmp,
      HAPPIER_STACK_CLI_BUILD: '1',
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const daemonPid = await readDaemonPid(join(cliHomeDir, 'daemon.state.json'));
    assert.ok(daemonPid > 1, 'expected daemon start to ignore unreachable stale dist modules');

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth prefers guarded dist over package-dist when both entrypoints exist', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-preferred-'));
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const monoRoot = join(cliDir, '..', '..');
    const distScript = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
if (args[1] === 'start') {
  startFakePingAwareDaemon(join(home, 'daemon.state.json'));
}
process.exit(0);
`;
    const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
      packageJsonContent: '{}\n',
      distIndexScript: distScript.trimStart(),
      binHappierScript: 'process.exit(43);\n',
    });
    await mkdir(join(cliDir, 'package-dist'), { recursive: true });
    await writeFile(join(cliDir, 'package-dist', 'index.mjs'), 'process.exit(42);\n', 'utf-8');

    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const cliBin = join(cliBinDir, 'happier.mjs');
    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_TUI: '0',
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const daemonState = JSON.parse(await readFile(join(cliHomeDir, 'daemon.state.json'), 'utf-8'));
    daemonPid = Number(daemonState.pid);
    assert.ok(daemonPid > 1, 'expected package-dist daemon to write daemon state');

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth starts from rebuilt dist when dist is missing at command resolution time', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-rebuild-command-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const monoRoot = join(cliDir, '..', '..');
    const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'daemon') process.exit(0);
if (args[1] === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
`;
    const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
      packageJsonContent: JSON.stringify({ scripts: { build: 'node scripts/build.mjs' } }) + '\n',
      // If daemon command resolution happens before the build creates dist/index.mjs,
      // the stale fallback path invokes this bin wrapper and the test fails.
      binHappierScript: 'process.exit(42);\n',
    });
    await mkdir(join(cliDir, 'scripts'), { recursive: true });
    await writeFile(
      join(cliDir, 'scripts', 'build.mjs'),
      `import { mkdirSync, writeFileSync } from 'node:fs';\n` +
        `import { join } from 'node:path';\n` +
      `const dist = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || process.env.HAPPIER_CLI_BUILD_OUTPUT_DIR || join(process.cwd(), 'dist');\n` +
      `mkdirSync(dist, { recursive: true });\n` +
        `writeFileSync(join(dist, 'index.mjs'), ${JSON.stringify(distScript.trimStart())}, 'utf-8');\n` +
        `writeFileSync(join(dist, '.build-manifest.json'), JSON.stringify({ fingerprint: '3333333333333333', builtAt: '2026-07-09T00:00:00.000Z', fileCount: 1, toolVersion: '1' }) + '\\n', 'utf-8');\n`,
      'utf-8',
    );

    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    await writeWorkspacePackageBuildOwnerStub(tmp);
    for (const app of ['ui', 'server']) {
      const appDir = join(tmp, 'apps', app);
      await mkdir(appDir, { recursive: true });
      await writeFile(join(appDir, 'package.json'), `{ "name": "fake-${app}" }\n`, 'utf-8');
    }
    await writeFile(join(tmp, 'yarn.lock'), '# root yarn\n', 'utf-8');
    await mkdir(join(tmp, 'node_modules'), { recursive: true });
    await writeFile(join(tmp, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
    await mkdir(join(cliDir, 'node_modules'), { recursive: true });
    await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
    const binDir = join(tmp, 'bin');
    const yarnPath = join(binDir, 'yarn');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      yarnPath,
      `#!${process.execPath}\n` +
        `const { spawnSync } = require('node:child_process');\n` +
        `const { appendFileSync } = require('node:fs');\n` +
        `const { join } = require('node:path');\n` +
        `appendFileSync(process.env.HAPPIER_TEST_YARN_INVOCATIONS, process.argv.slice(2).join(' ') + '\\n');\n` +
        `if (process.argv.includes('--version')) { console.log('1.22.22'); process.exit(0); }\n` +
        `if (process.argv.includes('build')) {\n` +
        `  const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'build.mjs')], { stdio: 'inherit', env: process.env });\n` +
        `  process.exit(result.status ?? 1);\n` +
        `}\n` +
        `process.exit(0);\n`,
      'utf-8',
    );
    await chmod(yarnPath, 0o755);
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const cliBin = join(cliBinDir, 'happier.mjs');
    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_HOME_DIR: join(tmp, 'hstack-home'),
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_TUI: '0',
      HAPPIER_TEST_YARN_INVOCATIONS: join(tmp, 'yarn-invocations.log'),
      PATH: `${binDir}:${process.env.PATH}`,
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const daemonState = JSON.parse(await readFile(join(cliHomeDir, 'daemon.state.json'), 'utf-8'));
    assert.ok(Number(daemonState.pid) > 1, 'expected rebuilt dist daemon to write daemon state');
    assert.deepEqual(
      (await readFile(join(tmp, 'yarn-invocations.log'), 'utf-8')).trim().split(/\n+/),
      ['--version', 'build'],
      'the rebuild must use the caller-owned package-manager environment',
    );

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth coalesces concurrent non-forced starts behind an active restart', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-lifecycle-lock-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeSlowStartStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const eventsPath = join(tmp, 'daemon-events.log');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_TEST_DAEMON_EVENTS_PATH: eventsPath,
    });

    await Promise.all([
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        isShuttingDown: () => false,
        forceRestart: true,
        env,
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: false,
          env,
          stackName: 'dev',
          cliIdentity: 'default',
        });
      })(),
    ]);

    const events = (await readFile(eventsPath, 'utf-8')).trim().split(/\n+/).filter(Boolean);
    assert.equal(events.filter((event) => event === 'start').length, 1);

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth keeps a running daemon when a concurrent CLI build removes dist before restart', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-build-race-'));
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeDelayedStopStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const eventsPath = join(tmp, 'daemon-events.log');
    const lockPath = join(cliDir, '.dist.hstack-build.lock');
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_TEST_DAEMON_EVENTS_PATH: eventsPath,
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '3000',
    });
    const daemonEnv = getDaemonEnv({
      baseEnv: env,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const statePath = resolveStackDaemonStatePaths({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: daemonEnv,
    }).serverScopedStatePath;

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    daemonPid = await readDaemonPid(statePath);
    await writeFile(eventsPath, '', 'utf-8');

    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() }),
      'utf-8',
    );
    const releaseBuildLockAfterDistMove = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      await rm(join(cliDir, '.dist.hstack-backup'), { recursive: true, force: true });
      await rename(join(cliDir, 'dist'), join(cliDir, '.dist.hstack-backup'));
      await rm(lockPath, { force: true });
    })();

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    await releaseBuildLockAfterDistMove;

    const events = (await readFile(eventsPath, 'utf-8')).trim().split(/\n+/).filter(Boolean);
    assert.deepEqual(events, []);
    assert.doesNotThrow(() => process.kill(daemonPid, 0));
    assert.equal(await readDaemonPid(statePath), daemonPid);
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth reconciles a stale dist fingerprint through the confirmed overlap owner', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-restart-reconcile-'));
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeSlowStartStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const statePath = join(cliHomeDir, 'daemon.state.json');
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName: 'dev',
      ownerPid: process.pid,
    });
    const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
    const eventsPath = join(tmp, 'daemon-events.log');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_TEST_DAEMON_EVENTS_PATH: eventsPath,
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    daemonPid = await readDaemonPid(statePath);
    await writeFile(eventsPath, '', 'utf-8');
    await writeDistBuildManifestForTest(distEntrypoint, '1111111111111111');
    let overlapRestartUsed = false;
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: false,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    }, {
      restartDaemonViaControlServerImpl: async (args) => {
        overlapRestartUsed = true;
        assert.equal(args.successorDistClosureFingerprint, '1111111111111111');
        assert.doesNotThrow(() => process.kill(daemonPid, 0));
        const successorPid = await spawnReplacementDaemonForTest({
          statePath,
          previousPid: daemonPid,
          env: {
            ...getDaemonEnv({
              baseEnv: env,
              cliHomeDir,
              internalServerUrl,
              publicServerUrl,
              stackName: 'dev',
              cliIdentity: 'default',
            }),
            HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: args.successorDistClosureFingerprint,
          },
        });
        assert.doesNotThrow(() => process.kill(daemonPid, 0));
        process.kill(daemonPid, 'SIGTERM');
        return { status: 'restarting', previousPid: daemonPid, pid: successorPid };
      },
    });

    const restartedPid = await readDaemonPid(statePath);
    assert.equal(overlapRestartUsed, true);
    assert.notEqual(restartedPid, daemonPid);
    assert.deepEqual((await readFile(eventsPath, 'utf-8')).trim().split(/\n+/).filter(Boolean), []);
    assert.equal(
      JSON.parse(await readFile(runtimeStatePath, 'utf-8')).daemon.distClosureFingerprint,
      '1111111111111111',
    );
    daemonPid = restartedPid;

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: false,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    }, {
      restartDaemonViaControlServerImpl: async () => {
        throw new Error('matching fingerprint must not request another overlap restart');
      },
    });

    assert.equal(await readDaemonPid(statePath), daemonPid);
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth preserves the old daemon when stale-dist overlap restart fails', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-restart-failure-'));
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeSlowStartStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const statePath = join(cliHomeDir, 'daemon.state.json');
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const eventsPath = join(tmp, 'daemon-events.log');
    const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const env = buildDaemonDistGuardEnv({ HAPPIER_TEST_DAEMON_EVENTS_PATH: eventsPath });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    daemonPid = await readDaemonPid(statePath);
    await writeFile(eventsPath, '', 'utf-8');
    await writeDistBuildManifestForTest(distEntrypoint, '2222222222222222');

    await assert.rejects(
      () => startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        runtimeStatePath,
        isShuttingDown: () => false,
        forceRestart: false,
        env,
        stackName: 'dev',
        cliIdentity: 'default',
      }, {
        restartDaemonViaControlServerImpl: async () => {
          throw new Error('replacement not confirmed');
        },
      }),
      /stale runtime.*keeping the existing daemon running.*replacement not confirmed/i,
    );

    assert.equal(await readDaemonPid(statePath), daemonPid);
    assert.doesNotThrow(() => process.kill(daemonPid, 0));
    assert.deepEqual((await readFile(eventsPath, 'utf-8')).trim().split(/\n+/).filter(Boolean), []);
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth reconciles an initial healthy mismatch during preserve-existing fallback', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-preserve-mismatch-'));
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const statePath = join(cliHomeDir, 'daemon.state.json');
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
    const currentFingerprint = JSON.parse(
      await readFile(join(dirname(distEntrypoint), '.build-manifest.json'), 'utf-8'),
    ).fingerprint;
    const existingFingerprint = currentFingerprint === '0000000000000000'
      ? '1111111111111111'
      : '0000000000000000';
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv();
    daemonPid = await spawnReplacementDaemonForTest({
      statePath,
      previousPid: null,
      env: {
        ...getDaemonEnv({
          baseEnv: env,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          stackName: 'dev',
          cliIdentity: 'default',
        }),
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: existingFingerprint,
      },
    });
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName: 'dev',
        processes: { daemonPid, daemonPids: [daemonPid] },
        daemon: { distClosureFingerprint: existingFingerprint },
      }) + '\n',
      'utf-8',
    );

    let overlapRestartUsed = false;
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: false,
      preserveExistingRunning: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    }, {
      restartDaemonViaControlServerImpl: async (args) => {
        overlapRestartUsed = true;
        assert.equal(args.successorDistClosureFingerprint, currentFingerprint);
        assert.doesNotThrow(() => process.kill(daemonPid, 0));
        const successorPid = await spawnReplacementDaemonForTest({
          statePath,
          previousPid: daemonPid,
          env: {
            ...getDaemonEnv({
              baseEnv: env,
              cliHomeDir,
              internalServerUrl,
              publicServerUrl,
              stackName: 'dev',
              cliIdentity: 'default',
            }),
            HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: currentFingerprint,
          },
        });
        process.kill(daemonPid, 'SIGTERM');
        return { status: 'restarting', previousPid: daemonPid, pid: successorPid };
      },
    });

    assert.equal(overlapRestartUsed, true);
    daemonPid = await readDaemonPid(statePath);
    const runtimeState = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    assert.equal(runtimeState.processes.daemonPid, daemonPid);
    assert.equal(runtimeState.daemon.distClosureFingerprint, currentFingerprint);
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth reconciles a mismatched daemon adopted during cold-start verification', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-cold-adoption-'));
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const statePath = join(cliHomeDir, 'daemon.state.json');
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName: 'dev',
      ownerPid: process.pid,
    });
    const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
    const currentFingerprint = JSON.parse(
      await readFile(join(dirname(distEntrypoint), '.build-manifest.json'), 'utf-8'),
    ).fingerprint;
    const adoptedFingerprint = currentFingerprint === '0000000000000000'
      ? '1111111111111111'
      : '0000000000000000';
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_TEST_DAEMON_CHILD_DIST_FINGERPRINT: adoptedFingerprint,
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    });
    let overlapRestartUsed = false;

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: false,
      preserveExistingRunning: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    }, {
      restartDaemonViaControlServerImpl: async (args) => {
        overlapRestartUsed = true;
        assert.equal(args.successorDistClosureFingerprint, currentFingerprint);
        const adoptedPid = await readDaemonPid(statePath);
        assert.doesNotThrow(() => process.kill(adoptedPid, 0));
        const successorPid = await spawnReplacementDaemonForTest({
          statePath,
          previousPid: adoptedPid,
          env: {
            ...getDaemonEnv({
              baseEnv: env,
              cliHomeDir,
              internalServerUrl,
              publicServerUrl,
              stackName: 'dev',
              cliIdentity: 'default',
            }),
            HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: currentFingerprint,
          },
        });
        process.kill(adoptedPid, 'SIGTERM');
        return { status: 'restarting', previousPid: adoptedPid, pid: successorPid };
      },
    });

    assert.equal(overlapRestartUsed, true);
    daemonPid = await readDaemonPid(statePath);
    assert.equal(
      JSON.parse(await readFile(runtimeStatePath, 'utf-8')).daemon.distClosureFingerprint,
      currentFingerprint,
    );
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth rejects incomplete dist when index imports missing chunks', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-incomplete-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });

    // Simulate a partially built dist where entrypoint exists but references a missing chunk.
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
      "import './doctor-missing-chunk.mjs';\nexport {};\n",
      'utf-8',
    );
    await rm(join(cliDir, 'dist', '.build-manifest.json'), { force: true });

    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_REPO_DIR: tmp,
      HAPPIER_STACK_CLI_ROOT_DIR: tmp,
      HAPPIER_STACK_CLI_BUILD: '0',
    });

    await assert.rejects(
      () =>
        startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName: 'dev',
          cliIdentity: 'default',
        }),
      (error) => error?.code === 'ECLIDISTSTALECOLDSTART',
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveGuardedLocalCliDistEntrypoint rejects local dist outside the active CLI directory', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-active-dist-guard-'));
  try {
    const activeCliDir = join(tmp, 'active', 'apps', 'cli');
    const staleCliDir = join(tmp, 'T', 'hstack-runtime-start-fixture-stale', 'apps', 'cli');
    const activeCliBin = await writeStubHappyCli({ cliDir: activeCliDir });
    const staleCliBin = await writeStubHappyCli({ cliDir: staleCliDir });

    const accepted = resolveGuardedLocalCliDistEntrypoint({
      cliBin: activeCliBin,
      activeCliDir,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.distEntrypoint, join(activeCliDir, 'dist', 'index.mjs'));

    const rejected = resolveGuardedLocalCliDistEntrypoint({
      cliBin: staleCliBin,
      activeCliDir,
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /outside_active_cli_dir/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveGuardedLocalCliDistEntrypoint rejects symlinked active dist outside the active CLI directory', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-active-dist-symlink-'));
  try {
    const activeCliDir = join(tmp, 'active', 'apps', 'cli');
    const staleCliDir = join(tmp, 'T', 'hstack-runtime-start-fixture-stale', 'apps', 'cli');
    const activeCliBin = await writeStubHappyCli({ cliDir: activeCliDir });
    await writeStubHappyCli({ cliDir: staleCliDir });

    await rm(join(activeCliDir, 'dist'), { recursive: true, force: true });
    await symlink(join(staleCliDir, 'dist'), join(activeCliDir, 'dist'), 'dir');

    const rejected = resolveGuardedLocalCliDistEntrypoint({
      cliBin: activeCliBin,
      activeCliDir,
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /outside_active_cli_dir/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('createDaemonStartAttemptLogPath prunes old start-attempt logs while keeping the current one', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-start-attempt-prune-'));
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const logsDir = join(cliHomeDir, 'logs');
    await mkdir(logsDir, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      await writeFile(
        join(logsDir, `2026-06-30-10-00-0${index}-pid-100-daemon-start-attempt.log`),
        `old ${index}\n`,
        'utf-8',
      );
    }

    const currentPath = await createDaemonStartAttemptLogPath({
      cliHomeDir,
      nowMs: Date.parse('2026-06-30T10:01:00.000Z'),
      pid: 200,
      keepCount: 2,
    });

    const remaining = (await readdir(logsDir))
      .filter((file) => file.endsWith('-daemon-start-attempt.log'))
      .sort();
    assert.equal(currentPath, join(logsDir, '2026-06-30-10-01-00-pid-200-daemon-start-attempt.log'));
    assert.deepEqual(remaining, [
      '2026-06-30-10-00-03-pid-100-daemon-start-attempt.log',
      '2026-06-30-10-01-00-pid-200-daemon-start-attempt.log',
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth accepts a runtime snapshot cli executable without requiring dist/index.mjs', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-cli-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const cliBin = await writeRuntimeSnapshotHappyCli({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth prefers a runtime snapshot node entrypoint over the bundled binary when available', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-node-entrypoint-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });
    const admittedFingerprint = 'abc123def4567890';
    await writeFile(
      join(dirname(cliNodeEntrypoint), '.build-manifest.json'),
      JSON.stringify({ fingerprint: admittedFingerprint, fileCount: 1 }) + '\n',
      'utf-8',
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliNodeEntrypoint,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
      runtimeStatePath,
      runtimeBacked: true,
      admittedDistClosureFingerprint: admittedFingerprint,
    });

    const authenticated = await checkDaemonStatePingAware(cliHomeDir, {
      serverUrl: internalServerUrl,
      env: buildDaemonDistGuardEnv(),
    });
    assert.equal(authenticated.distClosureFingerprint, admittedFingerprint);

    await stopLocalDaemon({
      cliBin,
      cliNodeEntrypoint,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth preserve-existing runtime adoption replaces a daemon with missing authenticated identity despite projection B', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-adoption-mismatch-'));
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-b');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });
    const admittedFingerprint = 'bbbbbbbbbbbbbbbb';
    await writeDistBuildManifestForTest(cliNodeEntrypoint, admittedFingerprint);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    const statePath = join(cliHomeDir, 'daemon.state.json');
    const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName: 'dev',
      ownerPid: process.pid,
      daemon: { distClosureFingerprint: admittedFingerprint },
    });

    const env = buildDaemonDistGuardEnv({ HAPPIER_STACK_CLI_BUILD: '0' });
    daemonPid = await spawnReplacementDaemonForTest({
      statePath,
      previousPid: null,
      env: {
        ...getDaemonEnv({
          baseEnv: env,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          stackName: 'dev',
          cliIdentity: 'default',
        }),
      },
    });

    let replacementCount = 0;
    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: cliBin,
      cliNodeEntrypoint,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: false,
      preserveExistingRunning: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
      runtimeBacked: true,
      admittedDistClosureFingerprint: admittedFingerprint,
    }, {
      restartDaemonViaControlServerImpl: async (args) => {
        replacementCount += 1;
        assert.equal(args.successorDistClosureFingerprint, admittedFingerprint);
        const successorPid = await spawnReplacementDaemonForTest({
          statePath,
          previousPid: daemonPid,
          env: {
            ...getDaemonEnv({
              baseEnv: env,
              cliHomeDir,
              internalServerUrl,
              publicServerUrl,
              stackName: 'dev',
              cliIdentity: 'default',
            }),
            HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: admittedFingerprint,
          },
        });
        process.kill(daemonPid, 'SIGTERM');
        return { status: 'restarting', previousPid: daemonPid, pid: successorPid };
      },
    });

    assert.equal(replacementCount, 1, 'missing authenticated identity must not be adopted or projected as closure B');
    daemonPid = await readDaemonPid(statePath);

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: cliBin,
      cliNodeEntrypoint,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: false,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
      runtimeBacked: true,
      admittedDistClosureFingerprint: admittedFingerprint,
    }, {
      restartDaemonViaControlServerImpl: async () => {
        throw new Error('matching admitted closure must remain adopted');
      },
    });

    assert.equal(await readDaemonPid(statePath), daemonPid);
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth fails closed on an unreachable runtime-backed daemon without changing its projected identity', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-unreachable-'));
  const admittedFingerprint = 'bbbbbbbbbbbbbbbb';
  const priorFingerprint = 'aaaaaaaaaaaaaaaa';
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-b');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });
    await writeDistBuildManifestForTest(cliNodeEntrypoint, admittedFingerprint);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    const statePath = join(cliHomeDir, 'daemon.state.json');
    const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName: 'dev',
      ownerPid: process.pid,
      daemon: { distClosureFingerprint: priorFingerprint },
    });

    const env = buildDaemonDistGuardEnv({ HAPPIER_STACK_CLI_BUILD: '0' });
    const daemonEnv = getDaemonEnv({
      baseEnv: env,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    daemonPid = await spawnUnreachableDaemonForTest({ statePath, env: daemonEnv });
    const observed = await checkDaemonStatePingAware(cliHomeDir, {
      serverUrl: internalServerUrl,
      env: daemonEnv,
      pingTimeoutMs: 50,
    });
    assert.equal(observed.status, 'unreachable');

    let replacementAttempted = false;
    await assert.rejects(
      () => startLocalDaemonWithAuth({
        cliBin,
        cliCommand: cliBin,
        cliNodeEntrypoint,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        runtimeStatePath,
        isShuttingDown: () => false,
        forceRestart: false,
        env,
        stackName: 'dev',
        cliIdentity: 'default',
        runtimeBacked: true,
        admittedDistClosureFingerprint: admittedFingerprint,
      }, {
        restartDaemonViaControlServerImpl: async () => {
          replacementAttempted = true;
          throw new Error('unreachable control ownership must not attempt replacement');
        },
      }),
      (error) => error?.code === 'EIMMUTABLERUNTIMEDAEMONIDENTITY',
    );

    assert.equal(replacementAttempted, false);
    assert.doesNotThrow(() => process.kill(daemonPid, 0));
    const projected = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    assert.equal(projected.daemon.distClosureFingerprint, priorFingerprint);
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth still prefers a runtime snapshot node entrypoint when the host runtime is bun', async () => {
  const restoreProcessReleaseName = overrideProcessReleaseNameForTest('bun');
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-bun-node-entrypoint-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliNodeEntrypoint,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      cliNodeEntrypoint,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    restoreProcessReleaseName();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth runs runtime snapshot JS commands through node when no separate node entrypoint exists', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-js-command-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliCommand } = await writeRuntimeSnapshotHappyCliJsCommand({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      cliCommand,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth rejects missing runtime snapshot command paths before spawning', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-missing-command-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await assert.rejects(
      () => startLocalDaemonWithAuth({
        cliBin: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'happier'),
        cliNodeEntrypoint: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'package-dist', 'index.mjs'),
        cliCommand: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'happier'),
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        isShuttingDown: () => false,
        forceRestart: true,
        env: buildDaemonDistGuardEnv({
          HAPPIER_STACK_CLI_BUILD: '0',
        }),
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      /runtime snapshot.*missing|runtime launch path.*missing|missing runtime/i,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth restarts PATH-resolved runtime commands instead of treating the command name as a dist path', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-path-runtime-command-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const binDir = join(tmp, 'bin');
    const { cliCommand } = await writePathResolvedRuntimeCommand({ binDir });

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const statePath = join(cliHomeDir, 'daemon.state.json');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    });

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const firstPid = await readDaemonPid(statePath);

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const secondPid = await readDaemonPid(statePath);

    assert.ok(Number.isFinite(firstPid) && firstPid > 0);
    assert.ok(Number.isFinite(secondPid) && secondPid > 0);
    assert.notEqual(secondPid, firstPid);

    await stopLocalDaemon({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth kills the daemon from daemon.state.json when daemon stop is a no-op', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-fallback-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const binDir = join(tmp, 'bin');
    const { cliCommand } = await writePathResolvedRuntimeCommand({ binDir, stopMode: 'noop' });

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const statePath = join(cliHomeDir, 'daemon.state.json');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    });

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const firstPid = await readDaemonPid(statePath);

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const secondPid = await readDaemonPid(statePath);

    assert.notEqual(secondPid, firstPid);
    assert.doesNotThrow(() => process.kill(secondPid, 0));
    assert.throws(() => process.kill(firstPid, 0));

    await stopLocalDaemon({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth preserves exact daemon publication bytes until the replacement CLI starts', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-owner-publication-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const binDir = join(tmp, 'bin');
    const observationPath = join(tmp, 'pre-start-publication.json');
    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    });
    const daemonEnv = getDaemonEnv({
      baseEnv: env,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const {
      serverScopedStatePath: statePath,
      serverScopedLockPath: lockPath,
    } = resolveStackDaemonStatePaths({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: daemonEnv,
    });
    const stateRaw = JSON.stringify({
      pid: 999999,
      httpPort: 4321,
      startTime: '2026-07-30T12:00:00.000Z',
      marker: 'exact-predecessor-publication',
    }) + '\n';
    const lockRaw = '999999\n';
    const { cliCommand } = await writePathResolvedRuntimeCommand({
      binDir,
      stopMode: 'noop',
      preStartObservationPath: observationPath,
      preStartStatePath: statePath,
      preStartLockPath: lockPath,
    });

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, stateRaw, 'utf-8');
    await writeFile(lockPath, lockRaw, 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const observed = JSON.parse(await readFile(observationPath, 'utf-8'));
    assert.equal(observed.stateRaw, stateRaw);
    assert.equal(observed.lockRaw, lockRaw);

    await stopLocalDaemon({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      internalServerUrl,
      cliHomeDir,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
