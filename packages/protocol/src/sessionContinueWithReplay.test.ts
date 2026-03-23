import { describe, expect, it } from 'vitest';

import { SessionContinueWithReplayRequestSchema, SessionContinueWithReplayRpcParamsSchema } from './sessionContinueWithReplay';

describe('SessionContinueWithReplayRequestSchema', () => {
  it('accepts transcript-hydrated replay request (no dialog)', () => {
    const parsed = SessionContinueWithReplayRequestSchema.safeParse({
      previousSessionId: 'sess-prev',
      strategy: 'recent_messages',
      recentMessagesCount: 16,
      seedMode: 'draft',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts larger recentMessagesCount values (bounded by server/seed budget)', () => {
    const parsed = SessionContinueWithReplayRequestSchema.safeParse({
      previousSessionId: 'sess-prev',
      strategy: 'recent_messages',
      recentMessagesCount: 500,
      seedMode: 'draft',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional maxSeedChars budget hint', () => {
    const parsed = SessionContinueWithReplayRequestSchema.safeParse({
      previousSessionId: 'sess-prev',
      strategy: 'recent_messages',
      recentMessagesCount: 100,
      maxSeedChars: 50_000,
      seedMode: 'draft',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional summary runner config for on-demand replay summary', () => {
    const parsed = SessionContinueWithReplayRequestSchema.safeParse({
      previousSessionId: 'sess-prev',
      strategy: 'summary_plus_recent',
      recentMessagesCount: 16,
      seedMode: 'draft',
      summaryRunner: {
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects legacy dialog field', () => {
    const parsed = SessionContinueWithReplayRequestSchema.safeParse({
      previousSessionId: 'sess-prev',
      dialog: [{ role: 'User', createdAt: 1, text: 'hi' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('SessionContinueWithReplayRpcParamsSchema', () => {
  it('rejects unknown top-level fields (no backward compatibility)', () => {
    const parsed = SessionContinueWithReplayRpcParamsSchema.safeParse({
      directory: '/repo',
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
      dialog: [{ role: 'User', createdAt: 1, text: 'should-not-be-here' }],
    });
    expect(parsed.success).toBe(false);
  });
});
