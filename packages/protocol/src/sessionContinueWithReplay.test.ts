import { describe, expect, it } from 'vitest';

import {
  SessionContinueWithReplayRequestSchema,
  SessionContinueWithReplayRpcParamsSchema,
} from './sessionContinueWithReplay';
import { parseSessionContinueWithReplayRpcParamsCompatIngress } from './sessionContinueWithReplayCompat';

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

describe('parseSessionContinueWithReplayRpcParamsCompatIngress', () => {
  it('normalizes legacy agent-only replay params into canonical backendTarget input', () => {
    const parsed = parseSessionContinueWithReplayRpcParamsCompatIngress({
      directory: '/repo',
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw parsed.error;
    }
    expect(parsed.data).toMatchObject({
      directory: '/repo',
      backendTarget: {
        kind: 'backend',
        backendId: 'claude',
        sourceKind: 'built_in',
      },
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
    });
  });

  it('normalizes legacy configured ACP replay params into canonical backendTarget input', () => {
    const parsed = parseSessionContinueWithReplayRpcParamsCompatIngress({
      directory: '/repo',
      agent: 'acp:review-bot',
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw parsed.error;
    }
    expect(parsed.data).toMatchObject({
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
  });

  it('rejects ambiguous customAcp replay params without a concrete backendTarget', () => {
    const parsed = parseSessionContinueWithReplayRpcParamsCompatIngress({
      directory: '/repo',
      agent: 'customAcp',
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects nested customAcp placeholders inside configured ACP replay carriers', () => {
    const parsed = parseSessionContinueWithReplayRpcParamsCompatIngress({
      directory: '/repo',
      agent: 'acp:customAcp',
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects mismatched legacy agent and backendTarget combinations', () => {
    const parsed = parseSessionContinueWithReplayRpcParamsCompatIngress({
      directory: '/repo',
      agent: 'claude',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects backendTarget values that use the customAcp family placeholder as a concrete backend', () => {
    const parsed = parseSessionContinueWithReplayRpcParamsCompatIngress({
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
    });
    expect(parsed.success).toBe(false);
  });

  it('preserves additive top-level transport fields in replay params', () => {
    const parsed = parseSessionContinueWithReplayRpcParamsCompatIngress({
      directory: '/repo',
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: { previousSessionId: 'sess-prev' },
      futureRpcFlag: 'keep-me',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw parsed.error;
    }
    expect((parsed.data as any).futureRpcFlag).toBe('keep-me');
  });
});
