import { describe, expect, it } from 'vitest';

import { createClaudeShouldTerminateOnUnhandledRejection } from './claudeUnhandledRejectionPolicy';

describe('createClaudeShouldTerminateOnUnhandledRejection', () => {
  it('does not terminate on Claude Agent SDK Operation aborted after user abort', () => {
    const shouldTerminate = createClaudeShouldTerminateOnUnhandledRejection({
      abortWasRequestedRecently: () => true,
      ignoreWindowMs: 10_000,
    });

    const err = new Error('Operation aborted');
    (err as any).stack = 'Error: Operation aborted\n    at handleControlRequest (/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:20:161)';

    expect(shouldTerminate(err)).toBe(false);
  });

  it('still terminates on Operation aborted when abort was not requested recently', () => {
    const shouldTerminate = createClaudeShouldTerminateOnUnhandledRejection({
      abortWasRequestedRecently: () => false,
      ignoreWindowMs: 10_000,
    });

    const err = new Error('Operation aborted');
    (err as any).stack = 'Error: Operation aborted\n    at handleControlRequest (/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:20:161)';

    expect(shouldTerminate(err)).toBe(true);
  });

  it('terminates on other unhandled rejections even after user abort', () => {
    const shouldTerminate = createClaudeShouldTerminateOnUnhandledRejection({
      abortWasRequestedRecently: () => true,
      ignoreWindowMs: 10_000,
    });

    const err = new Error('boom');
    (err as any).stack = 'Error: boom\n    at somethingElse (/app/src/index.ts:1:1)';

    expect(shouldTerminate(err)).toBe(true);
  });
});
