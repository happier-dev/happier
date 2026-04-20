import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    inferPublicReleaseRingIdFromEnvAndArgv,
    resolvePublicReleaseRingIdFromCliArgs,
} from './publicReleaseChannel';

describe('inferPublicReleaseRingIdFromEnvAndArgv', () => {
    it('prefers an embedded payload release ring marker when launcher and path hints are generic', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-public-release-ring-'));
        const payloadRoot = join(rootDir, 'managed', 'current');
        const entrypointPath = join(payloadRoot, 'package-dist', 'index.mjs');

        try {
            await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
            await writeFile(join(payloadRoot, 'public-release-ring.id'), 'preview\n', 'utf8');
            await writeFile(entrypointPath, 'export default null;\n', 'utf8');

            expect(
                inferPublicReleaseRingIdFromEnvAndArgv({
                    env: {
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
                        HAPPIER_RELEASE_RING: '',
                        HAPPIER_RELEASE_CHANNEL: '',
                    },
                    argv: [
                        '/home/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
                        entrypointPath,
                        'service',
                        'install',
                    ],
                    execPath: '/home/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
                    argv0: 'node',
                }),
            ).toBe('preview');
        } finally {
            await rm(rootDir, { recursive: true, force: true });
        }
    });

    it('infers preview from the installed preview runtime path when argv no longer carries the preview launcher basename', () => {
        expect(
            inferPublicReleaseRingIdFromEnvAndArgv({
                env: {
                    HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
                    HAPPIER_RELEASE_RING: '',
                    HAPPIER_RELEASE_CHANNEL: '',
                },
                argv: [
                    '/home/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
                    '/home/test/.happier/cli-preview/versions/0.2.3/package-dist/index.mjs',
                    'service',
                    'install',
                ],
                execPath: '/home/test/.happier/cli-preview/current/happier',
            }),
        ).toBe('preview');
    });

    it('infers public dev from an explicit packaged entrypoint hint when argv and execPath are generic runtime paths', () => {
        expect(
            inferPublicReleaseRingIdFromEnvAndArgv({
                env: {
                    HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
                    HAPPIER_RELEASE_RING: '',
                    HAPPIER_RELEASE_CHANNEL: '',
                },
                argv: [
                    '/home/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
                    'service',
                    'install',
                ],
                execPath: '/home/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
                additionalCandidates: [
                    '/home/test/.happier/cli-dev/versions/0.2.3/package-dist/index.mjs',
                ],
            }),
        ).toBe('publicdev');
    });

    it('uses the persisted default channel for the unsuffixed happier shim', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-public-release-channel-'));
        try {
            writeFileSync(
                join(homeDir, 'default-cli-release-channel.json'),
                `${JSON.stringify({ releaseChannel: 'preview' })}\n`,
                'utf8',
            );

            expect(
                inferPublicReleaseRingIdFromEnvAndArgv({
                    env: {
                        HAPPIER_HOME_DIR: homeDir,
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
                        HAPPIER_RELEASE_RING: '',
                        HAPPIER_RELEASE_CHANNEL: '',
                    },
                    argv: ['/home/test/.happier/bin/happier', 'self', 'update'],
                    execPath: '/home/test/.happier/bin/happier',
                }),
            ).toBe('preview');
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });
});

describe('resolvePublicReleaseRingIdFromCliArgs', () => {
    it('infers public dev from the managed cli-dev current path when no explicit channel flag is provided', () => {
        expect(resolvePublicReleaseRingIdFromCliArgs({
            args: ['update'],
            invokedPath: '/Users/test/.happier/cli-dev/current/happier',
        })).toBe('publicdev');
    });
});
