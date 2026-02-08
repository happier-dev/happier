import { describe, expect, it } from 'vitest';

import { extractFatalAgentErrorMessage } from '../../src/testkit/providers/harness';

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
});
