import { describe, expect, it } from 'vitest';

import { createProviderPromptAcceptanceSettlement } from './createProviderPromptAcceptanceSettlement';

describe('createProviderPromptAcceptanceSettlement', () => {
  it('drains accepted settlement before the next prompt reads provider context', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    let contextIsLive = true;
    retirement.register('local-1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      contextIsLive = false;
    });

    retirement.confirmProviderAccepted(['local-1']);
    await retirement.drain();

    expect(contextIsLive).toBe(false);
  });

  it('leaves context live when the provider never confirmed the prompt', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    let contextIsLive = true;
    retirement.register('local-1', async () => {
      contextIsLive = false;
    });

    await retirement.drain();

    expect(contextIsLive).toBe(true);
  });

  it('settles exactly once when acceptance is reported twice for one prompt', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    let settleCount = 0;
    retirement.register('local-1', async () => {
      settleCount += 1;
    });

    retirement.confirmProviderAccepted(['local-1']);
    retirement.confirmProviderAccepted(['local-1']);
    await retirement.drain();

    expect(settleCount).toBe(1);
  });

  it('does not settle an earlier seeded prompt when a later unseeded prompt is accepted', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    let contextIsLive = true;
    retirement.register('first-local', async () => {
      contextIsLive = false;
    });
    retirement.register('second-local', null);

    retirement.confirmProviderAccepted(['second-local']);
    await retirement.drain();

    expect(contextIsLive).toBe(true);
  });

  it('keeps delayed acceptance correlated after a newer prompt registers', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    const settled: string[] = [];
    retirement.register('first-local', async () => {
      settled.push('first');
    });
    retirement.register('second-local', async () => {
      settled.push('second');
    });

    retirement.confirmProviderAccepted(['first-local']);
    await retirement.drain();

    expect(settled).toEqual(['first']);
  });

  it('fails closed when provider acceptance does not identify exactly one prompt', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    const settled: string[] = [];
    retirement.register('first-local', async () => settled.push('first'));
    retirement.register('second-local', async () => settled.push('second'));

    retirement.confirmProviderAccepted(['first-local', 'second-local']);
    await retirement.drain();

    expect(settled).toEqual([]);
  });

  it('preserves opaque Pending localId bytes when correlating acceptance', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    const settled: string[] = [];
    retirement.register(' local-1\n', async () => settled.push('opaque'));
    retirement.register('local-1', async () => settled.push('trimmed'));

    retirement.confirmProviderAccepted([' local-1\n']);
    await retirement.drain();

    expect(settled).toEqual(['opaque']);
  });

  it('keeps a legacy prompt without Pending identity correlated by its own callback', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    const settled: string[] = [];
    const acceptLegacyPrompt = retirement.createPromptLocalAcceptanceCallback(
      async () => settled.push('legacy'),
    );
    retirement.register('newer-local', async () => settled.push('newer'));

    acceptLegacyPrompt();
    acceptLegacyPrompt();
    await retirement.drain();

    expect(settled).toEqual(['legacy']);
  });
});
