import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

import { resolveContinueWithReplayBackendTarget } from './resolveContinueWithReplayBackendTarget';

describe('resolveContinueWithReplayBackendTarget', () => {
  beforeEach(() => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        claude: { id: 'claude', cliSubcommand: 'claude', vendorResumeSupport: 'supported' },
        opencode: { id: 'opencode', cliSubcommand: 'opencode', vendorResumeSupport: 'supported' },
        'acme-agent': {
          id: 'acme-agent',
          cliSubcommand: 'acme-agent',
          vendorResumeSupport: 'supported',
        },
      },
    });
  });

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

  it('resolves an active external Agent replay target through the exact catalog projection', () => {
    expect(resolveContinueWithReplayBackendTarget({
      agent: 'acme-agent',
      backendTarget: { kind: 'backend', backendId: 'acme-agent', sourceKind: 'built_in' },
    })).toMatchObject({
      ok: true,
      backendTargetV2: {
        kind: 'backend',
        backendId: 'acme-agent',
        sourceKind: 'built_in',
      },
      backendTarget: { kind: 'builtInAgent', agentId: 'acme-agent' },
      replayFlavor: 'acme-agent',
      agentHintAgentId: 'acme-agent',
    });
  });

  it('rejects unavailable legacy Agent identities instead of treating their generic V1 carrier as active', () => {
    expect(resolveContinueWithReplayBackendTarget({ agent: 'missing-agent' })).toEqual({
      ok: false,
      errorMessage: 'Unknown agent id',
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
