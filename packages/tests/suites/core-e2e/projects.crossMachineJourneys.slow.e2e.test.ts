import type { MachineAccessGrantSetInputV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import type { StartedDaemon } from '../../src/testkit/daemon/daemon';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { addFriend, setUsername } from '../../src/testkit/socialFriends';
import { ensureProductionIrohNodeAddon, stageProductionIrohNodeAddonForConsumer } from '../../src/testkit/iroh/productionIrohNodeAddon';
import { repoRootDir } from '../../src/testkit/paths';

function typedFailureFacts(value: unknown): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  if (!value || typeof value !== 'object') return facts;
  for (const key of ['code', 'errorCode', 'phase', 'effectAttempted', 'reasonCode']) {
    const fact: unknown = Reflect.get(value, key);
    if (typeof fact === 'string' || typeof fact === 'boolean') facts[key] = fact;
  }
  for (const key of ['details', 'failureCause', 'cause', 'error', 'err', 'status']) {
    const nested = typedFailureFacts(Reflect.get(value, key));
    if (Object.keys(nested).length) facts[key] = nested;
  }
  return facts;
}

async function homeRefusalDiagnostics(paths: readonly string[]) {
  const rows = [];
  for (const path of paths) {
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      const facts = typedFailureFacts(value);
      if (Object.keys(facts).length) rows.push({ path, ...facts });
    }
  }
  return rows;
}

async function carrierStartupDiagnostics(daemon: StartedDaemon) {
  const path = daemon.state.daemonLogPath;
  if (!path) throw new Error('Daemon fixture did not publish its internal log path');
  const rows = [];
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    for (const marker of ['[DAEMON RUN] Native Machine Iroh runtime decision',
      '[DAEMON RUN] Iroh carrier is unavailable; the Home transport owner evaluates independently trusted HTTPS',
      '[DAEMON RUN] Home transport prepared']) {
      const at = line.indexOf(marker);
      if (at < 0) continue;
      const jsonAt = line.indexOf('{', at + marker.length);
      if (jsonAt < 0) continue;
      let value: unknown;
      try { value = JSON.parse(line.slice(jsonAt, line.lastIndexOf('}') + 1)); }
      catch { continue; }
      if (!value || typeof value !== 'object') continue;
      const facts: Record<string, string> = {};
      for (const key of ['status', 'reason', 'carrier', 'observedPath']) {
        const fact: unknown = Reflect.get(value, key);
        if (typeof fact === 'string' && /^[a-z_]+$/u.test(fact)) facts[key] = fact;
      }
      rows.push({ marker, ...facts });
    }
  }
  return { path, rows };
}

// Read the receiving owner's existing content-free diagnostic after decode.
// Only method, typed refusal and proof-presence facts leave this projection.
async function syncRpcDiagnostics(daemon: StartedDaemon) {
  const path = daemon.state.daemonLogPath;
  if (!path) throw new Error('Daemon fixture did not publish its internal log path');
  const rows = [];
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const refusalMarker = '[external-action-phase]';
    const refusalAt = line.indexOf(refusalMarker);
    if (refusalAt >= 0) {
      const jsonAt = line.indexOf('{', refusalAt + refusalMarker.length);
      let refusal: unknown;
      try { refusal = JSON.parse(line.slice(jsonAt, line.lastIndexOf('}') + 1)); } catch { continue; }
      if (refusal && typeof refusal === 'object') {
        const witness: Record<string, unknown> = {};
        for (const key of ['phase', 'actionId', 'requestId', 'refusalBranch', 'errorCode']) {
          const fact: unknown = Reflect.get(refusal, key);
          if (typeof fact === 'string') witness[key] = fact;
        }
        rows.push({ method: refusalMarker, ...witness });
      }
      continue;
    }
    const marker = '[RPC] Request completed ';
    const at = line.indexOf(marker);
    if (at < 0) continue;
    let value: unknown;
    try { value = JSON.parse(line.slice(at + marker.length, line.lastIndexOf('}') + 1)); }
    catch { continue; }
    if (!value || typeof value !== 'object') continue;
    const method: unknown = Reflect.get(value, 'method');
    if (typeof method !== 'string' || !(method.startsWith('daemon.workspaceSync.')
      || method.toLowerCase().includes('handoff') || method === 'daemon.actions.external.dispatch')) continue;
    const proof: unknown = Reflect.get(value, 'workspaceSyncProof');
    const cause: unknown = Reflect.get(value, 'failureCause');
    rows.push({ method, errorCode: Reflect.get(value, 'errorCode') as unknown,
      phase: cause && typeof cause === 'object' ? Reflect.get(cause, 'phase') as unknown : undefined,
      targetReplacementApproval: proof && typeof proof === 'object'
        ? Reflect.get(proof, 'targetReplacementApproval') === true : undefined });
  }
  return rows;
}

it('connects two Account Machines to one real Home before cross-Machine journeys', async () => {
  let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;
  try {
    fixture = await startProjectDaemonFixture({
      testDir: await mkdtemp(join(tmpdir(), 'cross-machine-journeys-')),
      dbProvider: 'sqlite',
      daemonAuthentication: 'existing-terminal',
    });
    const owner = await fixture.createAccount('source-owner');
    const member = await fixture.createAccount('target-owner');
    const source = await fixture.enrollDaemon(owner);
    const target = await fixture.enrollDaemon(member);
    expect(source.target.machineId).not.toBe(target.target.machineId);
    expect(source.target.serverId).toBe(target.target.serverId);
  } finally {
    await fixture?.stop();
  }
}, 0);

