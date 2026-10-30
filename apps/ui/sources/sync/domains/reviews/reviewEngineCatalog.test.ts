import { describe, expect, it } from 'vitest';

import { buildAvailableReviewEngineOptions, resolveReviewEngineTarget } from './reviewEngineCatalog';

describe('buildAvailableReviewEngineOptions', () => {
  it('matches canonical native snapshot facts without duplicating the seeded Agent', () => {
    const options = buildAvailableReviewEngineOptions({ enabledAgentIds: ['claude'], scope: 'paths', resolveAgentLabel: id => id,
      executionRunsBackends: { 'agent:happier.agent.claude/claude': {
        available: true, intents: ['review'], reviewScopes: ['paths'], title: 'Claude review',
      } } });
    expect(options).toEqual([{ id: 'claude', label: 'Claude review' }]);
  });
  it('collapses old and current configured snapshot aliases by definition identity', () => {
    const key = 'agent:happier.agent.custom-acp/custom-acp:definition:review';
    const options = buildAvailableReviewEngineOptions({ enabledAgentIds: [key], resolveAgentLabel: id => id,
      executionRunsBackends: {
        'backend:review:configured:review': { available: true, intents: ['review'], title: 'Review' },
        'acpBackend:review': { available: true, intents: ['review'], title: 'Review' },
        [key]: { available: true, intents: ['review'], title: 'Review' },
      } });
    expect(options).toEqual([{ id: key, label: 'Review' }]);
  });
  it('omits abstract declaration containers while retaining exact configured targets and discovered Agents', () => {
    const target = 'agent:happier.agent.custom-acp/custom-acp:definition:review';
    const options = buildAvailableReviewEngineOptions({
      enabledAgentIds: ['claude', 'custom-acp', target],
      resolveAgentLabel: id => id,
      executionRunsBackends: {
        'custom-acp': { available: true, intents: ['review'] },
        customAcp: { available: true, intents: ['review'] },
        'agent:happier.agent.custom-acp/custom-acp': { available: true, intents: ['review'] },
        'happier.agent.custom-acp/custom-acp': { available: true, intents: ['review'] },
        [target]: { available: true, intents: ['review'] },
        'acme.review/reviewer': { available: true, intents: ['review'] },
      },
    });
    expect(options.map(option => option.id)).toEqual(['claude', target, 'acme.review/reviewer']);
  });
  it('preserves configured review target keys while routing catalog Agent ids as backends', () => {
    expect(resolveReviewEngineTarget('backend:review-bot:configured:review-bot')).toEqual({
      kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured',
    });
    expect(resolveReviewEngineTarget('acme.review/reviewer')).toEqual({
      kind: 'backend', backendId: 'acme.review/reviewer',
    });
  });

  it('includes enabled review-capable engines from the execution-run backend snapshot', () => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds: ['claude', 'codex'],
      resolveAgentLabel: (id) => `agent:${id}`,
      executionRunsBackends: {
        claude: { available: true, intents: ['review', 'plan'] },
        codex: { available: false, intents: ['review'] },
      },
    });

    expect(opts).toEqual([
      { id: 'claude', label: 'agent:claude' },
      { id: 'codex', label: 'agent:codex', disabled: true },
    ]);
  });

  it('does not append host-native review engines when no machine backend snapshot is available yet', () => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds: ['claude'],
      resolveAgentLabel: (id) => `agent:${id}`,
      executionRunsBackends: null,
    });

    expect(opts).toEqual([
      { id: 'claude', label: 'agent:claude' },
    ]);
  });

  it('includes discovered source-backed review backends that are not enabled canonical agents', () => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds: ['claude'],
      resolveAgentLabel: (id) => `agent:${id}`,
      executionRunsBackends: {
        claude: { available: true, intents: ['review'] },
        'acme.review.backend': { available: true, intents: ['review'] },
        'acme.delegate.backend': { available: true, intents: ['delegate'] },
      },
    });

    expect(opts).toEqual([
      { id: 'claude', label: 'agent:claude' },
      { id: 'acme.review.backend', label: 'agent:acme.review.backend' },
    ]);
  });

  it('does not offer a built-in Agent when the machine inventory omits review intent', () => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds: ['claude', 'codex'],
      resolveAgentLabel: (id) => `agent:${id}`,
      executionRunsBackends: {
        claude: { available: true, intents: ['review'] },
        codex: { available: true, intents: ['delegate'] },
      },
    });

    expect(opts.map((option) => option.id)).toEqual(['claude']);
  });

  it('shows only engines that advertise exact path support for a paths scope', () => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds: ['claude'],
      resolveAgentLabel: (id) => id,
      scope: 'paths',
      executionRunsBackends: {
        claude: { available: true, intents: ['review'], reviewScopes: ['worktree', 'paths'] },
        coderabbit: { available: true, intents: ['review'], reviewScopes: ['worktree'] },
      },
    });

    expect(opts).toEqual([{ id: 'claude', label: 'claude' }]);
  });
});
