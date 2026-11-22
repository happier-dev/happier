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
        issue: { schemaPath: '#/properties/summary/type', keyword: 'type', message: expect.any(String) } } },
    });
    expect(invalid.summary).not.toContain('42');
  });

  it('keeps only the schema side of a refused result: a key the model wrote is never stored (REVIEW-DELTA7 F2)', () => {
    const invalid = TaskProfile.onBoundedComplete({
      start: {
        sessionId: null,
        runId: 'run_3',
        callId: 'call_3',
        sidechainId: 'call_3',
        intent: 'task',
        backendId: 'codex',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Return a summary.',
        intentInput: {
          resultSchema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
            additionalProperties: false,
          },
        },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        startedAtMs: 1,
      },
      // Every issue AJV collects (allErrors) would name a model-written key or a value.
      rawText: '{"model_invented_key":1,"another_invented_key":2}',
      finishedAtMs: 2,
    });
    expect(invalid).toMatchObject({
      status: 'failed',
      toolResultOutput: { error: { code: 'invalid_output', reason: 'schema_mismatch',
        issue: { schemaPath: '#/required', keyword: 'required' } } },
    });
    const kept = JSON.stringify(invalid);
    expect(kept).not.toContain('model_invented_key');
    expect(kept).not.toContain('another_invented_key');
  });
});
