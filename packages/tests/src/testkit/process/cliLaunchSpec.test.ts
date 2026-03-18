import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const sharedDepsBuildMock = vi.hoisted(() => ({
    ensureCliSharedDepsBuilt: vi.fn(async ({ testDir, env }: { testDir: string; env: NodeJS.ProcessEnv }) => {
        void testDir;
        void env;
    }),
}));

vi.mock('./cliDist', async () => {
    const actual = await vi.importActual<typeof import('./cliDist')>('./cliDist');
    return {
        ...actual,
        ensureCliSharedDepsBuilt: sharedDepsBuildMock.ensureCliSharedDepsBuilt,
    };
});

import { resolveCliTestLaunchSpec } from './cliLaunchSpec';

describe('resolveCliTestLaunchSpec', () => {
    it('ensures source-entrypoint launches refresh shared deps before snapshotting bundled node_modules', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-launch-spec-'));
        const snapshotDir = resolve(repoRoot, 'snapshot');

        try {
            mkdirSync(resolve(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
            mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime'), {
                recursive: true,
            });
            mkdirSync(resolve(repoRoot, 'packages', 'release-runtime', 'dist'), { recursive: true });
            mkdirSync(resolve(repoRoot, '.project'), { recursive: true });

            writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
            writeFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
            writeFileSync(resolve(repoRoot, 'apps', 'cli', 'tsconfig.json'), '{}', 'utf8');
            writeFileSync(resolve(repoRoot, 'apps', 'cli', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
            writeFileSync(
                resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'package.json'),
                JSON.stringify(
                    {
                        name: '@happier-dev/release-runtime',
                        version: '0.0.0',
                        type: 'module',
                        main: './dist/index.js',
                        exports: {
                            '.': { default: './dist/index.js' },
                            './github': { default: './dist/github.js' },
                        },
                    },
                    null,
                    2,
                ),
                'utf8',
            );
            writeFileSync(
                resolve(repoRoot, 'packages', 'release-runtime', 'package.json'),
                JSON.stringify({ name: '@happier-dev/release-runtime' }),
                'utf8',
            );

            sharedDepsBuildMock.ensureCliSharedDepsBuilt.mockImplementationOnce(async () => {
                mkdirSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist'), {
                    recursive: true,
                });
                writeFileSync(
                    resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js'),
                    'export const live = true;\n',
                    'utf8',
                );
            });

            const spec = await resolveCliTestLaunchSpec(
                {
                    testDir: resolve(repoRoot, '.project'),
                    env: {
                        ...process.env,
                        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                    },
                },
                {
                    repoRoot,
                    snapshotDir,
                },
            );

            expect(sharedDepsBuildMock.ensureCliSharedDepsBuilt).toHaveBeenCalledTimes(1);
            expect(spec.command).toBe(process.execPath);
            expect(spec.args).toContain(resolve(snapshotDir, 'src', 'index.ts'));
            expect(existsSync(resolve(snapshotDir, 'node_modules', '@happier-dev', 'release-runtime', 'dist', 'github.js'))).toBe(
                true,
            );
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
