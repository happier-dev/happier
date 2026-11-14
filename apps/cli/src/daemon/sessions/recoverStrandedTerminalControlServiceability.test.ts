import { afterEach, describe, expect, it, vi } from 'vitest';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import type { TerminalHostAdapter } from '@happier-dev/agents';
import axios from 'axios';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { SessionMetadataTuplePatchV1Schema, SessionSystemSessionV1Schema } from '@happier-dev/protocol';
import { retireExactTerminalControlServiceability } from './retireTerminalControlServiceability';
import { createStopSession } from './stopSession';
import { retireObservedSessionRunnerMetadata } from './plainRunnerRetirement';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';

import { recoverStrandedTerminalControlServiceability } from './recoverStrandedTerminalControlServiceability';

function adapter(evaluateLiveness: TerminalHostAdapter['evaluateLiveness']): TerminalHostAdapter {
  return {
    kind: 'tmux',
    createOrAttachHost: vi.fn(),
    injectUserPrompt: vi.fn(),
    interruptTurn: vi.fn(),
    evaluateLiveness,
    dispose: vi.fn(),
  };
}

function metadata(machineId = 'machine-current'): Record<string, unknown> {
  return {
    machineId,
    terminal: {
      mode: 'tmux',
      tmux: { target: 'happy-session:owned-pane' },
      controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-1',
        state: 'recoverable_unservable',
        observedAt: 100,
        reason: 'runner_absent',
      },
    },
  };
}

function params(input: Readonly<{
  evaluateLiveness: TerminalHostAdapter['evaluateLiveness'];
  metadata?: Record<string, unknown>;
  retire?: () => Promise<'retired' | 'superseded'>;
  expectedAttachmentId?: string;
}>) {
  return {
    credentials: { token: 'token', encryption: null },
    currentMachineId: 'machine-current',
    sessionId: 'session-1',
    ...(input.expectedAttachmentId ? { expectedAttachmentId: input.expectedAttachmentId } : {}),
    loadTerminalHostAdapters: async () => ({ tmux: adapter(input.evaluateLiveness) }),
    fetchSession: async () => createSessionRecordFixture({
      id: 'session-1',
      encryptionMode: 'plain',
      metadataLayoutVersion: 0,
      metadata: JSON.stringify(input.metadata ?? metadata()),
    }),
    resolveAccountEncryptionMode: async () => 'plain' as const,
    retireExactTerminalControlServiceability: vi.fn(input.retire ?? (async () => 'retired' as const)),
  };
}

