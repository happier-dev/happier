import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadConfiguration } from '@/configuration';
import { ExecutionRunStartRequestSchema, type ExecutionRunVoiceAgentIntentInputV1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import { startExecutionRun } from '@/agent/runtime/bridges/executionRun/startExecutionRun';
import { ensureExecutionRun } from '@/agent/runtime/bridges/executionRun/ensureExecutionRun';
import { projectExecutionRunPublicState } from '@/agent/runtime/bridges/executionRun/publicState';
import { resolveExecutionRunRuntimeBackendTarget } from '@/agent/runtime/bridges/executionRun/backendTargets';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from './VoiceAgentManager';

// CLI's static imports also reach Sync-client. Register the external Socket
// boundary before either package imports it, using the UI's canonical fixture.
vi.mock('socket.io-client', async (importOriginal) => {
  const boundaryPath = new URL('../../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness.ts', import.meta.url).href;
  const boundary = await import(boundaryPath);
  return boundary.createSocketIoClientBoundary(importOriginal);
});

type UiHandle = Readonly<{ voiceAgentId: string; voicePolicy?: ExecutionRunVoiceAgentIntentInputV1['voicePolicy'] }>;
type UiHarness = Readonly<{
  sessionId: string;
  handle: UiHandle;
  welcome(): Promise<void>;
  hydrateAfterSettingsChange(): Promise<UiHandle>;
  dispose(): Promise<void>;
}>;
type UiHarnessModule = Readonly<{ prepareStandaloneVoicePolicyHarness(): Promise<void>; createStandaloneVoicePolicyHarness(params: Readonly<{
  mode: 'off' | 'immediate' | 'on_first_turn';
  dispatch: (method: string, input: unknown) => Promise<unknown>;
}>): Promise<UiHarness> }>;

// Runtime import keeps UI aliases and globals out of the CLI compilation.
const uiHarnessPath = new URL('../../../../../ui/sources/dev/testkit/harness/standaloneVoicePolicyHarness.ts', import.meta.url).href;
const uiModule: UiHarnessModule = await import(uiHarnessPath);
await uiModule.prepareStandaloneVoicePolicyHarness();

describe('standalone Local Voice policy from UI admission to provider input', () => {
  let directory: string;
  let ui: UiHarness | undefined;
  let manager: VoiceAgentManager | undefined;
  beforeEach(() => {
    ui = undefined;
    manager = undefined;
    directory = mkdtempSync(join(tmpdir(), 'happier-voice-policy-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
  });
  afterEach(async () => {
    await manager?.dispose();
    await ui?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    reloadConfiguration();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['off', 'immediate', 'on_first_turn'] as const)('consumes French reply and %s greeting policy through the real initializer and daemon launch', async (mode) => {
    const prompts: string[] = [];
    const welcomeRequests: unknown[] = [];
    let retainedReadsUnavailable = false;
    let ensuredWithoutPolicyRead: string | undefined;
    let runtimeIndex = 0;
    const createRuntime = () => {
      runtimeIndex += 1;
      let releaseCancelled: (() => void) | undefined;
      const runtime = createTestExecutionRunHostRuntime({ runtimeId: `voice-runtime-${runtimeIndex}`,
        providerSessionId: `voice-provider-${runtimeIndex}`, resumeSupported: true,
        async onSendPrompt(_id, prompt) {
        prompts.push(prompt);
        if (prompt.includes('Annule cette demande.')) {
          await new Promise<void>((resolve) => { releaseCancelled = resolve; });
          return;
        }
        runtime.emitMessage({ type: 'model-output', fullText: prompt.includes('reply with exactly READY') ? 'READY' : 'Bonjour.' });
        runtime.emitMessage({ type: 'status', status: 'idle' });
      }, onCancel() { releaseCancelled?.(); } });
      return runtime;
    };
    manager = new VoiceAgentManager({ createRuntime });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const activeManager = manager;
    const dispatch = async (method: string, input: unknown) => {
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START) {
        const envelope = input as { start: unknown; runId?: string; resume?: boolean };
        if (envelope.runId) {
          if (retainedReadsUnavailable) ensuredWithoutPolicyRead = envelope.runId;
          const ensured = await ensureExecutionRun({ runId: envelope.runId, params: { resume: envelope.resume }, runs, controllers,
            budgetRegistry: null, voiceAgentManager: activeManager, createRuntime,
            sendAcp: async () => {}, parentProvider: 'claude', streamedTranscriptSession: null,
            getNowMs: Date.now, writeActivityMarker: async () => {} });
          if (!ensured.ok) return ensured;
          return { ok: true, runId: envelope.runId, created: false, resumed: true };
        }
        const request = ExecutionRunStartRequestSchema.parse(envelope.start);
        const backendTarget = resolveExecutionRunRuntimeBackendTarget(request.backendTarget);
        if (!backendTarget) throw new Error('Voice launch did not resolve a catalog-owned runtime target');
        const started = await startExecutionRun({ params: { ...request, backendTarget, sessionId: 'voice-parent' }, parentProvider: 'claude',
          sendAcp: async () => {}, streamedTranscriptSession: null, createRuntime,
          getNowMs: Date.now, budgetRegistry: null, runs, controllers,
          enqueueMarkerWrite: async (_id, write) => write(), writeActivityMarker: async () => {}, finishRun: async () => {},
          executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager: activeManager });
        return { ok: true, runId: started.runId, created: true, resumed: false };
      }
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION) {
        welcomeRequests.push(input);
        const action = input as { runId: string; input?: { welcomeText?: string } };
        return { ok: true, result: await activeManager.welcome({ voiceAgentId: action.runId, welcomeText: action.input?.welcomeText }) };
      }
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) {
        if (retainedReadsUnavailable) throw new Error('Home run-list transport unavailable');
        return { runs: [...runs.values()].map((run) => projectExecutionRunPublicState(run, controllers.get(run.runId) ?? null)) };
      }
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) {
        if (retainedReadsUnavailable) throw new Error('Home run-get transport unavailable');
        const runId = (input as { runId: string }).runId;
        const run = runs.get(runId);
        return run ? { run: projectExecutionRunPublicState(run, controllers.get(runId) ?? null) }
          : { ok: false, error: 'Not found', errorCode: 'execution_run_not_found' };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    };
    ui = await uiModule.createStandaloneVoicePolicyHarness({ mode, dispatch });
    const handle = ui.handle;
    expect(handle.voicePolicy).toEqual({ assistantLanguage: 'fr-FR', welcome: {
      enabled: mode !== 'off', mode: mode === 'on_first_turn' ? mode : 'immediate',
    } });
    const hydrated = await ui.hydrateAfterSettingsChange();
    expect(hydrated.voiceAgentId).toBe(handle.voiceAgentId);
    expect(hydrated.voicePolicy).toEqual(handle.voicePolicy);
    // A changed Account preference cannot suppress the adopted run's immediate
    // welcome or replace its admitted reply language before its first turn.
    await ui.welcome();
    if (mode === 'immediate') expect(welcomeRequests).toEqual([{
      runId: handle.voiceAgentId, actionId: 'voice_agent.welcome',
      input: { welcomeText: 'Bonjour, je vous écoute — que souhaitez-vous faire ?' },
    }]);
    else expect(welcomeRequests).toEqual([]);
    if (mode !== 'immediate') expect(prompts.filter((prompt) => !prompt.includes('reply with exactly READY'))).toEqual([]);
    await activeManager.sendTurn({ voiceAgentId: handle.voiceAgentId, userText: 'Explique le projet.' });
    const policyPrompt = prompts[0];
    expect(policyPrompt).toContain('Reply in fr-FR.');
    expect(policyPrompt?.includes('On your first reply to the user')).toBe(mode === 'on_first_turn');
    if (mode === 'off') expect(prompts[0]).toContain('Do not add greeting filler');
    if (mode === 'immediate') {
      expect(policyPrompt).toContain('exactly this message:');
      expect(policyPrompt).not.toContain('what we are working on today');
    }
    const cancelled = await activeManager.startTurnStream({ voiceAgentId: handle.voiceAgentId, userText: 'Annule cette demande.' });
    await vi.waitFor(() => expect(prompts.at(-1)).toContain('Annule cette demande.'));
    await activeManager.cancelTurnStream({ voiceAgentId: handle.voiceAgentId, streamId: cancelled.streamId });
    await activeManager.sendTurn({ voiceAgentId: handle.voiceAgentId, userText: 'Reprends la conversation.' });
    const reseeded = prompts.at(-1);
    expect(reseeded).toContain('Reply in fr-FR.');
    expect(reseeded).not.toContain('Reply in de-DE.');
    expect(reseeded).toContain('Explique le projet.');
    expect(reseeded).not.toContain('Annule cette demande.');
    expect(reseeded).not.toContain('On your first reply to the user');
    if (mode === 'immediate') {
      retainedReadsUnavailable = true;
      await expect(ui.hydrateAfterSettingsChange()).rejects.toMatchObject({ code: 'VOICE_AGENT_POLICY_UNAVAILABLE' });
      expect(ensuredWithoutPolicyRead).toBe(handle.voiceAgentId);
      // Refusing an unproved UI policy must leave the retained daemon Run usable.
      await expect(activeManager.sendTurn({ voiceAgentId: handle.voiceAgentId, userText: 'Continue.' }))
        .resolves.toMatchObject({ assistantText: 'Bonjour.' });
    }
  });
});
