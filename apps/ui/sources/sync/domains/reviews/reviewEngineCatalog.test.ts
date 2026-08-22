import { describe, expect, it } from 'vitest';

import { buildAvailableReviewEngineOptions } from './reviewEngineCatalog';

describe('buildAvailableReviewEngineOptions', () => {
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

  it('does not append missing backend snapshot entries as native review engines', () => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds: ['claude'],
      resolveAgentLabel: (id) => `agent:${id}`,
      executionRunsBackends: {
        claude: { available: true, intents: ['review'] },
      },
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

  it('falls back to the backend id when a discovered review backend has no canonical agent label', () => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds: ['claude'],
      // An Agent with no bundled core has no translated display name, so the
      // real resolver answers with the formatted backend id. (It used to throw
      // here; `getAgentCore` is a typed lookup now.)
      resolveAgentLabel: (id) => (id === 'customAcp' ? id : `agent:${id}`),
      executionRunsBackends: {
        claude: { available: true, intents: ['review'] },
        customAcp: { available: true, intents: ['review'] },
      },
    });

    expect(opts).toEqual([
      { id: 'claude', label: 'agent:claude' },
      { id: 'customAcp', label: 'customAcp' },
    ]);
  });
});
