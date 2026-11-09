import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadConfiguration } from '@/configuration';
import { removeTempDir } from '@/testkit/fs/tempDir';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { TaskProfile } from '@/agent/executionRuns/profiles/task/TaskProfile';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { startExecutionRun } from './startExecutionRun';
import type { ExecutionRunManagerStartParams, ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';
import { createTestExecutionRunHostRuntime } from './testkit';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'happier-run-input-budget-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  reloadConfiguration();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  reloadConfiguration();
  await removeTempDir(directory);
});

describe('execution run prepared input budget', () => {
  it.each(['bounded', 'long_lived', 'session_pending'] as const)('prepares one %s input after occurrence registration and before publication or native startup', async mode => {
    const runClass = mode === 'bounded' ? 'bounded' : 'long_lived';
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const observed: string[] = [];
    let capturedStart: ExecutionRunBackendStartContext | undefined;
    let dispatchedInstructions: string | undefined;
    let startedInstructions: string | undefined;
    let publishedInput: unknown;
    const boundaryRuntime = createTestExecutionRunHostRuntime({ onProvisionRuntime: () => {
      observed.push('provision');
    } });
    const runtime = { ...boundaryRuntime, ...(mode === 'session_pending' ? {
      interaction: { kind: 'retained_agent_session.v1' as const,
        capabilities: { open: ['create' as const], delivery: ['newTurn' as const], cancel: true } },
    } : {}) };
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });
    const profileCatalog = buildExecutionRunProfileCatalog([]);
    const taskProfile = {
      ...TaskProfile,
      transcriptMaterialization: 'full' as const,
      onStarted: async ({ start }: Parameters<NonNullable<typeof TaskProfile.onStarted>>[0]) => {
        observed.push('onStarted');
        startedInstructions = start.instructions;
        return null;
      },
    };
    const catalog = { ...profileCatalog,
      builtInProfilesByIntent: new Map(profileCatalog.builtInProfilesByIntent).set('task', taskProfile) };
    const finalizeStartParamsForRuntime = async (params: ExecutionRunManagerStartParams, prepareRuntime: () => ExecutionRunHostRuntime) => {
      const backend = prepareRuntime();
      observed.push('prepare');
      expect([...controllers.values()].some(controller => controller.kind === 'backend' && controller.backend === backend)).toBe(true);
      return { ...params, instructions: 'prepared 😀', intentInput: { input: { prepared: true } } };
    };
    try {
      const started = await startExecutionRun({
        params: { sessionId: 'parent', intent: 'task', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'unprepared', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass, ioMode: 'request_response' },
        finalizeStartParamsForRuntime, profileCatalog: catalog,
        parentProvider: 'claude', streamedTranscriptSession: null,
        sendAcp: async (_provider, body) => {
          if (body.type !== 'tool-call') return;
          observed.push('publication');
          publishedInput = body.input;
        },
        createRuntime: options => { capturedStart = options.start; return runtime; },
        getNowMs: () => 1, budgetRegistry: null, runs, controllers,
        enqueueMarkerWrite: async (_id, write) => { await write(); }, writeActivityMarker: async () => {},
        finishRun: async () => { throw new Error('Preparation must succeed'); },
        executeBoundedRun: async ({ params }) => {
          observed.push('input');
          dispatchedInstructions = params.instructions;
        },
        enqueueRetainedRunInitialInput: async input => {
          observed.push('input');
          dispatchedInstructions = input.text;
          return { status: 'accepted', localId: input.localId };
        },
        send: async (_runId, input) => {
          observed.push('input');
          dispatchedInstructions = input.message;
          return { ok: true };
        }, voiceAgentManager,
      });
      const controller = controllers.get(started.runId);
      if (controller?.kind === 'backend') await controller.provisioningPromise;
      await vi.waitFor(() => expect(observed).toContain('input'));
      expect(observed).toEqual(runClass === 'bounded'
        ? ['prepare', 'publication', 'onStarted', 'provision', 'input']
        : mode === 'session_pending' ? ['prepare', 'publication', 'input', 'provision', 'onStarted']
        : ['prepare', 'publication', 'provision', 'onStarted', 'input']);
      expect(capturedStart?.intentInput).toEqual({ input: { prepared: true } });
      expect(startedInstructions).toBe('prepared 😀');
      expect(publishedInput).toMatchObject({ instructions: 'prepared 😀', intentInput: { input: { prepared: true } } });
      expect(dispatchedInstructions).toContain('prepared 😀');
      expect(dispatchedInstructions).not.toContain('unprepared');
      expect(runs.get(started.runId)?.instructions).toBe('prepared 😀');
    } finally { await runtime.dispose(); await voiceAgentManager.dispose(); }
  });

  it('settles a demanded context when profile finalization fails before provider effects', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const dispose = vi.fn(async () => {});
    const provisionRuntime = vi.fn(async () => ({ runtimeId: 'unexpected' }));
    const runtime = { ...createTestExecutionRunHostRuntime(), dispose, provisionRuntime };
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });
    const sendAcp = vi.fn(async () => {});
    try {
      const started = await startExecutionRun({
        params: { sessionId: 'parent', intent: 'task', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'unprepared', permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'bounded', ioMode: 'request_response' },
        finalizeStartParamsForRuntime: async (_params, prepareRuntime) => {
          prepareRuntime();
          throw new Error('Budget finalization refused');
        },
        parentProvider: 'claude', streamedTranscriptSession: null, sendAcp,
        createRuntime: () => runtime, getNowMs: () => 1, budgetRegistry: null, runs, controllers,
        enqueueMarkerWrite: async (_id, write) => { await write(); }, writeActivityMarker: async () => {},
        finishRun: async (runId, next) => { runs.set(runId, { ...runs.get(runId)!, ...next }); },
        executeBoundedRun: async () => { throw new Error('Refused preparation must not dispatch'); },
        send: async () => ({ ok: true }), voiceAgentManager,
      });
      expect(runs.get(started.runId)).toMatchObject({ status: 'failed', error: { message: 'Budget finalization refused' } });
      expect(controllers.has(started.runId)).toBe(false);
      expect(dispose).toHaveBeenCalledOnce();
      expect(provisionRuntime).not.toHaveBeenCalled();
      expect(sendAcp).not.toHaveBeenCalled();
    } finally { await voiceAgentManager.dispose(); }
  });
});
