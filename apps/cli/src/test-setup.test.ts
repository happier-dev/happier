import { afterEach, describe, expect, it, vi } from 'vitest';

import { setup } from './test-setup';

describe('CLI test global setup', () => {
    const originalSkipBuild = process.env.HAPPIER_CLI_TEST_SKIP_BUILD;

    afterEach(() => {
        if (typeof originalSkipBuild === 'string') {
            process.env.HAPPIER_CLI_TEST_SKIP_BUILD = originalSkipBuild;
        } else {
            delete process.env.HAPPIER_CLI_TEST_SKIP_BUILD;
        }
        vi.restoreAllMocks();
    });

    it('skips the dist build for shared-only mode', async () => {
        const ensureSharedDepsBuiltOnce = vi.fn(async () => undefined);
        const ensureDistBuiltOnce = vi.fn(async () => undefined);

        await setup({
            buildMode: 'shared-only',
            dependencies: {
                resolveProjectRoot: () => '/tmp/happier-cli-project',
                ensureSharedDepsBuiltOnce,
                ensureDistBuiltOnce,
            },
        });

        expect(ensureSharedDepsBuiltOnce).toHaveBeenCalledWith('/tmp/happier-cli-project');
        expect(ensureDistBuiltOnce).not.toHaveBeenCalled();
    });

    it('runs both shared deps and dist builds for full mode', async () => {
        const ensureSharedDepsBuiltOnce = vi.fn(async () => undefined);
        const ensureDistBuiltOnce = vi.fn(async () => undefined);

        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => '/tmp/happier-cli-project',
                ensureSharedDepsBuiltOnce,
                ensureDistBuiltOnce,
            },
        });

        expect(ensureSharedDepsBuiltOnce).toHaveBeenCalledWith('/tmp/happier-cli-project');
        expect(ensureDistBuiltOnce).toHaveBeenCalledWith('/tmp/happier-cli-project');
    });

    it('respects the global skip-build override', async () => {
        process.env.HAPPIER_CLI_TEST_SKIP_BUILD = 'true';

        const ensureSharedDepsBuiltOnce = vi.fn(async () => undefined);
        const ensureDistBuiltOnce = vi.fn(async () => undefined);

        await setup({
            buildMode: 'full',
            dependencies: {
                resolveProjectRoot: () => '/tmp/happier-cli-project',
                ensureSharedDepsBuiltOnce,
                ensureDistBuiltOnce,
            },
        });

        expect(ensureSharedDepsBuiltOnce).not.toHaveBeenCalled();
        expect(ensureDistBuiltOnce).not.toHaveBeenCalled();
    });
});