describe('recoverStrandedTerminalControlServiceability', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['retired', 'unproven', 'replacement', 'replacement observation', 'failed-start', 'archived-failed-start', 'inactive-live-runner'] as const)(
    'settles Stop from current plain runner evidence (%s)', async state => {
      await withConfiguredDaemonTestHome({ prefix: 'stop-topology-' }, async ({ homeDir }) => {
        const failedStart = state === 'failed-start' || state === 'archived-failed-start';
        const base = { ...createTestMetadata({ machineId: 'machine-current' }),
          systemSessionV1: SessionSystemSessionV1Schema.parse({ v: 1, key: 'voice_conversation', hidden: true }),
        };
        const metadata = state === 'inactive-live-runner' ? { ...base, hostPid: process.pid }
          : state === 'unproven' || failedStart ? base : await retireObservedSessionRunnerMetadata({
          metadata: { ...base, hostPid: 999_123_456, hostProcessStartTimeMs: 1, lifecycleState: 'running' },
          expectedRunner: { pid: 999_123_456, startTimeMs: 1 },
          trackedSession: { trackingKey: legacyPidSessionTrackingKey(999_123_456), pid: 999_123_456, startedBy: 'daemon' }, sessionId: 'session-1', happyHomeDir: homeDir,
        });
        const input = params({ evaluateLiveness: async () => ({ paneAlive: false, observedAt: 1 }), metadata });
        const raw = await input.fetchSession();
        raw.active = state === 'unproven';
        raw.archivedAt = state === 'archived-failed-start' ? 200 : null;
        // The real owner detail retains its explicit recipient role across migration.
        raw.share = null;
        // Home HTTP is the boundary. Stop, recovery, owner-envelope opening,
        // currentness and the fenced retirement writer remain real.
        vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
          data: String(url).includes('/v2/sessions/') ? { session: state === 'replacement'
            ? { ...raw, metadata: JSON.stringify({ machineId: 'machine-current', hostPid: 1234,
                terminal: { mode: 'plain' } }) }
            : state === 'replacement observation' ? { ...raw, metadata: JSON.stringify({ machineId: 'machine-current',
                terminal: { mode: 'plain', controlServiceabilityV1: { v: 1, state: 'unknown', retired: true, observedAt: 101 } } }) }
            : raw }
            : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 },
        }));
        const patch = vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
          const request = SessionMetadataTuplePatchV1Schema.parse(body);
          if (request.mode === 'owner_migration') {
            raw.metadataLayoutVersion = 1;
            raw.metadata = request.target.sharedMetadata.ciphertext;
            raw.metadataVersion += 1;
            raw.ownerMetadata = request.target.ownerMetadata;
            raw.agentState = request.target.agentState.ciphertext;
            raw.agentStateVersion += 1;
            if (request.target.displayProjectionV1 === null) delete raw.displayProjectionV1;
            else if (request.target.displayProjectionV1 !== undefined) raw.displayProjectionV1 = request.target.displayProjectionV1;
          } else if (request.mode === 'owner') {
            raw.ownerMetadata = request.ownerMetadata;
            raw.agentState = request.agentState.ciphertext;
            raw.agentStateVersion += 1;
          } else throw new Error(`Unexpected retirement patch: ${request.mode}`);
          return { status: 200, data: { success: true, metadataLayoutVersion: 1,
            sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } } };
        });
        let retirementFailure = '';
        const stop = createStopSession({ trackedSessionsByKey: new Map(),
          recoverStrandedTerminalControlServiceability: recovery => recoverStrandedTerminalControlServiceability({
            ...input, ...recovery, fetchSession: async () => raw,
            retireExactTerminalControlServiceability: retirement => retireExactTerminalControlServiceability({
              ...input, ...retirement,
            }).catch(error => {
              retirementFailure = error instanceof Error ? error.message : String(error);
              throw error;
            }),
          }),
        });
        const stopped = await stop('session-1');
        expect(stopped, retirementFailure).toEqual(state === 'retired' || failedStart ? { status: 'stopped' }
          : { status: 'incomplete', reason: state === 'unproven' ? 'missing_topology_proof'
            : state === 'inactive-live-runner' ? 'tracked_runner_absent' : 'attachment_mismatch' });
        if (state === 'retired') {
          expect(tryDecryptSessionOwnerMetadataView({ credentials: input.credentials,
            accountEncryptionMode: 'plain', rawSession: raw })).toMatchObject({ lifecycleState: 'stopped' });
          const writes = patch.mock.calls.length;
          expect(await stop('session-1'), retirementFailure).toEqual({ status: 'stopped' });
          expect(patch).toHaveBeenCalledTimes(writes);
        } else {
          expect(patch).not.toHaveBeenCalled();
          if (failedStart) expect(await stop('session-1')).toEqual({ status: 'stopped' });
        }
      });
    });

  it.each([
    ['ESRCH', { status: 'stopped' }],
    ['EPERM', { status: 'incomplete', reason: 'tracked_runner_absent' }],
    ['EACCES', { status: 'incomplete', reason: 'tracked_runner_absent' }],
    [null, { status: 'incomplete', reason: 'tracked_runner_absent' }],
  ])('requires positive process death for a plain session (%s)', async (code, expected) => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (code) throw Object.assign(new Error('process probe'), { code });
      return true;
    });
    const sessionMetadata = { machineId: 'machine-current', hostPid: 4321 };
    const retire = vi.fn(async () => 'retired' as const);
    await expect(recoverStrandedTerminalControlServiceability({
      credentials: { token: 'token', encryption: null },
      resolveAccountEncryptionMode: async () => 'plain' as const,
      fetchSession: async () => createSessionRecordFixture({ id: 'session-1', encryptionMode: 'plain', metadataLayoutVersion: 0, metadata: JSON.stringify(sessionMetadata) }),
      currentMachineId: 'machine-current',
      sessionId: 'session-1',
      loadTerminalHostAdapters: async () => ({}),
      retireExactTerminalControlServiceability: retire,
    })).resolves.toEqual(expected);
    expect(retire).not.toHaveBeenCalled();
  });

  it('settles a repeated Stop of a stopped hosted Session while its shared host keeps running', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'stop-hosted-repeat-' }, async () => {
      // The session host outlives each hosted Session, so the retained hostPid stays live.
      const hostPid = process.pid;
      const input = params({ evaluateLiveness: async () => ({ paneAlive: false, observedAt: 1 }),
        metadata: { ...createTestMetadata({ machineId: 'machine-current' }), hostPid,
          hostProcessStartTimeMs: 1, lifecycleState: 'running', terminal: { mode: 'plain' } } });
      const raw = await input.fetchSession();
      raw.active = true;
      raw.share = null;
      vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
        data: String(url).includes('/v2/sessions/') ? { session: raw }
          : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }));
      const patch = vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
        const request = SessionMetadataTuplePatchV1Schema.parse(body);
        if (request.mode === 'owner_migration') {
          raw.metadataLayoutVersion = 1;
          raw.metadata = request.target.sharedMetadata.ciphertext;
          raw.metadataVersion += 1;
          raw.ownerMetadata = request.target.ownerMetadata;
          raw.agentState = request.target.agentState.ciphertext;
          raw.agentStateVersion += 1;
        } else if (request.mode === 'owner') {
          raw.ownerMetadata = request.ownerMetadata;
          raw.agentState = request.agentState.ciphertext;
          raw.agentStateVersion += 1;
        } else throw new Error(`Unexpected retirement patch: ${request.mode}`);
        return { status: 200, data: { success: true, metadataLayoutVersion: 1,
          sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } } };
      });
      // First Stop: the host's per-Session end report retires this hosted Session.
      await expect(retireExactTerminalControlServiceability({ ...input, stoppedAt: 50, terminalMode: 'plain',
        expectedRunner: { pid: hostPid, startTimeMs: 1, sessionEndObserved: Promise.resolve() } })).resolves.toBe('retired');
      raw.active = false;
      expect(tryDecryptSessionOwnerMetadataView({ credentials: input.credentials, accountEncryptionMode: 'plain',
        rawSession: raw })).toMatchObject({ hostPid, lifecycleState: 'stopped' });
      const writes = patch.mock.calls.length;

      const stop = createStopSession({ trackedSessionsByKey: new Map(),
        recoverStrandedTerminalControlServiceability: recovery => recoverStrandedTerminalControlServiceability({
          ...input, ...recovery, fetchSession: async () => raw,
          retireExactTerminalControlServiceability: retirement => retireExactTerminalControlServiceability({ ...input, ...retirement }),
        }),
      });
      await expect(stop('session-1')).resolves.toEqual({ status: 'stopped' });
      expect(patch).toHaveBeenCalledTimes(writes);
    });
  });

  it('does not probe a remote, malformed, or attachment-bound plain runner', async () => {
    const probe = vi.spyOn(process, 'kill');
    for (const [machineId, pid, active, expectedAttachmentId, expected] of [
      ['machine-other', 4321, false, undefined, null],
      ['machine-current', undefined, true, undefined, { status: 'incomplete', reason: 'missing_topology_proof' }],
      ['machine-current', 0, false, undefined, { status: 'incomplete', reason: 'missing_topology_proof' }],
      ['machine-current', '4321', false, undefined, { status: 'incomplete', reason: 'missing_topology_proof' }],
      ['machine-current', 4321, false, 'attachment-old', { status: 'incomplete', reason: 'attachment_mismatch' }],
    ] as const) {
      const sessionMetadata = { machineId, hostPid: pid, terminal: { mode: 'plain' } };
      await expect(recoverStrandedTerminalControlServiceability({
      credentials: { token: 'token', encryption: null },
      resolveAccountEncryptionMode: async () => 'plain' as const,
      fetchSession: async () => createSessionRecordFixture({ id: 'session-1', active, encryptionMode: 'plain', metadataLayoutVersion: 0, metadata: JSON.stringify(sessionMetadata) }),
        currentMachineId: 'machine-current',
        sessionId: 'session-1',
        expectedAttachmentId,
        loadTerminalHostAdapters: async () => ({}),
        retireExactTerminalControlServiceability: async () => 'retired',
      })).resolves.toEqual(expected);
    }
    expect(probe).not.toHaveBeenCalled();
  });


  it('retires exact stranded serviceability only after the canonical host probe proves death', async () => {
    const input = params({ evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }) });
    await expect(recoverStrandedTerminalControlServiceability(input)).resolves.toEqual({ status: 'stopped' });
    expect(input.retireExactTerminalControlServiceability).toHaveBeenCalledWith({
      sessionId: 'session-1',
      attachmentId: 'attachment-1',
      terminalMode: 'tmux',
    });
  });

  it('fails closed for alive, inconclusive, remote, or superseded terminal evidence', async () => {
    await expect(recoverStrandedTerminalControlServiceability(params({
      evaluateLiveness: async () => ({ paneAlive: true, observedAt: 200 }),
    }))).resolves.toEqual({ status: 'incomplete', reason: 'tracked_runner_absent' });
    await expect(recoverStrandedTerminalControlServiceability(params({
      evaluateLiveness: async () => ({ paneAlive: false, probeInconclusive: true, observedAt: 200 }),
    }))).resolves.toEqual({ status: 'incomplete', reason: 'missing_topology_proof' });
    await expect(recoverStrandedTerminalControlServiceability(params({
      evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }),
      metadata: metadata('machine-other'),
    }))).resolves.toBeNull();
    await expect(recoverStrandedTerminalControlServiceability(params({
      evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }),
      retire: async () => 'superseded',
    }))).resolves.toEqual({ status: 'incomplete', reason: 'attachment_mismatch' });
  });

  it('does not manufacture a probe identity for current Dev zellij or Windows metadata', async () => {
    for (const terminal of [
      { mode: 'zellij' },
      { mode: 'windows_console', windows: { host: 'console' } },
    ]) {
      await expect(recoverStrandedTerminalControlServiceability(params({
        evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }),
        metadata: {
          machineId: 'machine-current',
          terminal: {
            ...terminal,
            controlServiceabilityV1: {
              v: 1,
              attachmentId: 'attachment-1',
              state: 'recoverable_unservable',
              observedAt: 100,
            },
          },
        },
      }))).resolves.toEqual({ status: 'incomplete', reason: 'missing_topology_proof' });
    }
  });

  it('reproves a pinned dead host so local cleanup can retry after server retirement', async () => {
    const retiredMetadata = metadata();
    const terminal = retiredMetadata.terminal as { controlServiceabilityV1: Record<string, unknown> };
    terminal.controlServiceabilityV1.retired = true;
    const input = params({
      evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }),
      metadata: retiredMetadata,
      expectedAttachmentId: 'attachment-1',
    });

    await expect(recoverStrandedTerminalControlServiceability(input))
      .resolves.toEqual({ status: 'stopped' });
    expect(input.retireExactTerminalControlServiceability).not.toHaveBeenCalled();
  });

  it.each([
    [{ paneAlive: false, paneDead: true, observedAt: 200 }, { status: 'stopped' }],
    [{ paneAlive: true, observedAt: 200 }, { status: 'incomplete', reason: 'tracked_runner_absent' }],
    [{ paneAlive: false, probeInconclusive: true, observedAt: 200 }, { status: 'incomplete', reason: 'missing_topology_proof' }],
  ] as const)('reproves a retired host for repeated Stop after tracked-runner settlement (%j)', async (liveness, expected) => {
    const retiredMetadata = metadata();
    const terminal = retiredMetadata.terminal as { controlServiceabilityV1: Record<string, unknown> };
    // The real retirement producer leaves the exact tmux target but clears serviceability.
    terminal.controlServiceabilityV1 = { ...terminal.controlServiceabilityV1,
      state: 'unknown', reason: 'attachment_retired', retired: true };
    const evaluateLiveness = vi.fn(async () => liveness);
    const input = params({ evaluateLiveness, metadata: retiredMetadata });

    await expect(recoverStrandedTerminalControlServiceability(input)).resolves.toEqual(expected);
    expect(evaluateLiveness).toHaveBeenCalled();
    expect(input.retireExactTerminalControlServiceability).not.toHaveBeenCalled();
  });

  it('does not probe or retire a replacement attachment', async () => {
    const evaluateLiveness = vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 200 }));
    const input = params({ evaluateLiveness, expectedAttachmentId: 'attachment-local' });

    await expect(recoverStrandedTerminalControlServiceability(input))
      .resolves.toEqual({ status: 'incomplete', reason: 'attachment_mismatch' });
    expect(evaluateLiveness).not.toHaveBeenCalled();
    expect(input.retireExactTerminalControlServiceability).not.toHaveBeenCalled();
  });
});
