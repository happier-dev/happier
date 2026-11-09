import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { readyDevTargetSyncResult } from './testkit/core/dev_target_sync.mjs';
import { spawnProc } from './utils/proc/proc.mjs';
import { prepareStackRelay, inspectHostRelay, inspectStackRelay } from './utils/server/infra/iroh/runtime.mjs';
import { readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import { createStartableRuntimeSnapshotFixture, runNode, waitForHealth } from './testkit/runtime_snapshot_start_testkit.mjs';
import { ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { checkDaemonStatePingAware } from './daemon.mjs';

const repoDir = fileURLToPath(new URL('../../../', import.meta.url));

function commandJson(result, phase) {
  const diagnostic = result.stderr.split('\n').filter(line => !/:\/\/|bearer |token|secret|password|api_?key|credential|database_url|-----begin|private_key|[A-Za-z0-9+/_=-]{40,}\.[A-Za-z0-9+/_=-]{20,}/iu.test(line)).join('\n');
  assert.ok(result.stdout.trim(), `${phase} returned no JSON (exit ${result.code}): ${diagnostic}`);
  return JSON.parse(result.stdout);
}

async function certificateFixture(t, failure = 'denied') {
  const fixture = await createTempFixture(t, { prefix: 'relay-placement-' });
  const { binDir, binPath } = writeFakeBin({ root: fixture.root, name: 'tailscale', content: `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const home = process.env.HAPPIER_STACK_HOME_DIR;
fs.mkdirSync(home, { recursive: true });
fs.appendFileSync(path.join(home, 'tailscale.calls'), args[0] + '\\n');
if (args[0] === 'serve' && args[1] === 'status' && args.includes('--json')) {
  console.log('null');
} else if (args[0] === 'status') {
  console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'server-target.example.ts.net.'},TailscaleIPs:['100.64.0.5']}));
} else if (args[0] === 'cert') {
  const failure = ${JSON.stringify(failure)};
  if (failure === 'missing') process.exit(0);
  console.error(failure === 'denied' ? 'Access denied: cert access denied' : failure === 'https'
    ? 'HTTPS cert support is not enabled/configured for your tailnet.' : 'ACME service unavailable');
  process.exit(1);
} else process.exit(1);
` });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('controller'),
    HAPPIER_STACK_IROH_RELAY: '1', HAPPIER_IROH_RELAY_POLICY: '', HAPPIER_IROH_RELAY_URLS: '',
    HAPPIER_STACK_SANDBOX_DIR: '', HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1',
    HAPPIER_TAILSCALE_BIN: binPath, HAPPIER_STACK_TAILSCALE_ENABLE_TIMEOUT_MS: '30000',
    HAPPIER_PUBLIC_SERVER_URL: 'https://ordinary-home.example.ts.net' };
  return { fixture, env, binDir };
}

for (const [failure, reason] of [['denied', 'relay_certificate_permission_denied'],
  ['https', 'relay_certificate_https_disabled'], ['missing', 'relay_certificate_files_unavailable'],
  ['other', 'relay_certificate_unavailable']]) {
  test(`certificate ${failure} is actionable in startup, stack inspection and host tools status`, async t => {
    const { fixture, env } = await certificateFixture(t, failure);
    const runtimeStatePath = fixture.path('stack', 'stack.runtime.json');
    const result = await prepareStackRelay({ repoDir, env, runtimeStatePath });
    assert.equal(result.relay.status, 'degraded');
    assert.equal(result.relay.reason, reason);
    assert.deepEqual(result.relay.failure, { phase: 'certificate', code: reason });
    assert.equal(typeof result.relay.remediation, 'string');
    assert.ok(result.relay.remediation.length > 0);
    assert.equal(result.relay.httpsUrl, null);
    assert.equal(result.env.HAPPIER_IROH_RELAY_URLS, undefined);
    assert.equal(result.env.HAPPIER_IROH_RELAY_POLICY, 'disabled');
    assert.equal(result.env.HAPPIER_PUBLIC_SERVER_URL, env.HAPPIER_PUBLIC_SERVER_URL);
    const state = await readStackRuntimeStateFile(runtimeStatePath);
    assert.deepEqual(await inspectStackRelay({ env, runtimeState: state }), result.relay);
    assert.equal((await inspectHostRelay({ env })).reason, 'relay_process_unavailable',
      'host status observes current process availability rather than replaying a historical certificate failure');
    assert.deepEqual((await readFile(fixture.path('controller', 'tailscale.calls'), 'utf8')).trim().split('\n'), ['serve', 'status', 'cert']);
  });
}

test('placed preparation executes on the server target and records its typed result on the controller', async t => {
  const { fixture, env, binDir } = await certificateFixture(t);
  const serverTarget = { name: 'server-target', platform: 'posix', ssh: 'fixture-server',
    repoDir, cliHomeDir: fixture.path('target'), remotePath: [binDir] };
  let sshHost;
  const runtimeStatePath = fixture.path('stack', 'stack.runtime.json');
  const result = await prepareStackRelay({ repoDir, env, runtimeStatePath, serverTarget,
    stackBaseDir: fixture.root, executorDependencies: {
      runCaptureResult: async ({ args }) => args.includes('list')
        ? readyDevTargetSyncResult(args[args.indexOf('list') + 1]) : { ok: true, out: '', err: '' },
      spawnProcess: input => {
        sshHost = input.args.at(-2);
        return spawnProc('fixture-target', '/bin/bash', ['-c', input.args.at(-1)], env,
          { silent: true, persistOutput: false, stdio: ['pipe', 'pipe', 'pipe'], onLine: input.onLine });
      },
    } });
  assert.equal(sshHost, serverTarget.ssh);
  assert.equal(result.relay.target, serverTarget.name);
  assert.equal(result.relay.reason, 'relay_certificate_permission_denied');
  assert.deepEqual(result.relay.failure, { phase: 'certificate', code: 'relay_certificate_permission_denied' });
  assert.equal(result.env.HAPPIER_PUBLIC_SERVER_URL, env.HAPPIER_PUBLIC_SERVER_URL);
  assert.equal(result.env.HAPPIER_IROH_RELAY_URLS, undefined);
  await assert.rejects(stat(fixture.path('controller', 'tailscale.calls')), { code: 'ENOENT' });
  assert.deepEqual((await readFile(fixture.path('target', 'tailscale.calls'), 'utf8')).trim().split('\n'), ['serve', 'status', 'cert']);
  assert.deepEqual((await readStackRuntimeStateFile(runtimeStatePath)).irohRelay, result.relay);
});

test('certificate denial leaves the HTTPS Home origin intact and starts both server and daemon without relay hints', async t => {
  const { env } = await certificateFixture(t);
  const fixture = await createStartableRuntimeSnapshotFixture(t, { stackName: 'relay-cert-degraded' });
  const profileDir = join(fixture.root, 'deploy', 'iroh-relay');
  await mkdir(profileDir, { recursive: true });
  for (const name of ['Dockerfile', 'relay.toml']) await copyFile(join(repoDir, 'deploy', 'iroh-relay', name), join(profileDir, name));
  const stackEnvPath = join(fixture.stackDir, 'env');
  await ensureEnvFileUpdated({ envPath: stackEnvPath, updates: Object.entries({
    HAPPIER_STACK_IROH_RELAY: '1', HAPPIER_IROH_RELAY_POLICY: '', HAPPIER_IROH_RELAY_URLS: '',
    HAPPIER_TAILSCALE_BIN: env.HAPPIER_TAILSCALE_BIN,
    HAPPIER_PUBLIC_SERVER_URL: env.HAPPIER_PUBLIC_SERVER_URL,
  }).map(([key, value]) => ({ key, value })) });
  const launchEnv = { ...env, HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1', HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: stackEnvPath };
  const launcher = join(repoDir, 'apps/stack/bin/hstack.mjs');
  try {
    const started = await runNode([launcher, 'stack', 'start', fixture.stackName,
      '--background', '--runtime', '--no-ui', '--no-browser'], { cwd: repoDir, env: launchEnv });
    assert.equal(started.code, 0);
    await waitForHealth(fixture.baseUrl);
    const runtime = await readStackRuntimeStateFile(join(fixture.stackDir, 'stack.runtime.json'));
    assert.equal(runtime.irohRelay.reason, 'relay_certificate_permission_denied');
    assert.ok(Number(runtime.processes.serverPid) > 1);
    assert.ok(Number(runtime.processes.daemonPid) > 1);
    const daemon = await checkDaemonStatePingAware(fixture.cliHomeDir, { serverUrl: fixture.baseUrl, env: launchEnv });
    assert.match(daemon.status, /running/iu);
    const serverEnv = JSON.parse(await readFile(fixture.serverEnvCapturePath, 'utf8'));
    assert.equal(serverEnv.HAPPIER_PUBLIC_SERVER_URL, env.HAPPIER_PUBLIC_SERVER_URL);
    assert.equal(serverEnv.HAPPIER_IROH_RELAY_POLICY, 'disabled');
    assert.equal(serverEnv.HAPPIER_IROH_RELAY_URLS, null);
    const daemonLog = await readFile(join(fixture.cliHomeDir, 'runtime-daemon.log'), 'utf8');
    assert.match(daemonLog, /^iroh_relay_policy=disabled$/mu);
    assert.match(daemonLog, /^iroh_relay_urls=$/mu);
    const info = await runNode([launcher, 'stack', 'info', fixture.stackName, '--json'], { cwd: repoDir, env: launchEnv });
    assert.equal(commandJson(info, 'stack info').runtime.irohRelay.reason, runtime.irohRelay.reason);
    const doctor = await runNode([join(repoDir, 'apps/stack/scripts/doctor.mjs'), '--json'], { cwd: repoDir, env: launchEnv });
    assert.equal(commandJson(doctor, 'doctor').irohRelay.remediation, runtime.irohRelay.remediation);
    // The tools dispatcher selects this entry. Source fixtures invoke it
    // directly so an admitted test cannot republish shared workspace outputs.
    const tools = await runNode([join(repoDir, 'apps/stack/scripts/iroh_relay.mjs'), 'status', '--json'], { cwd: repoDir, env: launchEnv });
    assert.equal(commandJson(tools, 'tools status').reason, 'relay_process_unavailable');
  } finally {
    await runNode([launcher, 'stack', 'stop', fixture.stackName, '--yes'], { cwd: repoDir, env: launchEnv });
  }
});

test('tools install exposes the canonical installer failure as JSON with its failing exit status', async t => {
  const fixture = await createTempFixture(t, { prefix: 'relay-install-failure-' });
  const result = await runNode([join(repoDir, 'apps/stack/scripts/tools.mjs'), 'iroh-relay', 'install', '--json'], {
    cwd: repoDir, env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
      HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1', HAPPIER_STACK_SANDBOX_DIR: '',
      HAPPIER_STACK_IROH_RELAY_BIN: fixture.path('missing-selected-binary') },
  });
  assert.equal(result.code, 1);
  assert.equal(commandJson(result, 'tools install').reason, 'relay_binary_version_mismatch');
  assert.equal(result.stderr.trim(), '', 'typed relay output needs no generic child-process failure');
});
