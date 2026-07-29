import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalize } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    PINNED_ANDROID_SCRCPY_SERVER_ARTIFACT,
    resolveAndroidScrcpyServerArtifact,
} from './artifact';

function sha256(bytes: Uint8Array): string {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const trustedBytes = new TextEncoder().encode('trusted scrcpy server bytes');
const trustedMetadata = {
    version: '3.2',
    digest: sha256(trustedBytes),
};
const officialScrcpyServerV32Digest = 'sha256:b920e0ea01936bf2482f4ba2fa985c22c13c621999e3d33b45baa5acfc1ea3d0';

describe('resolveAndroidScrcpyServerArtifact', () => {
    it('pins the default artifact to the official scrcpy-server v3.2 digest', () => {
        expect(PINNED_ANDROID_SCRCPY_SERVER_ARTIFACT).toEqual({
            version: '3.2',
            digest: officialScrcpyServerV32Digest,
        });
    });

    it('rejects placeholder expected digests before trusting packaged bytes', async () => {
        const readFile = vi.fn(async () => trustedBytes);
        const readMetadata = vi.fn(async () => ({
            version: '3.2',
            digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        }));

        await expect(resolveAndroidScrcpyServerArtifact({
            expected: {
                version: '3.2',
                digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            },
            resolveAssetPath: () => '/runtime/assets/android/scrcpy-server/scrcpy-server.jar',
            readFile,
            readMetadata,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'scrcpy_server_digest_mismatch',
            diagnostics: [expect.objectContaining({
                code: 'scrcpy_server_placeholder_digest',
                expectedDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            })],
        });

        expect(readFile).not.toHaveBeenCalled();
        expect(readMetadata).not.toHaveBeenCalled();
    });

    it('fails closed when the pinned server jar is missing', async () => {
        await expect(resolveAndroidScrcpyServerArtifact({
            expected: trustedMetadata,
            resolveAssetPath: () => '/runtime/assets/android/scrcpy-server/scrcpy-server.jar',
            readFile: async () => {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            },
            readMetadata: async () => trustedMetadata,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'scrcpy_server_artifact_missing',
        });
    });

    it('fails closed when the server jar digest does not match pinned metadata', async () => {
        await expect(resolveAndroidScrcpyServerArtifact({
            expected: {
                version: trustedMetadata.version,
                digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
            },
            resolveAssetPath: () => '/runtime/assets/android/scrcpy-server/scrcpy-server.jar',
            readFile: async () => trustedBytes,
            readMetadata: async () => trustedMetadata,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'scrcpy_server_digest_mismatch',
            diagnostics: [expect.objectContaining({
                expectedDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                actualDigest: trustedMetadata.digest,
            })],
        });
    });

    it('fails closed when packaged metadata is for a different scrcpy-server version', async () => {
        await expect(resolveAndroidScrcpyServerArtifact({
            expected: trustedMetadata,
            resolveAssetPath: () => '/runtime/assets/android/scrcpy-server/scrcpy-server.jar',
            readFile: async () => trustedBytes,
            readMetadata: async () => ({
                ...trustedMetadata,
                version: '3.1',
            }),
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'scrcpy_server_version_mismatch',
            diagnostics: [expect.objectContaining({
                expectedVersion: '3.2',
                actualVersion: '3.1',
            })],
        });
    });

    it('returns a trusted packaged artifact when bytes and metadata match', async () => {
        await expect(resolveAndroidScrcpyServerArtifact({
            expected: trustedMetadata,
            resolveAssetPath: () => '/runtime/assets/android/scrcpy-server/scrcpy-server.jar',
            readFile: async () => trustedBytes,
            readMetadata: async () => trustedMetadata,
        })).resolves.toEqual({
            ok: true,
            path: '/runtime/assets/android/scrcpy-server/scrcpy-server.jar',
            version: '3.2',
            digest: trustedMetadata.digest,
            source: 'packaged_cli_asset',
        });
    });

    it('resolves the packaged jar only from the CLI simulator asset directory', async () => {
        const resolution = await resolveAndroidScrcpyServerArtifact({
            expected: trustedMetadata,
            readFile: async () => {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            },
            readMetadata: async () => trustedMetadata,
        });

        expect(resolution).toMatchObject({
            ok: false,
            reasonCode: 'scrcpy_server_artifact_missing',
            diagnostics: [expect.objectContaining({
                path: expect.any(String),
            })],
        });
        if (resolution.ok) return;
        const path = normalize(String(resolution.diagnostics[0]?.path ?? ''));
        expect(path.endsWith(normalize('apps/cli/assets/android/scrcpy-server/scrcpy-server.jar'))).toBe(true);
    });

    it('keeps first-party simulator assets in the CLI package file list', () => {
        const packageJson = JSON.parse(readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8')) as {
            files?: unknown;
        };
        const files = Array.isArray(packageJson.files) ? packageJson.files.map((entry) => String(entry)) : [];

        expect(files).toEqual(expect.arrayContaining([
            'assets/android/scrcpy-server',
            'assets/android/scrcpy-server/**',
            'assets/ios/simulator-helper',
            'assets/ios/simulator-helper/**',
        ]));
    });

    it('records official scrcpy-server v3.2 provenance in the packaged manifest', () => {
        const manifest = JSON.parse(
            readFileSync(new URL('../../../../../assets/android/scrcpy-server/manifest.json', import.meta.url), 'utf8'),
        ) as {
            artifact?: unknown;
            status?: unknown;
            upstream?: unknown;
            upstreamRelease?: unknown;
            artifactUrl?: unknown;
            checksumUrl?: unknown;
            license?: unknown;
            version?: unknown;
            sha256?: unknown;
        };

        expect(manifest).toMatchObject({
            artifact: 'scrcpy-server.jar',
            status: 'pinned_official_upstream_artifact',
            upstream: 'https://github.com/Genymobile/scrcpy',
            upstreamRelease: 'https://github.com/Genymobile/scrcpy/releases/tag/v3.2',
            artifactUrl: 'https://github.com/Genymobile/scrcpy/releases/download/v3.2/scrcpy-server-v3.2',
            checksumUrl: 'https://github.com/Genymobile/scrcpy/releases/download/v3.2/SHA256SUMS.txt',
            license: 'Apache-2.0',
            version: '3.2',
            sha256: officialScrcpyServerV32Digest,
        });
    });

    it('packages the upstream Apache-2.0 license evidence beside the scrcpy artifact', () => {
        const licenseText = readFileSync(
            new URL('../../../../../assets/android/scrcpy-server/LICENSE.scrcpy', import.meta.url),
            'utf8',
        );
        const noticeText = readFileSync(
            new URL('../../../../../assets/android/scrcpy-server/NOTICE.md', import.meta.url),
            'utf8',
        );

        expect(licenseText).toContain('Apache License');
        expect(licenseText).toContain('Copyright (C) 2018-2025 Romain Vimont');
        expect(noticeText).toContain('https://github.com/Genymobile/scrcpy/releases/tag/v3.2');
        expect(noticeText).toContain(officialScrcpyServerV32Digest);
    });

    it('uses only injected asset and file boundaries without shelling out or downloading', async () => {
        const resolveAssetPath = vi.fn(() => '/runtime/assets/android/scrcpy-server/scrcpy-server.jar');
        const readFile = vi.fn(async () => trustedBytes);
        const readMetadata = vi.fn(async () => trustedMetadata);

        await expect(resolveAndroidScrcpyServerArtifact({
            expected: trustedMetadata,
            resolveAssetPath,
            readFile,
            readMetadata,
            source: 'dev_fixture',
        })).resolves.toMatchObject({
            ok: true,
            source: 'dev_fixture',
        });

        expect(resolveAssetPath).toHaveBeenCalledWith('assets', 'android', 'scrcpy-server', 'scrcpy-server.jar');
        expect(readFile).toHaveBeenCalledTimes(1);
        expect(readMetadata).toHaveBeenCalledTimes(1);
    });
});
