import { describe, expect, it } from 'vitest';

import { createClaudeRemoteReplaySeedRetirement } from './claudeRemoteLauncher';

/**
 * The launcher is event-driven: acceptance arrives on `onPromptAcceptedByProvider`, and the
 * NEXT prompt reads the seed straight out of Session metadata. Starting retirement without
 * holding it therefore races that read, and the loser is a second full copy of the carry-over
 * context in front of the next message.
 */
describe('createClaudeRemoteReplaySeedRetirement', () => {
  it('drains an accepted prompt’s retirement before the next prompt reads the seed', async () => {
    const retirement = createClaudeRemoteReplaySeedRetirement();
    let seedIsLive = true;
    retirement.arm(async () => {
      // The real settler is an async metadata write; it does not land in the same microtask.
      await new Promise((resolve) => setTimeout(resolve, 0));
      seedIsLive = false;
    });

    retirement.confirmProviderAccepted();
    // The launcher's next `getNextMessage` drains here, immediately before resolving the next
    // prompt against the seed snapshot.
    await retirement.drain();

    expect(seedIsLive).toBe(false);
  });

  // The margin `replaySeedV1` documents: an unconfirmed send keeps the seed, because delivering
  // the carry-over context twice is strictly safer than delivering it never.
  it('leaves the seed live when the provider never confirmed the prompt', async () => {
    const retirement = createClaudeRemoteReplaySeedRetirement();
    let seedIsLive = true;
    retirement.arm(async () => {
      seedIsLive = false;
    });

    await retirement.drain();

    expect(seedIsLive).toBe(true);
  });

  it('retires exactly once when acceptance is reported twice for one prompt', async () => {
    const retirement = createClaudeRemoteReplaySeedRetirement();
    let settleCount = 0;
    retirement.arm(async () => {
      settleCount += 1;
    });

    retirement.confirmProviderAccepted();
    retirement.confirmProviderAccepted();
    await retirement.drain();

    expect(settleCount).toBe(1);
  });
});
