import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { configuration } from '@/configuration';
import { writeSessionMarker } from '@/daemon/sessionRegistry';
import { prepareIsolatedDaemonTestHome } from '@/daemon/testkit/realIntegration.testkit';
import { spawnDetachedInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import { getOpenCodeServerProcessInfoBestEffort, isOpenCodeServerPidAlive } from '../server/openCodeServerProcessState';
import {
  releaseForAuthSwitch,
  resolveSharedManagedOpenCodeServerStatePathForEnv,
  reapUnusedSharedManagedOpenCodeServersBestEffort,
  stopSharedManagedOpenCodeServerFromEnvBestEffort,
  type SharedManagedOpenCodeServerState,
} from '../server/sharedManagedServer';
import { resolveOpenCodeManagedServerLaunchFingerprint } from '../server/openCodeManagedServerEnv';
import { forkOpenCodeSessionNative } from '../server/nativeFork';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createOpenCodeServerRuntimeClient } from '../server/client';

import { listOpenCodeSessionCandidates } from './listOpenCodeSessionCandidates';

describe('bounded managed OpenCode direct reads', () => {
  it.each(['direct read', 'native fork'] as const)('holds acquisition custody through a %s and sees claims published while release waits', async (operation) => {
    const home = await prepareIsolatedDaemonTestHome({ prefix: 'happier-opencode-direct-custody-' });
    const child = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)');
    const pid = child.pid;
    if (!pid) throw new Error('Fake provider process did not start');
    let receivedRead!: () => void;
    let finishRead!: () => void;
    const readReceived = new Promise<void>((resolve) => { receivedRead = resolve; });
    const readFinished = new Promise<void>((resolve) => { finishRead = resolve; });
    const server = createServer(async (request, response) => {
      const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (requestPath === '/session' || requestPath.endsWith('/fork')) {
        receivedRead();
        await readFinished;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(requestPath.startsWith('/global/health')
        ? { healthy: true, version: 'fake-opencode' }
        : requestPath.startsWith('/session/status') ? {}
          : requestPath.endsWith('/fork') ? { id: 'ses_child' } : []));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fake provider endpoint did not bind');
    try {
      const info = await getOpenCodeServerProcessInfoBestEffort(pid);
      const birth = readProcessInstanceFingerprintSync(pid);
      if (!info || !birth) throw new Error('Fake provider identity could not be read');
      const fingerprint = operation === 'native fork' ? 'a'.repeat(64)
        : resolveOpenCodeManagedServerLaunchFingerprint({ baseEnv: process.env, xdgRootDir: null, isolateConfig: false });
      const currentStatePath = resolveSharedManagedOpenCodeServerStatePathForEnv(process.env);
      const statePath = operation === 'native fork'
        ? join(dirname(currentStatePath), `${fingerprint}.json`) : currentStatePath;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const state: SharedManagedOpenCodeServerState = {
        v: 2, baseUrl, pid, startedAtMs: Date.now(), status: 'ready',
        launchEnvFingerprint: fingerprint, ownerToken: 'direct-read-owner',
        processInstanceFingerprint: birth,
        expectedCmdlineHash: createHash('sha256').update(info.cmd).digest('hex'),
        activeServerDir: configuration.activeServerDir, daemonInstanceId: 'prior-daemon',
      };
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify(state));
      const directRead = operation === 'direct read'
        ? listOpenCodeSessionCandidates({ source: { kind: 'opencodeServer', baseUrl }, limit: 10 })
        : forkOpenCodeSessionNative({
          credentials: { token: 'test-token', encryption: null },
          parentHappySessionId: 'parent', parentRawSession: { encryptionMode: 'plain' },
          directory: home.homeDir, parentOpenCodeSessionId: 'ses_parent',
          baseUrlOverride: baseUrl, managedServerLaunchFingerprint: fingerprint,
          forkPoint: { type: 'latest' },
        });
      await readReceived;
      expect(existsSync(`${statePath}.lock`)).toBe(true);
      const release = releaseForAuthSwitch(fingerprint, state.ownerToken!);
      for (const markerPid of [process.pid, pid]) {
        await writeSessionMarker({
          pid: markerPid, happySessionId: `claim-${markerPid}`, flavor: 'opencode',
          metadata: { flavor: 'opencode', launchEnvFingerprint: fingerprint },
        });
      }
      finishRead();
      expect(await directRead).toEqual(operation === 'direct read'
        ? { candidates: [], nextCursor: null } : { vendorSessionId: 'ses_child' });
      expect(await release).toMatchObject({ released: false, reason: 'tracked_session_claimed' });
      expect(isOpenCodeServerPidAlive(pid)).toBe(true);
      expect(existsSync(statePath)).toBe(true);
    } finally {
      finishRead();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await waitForProcessExit(pid, { timeoutMs: 1_000 });
      await home.restore();
    }
  });
});


