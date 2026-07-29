import { describe, expect, it } from 'vitest';

import { resolveContinueWithReplayBackendTarget } from './resolveContinueWithReplayBackendTarget';

describe('resolveContinueWithReplayBackendTarget', () => {
  it('resolves built-in replay targets from legacy agent-only input', () => {
    expect(resolveContinueWithReplayBackendTarget({ agent: 'claude' })).toMatchObject({
      ok: true,
      backendTargetV2: {
        kind: 'backend',
        backendId: 'claude',
        sourceKind: 'built_in',
      },
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      replayFlavor: 'claude',
      agentHintAgentId: 'claude',
    });
  });

  it('resolves configured ACP replay targets with a legacy customAcp hint', () => {
    expect(
      resolveContinueWithReplayBackendTarget({
        agent: 'customAcp',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      }),
    ).toMatchObject({
      ok: true,
      backendTargetV2: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      replayFlavor: 'acp:review-bot',
      agentHintAgentId: 'acp:review-bot',
    });
  });

  it('resolves configured ACP replay targets from canonical V2 backend input', () => {
    expect(
      resolveContinueWithReplayBackendTarget({
        backendTarget: {
          kind: 'backend',
          backendId: 'review-bot',
          configuredBackendId: 'review-bot',
          sourceKind: 'configured',
        },
      }),
    ).toMatchObject({
      ok: true,
      backendTargetV2: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      replayFlavor: 'acp:review-bot',
      agentHintAgentId: 'acp:review-bot',
    });
  });

  it('resolves configured ACP replay targets from legacy agent-only acp:<backendId> input', () => {
    expect(resolveContinueWithReplayBackendTarget({ agent: 'acp:review-bot' })).toMatchObject({
      ok: true,
      backendTargetV2: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      replayFlavor: 'acp:review-bot',
      agentHintAgentId: 'acp:review-bot',
    });
  });

  it('rejects customAcp replay requests without a backendTarget', () => {
    expect(resolveContinueWithReplayBackendTarget({ agent: 'customAcp' })).toEqual({
      ok: false,
      errorMessage: 'backendTarget is required for customAcp',
    });
  });

  it('rejects mismatched legacy agent and backendTarget pairs', () => {
    expect(
      resolveContinueWithReplayBackendTarget({
        agent: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      }),
    ).toEqual({
      ok: false,
      errorMessage: 'agent must match backendTarget',
    });
  });

  it('rejects backendTarget values that use customAcp as a concrete built-in backend', () => {
    expect(
      resolveContinueWithReplayBackendTarget({
        backendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
      }),
    ).toEqual({
      ok: false,
      errorMessage: 'Unknown agent id',
    });
  });
});
