import { describe, expect, it, vi } from 'vitest';

import * as acpRuntimeModule from '../createAcpRuntime';

type MinimalAcpRuntime = {
  isTurnInFlight: () => boolean;
  cancel: () => Promise<void>;
};

describe('abortAcpRuntimeTurnIfNeeded', () => {
  it('cancels the ACP runtime when a turn is in-flight', async () => {
    const helper = (acpRuntimeModule as unknown as { abortAcpRuntimeTurnIfNeeded?: unknown })
      .abortAcpRuntimeTurnIfNeeded;

    expect(typeof helper).toBe('function');

    const cancel = vi.fn(async () => {});
    const runtime: MinimalAcpRuntime = {
      isTurnInFlight: () => true,
      cancel,
    };

    await (helper as (runtime: MinimalAcpRuntime) => Promise<boolean>)(runtime);

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

