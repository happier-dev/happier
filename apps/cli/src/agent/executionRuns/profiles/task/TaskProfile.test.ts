import { describe, expect, it } from 'vitest';

import { TaskProfile } from './TaskProfile';

describe('TaskProfile', () => {
  it('keeps generic task output detached-safe and validates an optional strict JSON result schema', () => {
    expect(TaskProfile.supportsDetached).toBe(true);
    expect(TaskProfile.transcriptMaterialization).toBe('none');

    const valid = TaskProfile.onBoundedComplete({
      start: {
        sessionId: null,
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        intent: 'task',
        backendId: 'codex',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Return a summary.',
        intentInput: {
          resultSchema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
          },
        },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        startedAtMs: 1,
      },
      rawText: '{"summary":"done"}',
      finishedAtMs: 2,
    });
    expect(valid).toMatchObject({
      status: 'succeeded',
      toolResultOutput: { summary: 'done' },
    });

    const invalid = TaskProfile.onBoundedComplete({
      start: {
        sessionId: null,
        runId: 'run_2',
        callId: 'call_2',
        sidechainId: 'call_2',
        intent: 'task',
        backendId: 'codex',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Return a summary.',
        intentInput: {
          resultSchema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
          },
        },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        startedAtMs: 1,
      },
      rawText: '{"summary":42}',
      finishedAtMs: 2,
    });
    // AUTO-FIX-W16 item 4: a Haiku deploy_suggestion run failed invalid_output with nothing kept to say why. The
    // failure carries the decoder's reason and the schema pointers it failed at (schema words only, never the output).
    expect(invalid).toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('schema_mismatch'),
      toolResultOutput: { error: { code: 'invalid_output', reason: 'schema_mismatch',
        issues: [{ pointer: '/summary', message: expect.any(String) }] } },
    });
    expect(invalid.summary).not.toContain('42');
  });
});
