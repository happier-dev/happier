import { describe, expect, it } from 'vitest';

import { AgentProfile } from './AgentProfile';

const start = {
  sessionId: null,
  runId: 'run_agent_1',
  callId: 'call_agent_1',
  sidechainId: 'call_agent_1',
  intent: 'agent' as const,
  backendId: 'codex',
  backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
  instructions: 'Implement the requested change.',
  permissionMode: 'workspace_write',
  retentionPolicy: 'resumable' as const,
  runClass: 'bounded' as const,
  ioMode: 'request_response' as const,
  startedAtMs: 1,
};

describe('AgentProfile', () => {
  it('exposes general detached execution without delegate output semantics', () => {
    expect(AgentProfile).toMatchObject({
      intent: 'agent',
      transcriptMaterialization: 'completion',
    });
    expect(AgentProfile.supportsDetached).toBe(true);
    expect(AgentProfile.buildPrompt(start)).toBe('Implement the requested change.');
  });

  it('returns exact text when no structured result was requested', () => {
    expect(AgentProfile.onBoundedComplete({
      start,
      rawText: '  exact final text  ',
      finishedAtMs: 2,
    })).toEqual({
      status: 'succeeded',
      summary: '  exact final text  ',
      toolResultOutput: '  exact final text  ',
    });
  });

  it('validates a declared strict JSON result without a delegate wrapper', () => {
    const resultSchema = {
      type: 'object' as const,
      properties: { changed: { type: 'boolean' as const } },
      required: ['changed'],
      additionalProperties: false,
    };
    const structuredStart = {
      ...start,
      intentInput: { input: { file: 'src/index.ts' }, resultSchema },
    };

    expect(AgentProfile.buildPrompt(structuredStart)).toContain('Task input (strict JSON):');
    expect(AgentProfile.onBoundedComplete({
      start: structuredStart,
      rawText: '{"changed":true}',
      finishedAtMs: 2,
    })).toMatchObject({
      status: 'succeeded',
      toolResultOutput: { changed: true },
    });
    expect(AgentProfile.onBoundedComplete({
      start: structuredStart,
      rawText: '{"changed":"yes"}',
      finishedAtMs: 2,
    })).toMatchObject({
      status: 'failed',
      toolResultOutput: { error: { code: 'invalid_output' } },
    });
  });
});
