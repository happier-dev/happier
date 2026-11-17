import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, readlink, rename, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { machineRpcWithServerScope } from '../../../../apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { resolveDaemonStateCandidatePaths } from '../../../../apps/cli/src/daemon/ownership/daemonOwnershipPaths';
import { collectDescendantPids, isProcessAlive } from '../../src/testkit/process/processTree';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

let fixture: ProjectDaemonFixture | undefined;
let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
afterEach(async () => {
  try { await ui?.close(); } finally {
    try { await fixture?.stop(); } finally { await postgres?.stop(); }
  }
}, 0);

// Linux exposes the owned host's native descriptors, allowing an exact close
// observation and a real FIFO filesystem delay instead of an admission mock.
it.skipIf(process.platform !== 'linux')('L12.hostAdmission releases a host when New Session closes during trusted-peer admission and its Session ends', async () => {
  const testDir = createRunDirs({ runLabel: 'l12-host-admission' }).testDir('closed-admission');
  console.info(JSON.stringify({ journey: 'L12.hostAdmission', testDir }));
  postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  console.info(JSON.stringify({ journey: 'L12.hostAdmission', postgresContainerId: postgres.containerId }));
  fixture = await startProjectDaemonFixture({ testDir, serverEnv: { ...process.env, DATABASE_URL: postgres.homeDatabaseUrl },
    daemonEnv: { ...process.env, HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath() } });
  const owner = await fixture.createAccount('host-owner');
  const machine = await fixture.enrollDaemon(owner);
  const knownGood = await fixture.assertKnownGoodSessionControl(owner, machine);
  ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: owner.auth.accountSigningSeed });
  await waitFor(() => ui!.isMachineActive(machine.target.machineId));
  const intents: AbortController[] = [];
  const pending: Promise<unknown>[] = [];
  const beginIntent = () => {
    const controller = new AbortController();
    intents.push(controller);
    pending.push(machineRpcWithServerScope({ serverId: ui!.serverId, machineId: machine.target.machineId,
      accountId: readAccountIdFromToken(owner.credentials.token), method: RPC_METHODS.DAEMON_SESSION_CREATION_INTENT,
      payload: {}, operationTimeoutMs: null, signal: controller.signal }).catch(error => error));
  };
  const descriptorLinks = async (pid: number) => Promise.all((await readdir(`/proc/${pid}/fd`))
    .map(name => readlink(`/proc/${pid}/fd/${name}`).catch(() => '')));
  let hostPid: number | undefined;
  let writer: FileHandle | undefined;
  let statePath: string | undefined;
  let originalState: Buffer | undefined;
  const findHost = async (sessionId: string) => {
    await waitFor(async () => {
      // The launch supervisor carries the same argv. Session metadata names
      // the actual host, whose descriptors this admission probe must observe.
      const { hostPid: publishedHostPid } = await owner.readSessionMetadata(sessionId);
      if (typeof publishedHostPid === 'number' && collectDescendantPids(machine.daemon.state.pid).includes(publishedHostPid)) {
        hostPid = publishedHostPid;
        return true;
      }
      return false;
    }, { timeoutMs: 60_000, context: 'real daemon Session host' });
  };
  try {
    await findHost(knownGood.sessionId);
    expect(await owner.execute('session.archive', { sessionId: knownGood.sessionId })).toMatchObject({ ok: true });
    await waitFor(() => !isProcessAlive(hostPid!), { context: 'known-good Session archive releases its host' });
    expect(isProcessAlive(machine.daemon.state.pid)).toBe(true);
    const session = await fixture.assertKnownGoodSessionControl(owner, machine);
    hostPid = undefined;
    await findHost(session.sessionId);
    const existingSockets = new Set((await descriptorLinks(hostPid!)).filter(link => link.startsWith('socket:[')));
    const candidates = resolveDaemonStateCandidatePaths({ serverDir: join(machine.homeDir, 'servers', machine.cliServerId) });
    for (const candidate of candidates) {
      const bytes = await readFile(candidate).catch(() => null);
      if (bytes && JSON.parse(bytes.toString()).pid === machine.daemon.state.pid) {
        statePath = candidate; originalState = bytes; break;
      }
    }
    if (!statePath || !originalState) throw new Error('Real daemon state publication unavailable');
    const fifo = join(testDir, 'pending-admission.fifo');
    await promisify(execFile)('mkfifo', ['-m', '600', fifo]);
    // Replace only this test's daemon publication. The FIFO remains readable
    // but cannot finish until the real published state bytes are released.
    await rename(fifo, statePath);
    beginIntent();
    await waitFor(async () => {
      try { writer = await open(statePath!, constants.O_WRONLY | constants.O_NONBLOCK); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENXIO') return false; throw error; }
    }, { context: 'real host opens pending trusted-daemon state FIFO', failFast: true });
    expect((await writer!.stat()).isFIFO()).toBe(true);
    await waitFor(async () => (await descriptorLinks(hostPid!)).some(link => link === statePath || link === `${statePath} (deleted)`),
      { context: 'host is awaiting its real trusted-daemon state read' });
    const pendingSockets = (await descriptorLinks(hostPid!)).filter(link => link.startsWith('socket:[') && !existingSockets.has(link));
    expect(pendingSockets.length).toBeGreaterThan(0);
    for (const intent of intents) intent.abort();
    await Promise.all(pending);
    await waitFor(async () => !(await descriptorLinks(hostPid!)).some(link => pendingSockets.includes(link)),
      { context: 'daemon hold connection closed before admission finishes' });
    await writer!.writeFile(originalState);
    await writer!.close();
    writer = undefined;
    await waitFor(async () => !(await descriptorLinks(hostPid!)).some(link => link === statePath || link === `${statePath} (deleted)`),
      { context: 'late trusted-peer admission finishes its filesystem read' });
    // Restore the publication before another ordinary request can read it.
    if ((await lstat(statePath)).isFIFO()) {
      const restored = `${statePath}.journey-restore`;
      await writeFile(restored, originalState, { mode: 0o600 });
      await rename(restored, statePath);
    }
    expect(await owner.execute('session.archive', { sessionId: session.sessionId })).toMatchObject({ ok: true });
    await waitFor(() => !isProcessAlive(hostPid!), { context: 'idle host exits after late admission on a closed connection' });
    expect(isProcessAlive(machine.daemon.state.pid)).toBe(true);
  } finally {
    for (const intent of intents) intent.abort();
    if (writer && originalState) { await writer.writeFile(originalState); await writer.close(); }
    if (statePath && originalState) {
      // The lifecycle owner may have published a newer heartbeat meanwhile.
      // Preserve it; otherwise replace our FIFO atomically with its own bytes.
      if ((await lstat(statePath)).isFIFO()) {
        const restored = `${statePath}.journey-restore`;
        await writeFile(restored, originalState, { mode: 0o600 });
        await rename(restored, statePath);
      }
    }
    await Promise.all(pending);
  }
}, 0);
