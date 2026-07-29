import { describe, expect, it } from 'vitest';

import {
  summarizeProviderTokenLedgerByProviderAndModel,
  summarizeProviderTokenLedgerTotals,
  type ProviderTokenLedgerEntryV1,
} from '../../src/testkit/providers/harness/tokenLedger';

describe('provider token ledger summary', () => {
  const sampleEntries: ProviderTokenLedgerEntryV1[] = [
    {
      v: 1,
      providerId: 'claude',
      scenarioId: 'read_known_file',
      phase: 'single',
      sessionId: 's1',
      key: 'turn-1',
      timestamp: 1,
      modelId: 'claude-sonnet-4',
      source: 'socket-ephemeral-usage',
      tokens: { input: 100, output: 40, total: 140 },
    },
    {
      v: 1,
      providerId: 'claude',
      scenarioId: 'abort_turn_then_continue',
      phase: 'single',
      sessionId: 's1',
      key: 'turn-2',
      timestamp: 2,
      modelId: 'claude-sonnet-4',
      source: 'socket-ephemeral-usage',
      tokens: { input: 20, output: 10, total: 30 },
    },
    {
      v: 1,
      providerId: 'codex',
      scenarioId: 'acp_probe_models',
      phase: 'single',
      sessionId: 's2',
      key: 'turn-1',
      timestamp: 3,
      modelId: 'gpt-5-codex',
      source: 'socket-ephemeral-usage',
      tokens: { input: 50, output: 25, total: 75 },
    },
  ];

  it('aggregates totals by provider + model', () => {
    const summary = summarizeProviderTokenLedgerByProviderAndModel(sampleEntries);
    expect(summary).toEqual([
      {
        providerId: 'claude',
        modelId: 'claude-sonnet-4',
        entries: 2,
        tokens: { input: 120, output: 50, total: 170 },
      },
      {
        providerId: 'codex',
        modelId: 'gpt-5-codex',
        entries: 1,
        tokens: { input: 50, output: 25, total: 75 },
      },
    ]);
  });

  it('aggregates overall totals', () => {
    const totals = summarizeProviderTokenLedgerTotals(sampleEntries);
    expect(totals.entries).toBe(3);
    expect(totals.tokens).toEqual({ input: 170, output: 75, total: 245 });
  });
});

