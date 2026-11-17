import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DaemonTerminalEnsureResponseSchema } from '@happier-dev/protocol/daemon/terminal';
import { MachineProcessesAnswerV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { MachineWorkSummaryV1Schema } from '@happier-dev/protocol/machines/machineWorkSummaryV1';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { TerminalStreamReadResponseSchema, decodeTerminalStreamBytesFrame } from '@happier-dev/protocol/terminal/stream';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

let fixture: ProjectDaemonFixture | undefined;
let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
afterEach(async () => {
  try { await fixture?.stop(); } finally { await postgres?.stop(); }
}, 0);

// Quotes here are literal argv bytes, exercising the Windows command display
// forms through a real native census on Linux too. Native Windows OS collection
// remains the platform release check; no census or projection is substituted.
it.skipIf(process.platform === 'win32')('L12.J20.J53 shares work counts while keeping terminal content private and CLI credentials masked', async () => {
  const testDir = createRunDirs({ runLabel: 'l12-process-journey' }).testDir('shared-process-privacy');
  console.info(JSON.stringify({ journey: 'L12.J20.J53', testDir }));
  postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  console.info(JSON.stringify({ journey: 'L12.J20.J53', postgresContainerId: postgres.containerId }));
  fixture = await startProjectDaemonFixture({ testDir, serverEnv: { ...process.env, DATABASE_URL: postgres.homeDatabaseUrl } });
  const owner = await fixture.createAccount('custodian');
  const member = await fixture.createAccount('member');
  const observer = await fixture.createAccount('observer');
  const machine = await fixture.enrollDaemon(owner);
  for (const account of [member, observer]) {
    expect(await owner.executeAsPerson('machines.access.grant.set', { ...machine.target,
      principal: { kind: 'account', accountId: readAccountIdFromToken(account.credentials.token) }, level: 'admin' }))
      .toMatchObject({ ok: true });
  }
  const memberId = readAccountIdFromToken(member.credentials.token);
  const observerId = readAccountIdFromToken(observer.credentials.token);
  async function workSummary() {
    const result = await observer.execute('machines.work.summary.get', machine.target);
    if (!result.ok) throw new Error(`Shared work summary refused (${result.errorCode}); error=${JSON.stringify(result.error)}`);
    return MachineWorkSummaryV1Schema.parse(result.result);
  }
  expect(await workSummary()).toMatchObject({ kind: 'current', requesters: [], finiteLoad: { kind: 'known', running: 0, queued: 0 } });
  const worker = join(machine.workspaceDir, 'private-worker.cjs');
  const pidFile = join(machine.workspaceDir, 'worker.pid');
  await writeFile(worker, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdout.write('L12_MEMBER_PTY_READY\\n');\nprocess.stdin.resume();\n`);
  const secrets = ['l12-api-value', 'l12-key-value', 'l12-invite-value', 'l12-verification-value',
    'l12-current-value', 'l12-proof-value', 'l12-windows-key-value', 'l12-windows-password-value', 'l12-recovery-value'];
  const argv = [process.execPath, worker, '--api-token', secrets[0]!, `--key=${secrets[1]}`,
    '--invitation-token', secrets[2]!, '--verification-token', secrets[3]!, '--current-password', secrets[4]!,
    `--reauth-proof-json={"proof":"${secrets[5]}"}`, `"--key=${secrets[6]}"`,
    `'--current-password=${secrets[7]} words'`, '--recovery-key', secrets[8]!, '--port=5173'];
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const opened = await member.executeAsPerson('machines.terminal.open', { ...machine.target,
    cwd: machine.workspaceDir, terminalKey: `l12-private-${randomUUID()}`,
    launch: { kind: 'shell_command', command: `exec ${argv.map(quote).join(' ')}` } });
  if (!opened.ok) throw new Error(`Member terminal Action refused (${opened.errorCode})`);
  const terminal = DaemonTerminalEnsureResponseSchema.parse(opened.result);
  if (!terminal.ok) throw new Error(`Member terminal unavailable (${terminal.errorCode})`);
  const terminalTarget = { ...machine.target, terminalId: terminal.terminalId };
  let output = '';
  let byteOffset = 0;
  let controlCursor: number | undefined;
  await waitFor(async () => {
    const result = await member.execute('machines.terminal.read', { ...terminalTarget, byteOffset, controlCursor });
    if (!result.ok) throw new Error(`Member terminal read refused (${result.errorCode})`);
    const stream = TerminalStreamReadResponseSchema.parse(result.result);
    if (!stream.ok) throw new Error(`Member terminal stream unavailable (${stream.code})`);
    output += stream.frames.filter(frame => frame.t === 'bytes')
      .map(frame => Buffer.from(decodeTerminalStreamBytesFrame(frame)).toString('utf8')).join('');
    byteOffset = stream.nextByteOffset;
    controlCursor = stream.nextControlCursor;
    return output.includes('L12_MEMBER_PTY_READY');
  }, { context: 'real member PTY output' });
  const workerPid = Number(await readFile(pidFile, 'utf8'));
  async function processes(account: typeof owner) {
    const result = await account.execute('machines.processes.list', { ...machine.target, scope: 'happier', view: 'tree' });
    if (!result.ok) throw new Error(`Process view refused (${result.errorCode})`);
    return MachineProcessesAnswerV1Schema.parse(result.result);
  }
  for (const account of [owner, member]) {
    let view: Awaited<ReturnType<typeof processes>>;
    await waitFor(async () => { view = await processes(account);
      return view.state === 'live' && view.owners.some(row => row.members.some(process => process.pid === workerPid));
    }, { context: `${account.name} sees legitimate member process` });
    const row = view!.owners.flatMap(owner => owner.members).find(process => process.pid === workerPid)!;
    expect(row.command).toContain('--port=5173');
    expect(row.command).toContain('[REDACTED]');
    for (const secret of secrets) expect(row.command).not.toContain(secret);
    if (account === owner) expect(view!.owners.find(row => row.members.some(process => process.pid === workerPid))?.requester)
      .toMatchObject({ accountId: memberId });
  }
  const hidden = await processes(observer);
  expect(hidden.state).toBe('live');
  expect(hidden.owners.flatMap(row => row.members).some(process => process.pid === workerPid)).toBe(false);
  expect(hidden.othersWork?.count).toBeGreaterThan(0);
  expect(await observer.execute('machines.terminal.read', { ...terminalTarget, byteOffset: 0 }))
    .toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
  const summary = await workSummary();
  expect(summary).toMatchObject({ kind: 'current', requesters: expect.arrayContaining([
    expect.objectContaining({ accountId: memberId, terminals: 1 }),
  ]) });
  expect(JSON.stringify(summary)).not.toContain('L12_MEMBER_PTY_READY');
  expect(await member.executeAsPerson('machines.terminal.close', terminalTarget)).toMatchObject({ ok: true });
  await waitFor(async () => !(await processes(owner)).owners.some(row => row.members.some(process => process.pid === workerPid)),
    { context: 'closed terminal process leaves Machine view' });
  await waitFor(async () => {
    const current = await workSummary();
    return current.kind === 'current' && !current.requesters.some(row => row.accountId === memberId && row.terminals > 0);
  }, { context: 'shared live terminal count returns to zero' });
  for (const accountId of [memberId, observerId]) {
    expect(await owner.executeAsPerson('machines.access.grant.remove', { ...machine.target,
      principal: { kind: 'account', accountId } })).toMatchObject({ ok: true });
  }
  const remaining = await owner.execute('machines.access.grants.list', machine.target);
  if (!remaining.ok) throw new Error(`Grant removal observation refused (${remaining.errorCode})`);
  const grants = MachineAccessGrantsListResponseV1Schema.parse(remaining.result);
  expect(grants.grants.some(grant => grant.principal.kind === 'account'
    && [memberId, observerId].includes(grant.principal.accountId))).toBe(false);
}, 0);
