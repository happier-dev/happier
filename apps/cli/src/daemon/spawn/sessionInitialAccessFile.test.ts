import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { consumeSessionInitialAccessFile, createSessionInitialAccessFile } from './sessionInitialAccessFile';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { buildHappySessionControlArgs } from '../sessionSpawnArgs';
import { partitionProviderSessionArgs } from '@/cli/providerSessionArgPartition';
import { createSpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { createOnChildExited } from '../sessions/onChildExited';
import { mintSessionTrackingKey, trackSession, type TrackedSessionMap } from '../sessions/sessionTrackingKey';
import type { TrackedSession } from '../types';

describe('initial access launch custody', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
  async function createHome() {
    const root = await mkdtemp(join(tmpdir(), 'initial access '));
    roots.push(root);
    return root;
  }
  const initialAccess = { grants: [{ subject: { kind: 'account' as const, accountId: 'recipient' }, accessLevel: 'edit' as const, canApprovePermissions: true }] };

  it('protects and consumes a draft exactly once and makes exit cleanup idempotent', async () => {
    const file = await createSessionInitialAccessFile(await createHome(), initialAccess);
    expect(JSON.parse(await readFile(file.path, 'utf8'))).toEqual(initialAccess);
    if (process.platform !== 'win32') {
      expect((await stat(file.path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(file.path))).mode & 0o777).toBe(0o700);
    }
    expect(await consumeSessionInitialAccessFile(file.path)).toEqual(initialAccess);
    await expect(consumeSessionInitialAccessFile(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await file.cleanup();
    await file.cleanup();
  });

  it('removes invalid JSON and strict-schema failures before surfacing the failure', async () => {
    for (const contents of ['{', JSON.stringify({ ...initialAccess, requiredByTeamPolicy: true })]) {
      const file = await createSessionInitialAccessFile(await createHome(), initialAccess);
      await writeFile(file.path, contents);
      await expect(consumeSessionInitialAccessFile(file.path)).rejects.toThrow();
      await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
      await file.cleanup();
    }
  });

  it('keeps a draft near the default daemon request ceiling out of argv and consumes it intact', async () => {
    // controlServer's default body limit is 8 MiB. Leave room for the request
    // envelope; this is a transport stress vector, not a new grant-count limit.
    const grant = initialAccess.grants[0];
    const budget = 8 * 1024 * 1024 - 4096;
    const grants = [];
    let bytes = Buffer.byteLength('{"grants":[]}');
    for (let index = 0; ; index++) {
      const next = { ...grant, subject: { kind: 'account' as const, accountId: `recipient-${index}` } };
      const added = Buffer.byteLength(JSON.stringify(next)) + (index === 0 ? 0 : 1);
      if (bytes + added > budget) break;
      grants.push(next);
      bytes += added;
    }
    const draft = { grants };
    const file = await createSessionInitialAccessFile(await createHome(), draft);
    const args = buildHappySessionControlArgs({ initialAccessFilePath: file.path, primaryTeamId: null });
    expect(args).toEqual(['--session-initial-access-file-v1', file.path, '--session-primary-team-id-v1', 'null']);
    const partition = partitionProviderSessionArgs({
      args: ['codex', '--started-by', 'daemon', ...args], providerSubcommand: 'codex',
    });
    expect(partition.providerArgs).toEqual([]);
    expect(partition.primaryTeamId).toBeNull();
    expect(await consumeSessionInitialAccessFile(partition.initialAccessFilePath!)).toEqual(draft);
    await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retires the carrier when launch fails before ownership transfers to a child', async () => {
    const file = await createSessionInitialAccessFile(await createHome(), initialAccess);
    const scope = createProviderLaunchResourceScope();
    scope.register(file.cleanup);
    await scope.release();
    await scope.retire();
    await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retires an unconsumed carrier through the canonical Session lifecycle after a real child exits abnormally', async () => {
    const file = await createSessionInitialAccessFile(await createHome(), initialAccess);
    const scope = createProviderLaunchResourceScope();
    scope.register(file.cleanup);
    const spawnResourceCleanupByKey = new Map();
    const sessionAttachCleanupByKey = new Map();
    const lifecycle = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: undefined, catalogAgentId: null,
      materializationKey: 'test', hasConnectedServiceAuth: () => false,
      getSpawnResourceCleanupOnExit: () => scope.transfer(),
      onSpawnResourceCleanupArmed: () => undefined,
      spawnResourceCleanupByKey,
      getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => undefined,
      sessionAttachCleanupByKey,
      persistAcceptedSpawnMarker: async () => undefined,
    });
    const trackedSessionsByKey: TrackedSessionMap = new Map();
    const onChildExited = createOnChildExited({
      trackedSessionsByKey, spawnResourceCleanupByKey,
      sessionAttachCleanupByKey, getApiMachineForSessions: () => null,
      removeSessionMarkerFn: async () => {},
    });
    // A fixture process, not a Happier runtime or Agent activation.
    const child = spawn(process.execPath, ['-e', 'process.exit(23)'], { stdio: 'ignore' });
    if (!child.pid) throw new Error('Fixture child did not acquire a PID');
    const tracked: TrackedSession = { trackingKey: mintSessionTrackingKey(), pid: child.pid, startedBy: 'daemon' };
    trackSession(trackedSessionsByKey, tracked);
    lifecycle.registerSpawnResourceCleanupForSession(tracked.trackingKey);
    const [code, signal] = await once(child, 'exit');
    expect(code).toBe(23);
    await onChildExited(child.pid, { reason: 'exit', code, signal });
    expect(spawnResourceCleanupByKey.size).toBe(0);
    await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
