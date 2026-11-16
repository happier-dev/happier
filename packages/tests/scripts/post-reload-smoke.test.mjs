import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { parseSmokeArgs, runSmoke } from './post-reload-smoke.mjs';

const args = ['--identity', 'qa-smoke', '--account-id', 'account-a', '--machine-id', 'machine-a',
  '--path', '/tmp', '--agent', 'codex', '--model', 'muse-spark-1.3-contributor',
  '--reasoning-effort', 'minimal', '--auth', 'native', '--provider-connection', 'pc-muse'];

// Mock only the process boundary. The complete runner, envelope reader, result
// assertions, command grammar, and cleanup execute unchanged.
function fakeLiveCli(t, { failedTurn = false, missingReply = false, wrongAccount = false, nestedFailure = false } = {}) {
  const commands = [];
  let reply;
  t.mock.method(childProcess, 'spawn', (_executable, invocation) => {
    const argv = invocation.slice(invocation.lastIndexOf('--') + 1);
    commands.push(argv);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const command = argv.slice(0, 2).join(' ');
    let kind;
    let data;
    switch (command) {
      case 'auth status': kind = 'auth_status'; data = { authenticated: true, accountId: wrongAccount ? 'other-account' : 'account-a', serverId: 'server-a' }; break;
      case 'providers list': kind = 'providers_list'; data = { connections: [{ connectionId: 'pc-muse' }] }; break;
      case 'actions invoke':
        kind = 'actions_invoke';
        data = argv[2] === 'connectedServices.accounts.list' ? { accounts: [], pools: [] }
          : nestedFailure ? { ok: false, error: 'deployment_access_denied' }
            : argv[2] === 'deployments.environments.get' ? { ok: true, environment: { id: 'environment-a' }, targetLinks: [] }
              : { ok: true, items: [], nextCursor: null };
        break;
      case 'session create':
        reply = argv[argv.indexOf('--prompt') + 1].split(' ').at(-1);
        kind = 'session_create'; data = { session: { id: 'own-session' }, initialInput: { status: 'accepted' } }; break;
      case 'session wait': kind = 'session_wait'; data = { sessionId: 'own-session', idle: true }; break;
      case 'session history':
        kind = 'session_history';
        data = { sessionId: 'own-session', messages: failedTurn
          // Captured COR4-166 shape: accepted spawn + idle + a failed real turn.
          ? [{ role: 'agent', kind: 'acp', text: 'Codex turn failed: The Provider model was not found. (provider_model_not_found)' }, { role: 'event', kind: 'turn_failed', text: '' }]
          : [{ role: 'user', kind: 'text', text: `Reply ${reply}` }, { role: 'agent', kind: 'text', text: missingReply ? 'Provider could not answer' : reply }] };
        break;
      case 'session stop': kind = 'session_stop'; data = { sessionId: 'own-session', stopped: true }; break;
      case 'session archive': kind = 'session_archive'; data = { sessionId: 'own-session', archivedAt: 1794849435498 }; break;
      default: throw new Error(`Unexpected command ${command}`);
    }
    queueMicrotask(() => {
      child.stdout.end(`private diagnostics never printed\n${JSON.stringify({ v: 1, ok: true, kind, data }, null, 2)}\nConnection closed.\n`);
      child.emit('close', 0, null);
    });
    return child;
  });
  return commands;
}

test('accepted spawn and idle are insufficient when the Agent transcript failed; cleans only its Session', async t => {
  const commands = fakeLiveCli(t, { failedTurn: true });
  const report = await runSmoke(parseSmokeArgs(args));
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.find(row => row.name === 'agent-settled-turn'), {
    name: 'agent-settled-turn', ok: false, code: 'agent_turn_failed',
  });
  assert.equal(report.checks.find(row => row.name === 'session-archive').ok, true);
  assert.ok(commands.filter(row => row[1] === 'stop' || row[1] === 'archive').every(row => row[2] === 'own-session'));
});

test('a real reply after the owning wait passes, with explicit identity and no raw diagnostics', async t => {
  fakeLiveCli(t);
  const report = await runSmoke(parseSmokeArgs([...args, '--environment-id', 'environment-a']));
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(row => row.name === 'environment-definition').ok, true);
  assert.equal(report.checks.find(row => row.name === 'environment-receipts').ok, true);
  assert.ok(!JSON.stringify(report).includes('private diagnostics'));
});

test('the prompt echo or unrelated Agent text cannot stand in for the requested real reply', async t => {
  fakeLiveCli(t, { missingReply: true });
  const report = await runSmoke(parseSmokeArgs(args));
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(row => row.name === 'agent-settled-turn').code, 'agent_reply_missing');
  assert.equal(report.checks.find(row => row.name === 'session-stop').ok, true);
});

test('wrong Account identity stops before any Agent or fixture mutation', async t => {
  const commands = fakeLiveCli(t, { wrongAccount: true });
  const report = await runSmoke(parseSmokeArgs(args));
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].code, 'account_identity_mismatch');
  assert.deepEqual(commands.map(row => row.slice(0, 2)), [['auth', 'status']]);
});

test('successful CLI envelope containing a typed Action refusal is a failure', async t => {
  fakeLiveCli(t, { nestedFailure: true });
  const report = await runSmoke(parseSmokeArgs(args));
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(row => row.name === 'environment-inventory').code, 'deployment_access_denied');
});

test('requires named identity and explicit auth, never the default', () => {
  assert.throws(() => parseSmokeArgs(args.map(value => value === 'qa-smoke' ? 'default' : value)), /named_identity_required/);
  assert.throws(() => parseSmokeArgs(args.map(value => value === 'native' ? 'default' : value)), /explicit_auth_required/);
});
