import { describe, expect, it } from 'vitest';

import type { ExecutionRunIntent } from '@happier-dev/protocol';
import {
  registerTranscriptSecret,
  TRANSCRIPT_SECRET_REDACTED as R,
} from '@/api/session/client/transport/transcriptSecretRedaction';
import { parseDiffSummaryModelOutput } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/parseDiffSummaryModelOutput';
import type { ExecutionRunProfileStartParams } from './ExecutionRunIntentProfile';
import { resolveExecutionRunIntentProfile } from './intentRegistry';

// Each profile decodes the Agent's raw output first and masks only what the Agent authored.
function complete(
  intent: ExecutionRunIntent,
  rawText: string,
  start: Partial<ExecutionRunProfileStartParams> = {},
) {
  const releases = ['native', 'postgres', '1', 'secret', 'true'].map(
    registerTranscriptSecret,
  );
  try {
    return resolveExecutionRunIntentProfile(intent).onBoundedComplete({
      start: {
        sessionId: null,
        runId: 'run-1',
        callId: 'call-1',
        sidechainId: 'side-1',
        intent,
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Do it.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        startedAtMs: 1,
        ...start,
      },
      rawText,
      finishedAtMs: 2,
    });
  } finally {
    releases.forEach((release) => release());
  }
}

describe('Execution Run profile output redaction', () => {
  const schema = {
    type: 'object',
    required: ['line', 'note'],
    properties: { line: { type: 'integer' }, note: { type: 'string' } },
  } as const;

  it.each([
    ['agent', { resultContract: { kind: 'json', schema } }],
    ['task', { intentInput: { resultSchema: schema } }],
  ] as const)(
    '%s keeps a decoded JSON result typed and masks its strings',
    (intent, start) => {
      const completion = complete(
        intent,
        '{"line":12,"note":"connect with postgres"}',
        start,
      );
      expect(completion.status).toBe('succeeded');
      expect(completion.toolResultOutput).toEqual({
        line: 12,
        note: `connect with ${R}`,
      });
      expect(JSON.stringify(completion)).not.toContain('postgres');
    },
  );

  it.each(['agent', 'task', 'memory_hints', 'voice_agent'] as const)(
    '%s masks plain text output as text',
    (intent) => {
      const completion = complete(intent, 'use postgres with the secret');
      expect(JSON.stringify(completion)).not.toMatch(/postgres|the secret/u);
      expect(JSON.stringify(completion)).toContain(`use ${R} with the ${R}`);
    },
  );

  it('keeps plan structure and masks its prose', () => {
    const completion = complete(
      'plan',
      JSON.stringify({
        summary: 'Move to postgres',
        sections: [{ title: 'Step 1', items: ['dump the secret'] }],
      }),
    );
    expect(completion.status).toBe('succeeded');
    expect(completion.structuredMeta?.payload).toMatchObject({
      runRef: { runId: 'run-1', callId: 'call-1' },
      summary: `Move to ${R}`,
      sections: [{ title: `Step ${R}`, items: [`dump the ${R}`] }],
    });
  });

  it('keeps delegate deliverable ids exact and masks their prose', () => {
    const completion = complete(
      'delegate',
      JSON.stringify({
        summary: 'Set up postgres',
        deliverables: [{ id: 'd1', title: 'postgres role' }],
      }),
    );
    expect(completion.structuredMeta?.payload).toMatchObject({
      runRef: { runId: 'run-1' },
      summary: `Set up ${R}`,
      deliverables: [{ id: 'd1', title: `${R} role` }],
    });
  });

  it('masks a commit message after decoding it', () => {
    const completion = complete(
      'scm_commit_message',
      JSON.stringify({
        title: 'Fix postgres pool',
        body: 'Rotate the secret',
        confidence: 1,
      }),
    );
    expect(completion.toolResultOutput).toEqual({
      title: `Fix ${R} pool`,
      body: `Rotate the ${R}`,
      message: `Fix ${R} pool\n\nRotate the ${R}`,
      confidence: 1,
    });
  });

  it('keeps diff summary references exact and masks its prose', () => {
    const releases = ['postgres', '1'].map(registerTranscriptSecret);
    try {
      expect(
        parseDiffSummaryModelOutput(
          JSON.stringify({
            summaryMarkdown: 'Adds postgres',
            walkthrough: {
              title: 'postgres',
              intro: '',
              stops: [
                {
                  id: 'stop-1',
                  title: 'Pool',
                  explanationMarkdown: 'Opens postgres',
                  changeRefs: ['change-1'],
                  captions: [
                    {
                      changeRef: 'change-1',
                      side: 'after',
                      startLine: 1,
                      endLine: 1,
                      text: 'postgres here',
                    },
                  ],
                },
              ],
              otherChangeRefs: ['change-2'],
            },
            commitPlan: {
              groups: [
                {
                  id: 'group-1',
                  message: 'postgres',
                  rationale: '',
                  changeRefs: ['change-1'],
                },
              ],
              leftOutChangeRefs: [],
            },
          }),
        ),
      ).toEqual({
        summaryMarkdown: `Adds ${R}`,
        walkthrough: {
          title: R,
          intro: '',
          stops: [
            {
              id: 'stop-1',
              title: 'Pool',
              explanationMarkdown: `Opens ${R}`,
              changeRefs: ['change-1'],
              captions: [
                {
                  changeRef: 'change-1',
                  side: 'after',
                  startLine: 1,
                  endLine: 1,
                  text: `${R} here`,
                },
              ],
            },
          ],
          otherChangeRefs: ['change-2'],
        },
        commitPlan: {
          groups: [
            {
              id: 'group-1',
              message: R,
              rationale: '',
              changeRefs: ['change-1'],
            },
          ],
          leftOutChangeRefs: [],
        },
      });
    } finally {
      releases.forEach((release) => release());
    }
  });
});
