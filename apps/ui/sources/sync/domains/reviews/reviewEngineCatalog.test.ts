import { describe, expect, it } from 'vitest';

import { buildAvailableReviewEngineOptions } from './reviewEngineCatalog';

describe('buildAvailableReviewEngineOptions', () => {
  it('includes only review-capable available engines and labels native engines from the protocol catalog', () => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds: ['claude', 'codex'],
      resolveAgentLabel: (id) => `agent:${id}`,
      executionRunsBackends: {
        claude: { available: true, intents: ['review', 'plan'] },
        codex: { available: false, intents: ['review'] },
        coderabbit: { available: true, intents: ['review'] },
      },
    });

    expect(opts).toEqual([
      { id: 'claude', label: 'agent:claude' },
      { id: 'coderabbit', label: 'CodeRabbit' },
    ]);
  });

  it('includes native review engines even when no machine backend snapshot is available yet (best-effort)', () => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds: ['claude'],
      resolveAgentLabel: (id) => `agent:${id}`,
      executionRunsBackends: null,
    });

    // When backends are unknown, we still show native engines (they may be available on the machine).
    expect(opts).toEqual([
      { id: 'claude', label: 'agent:claude' },
      { id: 'coderabbit', label: 'CodeRabbit' },
    ]);
  });

  it('includes native review engines when the backend snapshot does not list them (older snapshots)', () => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds: ['claude'],
      resolveAgentLabel: (id) => `agent:${id}`,
      executionRunsBackends: {
        claude: { available: true, intents: ['review'] },
        // coderabbit missing entirely
      },
    });

    expect(opts).toEqual([
      { id: 'claude', label: 'agent:claude' },
      { id: 'coderabbit', label: 'CodeRabbit' },
    ]);
  });
});
