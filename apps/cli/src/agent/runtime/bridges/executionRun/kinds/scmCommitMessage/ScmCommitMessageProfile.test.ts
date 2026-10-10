import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1, AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { ExecutionRunScmCommitMessageResultV1Schema } from '@happier-dev/protocol/execution/runs/startRequest';
import { createLocalScmRepositoryFixture } from '@/scm/contracts/scmBackendContractFixtures';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunManagerStartParams, ExecutionRunState } from '../../executionRunTypes';
import type { FinishExecutionRun } from '../../executionRunFinishRun';
import { startExecutionRun } from '../../startExecutionRun';
import { executeBoundedBackendRun } from '../../bounded/loop';
import { createNativeAgentExecutionRunContextLeaseFactory, createNativeAgentExecutionRunHostRuntime } from '../../nativeAgentExecutionRun';
import { ScmCommitMessageProfile } from './ScmCommitMessageProfile';

it.each(['no_tools', 'yolo'])('prepares repository evidence and completes a detached no-tools native Run from %s input', async (permissionMode) => {
  const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-commit-native-' });
  const runs = new Map<string, ExecutionRunState>();
  const controllers = new Map<string, ExecutionRunController>();
  const opens: Array<{ request: AgentExecutionRunOpenRequest; context: AgentExecutionRunRuntimeContextV1 }> = [];
  const result = { title: 'fix: update tracked content', body: 'Explain the changed line.', message: 'fix: update tracked content\n\nExplain the changed line.', confidence: 0.9 };
  // The typed Agent SDK surface is the provider/model boundary; all host preparation,
  // native context composition, admission and completion remain real.
  const runtime: AgentRuntime = { executionRuns: { async open(request, context) {
    if (!('executionRun' in context)) throw new Error('Expected a detached execution context');
    opens.push({ request, context });
    return {
      async send() { return { status: 'admitted' as const }; },
      async stop() { return { status: 'requested' as const }; },
      watch(listener) {
        listener({ kind: 'output-delta', runId: request.runId, sequence: 1, emittedAtMs: Date.now(), channel: 'assistant', text: JSON.stringify(result) });
        listener({ kind: 'run-complete', runId: request.runId, sequence: 2, emittedAtMs: Date.now() });
        return { dispose() {} };
      },
      async dispose() {},
    };
  } } };
  const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Commit-message Runs must not create a Voice runtime'); } });
  let completed!: (value: unknown) => void;
  const completion = new Promise<unknown>(resolve => { completed = resolve; });
  const finishRun: FinishExecutionRun = async (runId, next, toolResult) => {
    const current = runs.get(runId);
    if (!current) throw new Error('Run state missing');
    runs.set(runId, { ...current, ...next });
    completed(toolResult.output);
  };
  const sendAcp: Parameters<typeof startExecutionRun>[0]['sendAcp'] = async () => { throw new Error('Detached Runs must not publish to a Session transcript'); };
  try {
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'native-commit-evidence\n');
    const request = {
      kind: 'scm_commit_message.v1' as const,
      intent: 'scm_commit_message' as const, backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
      instructions: '', intentInput: { instructions: 'Keep the title concise' }, permissionMode,
      retentionPolicy: 'ephemeral' as const, runClass: 'bounded' as const, ioMode: 'request_response' as const,
    };
    const prepared = await ScmCommitMessageProfile.prepareStartParams!({ sessionId: null, request, cwd: fixture.rootPath });
    expect(prepared).toMatchObject({ permissionMode: 'no_tools' });
    const params: ExecutionRunManagerStartParams = { ...request, ...prepared, sessionId: null, cwd: fixture.rootPath };
    const started = await startExecutionRun({
      params, parentProvider: 'claude', sendAcp, streamedTranscriptSession: null, getNowMs: Date.now,
      budgetRegistry: null, runs, controllers, voiceAgentManager, finishRun,
      // Marker publication is an injected OS persistence boundary; use the real writer.
      enqueueMarkerWrite: async (_id, write) => { await write(); }, writeActivityMarker: async () => {},
      send: async () => { throw new Error('A bounded Run must use its native input path'); },
      executeBoundedRun: args => executeBoundedBackendRun({ ...args, runs, controllers, sendAcp,
        parentProvider: 'claude', getNowMs: Date.now, boundedTimeoutMs: null, finishRun }),
      createRuntime: options => {
        if (!options.runId || !options.controllerOccurrenceId || !options.callId || !options.sidechainId || !options.start) throw new Error('Missing native Run identity');
        const lease = { pluginId: 'acme.commit', pluginVersion: '1.0.0', agentId: 'acme.commit/agents/default',
          localAgentId: 'default', occurrenceId: options.controllerOccurrenceId, isCurrent: () => true };
        return createNativeAgentExecutionRunHostRuntime({ runtime, lease, supportsResume: false,
          options: { ...options, cwd: fixture.rootPath, scope: 'detached' },
          createExecutionRunContext: createNativeAgentExecutionRunContextLeaseFactory({ lease,
            runId: options.runId, controllerOccurrenceId: options.controllerOccurrenceId, callId: options.callId,
            sidechainId: options.sidechainId, runtimeRegistry: null, directory: fixture.rootPath,
            machineId: 'native-commit-machine', accountSettings: null, permissionMode: options.permissionMode, start: options.start }),
        });
      },
    });
    expect(ExecutionRunScmCommitMessageResultV1Schema.parse(await completion)).toEqual(result);
    expect(runs.get(started.runId)).toMatchObject({ sessionId: null, scope: 'detached', status: 'succeeded', permissionMode: 'no_tools' });
    expect(opens).toHaveLength(1);
    expect(opens[0]?.request).toMatchObject({ kind: 'create', cwd: fixture.rootPath, profile: { pluginId: 'acme.commit', localId: 'scm_commit_message' } });
    if (opens[0]?.request.kind !== 'create') throw new Error('Expected native create');
    expect(opens[0].request.input.text).toContain('native-commit-evidence');
    expect(opens[0].request.input.text).toContain(fixture.trackedPath);
    expect(opens[0].request.input.text).toContain('Keep the title concise');
    expect(opens[0].context).toMatchObject({ scope: { kind: 'execution_run', executionRunId: started.runId } });
    expect(opens[0].context).not.toHaveProperty('session');
  } finally {
    await Promise.all([...controllers.values()].filter(controller => controller.kind === 'backend').map(controller => controller.backend.dispose()));
    await voiceAgentManager.dispose();
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});
