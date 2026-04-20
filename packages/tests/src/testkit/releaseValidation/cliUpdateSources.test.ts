import { beforeEach, describe, expect, it, vi } from 'vitest';

const cliLaunchSpecMock = vi.hoisted(() => ({
    resolveCliTestLaunchSpec: vi.fn(
        async (
            _params: { testDir: string; env: NodeJS.ProcessEnv },
            _options: { snapshotDir: string; skipDistIntegrityCheck?: boolean; skipSourceFreshnessCheck?: boolean },
        ) => ({
            command: process.execPath,
            args: ['--preserve-symlinks', '/prepared/dist/index.mjs'],
        }),
    ),
}));

vi.mock('../process/cliLaunchSpec', () => cliLaunchSpecMock);

import {
    prepareCliUpdateSourceSnapshot,
    resolveCliUpdateNpmPackageSpec,
    resolveCliUpdateSourcePairFromEnv,
    resolveCliUpdateValidationLaunchEnv,
} from './cliUpdateSources';

describe('cli update release-validation sources', () => {
    beforeEach(() => {
        cliLaunchSpecMock.resolveCliTestLaunchSpec.mockClear();
    });

    it('defaults direct test runs to local-build snapshots for both update sides', () => {
        expect(resolveCliUpdateSourcePairFromEnv({})).toEqual({
            from: { kind: 'local-build', ref: 'HEAD' },
            to: { kind: 'local-build', ref: 'HEAD' },
        });
    });

    it('requires complete from/to source env when release-validation passes explicit sources', () => {
        expect(() =>
            resolveCliUpdateSourcePairFromEnv({
                HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_KIND: 'published-channel',
                HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_REF: 'preview',
            }),
        ).toThrow(/complete cli-update source env/i);
    });

    it('resolves published channels and release tags to npm package specs', () => {
        expect(resolveCliUpdateNpmPackageSpec({ kind: 'published-channel', ref: 'stable' })).toBe('@happier-dev/cli@latest');
        expect(resolveCliUpdateNpmPackageSpec({ kind: 'published-channel', ref: 'preview' })).toBe('@happier-dev/cli@next');
        expect(resolveCliUpdateNpmPackageSpec({ kind: 'published-tag', ref: 'cli-preview' })).toBe('@happier-dev/cli@next');
        expect(resolveCliUpdateNpmPackageSpec({ kind: 'published-tag', ref: 'cli-v1.2.3-preview.4' })).toBe('@happier-dev/cli@1.2.3-preview.4');
    });

    it('uses dist/package launch mode rather than source-entrypoint mode for update validation', () => {
        expect(
            resolveCliUpdateValidationLaunchEnv({
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                HAPPY_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: 'true',
                HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
                UNRELATED: 'kept',
            }),
        ).toEqual({
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
            UNRELATED: 'kept',
        });
    });

    it('materializes local-build sources as prepared dist snapshots for later artifact-only validation', async () => {
        await expect(
            prepareCliUpdateSourceSnapshot({
                testDir: '/tmp/happier-cli-update-test',
                role: 'to',
                source: { kind: 'local-build', ref: 'HEAD' },
                env: {
                    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                },
            }),
        ).resolves.toBe('/tmp/happier-cli-update-test/cli-update-to');

        expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).toHaveBeenCalledTimes(1);
        expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).toHaveBeenCalledWith(
            {
                testDir: '/tmp/happier-cli-update-test',
                env: expect.objectContaining({
                    HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
                }),
            },
            expect.objectContaining({
                snapshotDir: '/tmp/happier-cli-update-test/cli-update-to',
                skipDistIntegrityCheck: true,
                skipSourceFreshnessCheck: true,
            }),
        );
        expect(cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[0].env).not.toHaveProperty(
            'HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT',
        );
    });
});
