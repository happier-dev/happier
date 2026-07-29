import { afterEach, describe, expect, it, vi } from 'vitest';

describe('CLI shared deps test setup', () => {
  const originalSkipBuild = process.env.HAPPIER_CLI_TEST_SKIP_BUILD;

  afterEach(() => {
    if (typeof originalSkipBuild === 'string') {
      process.env.HAPPIER_CLI_TEST_SKIP_BUILD = originalSkipBuild;
    } else {
      delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('waits on concrete bundle markers instead of the broad bundled-workspace health gate', async () => {
    vi.resetModules();
    delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;

    const ensureBuildArtifactsReadyOnce = vi.fn(async (_options: Readonly<{
      lockPath: string;
      markerPaths: readonly string[];
      lockLabel: string;
      runBuild: () => Promise<void> | void;
      isReady?: () => boolean | Promise<boolean>;
    }>) => undefined);
    vi.doMock('./testSetupBuildCoordinator', () => ({
      ensureBuildArtifactsReadyOnce,
    }));

    const { setup } = await import('./test-setup');

    await setup({ buildMode: 'shared-only' });

    expect(ensureBuildArtifactsReadyOnce).toHaveBeenCalledTimes(1);
    const [options] = ensureBuildArtifactsReadyOnce.mock.calls[0] ?? [];
    if (!options) throw new Error('expected ensureBuildArtifactsReadyOnce to be called');

    expect(options.lockLabel).toBe('CLI shared deps build');
    expect(options.isReady).toBeUndefined();
    expect(options.markerPaths).toEqual(expect.arrayContaining([
      expect.stringContaining('/node_modules/@happier-dev/protocol/dist/sessions/fork.js'),
      expect.stringContaining('/node_modules/@happier-dev/protocol/dist/features/payload/isRecord.js'),
    ]));
  });
});
