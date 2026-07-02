import { describe, expect, it } from 'vitest';

import { formatProviderPromptErrorMessage } from './formatProviderPromptErrorMessage';

describe('formatProviderPromptErrorMessage', () => {
  it('formats provider prompt errors without publishing local stack frames', () => {
    const error = new Error('OpenCode HTTP GET http://127.0.0.1:51235/session/ses_123 failed: 404 Not Found');
    error.stack = [
      `Error: ${error.message}`,
      '    at fetchJson (/Users/leeroy/Documents/Development/happier/dev/packages/plugins/opencode/src/agent/runtime/server/client.ts:107:11)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)',
    ].join('\n');

    const formatted = formatProviderPromptErrorMessage(error);

    expect(formatted).toContain('Error: OpenCode HTTP GET http://127.0.0.1:51235/session/ses_123 failed: 404 Not Found');
    expect(formatted).not.toContain('/Users/leeroy');
    expect(formatted).not.toContain('client.ts:107');
    expect(formatted).not.toContain('processTicksAndRejections');
  });

  it('redacts provider prompt error summaries before surfacing them', () => {
    const formatted = formatProviderPromptErrorMessage({
      message: 'Authorization: Bearer provider-secret-token',
      error: new Error('refresh_token=provider-refresh-token'),
    });

    expect(formatted).toContain('[REDACTED]');
    expect(formatted).not.toContain('provider-secret-token');
    expect(formatted).not.toContain('provider-refresh-token');
    expect(formatted).not.toContain('stack');
  });
});