describe('managed OpenCode client lifetime', () => {
  it.each(['release', 'periodic cleanup', 'auth switch', 'daemon shutdown', 'pending request', 'unhealthy acquisition'] as const)(
    'keeps an unmarked client alive until the last client is disposed, then releases its server (%s)', async (trigger) => {
    const home = await prepareIsolatedDaemonTestHome({ prefix: 'happier-opencode-client-lifetime-' });
    const child = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)');
    const pid = child.pid;
    if (!pid) throw new Error('Provider fixture did not start');
    let readReceived!: () => void;
    const pendingReadReceived = new Promise<void>(resolve => { readReceived = resolve; });
    let healthy = true;
    const server = createServer((request, response) => {
      if (trigger === 'pending request' && request.url?.startsWith('/session')) {
        readReceived();
        return;
      }
      response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ healthy: true, version: 'fixture' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Provider fixture did not bind');
    const clients: Awaited<ReturnType<typeof createOpenCodeServerRuntimeClient>>[] = [];
    try {
      const info = await getOpenCodeServerProcessInfoBestEffort(pid);
      const birth = readProcessInstanceFingerprintSync(pid);
      if (!info || !birth) throw new Error('Provider fixture identity unavailable');
      const fingerprint = resolveOpenCodeManagedServerLaunchFingerprint({ baseEnv: process.env, xdgRootDir: null, isolateConfig: false });
      const statePath = resolveSharedManagedOpenCodeServerStatePathForEnv(process.env);
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify({
        v: 2, baseUrl: `http://127.0.0.1:${address.port}`, pid, startedAtMs: Date.now(), status: 'ready',
        launchEnvFingerprint: fingerprint, ownerToken: 'client-lifetime-owner', processInstanceFingerprint: birth,
        expectedCmdlineHash: createHash('sha256').update(info.cmd).digest('hex'),
        activeServerDir: configuration.activeServerDir, daemonInstanceId: 'prior-daemon',
      } satisfies SharedManagedOpenCodeServerState));
      for (let i = 0; i < 2; i++) clients.push(await createOpenCodeServerRuntimeClient({
        directory: home.homeDir, messageBuffer: new MessageBuffer(),
      }));
      if (trigger === 'periodic cleanup') await reapUnusedSharedManagedOpenCodeServersBestEffort();
      if (trigger === 'auth switch') {
        expect(await releaseForAuthSwitch(fingerprint, 'client-lifetime-owner')).toMatchObject({ released: false });
      }
      if (trigger === 'daemon shutdown') {
        await stopSharedManagedOpenCodeServerFromEnvBestEffort({ daemonInstanceId: 'prior-daemon' });
      }
      if (trigger === 'unhealthy acquisition') {
        healthy = false;
        const signals: unknown[] = [];
        const kill = process.kill.bind(process);
        const spy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
          if (Math.abs(target) === pid && signal !== 0) {
            signals.push(signal);
            throw Object.assign(new Error('Fixture refuses termination'), { code: 'EPERM' });
          }
          return kill(target, signal);
        });
        try {
          await expect(createOpenCodeServerRuntimeClient({
            directory: home.homeDir, messageBuffer: new MessageBuffer(),
          })).rejects.toThrow();
          expect(signals).toEqual([]);
        } finally {
          spy.mockRestore();
          healthy = true;
        }
      }
      await clients[0]!.dispose();
      expect(isOpenCodeServerPidAlive(pid)).toBe(true);
      let requestSettled = false;
      if (trigger === 'pending request') {
        void clients[1]!.sessionList().then(() => { requestSettled = true; }, () => { requestSettled = true; });
        await pendingReadReceived;
      }
      await clients[1]!.dispose();
      if (trigger === 'pending request') expect(requestSettled).toBe(true);
      await waitForProcessExit(pid, { timeoutMs: 1_000 });
      expect(isOpenCodeServerPidAlive(pid)).toBe(false);
      expect(existsSync(statePath)).toBe(false);
    } finally {
      for (const client of clients) await client.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await waitForProcessExit(pid, { timeoutMs: 1_000 });
      await home.restore();
    }
  });
});
