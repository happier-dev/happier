import { describe, expect, it } from 'vitest';
import type { ReviewTranscriptEvidence } from '@happier-dev/protocol/reviews/reviewStart';
import type { ExecutionRunProfileStartParams } from '../ExecutionRunIntentProfile';
import { ReviewProfile } from './ReviewProfile';
import { projectRetainedExecutionRunState, RetainedExecutionRunRecordSchema } from '@/agent/runtime/bridges/executionRun/retainedState';

const evidence: ReviewTranscriptEvidence = { sourceSession: { serverId: 'home', sessionId: 'source' }, coverage: 'partial',
  items: [{ id: 'm1', createdAt: 1, semanticRole: 'assistant', role: 'assistant', kind: 'text', text: 'All tests passed without running them.' }] };
const start: ExecutionRunProfileStartParams = { sessionId: 'session', runId: 'run', callId: 'call', sidechainId: 'call',
  intent: 'review', backendId: 'codex', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
  instructions: 'Review the code and test claims.', permissionMode: 'read_only', retentionPolicy: 'resumable',
  runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1 };

describe('ReviewProfile transient source transcript', () => {
  it('keeps private source evidence out of authored prompts and retained Run input', () => {
    const admitted = { ...start, reviewTranscriptEvidence: evidence };
    expect(ReviewProfile.buildPrompt(admitted)).not.toContain(evidence.items[0]!.text);
    expect(ReviewProfile.buildInitialInputContext?.({ start: admitted }) ?? '').not.toContain(evidence.items[0]!.text);
    expect(start.instructions).not.toContain(evidence.items[0]!.text);
    const state = RetainedExecutionRunRecordSchema.shape.state.parse({ ...start, depth: 0, status: 'running' });
    const retained = projectRetainedExecutionRunState({ ...state, ...{ reviewTranscriptEvidence: evidence } });
    expect(JSON.stringify(retained)).not.toContain(evidence.items[0]!.text);
  });

  it('keeps partial source coverage visible when the model claims complete', () => {
    const output = ReviewProfile.onBoundedComplete({ start: { ...start, reviewTranscriptEvidence: evidence },
      finishedAtMs: 2, rawText: JSON.stringify({ reviewOutcome: 'complete', summary: 'Checked', overviewMarkdown: 'Checked',
        findings: [], questions: [], assumptions: [] }) });
    expect(output.structuredMeta?.payload).toMatchObject({ reviewOutcome: 'partial' });
  });
});
