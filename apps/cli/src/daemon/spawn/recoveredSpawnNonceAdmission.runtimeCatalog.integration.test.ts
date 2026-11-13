import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuration, reloadConfiguration } from '@/configuration';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createTerminalAttachmentId, readTerminalHostAttachmentState, writeTerminalHostAttachmentInfo, writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { buildTerminalMetadataFromHostHandle } from '@/terminal/runtime/terminalMetadata';
import { readProcessIdentityByPid } from '../processIdentity';
import { hashProcessCommand, writeSessionMarker } from '../sessionRegistry';
import { probeSessionRunnerServiceability } from '../sessions/isSessionRunnerActive';
import { probeAlreadyRunningExistingSessionServiceability } from '../startup/pendingQueueNudge';
import type { TrackedSession } from '../types';
import { createDaemonControlApp } from '../controlServer';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import { buildWindowsHostedTerminalAttachment, buildWindowsTerminalWindowIdentity } from '../platform/windows/windowsHostedSessionRuntime';
import { resolveRecoveredSpawnNonceAdmission } from './recoveredSpawnNonceAdmission';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

describe('recovered spawn readiness through real marker, host and RPC owners', () => {
  it.each(['host-ready', 'host-absent', 'host-replacement', 'host-unreadable', 'plain-ready', 'plain-wrapper-ready', 'plain-unready', 'startup-pending', 'marker-unbound', 'completed-cache-race', 'host-missing-id-ready', 'host-missing-id-replacement', 'host-same-id-wrong-terminal', 'host-same-id-wrong-mode', 'windows-console-ready', 'windows-console-mismatch', 'windows-terminal-ready', 'windows-terminal-mismatch', 'windows-terminal-absent', 'windows-pty-ready', 'windows-pty-published-id-ready', 'windows-pty-unknown-id', 'windows-pty-replacement', 'await-windows-pty-replacement', 'await-stable', 'await-marker-rebound', 'await-tracked-nonce-rebound', 'await-host-replacement', 'await-host-geometry', 'await-host-inplace-geometry', 'await-host-missing-id-replacement', 'await-windows-replacement'] as const)(
    'admits only completed accepted custody and serviceability: %s', async (state) => {
      const home = await mkdtemp(join(tmpdir(), 'happier-recovered-nonce-'));
      const sessionId = 'session-recovered';
      let rpcReady = state !== 'plain-unready';
      let announceProbe!: () => void;
      const probeStarted = new Promise<void>(resolve => { announceProbe = resolve; });
      let releaseProbe: (() => void) | undefined;
      const http = createServer((_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}' }) }));
      });
      // Actual Socket.IO/HTTP transport, not mocked readiness or internal parsing.
      const sockets = new Server(http, { path: '/v1/updates/' });
      sockets.on('connection', socket => socket.on('rpc-call', (_request, ack) => {
        if (state === 'completed-cache-race' || state.startsWith('await-')) {
          releaseProbe = () => ack({ ok: true, result: state === 'completed-cache-race'
            ? { ok: false, errorCode: 'runtime_upgrade_required' }
            : { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' } });
          announceProbe();
          return;
        }
        ack({ ok: true, result: !rpcReady ? { ok: false, errorCode: 'runtime_upgrade_required' }
          : { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' } });
      }));
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('missing real HTTP endpoint');
      vi.stubEnv('HAPPIER_HOME_DIR', home);
      vi.stubEnv('HAPPIER_SERVER_URL', `http://127.0.0.1:${address.port}`);
      reloadConfiguration();
      try {
        const identity = await readProcessIdentityByPid(process.pid);
        if (identity?.processStartTimeMs === undefined) throw new Error('missing real process generation');
        const nonce = 'nonce-recovered';
        const plain = state.startsWith('plain');
        const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(process.pid), startedBy: 'daemon', pid: process.pid, happySessionId: sessionId,
          reattachedFromDiskMarker: true, processStartTimeMs: identity.processStartTimeMs,
          spawnOptions: { directory: home, spawnNonce: nonce, terminal: { mode: plain ? 'plain' : 'herdr' } } };
        if (state === 'plain-wrapper-ready') {
          tracked.pid = process.pid + 1;
          tracked.processStartTimeMs = identity.processStartTimeMs + 1;
          tracked.processCommandHash = hashProcessCommand('wrapper');
          tracked.sessionRunnerPid = process.pid;
          tracked.runnerProcessIdentity = { pid: process.pid, processStartTimeMs: identity.processStartTimeMs,
            processCommandHash: hashProcessCommand(identity.command) };
        }
        await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, happySessionId: sessionId, startedBy: 'daemon',
          processStartTimeMs: identity.processStartTimeMs,
          respawn: { version: 1, directory: home, spawnNonce: state === 'marker-unbound' ? 'another-nonce' : nonce,
            terminal: { mode: plain ? 'plain' : 'herdr' } } });
        if (state.startsWith('windows-pty') || state === 'await-windows-pty-replacement') {
          const handle = { attachmentId: createTerminalAttachmentId(), kind: 'windows_console' as const,
            sessionName: 'pty-session', paneId: 'pty-session', attachMetadata: { attachStrategy: 'terminal_host' as const,
              topology: 'shared' as const, locality: 'same_machine' as const, maxClients: null,
              requiresLocalAttachmentInfo: false, liveProbe: 'required' as const } };
          tracked.hostedTerminal = buildTerminalMetadataFromHostHandle(handle);
          if (state === 'windows-pty-published-id-ready') tracked.publishedTerminalControlServiceabilityAttachmentId = handle.attachmentId;
          if (state === 'windows-pty-published-id-ready' || state === 'windows-pty-unknown-id') {
            tracked.hostedTerminal = { ...tracked.hostedTerminal, controlServiceabilityV1: undefined };
          }
          await writeTerminalHostAttachmentInfo({ happyHomeDir: home, sessionId,
            handle: state === 'windows-pty-replacement' ? { ...handle, attachmentId: createTerminalAttachmentId() } : handle });
        } else if (state.startsWith('windows-') || state === 'await-windows-replacement') {
          const window = buildWindowsTerminalWindowIdentity({ agentCommand: 'codex', existingSessionId: sessionId });
          const actualMode = state.startsWith('windows-console') ? 'windows_console' as const : 'windows_terminal' as const;
          const terminal = buildWindowsHostedTerminalAttachment({ actualMode,
            requestedMode: actualMode === 'windows_console' ? 'console' : 'windows_terminal', pid: process.pid,
            windowId: window.windowId, title: window.title });
          tracked.hostedTerminal = terminal;
          if (state !== 'windows-terminal-absent') await writeTerminalAttachmentInfo({ happyHomeDir: home, sessionId,
            terminal: state === 'windows-console-mismatch' ? { ...terminal, windows: { host: 'console', pid: process.pid + 1 } }
              : state === 'windows-terminal-mismatch' ? { ...terminal, windows: { ...terminal.windows, host: 'windows_terminal', title: 'different-launch' } }
              : terminal });
        } else if (!plain && state !== 'host-absent') {
          const handle = { attachmentId: createTerminalAttachmentId(), kind: 'herdr' as const,
            sessionName: 'default', socketPath: join(home, 'herdr.sock'), terminalId: 'terminal-ready',
            attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const,
              locality: 'same_machine' as const, liveProbe: 'required' as const } };
          tracked.hostedTerminal = buildTerminalMetadataFromHostHandle(handle);
          if (state === 'host-missing-id-replacement' || state === 'host-missing-id-ready' || state === 'await-host-missing-id-replacement') tracked.hostedTerminal = { ...tracked.hostedTerminal, controlServiceabilityV1: undefined };
          await writeTerminalHostAttachmentInfo({ happyHomeDir: home, sessionId,
            handle: state === 'host-replacement' ? { ...handle, attachmentId: createTerminalAttachmentId() }
              : state === 'host-missing-id-replacement' || state === 'host-same-id-wrong-terminal' ? { ...handle, terminalId: 'different-terminal' }
              : state === 'host-same-id-wrong-mode' ? { ...handle, kind: 'tmux' } : handle });
          if (state === 'host-unreadable') await writeFile(join(home, 'terminal', 'sessions', `${sessionId}.host.json`), '{');
        }
        if (state === 'startup-pending') tracked.startupCustody = { finalization: Promise.resolve(), observeExit: () => {} };
        const resolveRecovered = async (spawnNonce: string) => await resolveRecoveredSpawnNonceAdmission({ spawnNonce, happyHomeDir: home,
          getChildren: () => [tracked],
          probeSessionServiceability: async (id) => await probeSessionRunnerServiceability({ sessionId: id, trackedSessions: [tracked],
            probeCapability: async () => await probeAlreadyRunningExistingSessionServiceability({ sessionId: id, credentials: { token: 'test-token', encryption: null } }) }),
        });
        const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine-local',
          resolveRecoveredSpawnNonce: resolveRecovered,
          spawnSession: async () => { throw new Error('recovered admission must not launch another runner'); },
          stopSession: async () => ({ status: 'not_found' }), requestShutdown: () => {},
          onHappySessionWebhook: createOnHappySessionWebhook({ trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]), spawnAwaiterByKey: new Map() }),
          controlToken: 'test-token' });
        try {
          await app.ready();
          const lookup = async () => await app.inject({ method: 'POST', url: '/spawn-session/resolve',
            headers: { 'x-happier-daemon-token': 'test-token' }, payload: { spawnNonce: nonce } });
          if (state === 'completed-cache-race') {
            const pendingLookup = lookup();
            await probeStarted;
            try {
              const report = await app.inject({ method: 'POST', url: '/session-started',
                headers: { 'x-happier-daemon-token': 'test-token' },
                payload: { sessionId, metadata: createTestMetadata({ hostPid: process.pid, startedBy: 'daemon',
                  happyHomeDir: home, terminal: tracked.hostedTerminal }) } });
              expect(report.statusCode, report.body).toBe(200);
            } finally { releaseProbe?.(); }
            expect((await pendingLookup).json()).toEqual({ success: true, status: 'success', sessionId });
          } else if (state.startsWith('await-')) {
            const pendingLookup = lookup();
            await probeStarted;
            try {
              if (state === 'await-marker-rebound') {
                await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, happySessionId: sessionId, startedBy: 'daemon',
                  processStartTimeMs: identity.processStartTimeMs,
                  respawn: { version: 1, directory: home, spawnNonce: 'another-nonce', terminal: { mode: 'herdr' } } });
              } else if (state === 'await-tracked-nonce-rebound' && tracked.spawnOptions) {
                tracked.spawnOptions = { ...tracked.spawnOptions, spawnNonce: 'another-nonce' };
              } else if (state === 'await-windows-pty-replacement') {
                const replacement = { attachmentId: createTerminalAttachmentId(), kind: 'windows_console' as const,
                  sessionName: 'replacement-pty', paneId: 'replacement-pty', attachMetadata: { attachStrategy: 'terminal_host' as const,
                    topology: 'shared' as const, locality: 'same_machine' as const, maxClients: null,
                    requiresLocalAttachmentInfo: false, liveProbe: 'required' as const } };
                await writeTerminalHostAttachmentInfo({ happyHomeDir: home, sessionId, handle: replacement });
                tracked.hostedTerminal = buildTerminalMetadataFromHostHandle(replacement);
              } else if (state === 'await-host-replacement' || state === 'await-host-geometry'
                || state === 'await-host-inplace-geometry' || state === 'await-host-missing-id-replacement') {
                const current = await readTerminalHostAttachmentState({ happyHomeDir: home, sessionId });
                if (current.status !== 'present' || current.info.version === 1 || current.info.handle.kind !== 'herdr'
                  || !current.info.handle.terminalId) {
                  throw new Error('missing real initial Herdr attachment');
                }
                const replacement = { ...current.info.handle,
                  terminalId: state === 'await-host-missing-id-replacement' ? current.info.handle.terminalId : 'new-terminal',
                  attachmentId: state === 'await-host-replacement' || state === 'await-host-missing-id-replacement'
                    ? createTerminalAttachmentId() : current.info.attachmentId };
                await writeTerminalHostAttachmentInfo({ happyHomeDir: home, sessionId, handle: replacement });
                if (state === 'await-host-inplace-geometry' && tracked.hostedTerminal?.herdr) {
                  tracked.hostedTerminal.herdr.terminalId = replacement.terminalId;
                } else if (state !== 'await-host-missing-id-replacement') {
                  tracked.hostedTerminal = buildTerminalMetadataFromHostHandle(replacement);
                }
              } else if (state === 'await-windows-replacement') {
                const replacement = buildWindowsHostedTerminalAttachment({ actualMode: 'windows_terminal',
                  requestedMode: 'windows_terminal', pid: process.pid, windowId: 'happier', title: 'new-launch-title' });
                await writeTerminalAttachmentInfo({ happyHomeDir: home, sessionId, terminal: replacement });
                tracked.hostedTerminal = replacement;
              }
            } finally { releaseProbe?.(); }
            expect((await pendingLookup).json()).toEqual(state === 'await-stable'
              ? { success: true, status: 'success', sessionId } : { success: true, status: 'pending' });
          } else {
            expect((await lookup()).json()).toEqual(state === 'host-ready' || state === 'plain-ready' || state === 'plain-wrapper-ready' || state === 'host-missing-id-ready'
              || state === 'windows-console-ready' || state === 'windows-terminal-ready'
              || state === 'windows-pty-ready' || state === 'windows-pty-published-id-ready'
              ? { success: true, status: 'success', sessionId } : { success: true, status: 'pending' });
          }
          if (state === 'plain-unready') {
            const replay = await app.inject({ method: 'POST', url: '/spawn-session',
              headers: { 'x-happier-daemon-token': 'test-token' }, payload: { directory: home, spawnNonce: nonce } });
            expect(replay.statusCode).toBe(202);
            rpcReady = true;
            expect((await lookup()).json()).toEqual({ success: true, status: 'success', sessionId });
          }
        } finally { await app.close(); await tracked.reportMarkerCustody?.pending; }
      } finally {
        await new Promise<void>(resolve => sockets.close(() => resolve()));
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
