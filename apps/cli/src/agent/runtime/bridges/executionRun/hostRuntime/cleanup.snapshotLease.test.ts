import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunHostRuntime } from '../executionRunHostRuntime';
import { createExecutionRunSnapshotLease } from '../contributionSnapshotLease';
import { withExecutionRunHostRuntimeCleanup } from './cleanup';

function createRuntime(dispose: ExecutionRunHostRuntime['dispose']): ExecutionRunHostRuntime {
  return {
    readResumeSupport: async () => false,
    provisionSession: async () => ({ sessionId: 'child-session' }),
    sendPrompt: async () => {},
    cancel: async () => {},
    subscribeMessages: () => () => {},
    dispose,
  };
}

describe('withExecutionRunHostRuntimeCleanup snapshot lifetime', () => {
  it('releases the final snapshot reference when runtime disposal fails and remains idempotent', async () => {
    const releaseServingRegistry = vi.fn(async () => {});
    const snapshotLease = createExecutionRunSnapshotLease(releaseServingRegistry);
    const releaseRuntime = snapshotLease.retain();
    const disposeError = new Error('runtime dispose failed');
    const disposeRuntime = vi.fn(async () => {
      throw disposeError;
    });
    const runtime = withExecutionRunHostRuntimeCleanup(
      createRuntime(disposeRuntime),
      releaseRuntime,
    );

    await snapshotLease.releaseOwner();
    expect(releaseServingRegistry).not.toHaveBeenCalled();

    await expect(runtime.dispose()).rejects.toBe(disposeError);
    expect(releaseServingRegistry).toHaveBeenCalledTimes(1);

    await expect(runtime.dispose()).rejects.toBe(disposeError);
    expect(releaseServingRegistry).toHaveBeenCalledTimes(1);
  });
});
