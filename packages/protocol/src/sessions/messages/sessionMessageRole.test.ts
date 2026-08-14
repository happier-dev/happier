import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

describe('session message role schema', () => {
  it('accepts supported role metadata values', () => {
    const schema = protocol.SessionMessageRoleSchema;

    expect(schema.safeParse('user').success).toBe(true);
    expect(schema.safeParse('agent').success).toBe(true);
    expect(schema.safeParse('event').success).toBe(true);
    expect(schema.safeParse('unknown').success).toBe(true);
  });

  it('rejects unsupported role metadata values', () => {
    const schema = protocol.SessionMessageRoleSchema;

    expect(schema.safeParse('tool').success).toBe(false);
  });

  it('classifies ACP message aliases through the shared transcript body helper', () => {
    expect(protocol.resolveTranscriptBodySessionMessageRole({
      protocol: 'acp',
      body: { type: 'message', message: 'assistant text' },
    })).toBe('agent');
    expect(protocol.resolveTranscriptBodySessionMessageRole({
      protocol: 'acp',
      body: { type: 'agent_message', text: 'assistant text' },
    })).toBe('agent');
  });

  it('classifies Codex agent_message user overrides through the shared transcript body helper', () => {
    expect(protocol.resolveTranscriptBodySessionMessageRole({
      protocol: 'codex',
      body: { type: 'agent_message', text: 'assistant text' },
    })).toBe('agent');
    expect(protocol.resolveTranscriptBodySessionMessageRole({
      protocol: 'codex',
      body: { type: 'agent_message', role: 'user', text: 'user text' },
    })).toBe('user');
  });

  it('classifies canonical raw external-session bodies without host-side wrapper parsing', () => {
    expect(protocol.resolveTranscriptBodySessionMessageRole({
      protocol: 'acp',
      body: { type: 'text', text: 'assistant text' },
    })).toBe('agent');
    expect(protocol.resolveTranscriptBodySessionMessageRole({
      protocol: 'acp',
      body: {
        type: 'codex',
        data: { type: 'message', message: 'assistant text' },
      },
    })).toBe('agent');
    expect(protocol.resolveTranscriptBodySessionMessageRole({
      protocol: 'acp',
      body: {
        type: 'event',
        data: { type: 'tool-call', callId: 'call-1', name: 'read', input: {} },
      },
    })).toBe('event');
    expect(protocol.resolveTranscriptBodySemanticEvent({
      protocol: 'acp',
      body: { type: 'text', text: 'assistant text' },
    })).toEqual({
      role: 'agent',
      body: { type: 'message', message: 'assistant text' },
    });
  });
});
