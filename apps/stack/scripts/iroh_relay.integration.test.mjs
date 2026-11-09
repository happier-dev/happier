import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { prepareStackRelay, stopHostRelay, inspectStackRelay, inspectHostRelay } from './utils/server/infra/iroh/runtime.mjs';
import { readyDevTargetSyncResult } from './testkit/core/dev_target_sync.mjs';
import { spawnProc } from './utils/proc/proc.mjs';
import { readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import { killPidOwnedByStack } from './utils/proc/ownership.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';
import { projectRetainedRelayEnvironment } from './utils/server/infra/iroh/configuration.mjs';

const repoDir = fileURLToPath(new URL('../../../', import.meta.url));

test('opt-out needs no relay/Tailscale tools and preserves the ordinary Home environment', async t => {
  const fixture = await createTempFixture(t, { prefix: 'iroh-relay-opt-out-' });
  const result = await prepareStackRelay({ repoDir: '/missing-profile', env: {
    HAPPIER_STACK_HOME_DIR: fixture.path('home'),
    HAPPIER_STACK_IROH_RELAY: '0', HAPPIER_SERVER_URL: 'http://home.localhost:3005', PATH: '' } });
  assert.equal(result.relay.status, 'disabled');
  assert.equal(result.env.HAPPIER_SERVER_URL, 'http://home.localhost:3005');
  assert.equal(result.env.HAPPIER_IROH_RELAY_POLICY, 'disabled');
  assert.equal(result.env.HAPPIER_IROH_RELAY_URLS, undefined);
});

test('missing Tailscale degrades only Iroh and settles without retrying', async t => {
  const fixture = await createTempFixture(t, { prefix: 'iroh-relay-degraded-' });
  const result = await prepareStackRelay({ repoDir, env: { HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_TAILSCALE_BIN: fixture.path('missing-tailscale'), HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1',
    HAPPIER_SERVER_URL: 'https://home.example.test' } });
  assert.equal(result.relay.status, 'degraded');
  assert.equal(result.env.HAPPIER_SERVER_URL, 'https://home.example.test');
  assert.equal(result.env.HAPPIER_IROH_RELAY_URLS, undefined);
});

async function hostRelayFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'iroh-relay-host-', registerCleanup: false });
  const servePath = fixture.path('serve.json');
  await writeFile(servePath, '{}');
  const tailscale = writeFakeBin({ root: fixture.root, name: 'tailscale', content: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = process.env.RELAY_TEST_SERVE_CONFIG;
if (args[0] === 'status') { console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'relay-test.example.ts.net.',CapMap:JSON.parse(process.env.RELAY_TEST_CAP_MAP||'{}')},TailscaleIPs:['100.64.0.5']})); process.exit(0); }
if (args[0] === 'cert') { for(const kind of ['cert','key']) fs.writeFileSync(args.find(a=>a.startsWith('--'+kind+'-file=')).split('=').slice(1).join('='),'external certificate boundary fixture'); process.exit(0); }
if(!['serve','funnel'].includes(args[0])) process.exit(1);
if(args[0]==='funnel' && args[1]!=='status' && process.env.RELAY_TEST_FUNNEL_REFUSAL==='1') {
  console.error("sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket\\n/private/alice token=secret-value"); process.exit(7);
}
if(args[0]==='funnel' && args[1]!=='status' && process.env.RELAY_TEST_FUNNEL_APPROVAL==='1') {
  console.error('https://login.tailscale.com/f/serve?node=secret-value'); process.exit(1);
}
if(process.env.RELAY_TEST_OPERATOR_REFUSAL==='inventory') {
  console.error("sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket"); process.exit(1);
}
const config=JSON.parse(fs.readFileSync(path,'utf8'));
const funnelPath=path+'.funnel';
const AllowFunnel=fs.existsSync(funnelPath)?JSON.parse(fs.readFileSync(funnelPath,'utf8')):{};
if(args[1]==='status' && args.includes('--json')) {
  fs.appendFileSync(path+'.reads','json\\n');
  const TCP={},Web={};
  for(const [port,upstream] of Object.entries(config)) {
    TCP[port]={HTTPS:true};
    Web['relay-test.example.ts.net:'+port]={Handlers:{'/':{Proxy:upstream}}};
  }
  console.log(process.env.RELAY_TEST_SERVE_STATUS_JSON || JSON.stringify(Object.keys(config).length ? {TCP,Web,AllowFunnel} : null));
  process.exit(0);
}
if(args[1]==='status') { for(const [port,upstream] of Object.entries(config)) { console.log('https://relay-test.example.ts.net:'+port); console.log('|-- / proxy '+upstream); } process.exit(0); }
if(process.env.RELAY_TEST_OPERATOR_REFUSAL==='1') {
  console.error("sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket"); process.exit(1);
}
const port=args.find(a=>a.startsWith('--https='))?.split('=')[1]||'443';
if(args.at(-1)==='off' && process.env.RELAY_TEST_DISABLE_FAILURE==='1') {
  console.error('Route removal refused by boundary fixture'); process.exit(7);
}
fs.appendFileSync(path+'.commands',JSON.stringify(args)+'\\n');
const hostPort='relay-test.example.ts.net:'+port;
if(args.at(-1)==='off'||args[0]==='serve') delete AllowFunnel[hostPort]; else if(process.env.RELAY_TEST_FUNNEL_NO_EFFECT!=='1') AllowFunnel[hostPort]=true;
fs.writeFileSync(funnelPath,JSON.stringify(AllowFunnel));
fs.appendFileSync(path+'.writes',port+'\\n');
if(args.at(-1)==='off') delete config[port]; else config[port]=args.at(-1);
fs.writeFileSync(path,JSON.stringify(config));
` }).binPath;
  const binary = writeFakeBin({ root: fixture.root, name: 'iroh-relay', content: `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='--version') { console.log('iroh-relay 1.1.0'); process.exit(0); }
