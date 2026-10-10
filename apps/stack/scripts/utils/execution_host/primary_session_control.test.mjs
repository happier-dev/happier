import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrimarySessionControlAdapter } from './primary_session_control.mjs';

const source = { name: 'a', platform: 'posix', ssh: 'a', sshConfigFile: '/fixture/ssh', repoDir: '/home/fixture/workspace/0.3' };
const target = { ...source, name: 'b', ssh: 'b' };
const envelope = (kind, data) => ({ ok: true, kind, data });
const daemon = machineId => ({ daemon: { running: true }, auth: { authenticated: true, machineId, accountId: 'account' },
  server: { comparableKey: 'https://relay.example' }, runtimeConvergence: { controlReachable: true, machineIdMatches: true } });
const session = (id, machineId = 'machine-a', permissionMode = 'read-only') => ({ id, machineId, permissionMode, active: true,
  host: 'a', path: '/home/fixture/workspace/0.2' });

function fixture({ pages = [[session('parent')]], modeMissing = false, targetAccount = 'account', supportsExisting = true,
  converged = true, missingMachineId = false, repeatedCursor = false } = {}) {
  const calls = [];
  // Only the SSH/process boundary is substituted. Public CLI envelopes use the
  // inspected 0.2 command producers; adapter parsing remains real.
  const capture = async (command, args) => {
    assert.equal(command, 'ssh');
    const remote = args.at(-1);
    calls.push(remote);
    const peer = args.at(-2);
    let result;
    if (remote.includes("'daemon' 'status'")) {
      result = daemon(peer === 'a' ? 'machine-a' : 'machine-b');
      if (peer === 'b') result.auth.accountId = targetAccount;
      result.runtimeConvergence.machineIdMatches = converged;
    }
    else if (remote.includes("'actions' 'describe'")) result = envelope('session_actions_describe', { actionSpec: { id: 'session.handoff', surfaces: { cli: true }, inputHints: { fields: supportsExisting ? [{ path: 'stateTransfer', options: [{ value: 'existing' }, { value: 'transfer' }] }] : [] } } });
    else if (remote.includes("'session' 'list'")) {
      const page = remote.includes("'--cursor' 'page-2'") ? 1 : 0;
      result = envelope('session_list', { sessions: pages[page].map(row => ({ ...row,
        ...(modeMissing && page === pages.length - 1 ? { permissionMode: undefined } : {}),
        ...(missingMachineId ? { machineId: undefined } : {}) })),
        hasNext: repeatedCursor || page < pages.length - 1, nextCursor: repeatedCursor || page < pages.length - 1 ? 'page-2' : null });
    }
    else throw new Error(`unhandled public command: ${remote}`);
    return { code: 0, out: JSON.stringify(result), err: '' };
  };
  const adapter = createPrimarySessionControlAdapter({ source, target, homeDir: '/home/fixture', workStackName: 'work-fixture', workRepoDir: '/home/fixture/workspace/0.2', env: {} }, { capture });
  return { adapter, calls };
}

test('primary session preflight paginates active Machine inventory and preserves explicit authoritative modes', async () => {
  const { adapter, calls } = fixture({ pages: [[session('other', 'machine-other')], [session('parent')]] });
  const inventory = await adapter.preflight();
  assert.deepEqual(inventory, { sourceMachineId: 'machine-a', targetMachineId: 'machine-b',
    sessions: [{ id: 'parent', permissionMode: 'read-only' }], scope: 'active-work-sessions' });
  assert.ok(calls.some(command => command.includes("'--cursor' 'page-2'")));
  for (const command of calls) {
    assert.match(command, /work-fixture/);
    assert.match(command, /workspace\/0\.2\/apps\/stack\/bin\/hstack\.mjs/);
    assert.doesNotMatch(command, /(?:^|\s)(?:node|npm|npx|pnpm|yarn|bunx)(?:\s|$)/);
  }
  assert.equal(calls.filter(command => command.includes("'execute'") || command.includes("'send'") || command.includes("'stop'")).length, 0);
});

test('primary session preflight refuses missing mode authority on the final inventory page', async () => {
  const { adapter, calls } = fixture({ pages: [[session('first')], [session('last')]], modeMissing: true });
  await assert.rejects(adapter.preflight(), { code: 'SESSION_PERMISSION_AUTHORITY_MISSING' });
  assert.equal(calls.filter(command => command.includes("'session' 'send'") || command.includes("'execution.run.send'")).length, 0);
});

test('primary session preflight requires the same Home and Account authority', async () => {
  const { adapter, calls } = fixture({ targetAccount: 'another-account' });
  await assert.rejects(adapter.preflight(), { code: 'WORK_DAEMON_SCOPE_MISMATCH' });
  assert.equal(calls.filter(command => command.includes("'session' 'send'")).length, 0);
});

test('primary session preflight refuses a mismatched live daemon identity', async () => {
  await assert.rejects(fixture({ converged: false }).adapter.preflight(), { code: 'WORK_DAEMON_IDENTITY_UNAVAILABLE' });
});

test('primary session preflight refuses missing existing-state public contract', async () => {
  await assert.rejects(fixture({ supportsExisting: false }).adapter.preflight(), { code: 'WORK_SESSION_CONTRACT_UNAVAILABLE' });
});

test('primary session preflight never infers Machine binding from matching host or path', async () => {
  await assert.rejects(fixture({ missingMachineId: true }).adapter.preflight(), { code: 'SESSION_MACHINE_AUTHORITY_MISSING' });
});

test('primary session preflight refuses repeated cursors rather than reporting incomplete inventory', async () => {
  await assert.rejects(fixture({ pages: [[session('first')], [session('second')]], repeatedCursor: true }).adapter.preflight(), { code: 'SESSION_INVENTORY_INVALID' });
});
