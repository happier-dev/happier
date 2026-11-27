import { expect, it } from 'vitest';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { ReviewModelOutputV1Schema } from '@happier-dev/protocol/reviews/reviewModelOutputV1';
import type { AgentExecutionRunEvent, AgentExecutionRunRuntimeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { createClawpatchProcessFixture } from '../../../../../../packages/plugins/review-slices/src/agent/reviews/run.testkit';
import { createClawpatchExecutionRunFactory } from '../../../../../../packages/plugins/review-slices/src/agent/reviews/execution';
import { ReviewProfile } from '../../executionRuns/profiles/review/ReviewProfile';
import type { ExecutionRunProfileStartParams } from '../../executionRuns/profiles/ExecutionRunIntentProfile';

it('builds native review schemas without changing the shared projection and retains native clawpatch findings', async () => {
  const shared = zodSchemaToJsonSchemaObject(ReviewModelOutputV1Schema, { target: 'draft-7' });
  const original = JSON.stringify(shared);
  const start = {
    sessionId: null, runId: 'native-quality', callId: 'native-quality', sidechainId: 'native-quality',
    intent: 'review', backendId: 'clawpatch', backendTarget: { kind: 'builtInAgent', agentId: 'clawpatch' },
    instructions: 'Review', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
    ioMode: 'request_response', startedAtMs: 1,
  } satisfies ExecutionRunProfileStartParams;
  const native = ReviewProfile.buildNativeOutputSchema!(start);
  expect(native).toMatchObject({ required: expect.arrayContaining(['quality']),
    properties: { quality: { anyOf: [expect.any(Object), { type: 'null' }] } } });
  expect(ReviewProfile.buildNativeOutputSchema!(start)).toEqual(native);
  expect(JSON.stringify(shared)).toBe(original);

  const f = await createClawpatchProcessFixture();
  // Only the native process/filesystem services are replaced; plugin execution and host normalization stay real.
  const context = { agent: { id: 'clawpatch' }, signal: f.controller.signal,
    services: { exec: f.exec, fs: { getPluginDataDirectory: async () => f.state } } } as unknown as AgentExecutionRunRuntimeContextV1;
  const runtime = await createClawpatchExecutionRunFactory().open({ kind: 'create', runId: 'native-quality', cwd: f.directory,
    profile: { pluginId: 'happier.review.clawpatch', localId: 'review' },
    input: { text: 'Review', structuredInput: { scope: 'repository', engines: {},
      scmReviewScope: { scope: 'repository', status: 'supported', worktreeRoot: f.directory } } },
  }, context);
  let rawText = '';
  try {
    const terminal = await new Promise<AgentExecutionRunEvent>(resolve => runtime.watch(event => {
      if (event.kind === 'output-delta' && event.channel === 'assistant') rawText += event.text;
      if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve(event);
    }));
    expect(terminal.kind).toBe('run-complete');
    const result = ReviewProfile.onBoundedComplete({ start, rawText, finishedAtMs: 2 });
    expect(result).toMatchObject({ status: 'succeeded', structuredMeta: { kind: 'review_findings.v2',
      payload: { reviewOutcome: 'complete', findings: [expect.objectContaining({ title: 'Defect one' }),
        expect.objectContaining({ title: 'Defect two' })] } } });
  } finally { await runtime.dispose(); }
});
