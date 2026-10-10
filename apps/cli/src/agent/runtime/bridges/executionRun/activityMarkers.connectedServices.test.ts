import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadConfiguration } from '@/configuration';
import { listExecutionRunMarkers, listExecutionRunMarkersForRehydration, reconcileRetainedExecutionRunRecords } from '@/daemon/executionRunRegistry';

const filesystemBoundary = vi.hoisted(() => ({ rejectMarkerRename: false }));
// Fail only the marker's OS publication; retain real parsing and lifecycle custody.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (filesystemBoundary.rejectMarkerRename && String(args[1]).endsWith('run-run_required.json')) {
      throw new Error('marker disk unavailable');
    }
    return await actual.rename(...args);
  } };
});

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'happier-run-marker-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  vi.stubEnv('HAPPIER_PUBLIC_RELEASE_CHANNEL', undefined);
  vi.stubEnv('HAPPIER_RELEASE_RING', undefined);
  vi.stubEnv('HAPPIER_RELEASE_CHANNEL', undefined);
  filesystemBoundary.rejectMarkerRename = false;
  reloadConfiguration();
});
afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfiguration();
  rmSync(directory, { recursive: true, force: true });
});

import { writeExecutionRunActivityMarker } from './activityMarkers';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { projectExecutionRunPublicState } from './publicState';

describe('writeExecutionRunActivityMarker marker privacy', () => {
  it('does not copy the in-memory connected-services registration into the marker', async () => {
    const registration = {
      v: 1 as const,
      activationId: '11111111-1111-4111-8111-111111111111',
      runKey: 'run_1',
      agentId: 'codex',
      materializationKey: 'run_1',
      connectedServicesBindings: {
        v: 2 as const,
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
      launch: { connectedServicesRegistration: registration, selectionSource: 'inherited', modelId: 'applied-model',
        modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'parent-provider', modelId: 'applied-model' },
        connectedServicesSelection: null },
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

    const marker = (await listExecutionRunMarkersForRehydration()).find((item) => item.runId === run.runId);
    expect(marker).toMatchObject({
      permissionMode: 'default',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(marker).not.toHaveProperty('executionRunConnectedServicesLaunchV1');
    expect(marker).toHaveProperty(
      'executionRunConnectedServicesCleanupReceiptV1',
      {
        v: 1,
        activationId: registration.activationId,
        runKey: registration.runKey,
        agentId: registration.agentId,
      },
    );
    expect(marker).not.toHaveProperty('summary');
    expect(JSON.stringify(marker)).not.toContain('/tmp/project');
    expect(JSON.stringify(marker)).not.toContain('profile_1');
    expect((await listExecutionRunMarkers()).find((item) => item.runId === run.runId))
      .not.toHaveProperty('executionRunConnectedServicesCleanupReceiptV1');
    expect.soft((await listExecutionRunMarkers()).find((item) => item.runId === run.runId))
      .toHaveProperty('resolvedSelection', projectExecutionRunPublicState(run).resolvedSelection);
    await reconcileRetainedExecutionRunRecords({ nowMs: 30, isPidAlive: () => false });
    expect((await listExecutionRunMarkers()).find((item) => item.runId === run.runId))
      .toMatchObject({ status: 'failed', errorCode: 'execution_run_host_lost',
        resolvedSelection: projectExecutionRunPublicState(run).resolvedSelection });
  });

  it('keeps marker publication best-effort when an in-memory launch fact is registered', async () => {
    filesystemBoundary.rejectMarkerRename = true;
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
          activationId: '22222222-2222-4222-8222-222222222222',
          runKey: 'run_required',
          agentId: 'codex',
          materializationKey: 'run_required',
          connectedServicesBindings: { v: 2 as const, bindingsByServiceId: {} },
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

  it('does not publish broker authority for a voice-agent controller without a backend occurrence', async () => {
    const run = {
      runId: 'voice_run',
      callId: 'voice_call',
      sidechainId: 'voice_side',
      sessionId: 'voice_session',
      depth: 0,
      intent: 'voice_agent' as const,
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
      backendId: 'claude',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable' as const,
      runClass: 'long_lived' as const,
      ioMode: 'streaming' as const,
      status: 'running' as const,
      startedAtMs: 10,
    } satisfies ExecutionRunState;
    const controller = {
      kind: 'voice_agent' as const,
      controllerOccurrenceId: 'voice_occurrence_current',
      voiceAgentId: run.runId,
      cancelled: false,
      lastMarkerWriteAtMs: 0,
      terminalPromise: Promise.resolve(),
      resolveTerminal: () => undefined,
      transcript: { persistenceMode: 'persistent' as const, epoch: 1 },
      externalStreamIdByInternal: new Map(),
      internalStreamIdByExternal: new Map(),
      pendingTranscriptTurnByExternalStreamId: new Map(),
      terminalReadByExternalStreamId: new Map(),
      readInFlightByExternalStreamId: new Map(),
    } satisfies ExecutionRunController;

    await writeExecutionRunActivityMarker({
      runId: run.runId,
      nowMs: 20,
      opts: { force: true },
      runs: new Map([[run.runId, run]]),
      controllers: new Map([[run.runId, controller]]),
      enqueueMarkerWrite: async (_runId, write) => await write(),
    });

    const marker = (await listExecutionRunMarkers()).find((item) => item.runId === run.runId);
    expect(marker).toMatchObject({
      runId: run.runId,
      intent: 'voice_agent',
      happySessionId: run.sessionId,
    });
    expect(marker)
      .not.toHaveProperty('executionRunBrokerAuthorityV1');
  });
});
