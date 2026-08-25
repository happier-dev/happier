import { describe, expect, it, vi } from 'vitest';

import { settleAtMostOnceProviderWrite } from './writeSettlement.js';

describe('settleAtMostOnceProviderWrite', () => {
  it('dispatches once and performs one authoritative confirmation after an answer-lost write', async () => {
    const dispatch = vi.fn(async () => ({ kind: 'answerLost' as const }));
    const confirm = vi.fn(async () => ({ kind: 'applied' as const, observation: { state: 'closed' } }));

    const settled = await settleAtMostOnceProviderWrite({
      dispatch,
      mayHaveChanged: (result) => result.kind === 'answerLost',
      confirm,
    });

    expect(settled).toEqual({ kind: 'applied', observation: { state: 'closed' } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('preserves unchanged and uncertain confirmation outcomes without retrying', async () => {
    const dispatch = vi.fn(async () => ({ kind: 'answerLost' as const }));
    const unchanged = await settleAtMostOnceProviderWrite({
      dispatch,
      mayHaveChanged: () => true,
      confirm: async () => ({ kind: 'unchanged' as const, observation: { state: 'open' } }),
    });
    const uncertain = await settleAtMostOnceProviderWrite({
      dispatch,
      mayHaveChanged: () => true,
      confirm: async () => ({ kind: 'uncertain' as const, failure: 'confirmation-failed' }),
    });

    expect(unchanged).toEqual({ kind: 'unchanged', observation: { state: 'open' } });
    expect(uncertain).toEqual({ kind: 'uncertain', failure: 'confirmation-failed' });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('does not confirm a provider result that proves no effect was attempted', async () => {
    const confirm = vi.fn(async () => ({ kind: 'applied' as const, observation: 'impossible' }));

    const settled = await settleAtMostOnceProviderWrite({
      dispatch: async () => ({ kind: 'refused' as const }),
      mayHaveChanged: () => false,
      confirm,
    });

    expect(settled).toEqual({ kind: 'settled', result: { kind: 'refused' } });
    expect(confirm).not.toHaveBeenCalled();
  });
});
