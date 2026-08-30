import { describe, expect, it } from 'vitest';

import { createClaudeReplaySeedRetirement } from './createClaudeReplaySeedRetirement';

/**
 * Claude launchers are event-driven: acceptance arrives synchronously, while the next prompt
 * reads the seed from Session metadata asynchronously. Holding settlement closes that race.
 */
describe('createClaudeReplaySeedRetirement', () => {
  it('drains an accepted prompt’s retirement before the next prompt reads the seed', async () => {
    const retirement = createClaudeReplaySeedRetirement();
    let seedIsLive = true;
    retirement.bind(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      seedIsLive = false;
    });

    retirement.confirmProviderAccepted();
    await retirement.drain();

    expect(seedIsLive).toBe(false);
  });

  it('leaves the seed live when the provider never confirmed the prompt', async () => {
    const retirement = createClaudeReplaySeedRetirement();
    let seedIsLive = true;
    retirement.bind(async () => {
      seedIsLive = false;
    });

    await retirement.drain();

    expect(seedIsLive).toBe(true);
  });

  it('retires exactly once when acceptance is reported twice for one prompt', async () => {
    const retirement = createClaudeReplaySeedRetirement();
    let settleCount = 0;
    retirement.bind(async () => {
      settleCount += 1;
    });

    retirement.confirmProviderAccepted();
    retirement.confirmProviderAccepted();
    await retirement.drain();

    expect(settleCount).toBe(1);
  });

  it('does not retire an earlier seeded attempt when the accepted prompt carried no seed', async () => {
    const retirement = createClaudeReplaySeedRetirement();
    let seedIsLive = true;
    retirement.bind(async () => {
      seedIsLive = false;
    });
    retirement.bind(null);

    retirement.confirmProviderAccepted();
    await retirement.drain();

    expect(seedIsLive).toBe(true);
  });
});
