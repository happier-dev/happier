import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveChannelForCliVersion, resolvePublishedCliTag, resolvePublishedStableBaseline, stageCliReleaseAssets } from './desktop-setup-artifacts.mjs';
import { planPromptResponse, runHsetupTask } from './desktop-setup-driver.mjs';
import { evaluateFreshSetup, evaluateUpgrade } from './desktop-setup.mjs';
import * as desktopSetup from './desktop-setup.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-setup-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-setup-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('stages exactly one platform bundle and refuses a torn archive', () => withTempDir((dir) => {
  const source = join(dir, 'src');
  mkdirSync(source);
  const archive = Buffer.from('archive-bytes');
  const sha = createHash('sha256').update(archive).digest('hex');
  writeFileSync(join(source, 'happier-v0.2.13-linux-x64.tar.gz'), archive);
  writeFileSync(join(source, 'happier-v0.2.13-linux-arm64.tar.gz'), 'other');
  writeFileSync(join(source, 'checksums-happier-v0.2.13.txt'), `${sha}  happier-v0.2.13-linux-x64.tar.gz\n`);
  writeFileSync(join(source, 'checksums-happier-v0.2.13.txt.minisig'), 'sig');

  const bundle = stageCliReleaseAssets({ sourceDir: source, stageDir: join(dir, 'stage') });
  assert.equal(bundle.version, '0.2.13');
  assert.deepEqual(readdirSync(join(dir, 'stage')).sort(), [
    'checksums-happier-v0.2.13.txt',
    'checksums-happier-v0.2.13.txt.minisig',
    'happier-v0.2.13-linux-x64.tar.gz',
  ]);

  writeFileSync(join(source, 'happier-v0.2.13-linux-x64.tar.gz'), 'torn');
  assert.throws(() => stageCliReleaseAssets({ sourceDir: source, stageDir: join(dir, 'stage2') }), /does not match/);
}));

test('the spec channel follows the ring the CLI build belongs to', () => {
  assert.equal(resolveChannelForCliVersion('0.2.13'), 'stable');
  assert.equal(resolveChannelForCliVersion('0.2.13-preview.2'), 'preview');
  assert.equal(resolveChannelForCliVersion('0.2.13-dev.6'), 'dev');
});

test('prompt policy approves pairing (current and 0.2.12 contracts) and refuses anything else by default', () => {
  assert.deepEqual(planPromptResponse({ kind: 'setup.pairThisComputer', publicKeyB64Url: 'pk' }, { approvePairing: async () => {} }), {
    kind: 'setup.pairThisComputer', action: 'approve-pairing', publicKey: 'pk', answer: { approved: true },
  });
  assert.deepEqual(planPromptResponse({ kind: 'authRequest', publicKey: 'pk' }, { approvePairing: async () => {} }), {
    kind: 'authRequest', action: 'approve-pairing', publicKey: 'pk', answer: null,
  });
  assert.equal(planPromptResponse({ kind: 'setup.serviceConsent' }, { approvePairing: async () => {} }).answer.approved, false);
  assert.equal(planPromptResponse({ kind: 'setup.serviceConsent' }, { approvePairing: async () => {}, serviceConsent: 'approve' }).answer.approved, true);
  assert.equal(planPromptResponse({ kind: 'setup.accountConsent' }, { approvePairing: async () => {}, serviceConsent: 'approve' }).answer.approved, false);
});

