import { describe, expect, it } from 'vitest';

import {
  SessionContinueWithReplayRequestSchema,
  SessionContinueWithReplayRpcParamsSchema,
} from './continueWithReplay.js';

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
  it('carries provider-bound model selection without a bare model field', () => {
    const parsed = SessionContinueWithReplayRpcParamsSchema.parse({
      directory: '/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        updatedAt: 42,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_work', modelId: 'provider-model' },
      },
      replay: { previousSessionId: 'sess-prev' },
    });
    expect(parsed.modelSelection?.ref.providerConnectionId).toBe('pc_work');
    expect(parsed).not.toHaveProperty('modelId');
  });

  it('accepts additive backendTarget input without the legacy agent field', () => {
    const parsed = SessionContinueWithReplayRpcParamsSchema.safeParse({
      directory: '/repo',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects the legacy agent carrier on the canonical replay transport path', () => {
    const parsed = SessionContinueWithReplayRpcParamsSchema.safeParse({
      directory: '/repo',
      agent: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts V2 backendTarget input and preserves the canonical backend transport shape', () => {
    const parsed = SessionContinueWithReplayRpcParamsSchema.parse({
      directory: '/repo',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
    });

    expect(parsed.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });
  it('rejects missing backendTarget on the canonical replay transport path', () => {
    const parsed = SessionContinueWithReplayRpcParamsSchema.safeParse({
      directory: '/repo',
      replay: { previousSessionId: 'sess-prev' },
    });
    expect(parsed.success).toBe(false);
  });
});
