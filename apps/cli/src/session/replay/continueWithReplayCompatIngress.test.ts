import { describe, expect, it } from 'vitest';

import { parseSessionContinueWithReplayRpcParamsCompatIngress } from './continueWithReplayCompatIngress';

describe('parseSessionContinueWithReplayRpcParamsCompatIngress', () => {
  it('normalizes a deployed bare replay model to the canonical backend target', () => {
    const parsed = parseSessionContinueWithReplayRpcParamsCompatIngress({
      directory: '/tmp/repo',
      agent: 'codex',
      modelId: 'legacy-native',
      modelUpdatedAt: 12,
      replay: { previousSessionId: 'previous' },
    });
    expect(parsed.success && parsed.data.modelSelection).toEqual({
      v: 1,
      updatedAt: 12,
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'legacy-native' },
    });
  });

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
    expect((parsed.data as { futureRpcFlag?: unknown }).futureRpcFlag).toBe('keep-me');
  });
});