// A stand-in executor speaking hsetup's JSON-lines protocol: it reads the spec, emits a pairing
// prompt, blocks on the answer line exactly as `readLineAbortable` does, and reports what it read.
const FAKE_HSETUP = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const it = rl[Symbol.asyncIterator]();
(async () => {
  const spec = JSON.parse((await it.next()).value);
  const out = (value) => process.stdout.write(JSON.stringify({ protocolVersion: 1, taskId: 't', ...value }) + '\\n');
  out({ tsMs: 1, type: 'progress', stepId: 'setup.thisComputer.ensureCli' });
  out({ tsMs: 2, type: 'prompt', stepId: 'setup.thisComputer.auth.request', message: 'Approve', data: { kind: 'setup.pairThisComputer', publicKeyB64Url: 'PUBKEY' } });
  const answer = JSON.parse((await it.next()).value);
  out({ ok: answer.approved === true, data: { kind: spec.kind, answer } });
  rl.close();
})();
`;

test('the driver sends the spec, approves the pairing before answering, and returns the result', async () => withTempDirAsync(async (dir) => {
  const script = join(dir, 'hsetup');
  writeFileSync(script, FAKE_HSETUP);
  chmodSync(script, 0o755);
  const order = [];
  const run = await runHsetupTask({
    command: script,
    args: [],
    kind: 'setup.thisComputer.v1',
    params: { channel: 'stable' },
    handlers: { approvePairing: async (publicKey) => { order.push(`approve:${publicKey}`); } },
  });
  assert.equal(run.exitCode, 0);
  assert.deepEqual(order, ['approve:PUBKEY']);
  assert.equal(run.result.ok, true);
  assert.deepEqual(run.result.data, { kind: 'setup.thisComputer.v1', answer: { approved: true } });
  assert.deepEqual(run.prompts, [{ kind: 'setup.pairThisComputer', stepId: 'setup.thisComputer.auth.request', answered: true, approved: true }]);
}));

test('a failed approval stops the run instead of answering the prompt', async () => withTempDirAsync(async (dir) => {
  const script = join(dir, 'hsetup');
  writeFileSync(script, FAKE_HSETUP);
  chmodSync(script, 0o755);
  await assert.rejects(runHsetupTask({
    command: script,
    args: [],
    kind: 'setup.thisComputer.v1',
    params: {},
    handlers: { approvePairing: async () => { throw new Error('approve failed: relay rejected'); } },
  }), /approve failed/);
}));

const FRESH_OK = () => ({
  expectedCliVersion: '0.2.13',
  precondition: { happierOnPath: '', happierHomeExists: false, userUnits: '' },
  inspection: { exitCode: 0, result: { ok: true, data: {} }, prompts: [] },
  setup: { exitCode: 0, result: { ok: true, data: { machineId: 'm1', cliProvenance: 'managed', cliVersion: '0.2.13', serviceAction: 'install' } }, prompts: [{ kind: 'setup.pairThisComputer' }] },
  feedServedArchive: true,
  pathCommand: '/home/happy/.happier/bin/happier',
  pathCommandResolved: '/home/happy/.happier/cli/versions/0.2.13/happier',
  pathVersion: '0.2.13',
  status: {
    service: { installed: true, running: true },
    daemon: { serviceManaged: true, startedWithCliVersion: '0.2.13' },
    auth: { machineId: 'm1' },
    runtimeConvergence: { controlReachable: true, serviceOwnsRunningDaemon: true, machineIdMatches: true, cliVersionMatches: true },
  },
  systemd: { active: 'active', enabled: 'enabled' },
  probe: { ok: true, machineId: 'm1' },
});

test('systemd observation uses the CLI installed unit path instead of its cross-platform daemon label', () => {
  const units = [];
  const observed = desktopSetup.readSystemdState({
    serviceStatus: { installed: true, installedPath: '/home/happy/.config/systemd/user/happier-daemon.default.service', owner: { serviceLabel: 'com.happier.cli.daemon.default' } },
    run: (command) => {
      units.push(command);
      return { stdout: command.includes('is-enabled') ? 'enabled\n' : 'active\n' };
    },
  });
  assert.deepEqual(observed, { unit: 'happier-daemon.default.service', active: 'active', enabled: 'enabled' });
  assert.ok(units.every((command) => command.includes("'happier-daemon.default.service'")));
  assert.throws(() => desktopSetup.readSystemdState({ serviceStatus: { installed: false }, run: () => { throw new Error('must not probe a guessed unit'); } }), /installed systemd unit/);
});

test('the upgrade baseline binds the CLI from the immutable desktop source, even after cli-stable advances', async () => {
  const realFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith('/ui-desktop-stable')) return Response.json({ assets: [{ name: 'happier-ui-desktop-linux-x86_64-v0.2.12.deb.sha256' }] });
    if (String(url).endsWith('/contents/apps/cli/package.json?ref=ui-desktop-v0.2.12')) return Response.json({ version: '0.2.12' });
    if (String(url).endsWith('/cli-stable')) return Response.json({ assets: [{ name: 'checksums-happier-v0.2.16.txt' }] });
    throw new Error(`Unexpected GitHub boundary request: ${url}`);
  };
  try {
    assert.deepEqual(await resolvePublishedStableBaseline({ repo: 'o/r' }), { cliTag: 'cli-v0.2.12', desktopTag: 'ui-desktop-v0.2.12' });
    assert.equal(requested.some((url) => url.endsWith('/cli-stable')), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fresh setup passes only when every user-visible outcome holds', () => {
  assert.ok(evaluateFreshSetup(FRESH_OK()).every((entry) => entry.pass));

  const githubCli = FRESH_OK();
  githubCli.feedServedArchive = false;
  githubCli.setup.result.data.cliVersion = '0.2.12';
  const failed = evaluateFreshSetup(githubCli).filter((entry) => !entry.pass).map((entry) => entry.check);
  assert.deepEqual(failed, ['CLI is managed and is the build under test', 'CLI archive came from the staged release feed']);

  const unreachable = FRESH_OK();
  unreachable.probe = { ok: false, error: 'rpc not acknowledged' };
  assert.deepEqual(evaluateFreshSetup(unreachable).filter((entry) => !entry.pass).map((entry) => entry.check), [
    'machine answers a relay-routed capabilities.describe (INV10)',
  ]);
});

const UPGRADE_OK = () => ({
  previousCliVersion: '0.2.12',
  expectedCliVersion: '0.2.13',
  previousSetup: { exitCode: 0, result: { ok: true, data: { machineId: 'm1' } } },
  previousStatus: { daemon: { startedWithCliVersion: '0.2.12' }, auth: { machineId: 'm1' } },
  previousProbe: { ok: true, machineId: 'm1' },
  newInspection: { exitCode: 0, result: { ok: true, data: {} } },
  newSetup: { exitCode: 0, result: { ok: true, data: {} }, prompts: [] },
  update: { exitCode: 0, result: { ok: true, data: { previousVersion: '0.2.13', version: '0.2.13', restarted: true } } },
  finalStatus: {
    daemon: { startedWithCliVersion: '0.2.13' },
    auth: { machineId: 'm1' },
    runtimeConvergence: { controlReachable: true, serviceOwnsRunningDaemon: true, machineIdMatches: true, cliVersionMatches: true },
  },
  systemd: { active: 'active' },
  finalProbe: { ok: true, machineId: 'm1' },
});

test('the released predecessor sets up the persisted relay, not a caller-only URL override', async () => {
  // The separate shipped 0.2.12 hsetup/CLI processes are the boundary. Its tagged source reads
  // server current's persisted profile; service units follow that profile, not caller URL env.
  let acquired = false;
  let selectedRelay = 'https://api.happier.dev';
  const previousSetup = await desktopSetup.runPredecessorSetup({
    relayUrl: 'http://relay:3005',
    webappUrl: 'http://relay:3005',
    setupParams: { surface: 'desktop.ui', target: 'thisComputer' },
    inspectionParams: { target: { kind: 'local' }, mode: 'user' },
    runHsetup: async (kind, _params, env) => {
      if (kind === 'daemon.service.status.v1') {
        acquired = true;
        return { exitCode: 0, result: { ok: true } };
      }
      return { exitCode: 0, result: { ok: selectedRelay === 'http://relay:3005' && !env?.HAPPIER_SERVER_URL } };
    },
    runCli: (args) => {
      assert.ok(acquired, 'CLI must be acquired before selecting the relay');
      assert.deepEqual(args, ['server', 'set', '--server-url', 'http://relay:3005', '--webapp-url', 'http://relay:3005', '--json']);
      selectedRelay = args[args.indexOf('--server-url') + 1];
      return { status: 0 };
    },
  });
  assert.equal(previousSetup.result.ok, true, 'old setup and its service must use the Docker relay');
});

test('upgrade fails when the service keeps running the previous CLI (stale daemon)', () => {
  assert.ok(evaluateUpgrade(UPGRADE_OK()).every((entry) => entry.pass));

  const stale = UPGRADE_OK();
  stale.finalStatus.daemon.startedWithCliVersion = '0.2.12';
  stale.finalStatus.runtimeConvergence.cliVersionMatches = false;
  assert.deepEqual(evaluateUpgrade(stale).filter((entry) => !entry.pass).map((entry) => entry.check), [
    'daemon restarted on the new CLI (INV8 cliVersionMatches)',
  ]);

  const newMachine = UPGRADE_OK();
  newMachine.finalStatus.auth.machineId = 'm2';
  newMachine.finalProbe.machineId = 'm2';
  assert.ok(evaluateUpgrade(newMachine).some((entry) => entry.check === 'still the same machine' && !entry.pass));
});

test('a desktop-only release pins the rolling channel CLI once to its immutable tag', async () => {
  // GitHub's release API is the network boundary; the real asset parsing runs beneath it.
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const assets = String(url).endsWith('/cli-stable')
      ? [{ name: 'happier-v0.2.13-linux-x64.tar.gz' }, { name: 'checksums-happier-v0.2.13.txt' }, { name: 'checksums-happier-v0.2.13.txt.minisig' }]
      : [{ name: 'README.md' }];
    return new Response(JSON.stringify({ assets }), { status: 200 });
  };
  try {
    assert.equal(await resolvePublishedCliTag({ repo: 'o/r', channel: 'stable' }), 'cli-v0.2.13');
    assert.deepEqual(requested, ['https://api.github.com/repos/o/r/releases/tags/cli-stable']);
    await assert.rejects(resolvePublishedCliTag({ repo: 'o/r', channel: 'preview' }), /could not resolve the published cli-preview/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
