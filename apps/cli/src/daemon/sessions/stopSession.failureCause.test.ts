import { describe, expect, it } from 'vitest';
import type { TrackedSession } from '../types';
import { legacyPidSessionTrackingKey } from './sessionTrackingKey';
import { createStopSession } from './stopSession';
import { StopSessionResultSchema } from './stopSessionContract';
import type { ExactTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { createDaemonControlApp } from '../controlServer';

describe('Stop failure causes', () => {
  it('preserves a native Stop failure through the authenticated HTTP reply serializer', async () => {
    const stop = createStopSession({ trackedSessionsByKey: new Map(),
      readHostAttachmentState: async () => { throw Object.assign(new Error('private path'), { code: 'EACCES' }); },
    });
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine_local',
      stopSession: sessionId => stop(sessionId),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'test-token',
    });
    try {
      await app.ready();
      const response = await app.inject({ method: 'POST', url: '/stop-session',
        headers: { 'x-happier-daemon-token': 'test-token' }, payload: { sessionId: 'cause-session' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'incomplete', reason: 'missing_topology_proof',
        failureCause: { phase: 'stop.attachment_read', errorClass: 'Error', errorCode: 'EACCES', httpStatus: null } });
    } finally { await app.close(); }
  });

  it('retains a failed host end request instead of flattening it to incomplete signaling', async () => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(472), pid: 472,
      startedBy: 'daemon', happySessionId: 'hosted-failure', hostedSession: {
        end: async () => { throw Object.assign(new Error('private native details'), { code: 'EACCES' }); },
        observed: Promise.resolve(),
      } };
    const stop = createStopSession({ trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      readHostAttachmentState: async () => ({ status: 'absent' }), readTerminalAttachmentInfo: async () => null,
    });
    expect(await stop('hosted-failure')).toEqual({ status: 'incomplete', reason: 'runner_signal_incomplete',
      failureCause: { phase: 'stop.runner_signal', errorClass: 'Error', errorCode: 'EACCES', httpStatus: null } });
  });

  it.each([
    { name: 'filesystem error', error: Object.assign(new Error('private filesystem path'), { code: 'EACCES' }),
      expected: { errorClass: 'Error', errorCode: 'EACCES', httpStatus: null } },
    { name: 'native type error', error: new TypeError('private native response'),
      expected: { errorClass: 'TypeError', errorCode: null, httpStatus: null } },
    { name: 'HTTP failure', error: Object.assign(new Error('private endpoint'), { response: { status: 503 } }),
      expected: { errorClass: 'Error', errorCode: null, httpStatus: 503 } },
  ])('retains the secret-free $name through the Stop result reader', async ({ error, expected }) => {
    const stop = createStopSession({ trackedSessionsByKey: new Map(),
      // Filesystem I/O is the boundary; Stop and its wire reader remain real.
      readHostAttachmentState: async () => { throw error; },
    });
    expect(StopSessionResultSchema.parse(await stop('failure-session'))).toEqual({
      status: 'incomplete', reason: 'missing_topology_proof',
      failureCause: { phase: 'stop.attachment_read', ...expected },
    });
  });

  it.each(['startup_cancellation', 'adapter_acquisition', 'stranded_recovery'] as const)(
    'retains a native cause from %s without changing the incomplete outcome', async path => {
      const error = Object.assign(new Error('private native details'), { code: 'EACCES' });
      const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(471), pid: 471,
        startedBy: 'daemon', happySessionId: 'failure-session' };
      const attachment: ExactTerminalHostAttachmentInfo = { version: 2,
        attachmentId: 'cause-attachment' as ExactTerminalHostAttachmentInfo['attachmentId'], sessionId: 'failure-session', updatedAt: 1,
        handle: { kind: 'tmux', sessionName: 'fixture', paneId: 'fixture-pane',
          attachmentId: 'cause-attachment' as ExactTerminalHostAttachmentInfo['attachmentId'],
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } } };
      if (path === 'startup_cancellation') tracked.cancelStartupLaunchBeforeAck = async () => { throw error; };
      const stop = createStopSession({
        trackedSessionsByKey: path === 'stranded_recovery' ? new Map() : new Map([[tracked.trackingKey, tracked]]),
        readHostAttachmentState: async () => path === 'adapter_acquisition'
          ? { status: 'present', info: attachment } : { status: 'absent' },
        readTerminalAttachmentInfo: async () => null,
        loadTerminalHostAdapters: async () => { throw error; },
        recoverStrandedTerminalControlServiceability: async () => { throw error; },
      });
      expect(StopSessionResultSchema.parse(await stop('failure-session'))).toEqual({
        status: 'incomplete', reason: path === 'startup_cancellation' ? 'runner_signal_incomplete'
          : path === 'adapter_acquisition' ? 'terminal_host_adapter_unavailable' : 'missing_topology_proof',
        failureCause: { phase: path === 'startup_cancellation' ? 'stop.startup_launch_cancellation'
          : path === 'adapter_acquisition' ? 'stop.terminal_host_adapter_acquisition' : 'stop.stranded_control_recovery',
          errorClass: 'Error', errorCode: 'EACCES', httpStatus: null },
      });
    });
});
