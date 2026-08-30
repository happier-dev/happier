import { describe, expect, it } from 'vitest';

import { createProviderPromptAcceptanceSettlement } from './createProviderPromptAcceptanceSettlement';

describe('createProviderPromptAcceptanceSettlement', () => {
  it('drains accepted settlement before the next prompt reads provider context', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    let contextIsLive = true;
    retirement.bind(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      contextIsLive = false;
    });

    retirement.confirmProviderAccepted();
    await retirement.drain();

    expect(contextIsLive).toBe(false);
  });

  it('leaves context live when the provider never confirmed the prompt', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    let contextIsLive = true;
    retirement.bind(async () => {
      contextIsLive = false;
    });

    await retirement.drain();

    expect(contextIsLive).toBe(true);
  });

  it('settles exactly once when acceptance is reported twice for one prompt', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    let settleCount = 0;
    retirement.bind(async () => {
      settleCount += 1;
    });

    retirement.confirmProviderAccepted();
    retirement.confirmProviderAccepted();
    await retirement.drain();

    expect(settleCount).toBe(1);
  });

  it('does not settle an earlier attempt when the accepted prompt bound no context', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    let contextIsLive = true;
    retirement.bind(async () => {
      contextIsLive = false;
    });
    retirement.bind(null);

    retirement.confirmProviderAccepted();
    await retirement.drain();

    expect(contextIsLive).toBe(true);
  });

  it('keeps delayed acceptance correlated to the prompt that created its callback', async () => {
    const retirement = createProviderPromptAcceptanceSettlement();
    const settled: string[] = [];
    const acceptFirst = retirement.createAcceptanceCallback(async () => {
      settled.push('first');
    });
    retirement.createAcceptanceCallback(async () => {
      settled.push('second');
    });

    acceptFirst();
    await retirement.drain();

    expect(settled).toEqual(['first']);
  });
});
