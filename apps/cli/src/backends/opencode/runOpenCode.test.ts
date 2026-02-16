import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runStandardAcpProviderMock } = vi.hoisted(() => ({
  runStandardAcpProviderMock: vi.fn(),
}));

vi.mock('@/agent/runtime/runStandardAcpProvider', () => ({
  runStandardAcpProvider: runStandardAcpProviderMock,
}));

describe('runOpenCode', () => {
  beforeEach(() => {
    vi.resetModules();
    runStandardAcpProviderMock.mockReset();
  });

  it('does not block startup while waiting for metadata snapshot publish prerequisites', async () => {
    const ensureMetadataSnapshot = vi.fn(() => new Promise<null>(() => {}));
    const updateMetadata = vi.fn(async () => {});

    let onAfterStartOutcome: 'completed' | 'timed_out' = 'timed_out';

    runStandardAcpProviderMock.mockImplementationOnce(async (_opts: unknown, config: any) => {
      const onAfterStartPromise = Promise.resolve(
        config.onAfterStart?.({
          session: { ensureMetadataSnapshot, updateMetadata },
          runtime: { getSessionId: () => 'opencode-session-1' },
        }),
      );

      onAfterStartOutcome = await Promise.race([
        onAfterStartPromise.then(() => 'completed' as const),
        new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 25)),
      ]);

      await Promise.resolve();
    });

    const { runOpenCode } = await import('./runOpenCode');
    await runOpenCode({ credentials: {} as any });

    expect(onAfterStartOutcome).toBe('completed');
    expect(ensureMetadataSnapshot).toHaveBeenCalledTimes(1);
    expect(updateMetadata).not.toHaveBeenCalled();
  }, 15_000);
});