const path=args[args.indexOf('--config-path')+1];
const config=fs.readFileSync(path,'utf8');
const port=Number(config.match(/^http_bind_addr = "127\\.0\\.0\\.1:(\\d+)"$/m)[1]);
fs.appendFileSync(path+'.launches','started\\n');
fs.writeFileSync(path+'.env-keys',JSON.stringify(Object.keys(process.env)));
if(!args.includes('--dev') || !config.includes('enable_quic_addr_discovery = true')) process.exit(1);
require('node:http').createServer((req,res)=> {res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',version:'1.1.0'}));}).listen(port,'127.0.0.1');
` }).binPath;
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
    HAPPIER_STACK_HOME_DIR: fixture.path('home'), HAPPIER_STACK_IROH_RELAY: '1',
    HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1', HAPPIER_TAILSCALE_BIN: tailscale,
    HAPPIER_STACK_IROH_RELAY_BIN: binary, RELAY_TEST_SERVE_CONFIG: servePath,
    HAPPIER_IROH_RELAY_POLICY: '', HAPPIER_IROH_RELAY_URLS: '', HAPPIER_MASTER_SECRET: 'fixture-only-secret' };
  t.after(async () => { await stopHostRelay({ env }); await fixture.cleanup(); });
  withPatchedProcessEnv(t, { HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1' });
  return { fixture, env, servePath };
}

function relayTargetExecutor(env, onCommand = () => {}) {
  return {
    runCaptureResult: async ({ args }) => args.includes('list')
      ? readyDevTargetSyncResult(args[args.indexOf('list') + 1]) : { ok: true, out: '', err: '' },
    // Only SSH is replaced; the target worker and relay owner remain real.
    spawnProcess: input => {
      onCommand(input.args.at(-1));
      return spawnProc('fixture-target', '/bin/bash', ['-c', input.args.at(-1)], env,
        { silent: true, persistOutput: false, stdio: ['pipe', 'pipe', 'pipe'], onLine: input.onLine });
    },
  };
}

test('placed inspection reads host AllowFunnel rather than attesting saved public exposure from HTTPS health', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  const publicEnv = { ...env, HAPPIER_STACK_IROH_RELAY_FUNNEL: '1' };
  const first = await prepareStackRelay({ repoDir, env: publicEnv });
  assert.equal(first.relay.status, 'ready', JSON.stringify(first.relay));
  const fetchFromNetwork = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, init) => String(input) === `${first.relay.httpsUrl}/healthz`
    ? Promise.resolve(new Response(JSON.stringify({ status: 'ok', version: first.relay.version })))
    : fetchFromNetwork(input, init));
  await writeFile(servePath + '.funnel', '{}');
  const commands = await readFile(servePath + '.commands', 'utf8');
  const serverTarget = { name: 'server-target', platform: 'posix', ssh: 'fixture-target', repoDir,
    cliHomeDir: env.HAPPIER_STACK_HOME_DIR };
  const observed = await inspectStackRelay({ repoDir, env: publicEnv, serverTarget,
    stackBaseDir: fixture.root, executorDependencies: relayTargetExecutor(env),
    runtimeState: { irohRelay: { ...first.relay, target: serverTarget.name } } });
  assert.equal(observed.exposure, 'tailnet');
  assert.equal(observed.reason, 'funnel_unavailable');
  assert.equal(observed.httpsUrl, first.relay.httpsUrl);
  assert.equal(observed.target, serverTarget.name);
  assert.equal(await readFile(servePath + '.commands', 'utf8'), commands,
    'placed inspection never re-enables Funnel or changes Serve');
});

test('temporary Funnel moves only the relay to a public capable port and opt-out removes public exposure', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  const foreign = { '443': 'http://127.0.0.1:32000', '8443': 'http://127.0.0.1:32001' };
  await writeFile(servePath, JSON.stringify(foreign));
  const privateRelay = await prepareStackRelay({ repoDir, env });
  assert.equal(privateRelay.relay.status, 'ready');
  const publicEnv = { ...env, HAPPIER_STACK_IROH_RELAY_FUNNEL: '1', RELAY_TEST_CAP_MAP: JSON.stringify({
    'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': [],
  }) };
  const published = await prepareStackRelay({ repoDir, env: publicEnv });
  assert.equal(published.relay.status, 'ready', JSON.stringify(published.relay));
  assert.equal(published.relay.exposure, 'public');
  assert.equal(published.env.HAPPIER_IROH_RELAY_URLS, 'https://relay-test.example.ts.net:10000');
  assert.deepEqual(JSON.parse(await readFile(servePath, 'utf8')), { ...foreign, '10000': published.relay.upstreamUrl });
  assert.deepEqual(JSON.parse(await readFile(servePath + '.funnel', 'utf8')), { 'relay-test.example.ts.net:10000': true });
  const commands = await readFile(servePath + '.commands', 'utf8');
  assert.equal((await prepareStackRelay({ repoDir, env: publicEnv })).relay.exposure, 'public');
  assert.equal(await readFile(servePath + '.commands', 'utf8'), commands, 'unchanged public ensure is read-only');
  assert.equal((await inspectStackRelay({ env: publicEnv, runtimeState: { irohRelay: published.relay } })).exposure, 'public');
  const reverted = await prepareStackRelay({ repoDir, env: { ...env, HAPPIER_STACK_IROH_RELAY_FUNNEL: '0' } });
  assert.equal(reverted.relay.status, 'ready', JSON.stringify(reverted.relay));
  assert.equal(reverted.relay.exposure, 'tailnet');
  assert.deepEqual(JSON.parse(await readFile(servePath + '.funnel', 'utf8')), {});
  assert.deepEqual(JSON.parse(await readFile(servePath, 'utf8')), { ...foreign, '10000': reverted.relay.upstreamUrl });
  assert.equal((await readFile(fixture.path('home', 'iroh-relay', 'relay.toml.launches'), 'utf8')).trim(), 'started');
  assert.equal((await prepareStackRelay({ repoDir, env: publicEnv })).relay.exposure, 'public');
  assert.deepEqual(await stopHostRelay({ env }), { stopped: true });
  assert.deepEqual(JSON.parse(await readFile(servePath, 'utf8')), foreign);
  assert.deepEqual(JSON.parse(await readFile(servePath + '.funnel', 'utf8')), {});
});

test('ensure adopts a manually enabled owned Funnel without rewriting its mapping, then opt-out disables it', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  await writeFile(servePath, JSON.stringify({ '443': 'http://127.0.0.1:32000', '8443': 'http://127.0.0.1:32001' }));
  const publicEnv = { ...env, HAPPIER_STACK_IROH_RELAY_FUNNEL: '1' };
  const initial = await prepareStackRelay({ repoDir, env: { ...publicEnv, RELAY_TEST_FUNNEL_NO_EFFECT: '1' } });
  assert.equal(initial.relay.reason, 'funnel_unavailable');
  await writeFile(servePath + '.funnel', JSON.stringify({ 'relay-test.example.ts.net:10000': true }));
  const commands = await readFile(servePath + '.commands', 'utf8');
  const adopted = await prepareStackRelay({ repoDir, env: publicEnv });
  assert.equal(adopted.relay.exposure, 'public');
  assert.equal(adopted.relay.status, 'ready');
  assert.equal(await readFile(servePath + '.commands', 'utf8'), commands, 'adoption must not run Serve or Funnel');
  const host = await readStackRuntimeStateFile(fixture.path('home', 'iroh-relay', 'stack.runtime.json'));
  assert.equal(host.irohRelay.exposure, 'public', 'owned exposure must survive the next opt-out');
  assert.equal(host.irohRelay.failure, null);
  const reverted = await prepareStackRelay({ repoDir, env: { ...env, HAPPIER_STACK_IROH_RELAY_FUNNEL: '0' } });
  assert.equal(reverted.relay.exposure, 'tailnet');
  assert.deepEqual(JSON.parse(await readFile(servePath + '.funnel', 'utf8')), {});
});

test('host Funnel intent survives another stack ensure and recovery until explicit opt-out or host stop', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  const foreign = { '443': 'http://127.0.0.1:32000', '8443': 'http://127.0.0.1:32001' };
  await writeFile(servePath, JSON.stringify(foreign));
  const owner = { ...env, HAPPIER_STACK_STACK: 'agent-qa-l12-c', HAPPIER_STACK_IROH_RELAY_FUNNEL: '1' };
  const other = { ...env, HAPPIER_STACK_STACK: 'other-stack' };
  const first = await prepareStackRelay({ repoDir, env: owner, runtimeStatePath: fixture.path('owner.runtime.json') });
  assert.equal(first.relay.exposure, 'public');
  const commands = await readFile(servePath + '.commands', 'utf8');
  const second = await prepareStackRelay({ repoDir, env: other, runtimeStatePath: fixture.path('other.runtime.json') });
  assert.equal(second.relay.exposure, 'public');
  assert.equal(second.relay.httpsUrl, first.relay.httpsUrl);
  assert.equal(second.env.HAPPIER_IROH_RELAY_URLS, first.env.HAPPIER_IROH_RELAY_URLS);
  assert.equal(await readFile(servePath + '.commands', 'utf8'), commands, 'an unrelated stack ensure must not rewrite the listener');
  assert.equal((await prepareStackRelay({ repoDir, env: { ...other, HAPPIER_STACK_IROH_RELAY_FUNNEL: '0' } })).relay.exposure, 'public');
  assert.equal(await readFile(servePath + '.commands', 'utf8'), commands, 'another stack cannot clear the enabling stack decision');
  const statePath = fixture.path('home', 'iroh-relay', 'stack.runtime.json');
  const host = await readStackRuntimeStateFile(statePath);
  assert.equal(host.relayFunnel.enabled, true);
  assert.equal(host.relayFunnel.stack, 'agent-qa-l12-c');
  await killPidOwnedByStack(host.processes.relayPid, { stackName: 'host-iroh-relay',
    envPath: fixture.path('home', 'iroh-relay', 'env'), signal: 'SIGINT', json: true });
  const recovered = await prepareStackRelay({ repoDir, env: other });
  assert.equal(recovered.relay.exposure, 'public');
  assert.equal(recovered.relay.httpsUrl, first.relay.httpsUrl);
  const off = await prepareStackRelay({ repoDir, env: { ...owner, HAPPIER_STACK_IROH_RELAY_FUNNEL: '0' } });
  assert.equal(off.relay.exposure, 'tailnet');
  assert.equal(off.relay.httpsUrl, first.relay.httpsUrl);
  assert.equal((await readStackRuntimeStateFile(statePath)).relayFunnel.enabled, false);
  assert.deepEqual(JSON.parse(await readFile(servePath + '.funnel', 'utf8')), {});
  assert.deepEqual(JSON.parse(await readFile(servePath, 'utf8')), { ...foreign, '10000': off.relay.upstreamUrl });
  assert.equal((await prepareStackRelay({ repoDir, env: other })).relay.httpsUrl, off.relay.httpsUrl);
  assert.equal((await prepareStackRelay({ repoDir, env: owner })).relay.exposure, 'public');
  const stopped = await runNodeCapture([join(repoDir, 'apps/stack/scripts/iroh_relay.mjs'), 'stop', '--json'], {
    cwd: repoDir, env: other,
  });
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.deepEqual(JSON.parse(stopped.stdout), { stopped: true });
  assert.equal((await readStackRuntimeStateFile(statePath)).relayFunnel.enabled, false);
  assert.equal((await prepareStackRelay({ repoDir, env: other })).relay.exposure, 'tailnet');
});

test('stack relay opt-outs leave the shared host process and public mapping untouched', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  const owner = { ...env, HAPPIER_STACK_STACK: 'public-owner', HAPPIER_STACK_IROH_RELAY_FUNNEL: '1' };
  const first = await prepareStackRelay({ repoDir, env: owner });
  assert.equal(first.relay.exposure, 'public');
  const statePath = fixture.path('home', 'iroh-relay', 'stack.runtime.json');
  const host = await readFile(statePath, 'utf8');
  const commands = await readFile(servePath + '.commands', 'utf8');
  const other = { ...env, HAPPIER_STACK_STACK: 'other-stack' };
  for (const optOut of [
    { HAPPIER_STACK_IROH_RELAY: '0' },
    { HAPPIER_IROH_RELAY_POLICY: 'disabled' },
    { HAPPIER_STACK_SANDBOX_DIR: fixture.path('sandbox'), HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '' },
  ]) {
    const disabled = await prepareStackRelay({ repoDir, env: { ...other, ...optOut } });
    assert.equal(disabled.relay.status, 'disabled');
    assert.equal(disabled.env.HAPPIER_IROH_RELAY_POLICY, 'disabled');
    assert.equal(disabled.env.HAPPIER_IROH_RELAY_URLS, undefined);
    assert.equal(await readFile(statePath, 'utf8'), host, 'consumer opt-out must not mutate the host owner');
    assert.equal(await readFile(servePath + '.commands', 'utf8'), commands);
    assert.equal((await inspectHostRelay({ env })).exposure, 'public');
  }
  const resumed = await prepareStackRelay({ repoDir, env: other });
  assert.equal(resumed.relay.httpsUrl, first.relay.httpsUrl);
  assert.equal((await readFile(fixture.path('home', 'iroh-relay', 'relay.toml.launches'), 'utf8')).trim(), 'started');
});

test('a legacy public host record needs a named opt-in before stack opt-out can clear it', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  const owner = { ...env, HAPPIER_STACK_STACK: 'legacy-owner', HAPPIER_STACK_IROH_RELAY_FUNNEL: '1' };
  const first = await prepareStackRelay({ repoDir, env: owner });
  const statePath = fixture.path('home', 'iroh-relay', 'stack.runtime.json');
  const host = await readStackRuntimeStateFile(statePath);
  delete host.relayFunnel;
  await writeFile(statePath, JSON.stringify(host));
  const commands = await readFile(servePath + '.commands', 'utf8');
  const other = { ...env, HAPPIER_STACK_STACK: 'other-stack' };
  assert.equal((await prepareStackRelay({ repoDir, env: other })).relay.httpsUrl, first.relay.httpsUrl);
  assert.equal((await prepareStackRelay({ repoDir, env: { ...other, HAPPIER_STACK_IROH_RELAY_FUNNEL: '0' } })).relay.exposure, 'public');
  assert.equal(await readFile(servePath + '.commands', 'utf8'), commands);
  assert.equal((await prepareStackRelay({ repoDir, env: owner })).relay.exposure, 'public');
  assert.equal((await readStackRuntimeStateFile(statePath)).relayFunnel.stack, 'legacy-owner');
  assert.equal((await prepareStackRelay({ repoDir, env: { ...owner, HAPPIER_STACK_IROH_RELAY_FUNNEL: '0' } })).relay.exposure, 'tailnet');
});

for (const refusal of ['RELAY_TEST_FUNNEL_REFUSAL', 'RELAY_TEST_FUNNEL_NO_EFFECT', 'RELAY_TEST_FUNNEL_APPROVAL']) {
test(`a refused or ineffective Funnel keeps the observed tailnet relay available (${refusal})`, async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  const foreign = { '443': 'http://127.0.0.1:32000', '8443': 'http://127.0.0.1:32001' };
  await writeFile(servePath, JSON.stringify(foreign));
  const runtimeStatePath = fixture.path('stack.runtime.json');
  const result = await prepareStackRelay({ repoDir, runtimeStatePath, env: { ...env,
    HAPPIER_STACK_IROH_RELAY_FUNNEL: '1', [refusal]: '1',
    HAPPIER_SERVER_URL: 'https://home.example.test' } });
  assert.equal(result.relay.status, 'degraded');
  assert.equal(result.relay.reason, 'funnel_unavailable');
  assert.equal(result.relay.exposure, 'tailnet');
  assert.equal(result.env.HAPPIER_SERVER_URL, 'https://home.example.test');
  assert.equal(result.env.HAPPIER_IROH_RELAY_URLS, 'https://relay-test.example.ts.net:10000');
  assert.equal(result.env.HAPPIER_IROH_RELAY_POLICY, 'automatic');
  const retained = await readStackRuntimeStateFile(runtimeStatePath);
  assert.equal(projectRetainedRelayEnvironment(env, retained.irohRelay).HAPPIER_IROH_RELAY_URLS, result.relay.httpsUrl);
  assert.deepEqual(JSON.parse(await readFile(servePath, 'utf8')), { ...foreign, '10000': result.relay.upstreamUrl });
  const host = await readStackRuntimeStateFile(join(env.HAPPIER_STACK_HOME_DIR, 'iroh-relay', 'stack.runtime.json'));
  assert.equal(host.irohRelay.exposure, 'tailnet');
  if (refusal !== 'RELAY_TEST_FUNNEL_NO_EFFECT') {
    assert.equal(result.relay.failure.code, refusal === 'RELAY_TEST_FUNNEL_APPROVAL'
      ? 'tailscale_funnel_approval_required' : 'tailscale_operator_authorization_refused');
    assert.deepEqual(host.irohRelay.failure, result.relay.failure);
    if (refusal === 'RELAY_TEST_FUNNEL_REFUSAL') assert.equal(result.relay.failure.stderrClass, 'operator_authorization_refused');
    assert.doesNotMatch(JSON.stringify(result.relay), /secret-value|private\/alice|login\.tailscale/);
  }
  assert.equal((await inspectHostRelay({ env: { ...env, HAPPIER_STACK_IROH_RELAY_FUNNEL: '1' } })).reason, 'funnel_unavailable');
  const repaired = await prepareStackRelay({ repoDir, env });
  assert.equal(repaired.relay.status, 'ready');
  assert.equal(repaired.relay.exposure, 'public');
  assert.equal((await inspectStackRelay({ env: { ...env, HAPPIER_STACK_IROH_RELAY_FUNNEL: '1' },
    runtimeState: { irohRelay: result.relay } })).exposure, 'public', 'a retained Funnel refusal also reads the live owner');
  await writeFile(servePath + '.funnel', '{}');
  const observed = await inspectStackRelay({ env: { ...env, HAPPIER_STACK_IROH_RELAY_FUNNEL: '1' }, runtimeState: { irohRelay: repaired.relay } });
  assert.equal(observed.exposure, 'tailnet', 'inspection must ignore the previously public runtime record');
  assert.equal(observed.reason, 'funnel_unavailable');
});
}

test('a foreign default listener is preserved while the selected relay URL reaches both stacks', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  const foreign = { '8443': 'http://127.0.0.1:32001', '9443': 'http://127.0.0.1:32002' };
  await writeFile(servePath, JSON.stringify(foreign));
  const first = await prepareStackRelay({ repoDir, env });
  assert.equal(first.relay.status, 'ready', first.relay.reason);
  const port = Number(new URL(first.relay.httpsUrl).port);
  assert.ok(port > 8443 && port !== 9443);
  assert.equal(first.env.HAPPIER_IROH_RELAY_URLS, first.relay.httpsUrl);
  const statePath = fixture.path('home', 'iroh-relay', 'stack.runtime.json');
  const beforeReuse = await readStackRuntimeStateFile(statePath);
  const second = await prepareStackRelay({ repoDir, env });
  assert.equal(second.relay.httpsUrl, first.relay.httpsUrl);
  const host = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(host, beforeReuse, 'unchanged ensure must not republish host state');
  assert.equal(host.ports.relayHttps, port);
  const config = JSON.parse(await readFile(servePath, 'utf8'));
  for (const [foreignPort, upstream] of Object.entries(foreign)) assert.equal(config[foreignPort], upstream);
  assert.equal(config[port], first.relay.upstreamUrl);
  assert.equal((await readFile(servePath + '.reads', 'utf8')).trim(), 'json\njson\njson',
    'each ensure reads one inventory; publication also observes its effect once');
  assert.equal((await readFile(servePath + '.writes', 'utf8')).trim(), String(port),
    'unchanged ensure must not republish its existing route');
  await stopHostRelay({ env });
  assert.deepEqual(JSON.parse(await readFile(servePath, 'utf8')), foreign);
});

test('an owned listener and its persisted port are reused across route recovery and a relay restart', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  await writeFile(servePath, JSON.stringify({ '8443': 'http://127.0.0.1:32001' }));
  const first = await prepareStackRelay({ repoDir, env });
  assert.equal(first.relay.status, 'ready', first.relay.reason);
  const port = Number(new URL(first.relay.httpsUrl).port);
  await writeFile(servePath, JSON.stringify({ [port]: first.relay.upstreamUrl }));
  const reused = await prepareStackRelay({ repoDir, env });
  assert.equal(reused.relay.httpsUrl, first.relay.httpsUrl, 'a now-free default cannot displace an owned listener');
  await writeFile(servePath, '{}');
  assert.equal((await prepareStackRelay({ repoDir, env })).relay.httpsUrl, first.relay.httpsUrl);
  await stopHostRelay({ env });
  const restarted = await prepareStackRelay({ repoDir, env });
  assert.equal(restarted.relay.status, 'ready', restarted.relay.reason);
  assert.equal(restarted.relay.httpsUrl, first.relay.httpsUrl);
  assert.equal((await readFile(fixture.path('home', 'iroh-relay', 'relay.toml.launches'), 'utf8')).trim(), 'started\nstarted');
});

test('host tools status re-ensures an unexpectedly exited relay once and respects explicit stop', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  const first = await prepareStackRelay({ repoDir, env });
  assert.equal(first.relay.status, 'ready', first.relay.reason);
  const statePath = fixture.path('home', 'iroh-relay', 'stack.runtime.json');
  const host = await readStackRuntimeStateFile(statePath);
  const retired = await killPidOwnedByStack(host.processes.relayPid, {
    stackName: 'host-iroh-relay', envPath: fixture.path('home', 'iroh-relay', 'env'),
    signal: 'SIGINT', json: true,
  });
  assert.equal(retired.killed, true);
  assert.equal((await inspectHostRelay({ env })).reason, 'relay_process_unavailable');
  const status = async (overrides = {}) => {
    const result = await runNodeCapture([join(repoDir, 'apps/stack/scripts/iroh_relay.mjs'), 'status', '--json'], {
      cwd: repoDir, env: { ...env, ...overrides },
    });
    assert.equal(result.code, 0);
    return JSON.parse(result.stdout);
  };
  const launchPath = fixture.path('home', 'iroh-relay', 'relay.toml.launches');
  const routeBefore = await readFile(servePath, 'utf8');
  const disabledStatus = await status({ HAPPIER_STACK_IROH_RELAY: '0' });
  assert.equal(disabledStatus.reason, 'relay_process_unavailable', JSON.stringify(disabledStatus));
  const unavailable = await status({ RELAY_TEST_SERVE_STATUS_JSON: 'not-json' });
  assert.equal(unavailable.status, 'degraded');
  assert.equal(unavailable.reason, 'relay_serve_status_unavailable');
  assert.equal(await readFile(servePath, 'utf8'), routeBefore);
  assert.equal((await readFile(launchPath, 'utf8')).trim(), 'started');
  const recovered = await status();
  assert.equal(recovered.status, 'ready', recovered.reason);
  assert.equal(recovered.httpsUrl, first.relay.httpsUrl);
  const recoveredState = await readStackRuntimeStateFile(statePath);
  assert.notEqual(recoveredState.processes.relayPid, host.processes.relayPid);
  assert.equal((await readFile(launchPath, 'utf8')).trim(), 'started\nstarted');
  const routeWrites = await readFile(servePath + '.writes', 'utf8');
  assert.equal((await status()).status, 'ready');
  assert.deepEqual(await readStackRuntimeStateFile(statePath), recoveredState);
  assert.equal(await readFile(servePath + '.writes', 'utf8'), routeWrites);
  assert.equal((await readFile(launchPath, 'utf8')).trim(), 'started\nstarted');
  await stopHostRelay({ env });
  assert.equal((await status()).status, 'not_started');
  assert.equal((await readFile(launchPath, 'utf8')).trim(), 'started\nstarted');
});

test('startup failures expose a redacted phase and system code through ensure and host tools status', async t => {
  const { fixture, env } = await hostRelayFixture(t);
  const first = await prepareStackRelay({ repoDir, env });
  assert.equal(first.relay.status, 'ready', first.relay.reason);
  const host = await readStackRuntimeStateFile(fixture.path('home', 'iroh-relay', 'stack.runtime.json'));
  const retired = await killPidOwnedByStack(host.processes.relayPid, {
    stackName: 'host-iroh-relay', envPath: fixture.path('home', 'iroh-relay', 'env'),
    signal: 'SIGINT', json: true,
  });
  assert.equal(retired.killed, true);
  const missingRepo = fixture.path('private-diagnostic-path');
  const ensured = await prepareStackRelay({ repoDir: missingRepo, env });
  assert.equal(ensured.relay.reason, 'relay_start_failed');
  assert.deepEqual(ensured.relay.failure, { phase: 'profile', code: 'ENOENT' });
  const status = await runNodeCapture([join(repoDir, 'apps/stack/scripts/iroh_relay.mjs'), 'status', '--json'], {
    cwd: repoDir, env: { ...env, HAPPIER_STACK_REPO_DIR: missingRepo },
  });
  assert.equal(status.code, 0);
  const observed = JSON.parse(status.stdout);
  assert.deepEqual(observed.failure, ensured.relay.failure);
  assert.equal(observed.reason, 'relay_start_failed');
  assert.equal(JSON.stringify(ensured.relay).includes(missingRepo), false);
  assert.equal(status.stdout.includes(missingRepo), false);
});

test('retirement failures retain the Tailscale boundary class and exit code', async t => {
  const { fixture, env } = await hostRelayFixture(t);
  assert.equal((await prepareStackRelay({ repoDir, env })).relay.status, 'ready');
  const host = await readStackRuntimeStateFile(fixture.path('home', 'iroh-relay', 'stack.runtime.json'));
  assert.equal((await killPidOwnedByStack(host.processes.relayPid, {
    stackName: 'host-iroh-relay', envPath: fixture.path('home', 'iroh-relay', 'env'),
    signal: 'SIGINT', json: true,
  })).killed, true);
  const result = await prepareStackRelay({ repoDir, env: { ...env, RELAY_TEST_DISABLE_FAILURE: '1' } });
  assert.equal(result.relay.reason, 'relay_start_failed');
  assert.deepEqual(result.relay.failure,
    { phase: 'retirement', code: 'TailscaleCommandError', stderrClass: 'unclassified', exitCode: 7 });
  assert.deepEqual((await inspectHostRelay({ env })).failure, result.relay.failure);
  assert.equal(JSON.stringify(result.relay).includes('Route removal refused'), false);
  const later = await prepareStackRelay({ repoDir: fixture.path('missing-later-profile'), env });
  assert.deepEqual(later.relay.failure, { phase: 'profile', code: 'ENOENT' });
  assert.deepEqual((await inspectHostRelay({ env })).failure, later.relay.failure,
    'a later failure cannot inherit the earlier command exit code');
});

test('relay repair clears an earlier typed refusal after an explicit retry succeeds', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  assert.equal((await prepareStackRelay({ repoDir, env })).relay.status, 'ready');
  for (const phase of ['inventory', 'enable']) {
    if (phase === 'enable') await writeFile(servePath, '{}');
    const refused = await prepareStackRelay({ repoDir, env: { ...env,
      RELAY_TEST_OPERATOR_REFUSAL: phase === 'inventory' ? 'inventory' : '1' } });
    assert.equal(refused.relay.reason, 'tailscale_operator_authorization_refused');
    assert.equal(refused.relay.failure.retryable, false);
    assert.equal((await prepareStackRelay({ repoDir, env })).relay.status, 'ready');
    const host = await readStackRuntimeStateFile(fixture.path('home', 'iroh-relay', 'stack.runtime.json'));
    assert.equal(host.irohRelay.failure, null,
      `successful recovery after ${phase} must not retain a historical refusal for later status projection`);
  }
});

test('failed initial preparation retains redacted diagnostics for observational host status', async t => {
  const { fixture, env } = await hostRelayFixture(t);
  const missingRepo = fixture.path('private-profile-path');
  const ensured = await prepareStackRelay({ repoDir: missingRepo, env });
  assert.equal(ensured.relay.reason, 'relay_start_failed');
  const observed = await inspectHostRelay({ env });
  assert.deepEqual(observed.failure, { phase: 'profile', code: 'ENOENT' });
  const status = await runNodeCapture([join(repoDir, 'apps/stack/scripts/tools.mjs'), 'iroh-relay', 'status', '--json'], {
    cwd: repoDir, env,
  });
  assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.stdout).failure, observed.failure);
  assert.equal(status.stdout.includes(missingRepo), false);
  await assert.rejects(readFile(fixture.path('home', 'iroh-relay', 'relay.toml.launches')), { code: 'ENOENT' });
});

test('an unreadable listener inventory disables only Iroh without spawning or mutating Serve', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  const result = await prepareStackRelay({ repoDir, env: { ...env, RELAY_TEST_SERVE_STATUS_JSON: 'not-json' } });
  assert.equal(result.relay.reason, 'relay_serve_status_unavailable');
  assert.ok(result.relay.remediation);
  assert.equal(result.env.HAPPIER_IROH_RELAY_POLICY, 'disabled');
  assert.equal(result.env.HAPPIER_IROH_RELAY_URLS, undefined);
  assert.deepEqual(JSON.parse(await readFile(servePath, 'utf8')), {});
  await assert.rejects(readFile(fixture.path('home', 'iroh-relay', 'relay.toml.launches')), { code: 'ENOENT' });
  await assert.rejects(readFile(servePath + '.writes'), { code: 'ENOENT' });
});

test('a replaced relay route stays foreign when the live relay moves and later stops', async t => {
  const { env, servePath } = await hostRelayFixture(t);
  const first = await prepareStackRelay({ repoDir, env });
  assert.equal(first.relay.status, 'ready', first.relay.reason);
  const oldPort = Number(new URL(first.relay.httpsUrl).port);
  const foreign = { [oldPort]: 'http://127.0.0.1:32003' };
  await writeFile(servePath, JSON.stringify(foreign));
  const recovered = await prepareStackRelay({ repoDir, env });
  assert.equal(recovered.relay.status, 'ready', recovered.relay.reason);
  assert.notEqual(recovered.relay.httpsUrl, first.relay.httpsUrl);
  assert.equal(JSON.parse(await readFile(servePath, 'utf8'))[oldPort], foreign[oldPort]);
  await stopHostRelay({ env });
  assert.deepEqual(JSON.parse(await readFile(servePath, 'utf8')), foreign);
});

test('two stack starts share one pinned process and only the TLS-served relay URL reaches consumers', async t => {
  const { fixture, env, servePath } = await hostRelayFixture(t);
  const stackA = fixture.path('stack-a', 'stack.runtime.json');
  const stackB = fixture.path('stack-b', 'stack.runtime.json');
  const [first, second] = await Promise.all([
    prepareStackRelay({ repoDir, env, runtimeStatePath: stackA }),
    prepareStackRelay({ repoDir, env, runtimeStatePath: stackB }),
  ]);
  assert.equal(first.relay.status, 'ready', JSON.stringify(first.relay));
  assert.equal(second.relay.status, 'ready', JSON.stringify(second.relay));
  const initialHost = await readStackRuntimeStateFile(join(env.HAPPIER_STACK_HOME_DIR, 'iroh-relay', 'stack.runtime.json'));
  assert.equal(first.env.HAPPIER_IROH_RELAY_URLS, `https://relay-test.example.ts.net:${initialHost.ports.relayHttps}`);
  assert.equal(JSON.parse(await readFile(servePath, 'utf8'))[initialHost.ports.relayHttps], initialHost.irohRelay.upstreamUrl);
  assert.equal(second.env.HAPPIER_IROH_RELAY_URLS, first.env.HAPPIER_IROH_RELAY_URLS);
  const configPath = join(env.HAPPIER_STACK_HOME_DIR, 'iroh-relay', 'relay.toml');
  assert.equal((await readFile(`${configPath}.launches`, 'utf8')).trim(), 'started');
  assert.ok(!JSON.parse(await readFile(`${configPath}.env-keys`, 'utf8')).includes('HAPPIER_MASTER_SECRET'));
  const observed = await inspectStackRelay({ env, runtimeState: await readStackRuntimeStateFile(stackA) });
  assert.equal(observed.status, 'ready');
  const sandbox = await prepareStackRelay({ repoDir, env: { ...env,
    HAPPIER_STACK_SANDBOX_DIR: fixture.path('sandbox'), HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '',
    HAPPIER_STACK_IROH_RELAY: '0' } });
  assert.equal(sandbox.relay.status, 'disabled');
  assert.equal((await inspectStackRelay({ env, runtimeState: await readStackRuntimeStateFile(stackA) })).status, 'ready',
    'sandbox opt-out must not retire the real host relay');
  await writeFile(servePath, '{}');
  assert.equal((await inspectStackRelay({ env, runtimeState: await readStackRuntimeStateFile(stackA) })).reason, 'relay_serve_unavailable');
  assert.equal((await prepareStackRelay({ repoDir, env })).relay.status, 'ready');
  assert.equal((await readFile(`${configPath}.launches`, 'utf8')).trim(), 'started');
  const host = await readStackRuntimeStateFile(join(env.HAPPIER_STACK_HOME_DIR, 'iroh-relay', 'stack.runtime.json'));
  const retired = await killPidOwnedByStack(host.processes.relayPid, { stackName: 'host-iroh-relay',
    envPath: join(env.HAPPIER_STACK_HOME_DIR, 'iroh-relay', 'env'), signal: 'SIGINT', json: true });
  assert.equal(retired.killed, true);
  const unrelated = createServer((req, res) => res.end('not the relay'));
  await new Promise((resolve, reject) => {
    unrelated.once('error', reject);
    unrelated.listen(Number(new URL(host.irohRelay.upstreamUrl).port), '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  const recovered = await prepareStackRelay({ repoDir, env });
  assert.equal(recovered.relay.status, 'ready', JSON.stringify(recovered.relay));
  assert.equal((await readFile(`${configPath}.launches`, 'utf8')).trim(), 'started\nstarted');
  const disabled = await prepareStackRelay({ repoDir, env: { ...env, HAPPIER_STACK_IROH_RELAY: '0' } });
  assert.equal(disabled.relay.status, 'disabled');
  assert.equal((await inspectHostRelay({ env })).status, 'ready');
  assert.deepEqual(await stopHostRelay({ env }), { stopped: true });
  assert.deepEqual(JSON.parse(await readFile(servePath, 'utf8')), {});
});

test('a ready target relay survives its finite preparation worker and is reused without a second spawn', async t => {
  const { fixture, env: initialEnv } = await hostRelayFixture(t);
  const env = { ...initialEnv, CARGO_HOME: fixture.path('rust', '.cargo') };
  delete env.HAPPIER_STACK_IROH_RELAY_BIN;
  writeFakeBin({ root: env.CARGO_HOME, name: 'cargo', content: `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 'install' || args[1] !== 'iroh-relay' || !args.includes('--locked')
  || args[args.indexOf('--version') + 1] !== '1.1.0'
  || args[args.indexOf('--features') + 1] !== 'server') process.exit(1);
const root = args[args.indexOf('--root') + 1];
fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
fs.appendFileSync(path.join(root, 'install.calls'), 'installed\\n');
fs.copyFileSync(${JSON.stringify(initialEnv.HAPPIER_STACK_IROH_RELAY_BIN)}, path.join(root, 'bin', 'iroh-relay'));
` });
  const controllerBinary = fixture.path('controller-only-relay');
  const controllerEnv = { ...env, HAPPIER_STACK_STACK: 'placed-relay-owner', HAPPIER_STACK_IROH_RELAY_FUNNEL: '1', HAPPIER_STACK_HOME_DIR: fixture.path('controller'),
    HAPPIER_STACK_IROH_RELAY_BIN: controllerBinary };
  let controllerBinaryForwards = 0;
  const serverTarget = { name: 'server-target', platform: 'posix', ssh: 'fixture-target', repoDir,
    cliHomeDir: env.HAPPIER_STACK_HOME_DIR };
  const executorDependencies = relayTargetExecutor(env, command => {
    if (command.includes(controllerBinary)) controllerBinaryForwards++;
  });
  const options = { repoDir, env: controllerEnv, serverTarget, stackBaseDir: fixture.root, executorDependencies };
  const first = await prepareStackRelay(options);
  assert.equal(first.relay.status, 'ready', first.relay.reason);
  assert.equal(first.relay.exposure, 'public', 'placed preparation forwards the explicit opt-in');
  assert.equal(new URL(first.relay.httpsUrl).hostname, 'relay-test.example.ts.net');
  assert.equal(first.env.HAPPIER_IROH_RELAY_URLS, first.relay.httpsUrl);
  assert.equal((await inspectHostRelay({ env })).status, 'ready', 'the relay survives worker custody cleanup');
  assert.equal((await readStackRuntimeStateFile(join(env.HAPPIER_STACK_HOME_DIR, 'iroh-relay', 'stack.runtime.json'))).relayFunnel.stack,
    'placed-relay-owner');
  const second = await prepareStackRelay({ ...options, env: { ...controllerEnv,
    HAPPIER_STACK_STACK: 'placed-unrelated-stack', HAPPIER_STACK_IROH_RELAY_FUNNEL: undefined } });
  assert.equal(second.relay.status, 'ready', second.relay.reason);
  assert.equal(second.relay.exposure, 'public');
  assert.equal(second.relay.httpsUrl, first.relay.httpsUrl);
  assert.equal((await readFile(join(env.HAPPIER_STACK_HOME_DIR, 'iroh-relay', 'relay.toml.launches'), 'utf8')).trim(), 'started');
  assert.equal(await readStackRuntimeStateFile(join(controllerEnv.HAPPIER_STACK_HOME_DIR, 'iroh-relay', 'stack.runtime.json')), null);
  assert.equal((await readFile(join(env.HAPPIER_STACK_HOME_DIR, 'tools', 'iroh-relay', '1.1.0', 'install.calls'), 'utf8')).trim(), 'installed');
  const statePath = join(env.HAPPIER_STACK_HOME_DIR, 'iroh-relay', 'stack.runtime.json');
  const hostState = await readFile(statePath, 'utf8');
  const disabled = await prepareStackRelay({ ...options, env: { ...controllerEnv,
    HAPPIER_STACK_STACK: 'placed-unrelated-stack', HAPPIER_STACK_IROH_RELAY: '0',
    HAPPIER_STACK_IROH_RELAY_FUNNEL: undefined } });
  assert.equal(disabled.relay.status, 'disabled');
  assert.equal(await readFile(statePath, 'utf8'), hostState, 'a placed opt-out cannot retire the shared host relay');
  assert.equal((await inspectHostRelay({ env })).exposure, 'public');
  assert.equal(controllerBinaryForwards, 0);
});
