import { describe, expect, it, vi } from 'vitest';

const writeExecutionRunMarkerMock = vi.fn(async (_marker: unknown) => undefined);
vi.mock('@/daemon/executionRunRegistry', () => ({
  writeExecutionRunMarker: (marker: unknown) => writeExecutionRunMarkerMock(marker),
}));

import { writeExecutionRunActivityMarker } from './activityMarkers';
import type { ExecutionRunState } from './executionRunTypes';

describe('writeExecutionRunActivityMarker marker privacy', () => {
  it('does not copy the in-memory connected-services registration into the marker', async () => {
    const registration = {
      v: 1 as const,
      runKey: 'run_1',
      agentId: 'codex',
      materializationKey: 'run_1',
      connectedServicesBindings: {
        v: 1 as const,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'profile_1' },
        },
      },
      connectedServiceSelectionsEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: '{"v":1}' },
      sessionDirectory: '/tmp/project',
      materializedRoot: '/materialized/run_1',
    };
    const run: ExecutionRunState = {
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      sessionId: 'session_1',
      depth: 0,
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      backendId: 'codex',
      instructions: 'review',
      permissionMode: 'default',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
      launch: { connectedServicesRegistration: registration },
      status: 'running',
      startedAtMs: 10,
      summary: 'raw model output must not enter the marker',
    };

    await writeExecutionRunActivityMarker({
      runId: run.runId,
      nowMs: 20,
      opts: { force: true },
      runs: new Map([[run.runId, run]]),
      controllers: new Map(),
      enqueueMarkerWrite: async (_runId, write) => await write(),
    });

    const marker = writeExecutionRunMarkerMock.mock.calls.at(-1)?.[0];
    expect(marker).toMatchObject({
      permissionMode: 'default',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(marker).not.toHaveProperty('executionRunConnectedServicesLaunchV1');
    expect(marker).not.toHaveProperty('summary');
    expect(JSON.stringify(marker)).not.toContain('/tmp/project');
    expect(JSON.stringify(marker)).not.toContain('profile_1');
  });

  it('keeps marker publication best-effort when an in-memory launch fact is registered', async () => {
    writeExecutionRunMarkerMock.mockRejectedValueOnce(new Error('marker disk unavailable'));
    const run = {
      runId: 'run_required',
      callId: 'call_required',
      sidechainId: 'side_required',
      sessionId: 'session_required',
      depth: 0,
      intent: 'review' as const,
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' as const },
      backendId: 'codex',
      instructions: 'review',
      permissionMode: 'default',
      retentionPolicy: 'resumable' as const,
      runClass: 'bounded' as const,
      ioMode: 'request_response' as const,
      launch: {
        connectedServicesRegistration: {
          v: 1 as const,
          runKey: 'run_required',
          agentId: 'codex',
          materializationKey: 'run_required',
          connectedServicesBindings: { v: 1 as const, bindingsByServiceId: {} },
          connectedServiceSelectionsEnv: {},
          sessionDirectory: '/tmp/project',
          materializedRoot: null,
        },
      },
      status: 'running' as const,
      startedAtMs: 10,
    } satisfies ExecutionRunState;

    await expect(writeExecutionRunActivityMarker({
      runId: run.runId,
      nowMs: 20,
      opts: { force: true },
      runs: new Map([[run.runId, run]]),
      controllers: new Map(),
      enqueueMarkerWrite: async (_runId, write) => await write(),
    })).resolves.toBeUndefined();
  });
});
