import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'sess-review-1' }));
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveSessionTarget }));
const createCliActionExecutor = vi.fn(() => ({ execute }));
const resolveSessionTransportContext = vi.fn();
const ensureCliActionPolicySettings = vi.fn();

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));
vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));
vi.mock('@/session/actions/ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

describe('happier session review start command', () => {
  beforeEach(() => vi.clearAllMocks());
  it('returns the admitted Workflow and Review round for a composed selection', async () => {
    const run = { id: 'review-workflow', sourceArtifactId: null, ownerAccountId: 'account', visibleTeamId: null,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      origin: { kind: 'direct' }, state: 'running', revision: 1, machineId: 'machine',
      workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const reviewRound = { reviewId: 'review', roundOrdinal: 1 };
    execute.mockResolvedValueOnce({ ok: true, result: { run, admission: 'created', reviewRound } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['review', 'start', 'sess-review', '--engines', 'engine-1,engine-2', '--instructions', 'Review.', '--json'],
        { readCredentialsFn: async () => ({ token: 'hap_v1_token_secret', encryption: null, credentialProvenance: 'api_token' as const }) },
      );
      expect(output.json()).toMatchObject({ ok: true, kind: 'session_review_start', data: {
        sessionId: 'sess-review-1', workflow: { runId: run.id, origin: run.origin }, reviewRound,
      } });
    } finally {
      output.restore();
    }
  });

  it('selects the public Action transport before legacy Session bootstrap for API tokens', async () => {
    const reviewRound = { reviewId: 'direct-review', roundOrdinal: 1 };
    const results = [{ key: 'step-1-reviewer-1', ok: true, result: { runId: 'review-1' } }];
    execute.mockResolvedValueOnce({ ok: true, result: { intent: 'review', sessionId: 'sess-review-1', reviewRound, results } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['review', 'start', 'sess-review', '--engines', 'engine-1', '--instructions', 'Review.', '--json'],
        { readCredentialsFn: async () => ({ token: 'hap_v1_token_secret', encryption: null, credentialProvenance: 'api_token' as const }) },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-review');
      expect(createCliActionExecutor).not.toHaveBeenCalled();
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'review.start',
        expect.objectContaining({ reviewers: [{ kind: 'engine', engineId: 'engine-1' }], instructions: 'Review.', changeType: 'uncommitted', base: { kind: 'none' } }),
        { defaultSessionId: 'sess-review-1' },
      );
      expect(output.json()).toMatchObject({ ok: true, kind: 'session_review_start', data: { results, reviewRound } });
    } finally {
      output.restore();
    }
  });

  it('preserves a whole-input mixed roster and explicitly selected transcript source', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { intent: 'review', sessionId: 'sess-review-1', results: [
      { key: 'step-1-reviewer-1', ok: true, result: { runId: 'review-mixed-1' } },
      { key: 'step-1-reviewer-2', ok: true, result: { runId: 'review-mixed-2' } },
      { key: 'step-1-reviewer-3', ok: true, result: { runId: 'review-mixed-3' } },
    ] } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const reviewers = [
      { kind: 'engine', engineId: 'engine-1', modelId: 'model-a', options: { effort: 'high' }, includeSessionTranscript: true },
      { kind: 'engine', engineId: 'engine-1', modelId: 'model-b', approvalProfileId: 'approval-b' },
      { kind: 'session', session: { serverId: 'home-1', sessionId: 'reviewer-session' } },
      { kind: 'person', principal: { kind: 'account', accountId: 'reviewer-person' }, required: true },
    ];
    const sourceSession = { serverId: 'home-1', sessionId: 'source-session' };
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['review', 'start', 'sess-review', '--input-json', JSON.stringify({
          reviewers, instructions: 'Review the claim.', sourceSession,
          outputs: ['walkthrough'], scope: 'changes',
        }), '--json'],
        { readCredentialsFn: async () => ({ token: 'hap_v1_token_secret', encryption: null, credentialProvenance: 'api_token' as const }) },
      );

      expect(output.json()).toEqual(expect.objectContaining({ ok: true, kind: 'session_review_start' }));
      expect(execute).toHaveBeenLastCalledWith('review.start', expect.objectContaining({
        reviewers, sourceSession, outputs: ['walkthrough'], scope: 'changes',
      }), { defaultSessionId: 'sess-review-1' });
    } finally {
      output.restore();
    }
  });

  it('reports an unknown start outcome when the selected reviewer receipt is missing', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { intent: 'review', sessionId: 'sess-review-1', results: [] } });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['review', 'start', 'sess-review', '--engines', 'engine-1', '--instructions', 'Review.', '--json'],
        { readCredentialsFn: async () => ({ token: 'hap_v1_token_secret', encryption: null, credentialProvenance: 'api_token' as const }) },
      );
      expect(output.json()).toMatchObject({ ok: false, kind: 'session_review_start', error: { code: 'action_outcome_unknown' } });
    } finally {
      output.restore();
    }
  });
});
