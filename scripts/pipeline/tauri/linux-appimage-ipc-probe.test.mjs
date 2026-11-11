import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertPackagedHsetupResolution, evaluateAppIpcInvocations, readStubInvocations, waitForAppIpcStatusRead, writeStubHappierCli } from './linux-appimage-ipc-probe.mjs';

/**
 * Stand-ins for the process tree of the real smoke: an "app" process that spawns an "hsetup"
 * process that runs the CLI. Both are node, so the hsetup identity is node's own executable.
 * Resolves with the app's pid and the CLI's outputs once the whole tree has exited.
 */
function runThroughAppTree(cliPath, argvList) {
  const hsetupScript = `
    const { spawnSync } = require('node:child_process');
    const out = ${JSON.stringify(argvList)}.map((argv) => {
      const r = spawnSync(${JSON.stringify(cliPath)}, argv, { encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout };
    });
    process.stdout.write(JSON.stringify(out));`;
  const appScript = `
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, ['-e', ${JSON.stringify(hsetupScript)}], { encoding: 'utf8' });
    process.stdout.write(r.stdout);`;
  return new Promise((resolve, reject) => {
    const app = spawn(process.execPath, ['-e', appScript], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    app.stdout.on('data', (chunk) => { stdout += chunk; });
    app.on('error', reject);
    app.on('exit', () => resolve({ appPid: app.pid, outputs: JSON.parse(stdout) }));
  });
}

const isNodeHsetup = (exe) => exe === process.execPath;
// The stand-in CLI reads its process tree from /proc; the smoke it serves runs only on Linux.
const linuxOnly = { skip: process.platform !== 'linux' && 'reads /proc (Linux only)' };

function withScratch(run) {
  const root = mkdtempSync(join(tmpdir(), 'ipc-probe-test-'));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('the stand-in CLI answers startup status and service-list reads and records their process tree', linuxOnly, () => withScratch(async (root) => {
  const recordDir = join(root, 'records');
  const cli = writeStubHappierCli({ dir: join(root, 'bin'), recordDir });
  const { appPid, outputs } = await runThroughAppTree(cli, [['--version'], ['daemon', 'service', 'list', '--json'], ['daemon', 'status', '--json']]);
  assert.equal(outputs[0].stdout.trim(), '0.2.99');
  const verdict = evaluateAppIpcInvocations({ invocations: readStubInvocations(recordDir), appPid, isBundledHsetup: isNodeHsetup });
  assert.equal(outputs[1].status, 0);
  assert.deepEqual(JSON.parse(outputs[1].stdout), { entries: [], services: [] });
  assert.equal(JSON.parse(outputs[2].stdout).service.installed, false);
  assert.deepEqual(verdict.statusRead.argv, ['daemon', 'status', '--json']);
  assert.equal(verdict.hsetupExe, process.execPath);
}));

test('the desktop status read that names its bundle id is the startup status read', linuxOnly, () => withScratch(async (root) => {
  // localDaemonCli.ts sends --desktop-bundle-id with the Desktop status read; on a computer with
  // no installed service the CLI records nothing (recordDesktopDaemonServiceUse).
  const recordDir = join(root, 'records');
  const cli = writeStubHappierCli({ dir: join(root, 'bin'), recordDir });
  const argv = ['daemon', 'status', '--json', '--desktop-bundle-id', 'dev.happier.app.publicdev'];
  const { appPid, outputs } = await runThroughAppTree(cli, [argv]);
  assert.equal(outputs[0].status, 0);
  assert.equal(JSON.parse(outputs[0].stdout).service.installed, false);
  const verdict = evaluateAppIpcInvocations({ invocations: readStubInvocations(recordDir), appPid, isBundledHsetup: isNodeHsetup });
  assert.deepEqual(verdict.statusRead.argv, argv);
}));

test('no status read at all fails the probe', linuxOnly, () => withScratch(async (root) => {
  const recordDir = join(root, 'records');
  const cli = writeStubHappierCli({ dir: join(root, 'bin'), recordDir });
  const { appPid } = await runThroughAppTree(cli, [['--version'], ['daemon', 'service', 'list', '--json']]);
  assert.throws(
    () => evaluateAppIpcInvocations({ invocations: readStubInvocations(recordDir), appPid, isBundledHsetup: isNodeHsetup }),
    /no `daemon status --json`/,
  );
}));

test('a status read that did not descend from the launched app fails the probe', linuxOnly, () => withScratch(async (root) => {
  const recordDir = join(root, 'records');
  const cli = writeStubHappierCli({ dir: join(root, 'bin'), recordDir });
  await runThroughAppTree(cli, [['daemon', 'status', '--json']]);
  const { appPid: otherApp } = await runThroughAppTree(writeStubHappierCli({ dir: join(root, 'bin2'), recordDir: join(root, 'other') }), [['--version']]);
  assert.throws(
    () => evaluateAppIpcInvocations({ invocations: readStubInvocations(recordDir), appPid: otherApp, isBundledHsetup: isNodeHsetup }),
    /no `daemon status --json`/,
  );
}));

test('a status read whose parent is not the bundled hsetup fails the probe', linuxOnly, () => withScratch(async (root) => {
  const recordDir = join(root, 'records');
  const cli = writeStubHappierCli({ dir: join(root, 'bin'), recordDir });
  const { appPid } = await runThroughAppTree(cli, [['daemon', 'status', '--json']]);
  assert.throws(
    () => evaluateAppIpcInvocations({ invocations: readStubInvocations(recordDir), appPid, isBundledHsetup: () => false }),
    /no `daemon status --json`/,
  );
}));

test('a command outside the read-only set is refused by the CLI and fails the probe at once', linuxOnly, () => withScratch(async (root) => {
  const recordDir = join(root, 'records');
  const cli = writeStubHappierCli({ dir: join(root, 'bin'), recordDir });
  const { appPid, outputs } = await runThroughAppTree(cli, [['daemon', 'status', '--json'], ['daemon', 'service', 'install', '--json']]);
  assert.notEqual(outputs[1].status, 0);
  await assert.rejects(
    waitForAppIpcStatusRead({ recordDir, appPid, isBundledHsetup: isNodeHsetup, timeoutMs: 60_000 }),
    /not read-only: \["daemon","service","install","--json"\]/,
  );
}));

test('waiting stops when the app exits before its task ran', linuxOnly, () => withScratch(async (root) => {
  await assert.rejects(
    waitForAppIpcStatusRead({ recordDir: join(root, 'records'), appPid: 1, isBundledHsetup: isNodeHsetup, timeoutMs: 60_000, appExited: () => 'code=1' }),
    /exited before its system task ran: code=1/,
  );
}));

test('the app ran the packaged hsetup: its materialized copy of the .gz resource, or the resource itself', () => {
  const cacheHome = '/tmp/smoke/home/.cache';
  const resource = 'usr/lib/Happier/binaries/hsetup-x86_64-unknown-linux-gnu.gz';
  // hsetup_path.rs materializes `<app cache dir>/systemTasks/hsetup-materialized-<gz len>-<mtime>`.
  assert.equal(assertPackagedHsetupResolution({
    hsetupExe: `${cacheHome}/dev.happier.app/systemTasks/hsetup-materialized-5120-1790000000`,
    cacheHome, resource, resourceBytes: 5120,
  }), 'materialized-resource');
  assert.equal(assertPackagedHsetupResolution({
    hsetupExe: '/tmp/.mount_HappieXYZ/usr/lib/Happier/binaries/hsetup-x86_64-unknown-linux-gnu',
    cacheHome, resource, resourceBytes: 5120,
  }), 'packaged-resource');
  // A checkout's `apps/ui/src-tauri/binaries` (compile-time CARGO_MANIFEST_DIR) is not packaged.
  assert.throws(() => assertPackagedHsetupResolution({
    hsetupExe: '/home/runner/work/happier/apps/ui/src-tauri/binaries/hsetup-x86_64-unknown-linux-gnu',
    cacheHome, resource, resourceBytes: 5120,
  }), /not the packaged resource/);
  // A materialized copy of some other .gz (a different size) is not this artifact's resource.
  assert.throws(() => assertPackagedHsetupResolution({
    hsetupExe: `${cacheHome}/dev.happier.app/systemTasks/hsetup-materialized-9999-1790000000`,
    cacheHome, resource, resourceBytes: 5120,
  }), /not the packaged resource/);
  // Outside the app's cache dir (e.g. the runner's own cache) is not this app's materialization.
  assert.throws(() => assertPackagedHsetupResolution({
    hsetupExe: '/home/runner/.cache/dev.happier.app/systemTasks/hsetup-materialized-5120-1790000000',
    cacheHome, resource, resourceBytes: 5120,
  }), /not the packaged resource/);
});
