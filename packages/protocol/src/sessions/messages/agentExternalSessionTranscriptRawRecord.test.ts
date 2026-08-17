import { describe, expect, it } from 'vitest';

import { TranscriptRawRecordV1Schema } from './transcriptRawRecordV1';
import { AgentExternalSessionTranscriptRawRecordSchema } from './agentExternalSessionTranscriptRawRecord';
import * as agentExternalSessionTranscriptRawRecord from './agentExternalSessionTranscriptRawRecord';

describe('AgentExternalSessionTranscriptRawRecordSchema', () => {
  it('owns one closed user-projection classification beside the strict raw envelope', () => {
    const schema = Reflect.get(
      agentExternalSessionTranscriptRawRecord,
      'ExternalSessionUserProjectionSchema',
    ) as Readonly<{ safeParse(value: unknown): Readonly<{ success: boolean }> }>;

    expect(schema).toHaveProperty('safeParse');
    for (const value of ['source_fact', 'terminal_origin', 'host_prompt_echo']) {
      expect(schema.safeParse(value).success).toBe(true);
    }
    expect(schema.safeParse('guessed_from_text').success).toBe(false);
  });

  it('admits exact current Agent user and agent envelopes', () => {
    expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse({
      role: 'user',
      content: { type: 'text', text: 'hello' },
    }).success).toBe(true);
    expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse({
      role: 'agent',
      content: {
        type: 'acp',
        agentId: 'claude',
        data: { type: 'message', message: 'done' },
      },
    }).success).toBe(true);
  });

  it.each(['output', 'event', 'codex', 'acp'] as const)(
    'admits the canonical %s agent wrapper',
    (type) => {
      const content = type === 'acp'
        ? { type, agentId: 'acme.agent', data: { type: 'message', message: 'done' } }
        : type === 'event'
          ? { type, id: 'event-1', data: { type: 'message', message: 'done' } }
          : { type, data: { type: 'message', message: 'done' } };

      expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse({
        role: 'agent',
        content,
      }).success).toBe(true);
    },
  );

  it.each([
    {
      role: 'user',
      content: { type: 'text', text: 'hello' },
      meta: { provider: 'legacy' },
    },
    {
      role: 'user',
      content: { type: 'text', text: 'hello', providerTag: 'legacy' },
    },
    {
      role: 'agent',
      content: { type: 'provider-native-unknown', payload: true },
    },
    {
      role: 'agent',
      content: { type: 'message', message: 'bare semantic body' },
    },
    {
      role: 'agent',
      content: { type: 'acp', data: { type: 'message', message: 'missing agent identity' } },
    },
  ])('rejects non-canonical current Agent output %#', (value) => {
    expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(value).success).toBe(false);
  });

  it('keeps persisted transcript compatibility in its existing permissive reader', () => {
    const persisted = {
      role: 'user',
      content: { type: 'text', text: 'hello', providerTag: 'legacy' },
      meta: { provider: 'legacy' },
    };

    expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(persisted).success).toBe(false);
    expect(TranscriptRawRecordV1Schema.safeParse(persisted).success).toBe(true);
  });
});
