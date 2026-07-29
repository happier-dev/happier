import { describe, expect, it, vi } from 'vitest';

import { createDirectTransferCancellationChunkGate } from './directTransferCancellationChunkGate';

describe('createDirectTransferCancellationChunkGate', () => {
  it('holds every response after the first chunk until cancellation releases it', async () => {
    const gate = createDirectTransferCancellationChunkGate();
    const continueFirstChunk = vi.fn(async () => undefined);
    const continueSecondChunk = vi.fn(async () => undefined);
    const continueThirdChunk = vi.fn(async () => undefined);

    await gate.handleRoute({ continue: continueFirstChunk });

    const secondChunk = gate.handleRoute({ continue: continueSecondChunk });
    const thirdChunk = gate.handleRoute({ continue: continueThirdChunk });
    await gate.waitForLaterChunkHeld();

    expect(continueFirstChunk).toHaveBeenCalledOnce();
    expect(continueSecondChunk).not.toHaveBeenCalled();
    expect(continueThirdChunk).not.toHaveBeenCalled();

    gate.releaseAfterCancellation();
    gate.releaseAfterCancellation();
    await Promise.all([secondChunk, thirdChunk]);

    expect(continueSecondChunk).toHaveBeenCalledOnce();
    expect(continueThirdChunk).toHaveBeenCalledOnce();
    expect(gate.requestCount).toBe(3);
  });
});
