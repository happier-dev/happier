import { spawn } from 'node:child_process';
import { once } from 'node:events';
import axios, { AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { StopSessionResultSchema, SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol';
import { MachineSessionTerminalCaptureResponseV1Schema } from '@happier-dev/protocol/sessions/control/machineSessionTerminalV1';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { readProcessIdentityByPid } from '../processIdentity';
import { readSessionMarkerForPid, writeSessionMarker } from '../sessionRegistry';
import type { TrackedSession } from '../types';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createOnChildExited } from './onChildExited';
import { createStopSession } from './stopSession';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';
import { resolveTrackedSessionTerminalHostExitCandidate, shouldRetainTrackedTerminalHostExitMarker } from './disconnectedTerminalHostSupervision';
import { retireExactTerminalControlServiceability, retireStoppedPlainRunnerControlServiceability } from './retireTerminalControlServiceability';
import { reattachTrackedSessionsFromMarkers, readOrphanedDeadPlainRunnerMarkers } from './reattachFromMarkers';
import { publishOrphanedStartupSessionEnds } from './publishOrphanedStartupSessionEnds';
import { recoverStrandedTerminalControlServiceability } from './recoverStrandedTerminalControlServiceability';

describe.skipIf(process.platform !== 'linux')('offline Stop through physical exit, marker custody and Home recovery', () => {
  it.each(['bound', 'missing-owned-host', 'mode-only', 'mode-only-offline', 'terminal-started-offline', 'missing-marker', 'live-child',
    'unreported-dead-runner', 'unreported-live-runner'] as const)('releases only durably recoverable dead custody: %s', async wiring => {
    await withConfiguredDaemonTestHome({ prefix: 'offline-stop-' }, async ({ homeDir }) => {
      const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
        { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const exited = once(child, 'exit');
      await once(child, 'message');
      const pid = child.pid!;
      const identity = await readProcessIdentityByPid(pid);
      if (!identity) throw new Error('Owned fixture process identity unavailable');
      // A native runner can publish hostPid before its webhook binds it to the
      // tracked launcher. Stop must re-prove that metadata owner, not ignore it.
      const unreported = wiring === 'unreported-dead-runner' || wiring === 'unreported-live-runner';
      const nativeChild = unreported ? spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }) : null;
      const nativeExited = nativeChild ? once(nativeChild, 'exit') : null;
      if (nativeChild) await once(nativeChild, 'message');
      const nativeIdentity = nativeChild?.pid ? await readProcessIdentityByPid(nativeChild.pid) : null;
      if (nativeChild && !nativeIdentity) throw new Error('Owned native runner identity unavailable');
      const sessionId = `offline-stop-${wiring}`;
      const startedBy = wiring === 'terminal-started-offline' ? 'terminal' as const : 'daemon' as const;
      const tracked: TrackedSession = { pid, childProcess: child, startedBy, happySessionId: sessionId,
        processStartTimeMs: identity.processStartTimeMs, processCommandHash: identity.processCommandHash,
        stopRequestedAtMs: Date.now(), spawnOptions: { directory: homeDir },
        ...(wiring === 'missing-owned-host' ? { hostedTerminal: { mode: 'tmux' as const },
          publishedTerminalControlServiceabilityAttachmentId: 'retired-owned-host' } : {}) };
      if (wiring !== 'missing-marker') await writeSessionMarker({ pid, happySessionId: sessionId, startedBy,
        processStartTimeMs: identity.processStartTimeMs, processCommandHash: identity.processCommandHash });
      const modeOnly = wiring === 'mode-only' || wiring === 'mode-only-offline';
      let online = wiring === 'mode-only' || unreported;
      let retired = false;
      let retirementResult: Awaited<ReturnType<typeof retireExactTerminalControlServiceability>> | undefined;
      const raw = createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain', metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ path: homeDir, machineId: 'fixture-machine',
          hostPid: nativeChild?.pid ?? pid, hostProcessStartTimeMs: nativeIdentity?.processStartTimeMs ?? identity.processStartTimeMs,
          ...(modeOnly ? { terminal: { mode: 'tmux' } } : {}),
          ...(wiring === 'missing-owned-host' ? { terminal: { mode: 'tmux', controlServiceabilityV1: {
            v: 1, attachmentId: 'retired-owned-host', state: 'servable', observedAt: 1 } } } : {}) }) });
      const refusal = () => Object.assign(new Error('Home unreachable'), { code: 'ECONNREFUSED' });
      const response = { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
      // Only genuine HTTP/socket carriers are replaced; all lifecycle, storage,
      // metadata production and strict consumer schemas below remain real.
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (!online) throw refusal();
        return { ...response, data: String(url).includes('/v2/sessions/') ? { session: raw } : {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      });
      const patch = vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
        if (!online) throw refusal();
        const parsed = SessionMetadataTuplePatchV1Schema.parse(body);
        // Migration preserves the legacy tuple; the following owner write retires it.
        if (parsed.mode === 'owner_migration') {
          raw.metadataLayoutVersion = 1;
          raw.metadata = parsed.target.sharedMetadata.ciphertext;
          raw.ownerMetadata = parsed.target.ownerMetadata;
          raw.agentState = parsed.target.agentState.ciphertext;
          raw.metadataVersion += 1;
          return { ...response, data: { success: true, metadataLayoutVersion: 1,
            sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } } };
        }
        if (parsed.mode !== 'owner') throw new Error('Expected an owner retirement write');
        if (modeOnly) expect.soft(parsed).toMatchObject({ mode: 'owner', ownerMetadata: { t: 'plain', v: { runtime: {
          lifecycleState: 'stopped', lifecycleStateSince: expect.any(Number), terminal: { mode: 'tmux' },
        } } } });
        else expect.soft(parsed).toMatchObject({ mode: 'owner', ownerMetadata: { t: 'plain', v: { runtime: {
          terminal: { mode: wiring === 'missing-owned-host' ? 'tmux' : 'plain', controlServiceabilityV1: {
            retired: true, ...(wiring === 'missing-owned-host' ? { attachmentId: 'retired-owned-host' } : {}) } } } } } });
        raw.ownerMetadata = parsed.ownerMetadata;
        raw.agentState = parsed.agentState.ciphertext;
        retired = true;
        return { ...response, data: { success: true, metadataLayoutVersion: 1,
          sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } } };
      });
      const machine = {
        captureMachineSessionTerminal: async () => {
          if (!online) throw refusal();
          return MachineSessionTerminalCaptureResponseV1Schema.parse({ v: 1, status: 'already_inactive', sessionId });
        },
        finalizeMachineSessionTerminal: async () => { throw new Error('Already inactive must not be finalized again'); },
        enqueueDaemonTerminalExactTurnEnd: async () => { throw new Error('No turn identity must not invent a turn mutation'); },
      } satisfies Pick<ApiMachineClient, 'captureMachineSessionTerminal' | 'finalizeMachineSessionTerminal' | 'enqueueDaemonTerminalExactTurnEnd'>;
      const sessions = new Map([[pid, tracked]]);
      const onExit = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: new Map(),
        sessionAttachCleanupByPid: new Map(), getApiMachineForSessions: () => machine as ApiMachineClient,
        shouldPreserveSessionMarkerOnExit: () => shouldRetainTrackedTerminalHostExitMarker({ tracked, happyHomeDir: homeDir }),
        onFinalTrackedSessionExitStaged: async () => {
          await resolveTrackedSessionTerminalHostExitCandidate({ tracked, pid, happyHomeDir: homeDir, attachmentInfo: null });
        } });
      const retire = async (stoppedAt?: number, expectedRunner = { pid, startTimeMs: identity.processStartTimeMs }) => {
        const input = { credentials: { token: 'fixture', encryption: null }, sessionId, terminalMode: 'plain' as const,
          expectedRunner, stoppedAt };
        const retirement = await retireExactTerminalControlServiceability(input);
        retirementResult = retirement;
        expect(retirement).toBe(unreported ? 'superseded' : 'retired');
        return retirement;
      };
      const observeExit = async ({ trackedPids }: { trackedPids: readonly number[] }, onExitObserved?: typeof onExit) =>
        await waitForTrackedRunnerProcessesExit({ runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0,
          onExitObserved });
      try {
        if (wiring !== 'live-child') { child.kill('SIGTERM'); await exited; }
        if (wiring === 'unreported-dead-runner') { nativeChild!.kill('SIGTERM'); await nativeExited; }
        const stop = createStopSession({ pidToTrackedSession: sessions, areTrackedRunnersExited: observeExit,
          waitForTrackedRunnersExit: async input => await observeExit(input, onExit)
            && input.trackedPids.every(pid => !sessions.has(pid)),
          retireAbsentTerminalControlServiceability: ({ stoppedAt }) =>
            retireStoppedPlainRunnerControlServiceability({ sessionId, trackedSession: tracked,
              publishRetirement: expectedRunner => retire(stoppedAt, expectedRunner) }),
          recoverStrandedTerminalControlServiceability: input => recoverStrandedTerminalControlServiceability({
            ...input, credentials: { token: 'fixture', encryption: null }, currentMachineId: 'fixture-machine',
            loadTerminalHostAdapters: async () => ({}),
            retireExactTerminalControlServiceability: target => retireExactTerminalControlServiceability({
              ...target, credentials: { token: 'fixture', encryption: null },
            }),
          }),
          // Refuse OS effect authority for the live-child sensitivity vector.
          retireUpstreamAuthorityBeforeProcessStop: wiring === 'live-child' ? async () => false : undefined });
        const result = StopSessionResultSchema.parse(await stop(sessionId));
        if (unreported) {
          expect(retirementResult).toBe('superseded');
          expect(result).toEqual(wiring === 'unreported-dead-runner' ? { status: 'stopped' }
            : { status: 'incomplete', reason: 'tracked_runner_absent' });
          expect(retired).toBe(wiring === 'unreported-dead-runner');
          expect(sessions.size).toBe(0);
          if (wiring === 'unreported-live-runner') expect(nativeChild!.exitCode === null && nativeChild!.signalCode === null).toBe(true);
        } else if (wiring === 'mode-only') {
          expect(result).toEqual({ status: 'stopped' });
          expect(retirementResult).toBe('retired');
          expect(sessions.size).toBe(0);
          // The exit owner retains exact marker evidence until Home finality
          // and control retirement converge through the existing recovery owner.
          expect(await readSessionMarkerForPid(pid)).toMatchObject({ happySessionId: sessionId });
          const recovery = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession: sessions });
          expect(await publishOrphanedStartupSessionEnds({ apiMachine: machine,
            orphanedDeadDaemonSessions: recovery.orphanedDeadDaemonSessions,
            retireTerminalControlServiceability: async () => { await retire(); } })).toEqual([]);
          expect(await readSessionMarkerForPid(pid)).toBeNull();
          expect(retired).toBe(true);
        } else if (wiring === 'bound' || wiring === 'missing-owned-host' || wiring === 'mode-only-offline'
            || wiring === 'terminal-started-offline') {
          expect(result).toEqual({ status: 'stopped' });
          // This fixture's zero-budget probe may finish before exit staging.
          // Join that existing lifecycle before driving connected-edge recovery.
          await onExit(pid, { reason: 'process-missing', code: null, signal: null });
          expect(sessions.has(pid)).toBe(false);
          expect(await readSessionMarkerForPid(pid)).toMatchObject({ happySessionId: sessionId, processStartTimeMs: identity.processStartTimeMs });
          online = true;
          // Reconnect scans disk independently of retained in-memory custody;
          // startup reattachment's already-adopted flag is not physical liveness.
          const orphanedDeadDaemonSessions = await readOrphanedDeadPlainRunnerMarkers();
          expect(orphanedDeadDaemonSessions).toEqual([{ pid, sessionId, processStartTimeMs: identity.processStartTimeMs }]);
          const input = { apiMachine: machine, orphanedDeadDaemonSessions,
            retireTerminalControlServiceability: async () => { await retire(); } };
          // Machine finality is reachable before the metadata HTTP path. Its
          // success alone must not erase the remaining retirement obligation.
          get.mockRejectedValueOnce(refusal());
          expect(await publishOrphanedStartupSessionEnds(input)).toEqual(orphanedDeadDaemonSessions);
          expect(await readSessionMarkerForPid(pid)).not.toBeNull();
          expect(await publishOrphanedStartupSessionEnds(input)).toEqual([]);
          expect(retired).toBe(!modeOnly);
          expect(await readSessionMarkerForPid(pid)).toBeNull();
        } else {
          expect(result.status).toBe('incomplete');
          expect(sessions.get(pid)).toBe(tracked);
          expect(retired).toBe(false);
          if (wiring === 'live-child') expect(child.exitCode === null && child.signalCode === null).toBe(true);
        }
      } finally {
        get.mockRestore(); patch.mockRestore();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (nativeChild && nativeChild.exitCode === null && nativeChild.signalCode === null) nativeChild.kill('SIGKILL');
        await exited;
        await nativeExited;
      }
    });
  });
});