it('journey 1 exact replica commits All files through real Home', async () => {
  const journey = 'journey 1 exact replica';
  const testDir = await mkdtemp(join(tmpdir(), 'cross-person-add-machine-'));
  console.info(JSON.stringify({ journey, testDir }));
  const home = await startProjectDaemonFixture({
    testDir,
    dbProvider: 'sqlite', daemonAuthentication: 'existing-terminal',
  });
  try {
    const owner = await home.createAccount('source-owner');
    const member = await home.createAccount('manage-member');
    const env = { HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink' };
    const cliLaunchSpec = { command: process.execPath, args: ['--import',
      resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs'),
      resolve(repoRootDir(), 'apps/cli/src/index.ts')], cwd: repoRootDir() };
    const beforeDaemonSpawn = async () => {
      const { addonPath } = await ensureProductionIrohNodeAddon({ testDir,
        packageRoot: process.env.HAPPIER_IROH_TEST_PACKAGE_ROOT });
      stageProductionIrohNodeAddonForConsumer({ sourceAddonPath: addonPath,
        consumerDir: resolve(repoRootDir(), 'apps/cli') });
    };
    const source = await home.enrollDaemon(owner, { env, cliLaunchSpec, beforeDaemonSpawn });
    const target = await home.enrollDaemon(member, { env, cliLaunchSpec, beforeDaemonSpawn });
    console.info(JSON.stringify({ journey, carrierStartup: {
      source: await carrierStartupDiagnostics(source.daemon), target: await carrierStartupDiagnostics(target.daemon) } }));
    await writeFile(join(source.workspaceDir, 'payload.txt'), 'real Home exact replica');
    // Sharing a Machine with another person requires an accepted friendship, as in the app.
    const ownerId = readAccountIdFromToken(owner.credentials.token);
    const memberId = readAccountIdFromToken(member.credentials.token);
    if (!ownerId || !memberId) throw new Error('Account identity unavailable');
    await setUsername(home.server.baseUrl, owner.credentials.token, 'journey_source_owner');
    await setUsername(home.server.baseUrl, member.credentials.token, 'journey_manage_member');
    await addFriend(home.server.baseUrl, owner.credentials.token, memberId);
    await addFriend(home.server.baseUrl, member.credentials.token, ownerId);
    const grantInput = { ...source.target,
      principal: { kind: 'account', accountId: memberId },
      level: 'admin' } satisfies MachineAccessGrantSetInputV1;
    const grant = await owner.executeAsPerson('machines.access.grant.set', grantInput);
    expect(grant.ok, `Manage grant code=${grant.ok ? 'none' : grant.errorCode}`).toBe(true);
    expect(await owner.executeAsPerson('machines.access.prepareKeys', source.target))
      .toMatchObject({ ok: true, result: { kind: 'prepared' } });
    await member.withPersonActionClient(async executePersonAction => {
      const execute: typeof executePersonAction = async (...args) => {
        const result = await executePersonAction(...args);
        if (!result.ok) {
          const details: unknown = result.details;
          const cause: unknown = details && typeof details === 'object' ? Reflect.get(details, 'failureCause') : undefined;
          console.info(JSON.stringify({ journey, actionId: args[0], errorCode: result.errorCode,
            failure: typedFailureFacts(result),
            phase: cause && typeof cause === 'object' ? Reflect.get(cause, 'phase') : null,
            sourceMachineMissingInHandoffProjection: result.error === 'No reachable source machine target found for session handoff',
            sourceMachineId: source.target.machineId, targetMachineId: target.target.machineId,
            source: await syncRpcDiagnostics(source.daemon), target: await syncRpcDiagnostics(target.daemon),
            home: await homeRefusalDiagnostics([home.server.proc.stdoutPath, home.server.proc.stderrPath]) }));
        }
        return result;
      };
      const opened = await execute('projects.open', { ...source.target,
        source: { kind: 'folder', path: source.workspaceDir }, materialization: { kind: 'attach' } });
      expect(opened.ok, 'Manage member opens the shared source through Home').toBe(true);
      if (!opened.ok) throw new Error(opened.errorCode);
      const project = OpenProjectResultV1Schema.parse(opened.result);
      if (project.kind !== 'opened') throw new Error('Shared source Project did not open');
      const policy = { v: 1 as const, selection: 'all_files' as const,
        extraIgnorePatterns: [], extraIncludePatterns: [] };
      const targetPath = join(target.workspaceDir, 'exact-replica');
      const copied = await execute('workspace.sync.relationship.create', {
        v: 1, sourceWorkspaceRefId: project.workspace.workspaceId,
        targetMachineId: target.target.machineId, targetPath,
        mode: 'mirror_exactly',
        destinationIntent: 'materialize_from_source_workspace',
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      });
      console.info(JSON.stringify({ journey, copied: copied.ok,
        source: await syncRpcDiagnostics(source.daemon), target: await syncRpcDiagnostics(target.daemon) }));
      expect(copied, 'reviewed Confirm must reach target bootstrap with its approval proof')
        .toMatchObject({ ok: true, result: { created: true } });
      expect(await readFile(join(targetPath, 'payload.txt'), 'utf8')).toBe('real Home exact replica');
    }, { confirmation: 'presented' });
  } finally { await home.stop(); }
}, 0);
