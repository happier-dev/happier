import { describe, expect, it } from 'vitest';

import {
  extractFatalAgentErrorMessage,
  formatFatalProviderAssistantError,
} from '../../src/testkit/providers/harness';

describe('providers harness: fatal agent error extraction', () => {
  it('extracts authentication-required assistant errors', () => {
    const out = extractFatalAgentErrorMessage([
      {
        role: 'assistant',
        content: {
          type: 'text',
          text: 'Error: Authentication required\n\nKimi appears not configured.',
        },
      },
    ]);

    expect(out).toContain('Authentication required');
  });

  it('ignores non-assistant messages', () => {
    const out = extractFatalAgentErrorMessage([
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Error: Authentication required',
        },
      },
    ]);

    expect(out).toBeNull();
  });

  it('ignores assistant messages that are not explicit errors', () => {
    const out = extractFatalAgentErrorMessage([
      {
        role: 'assistant',
        content: {
          type: 'text',
          text: 'Authentication required in provider docs means users must configure credentials.',
        },
      },
    ]);

    expect(out).toBeNull();
  });

  it('extracts explicit errors from serialized transcript wrapper values', () => {
    const out = extractFatalAgentErrorMessage([
      {
        __happierSerializedJsonValueV1: true,
        type: 'json',
        value: {
          role: 'agent',
          content: {
            type: 'acp',
            data: {
              type: 'message',
              message: 'Error: Authentication required\\n\\nOpenCode appears not configured.',
            },
          },
        },
      },
    ]);

    expect(out).toContain('Authentication required');
  });

  it('adds auth prerequisite guidance for OpenCode token refresh 401 in host-auth mode', () => {
    const out = formatFatalProviderAssistantError({
      providerId: 'opencode',
      scenarioId: 'execute_trace_ok',
      fatal: 'Error: Token refresh failed: 401',
      env: {},
    });

    expect(out).toContain('Token refresh failed: 401');
    expect(out).toContain('opencode auth login');
    expect(out).toContain('OPENAI_API_KEY');
  });

  it('does not add host-auth guidance when OPENAI_API_KEY env auth is set', () => {
    const out = formatFatalProviderAssistantError({
      providerId: 'opencode_server',
      scenarioId: 'execute_trace_ok',
      fatal: 'Error: Token refresh failed: 401',
      env: { OPENAI_API_KEY: 'set' },
    });

    expect(out).not.toContain('opencode auth login');
    expect(out).not.toContain('OPENAI_API_KEY');
  });
});
