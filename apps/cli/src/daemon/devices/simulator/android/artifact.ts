import { createHash } from 'node:crypto';
import { readFile as readFileDefault } from 'node:fs/promises';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';

const SCRCPY_SERVER_ASSET_SEGMENTS = ['assets', 'android', 'scrcpy-server', 'scrcpy-server.jar'] as const;

export const PINNED_ANDROID_SCRCPY_SERVER_ARTIFACT = {
    version: '3.2',
    digest: 'sha256:b920e0ea01936bf2482f4ba2fa985c22c13c621999e3d33b45baa5acfc1ea3d0',
} as const;

export type AndroidScrcpyServerArtifactMetadata = Readonly<{
    version: string;
    digest: string;
}>;

export type AndroidScrcpyServerArtifactResolution = Readonly<
    | {
        ok: true;
        path: string;
        version: string;
        digest: string;
        source: 'packaged_cli_asset' | 'dev_fixture';
    }
    | {
        ok: false;
        reasonCode:
            | 'scrcpy_server_artifact_missing'
            | 'scrcpy_server_digest_mismatch'
            | 'scrcpy_server_version_mismatch';
        diagnostics: readonly Record<string, unknown>[];
    }
>;

export type AndroidScrcpyServerArtifactResolverInput = Readonly<{
    expected?: AndroidScrcpyServerArtifactMetadata;
    source?: 'packaged_cli_asset' | 'dev_fixture';
    resolveAssetPath?: (...segments: string[]) => string;
    readFile?: (path: string) => Promise<Uint8Array> | Uint8Array;
    readMetadata?: (path: string) => Promise<AndroidScrcpyServerArtifactMetadata> | AndroidScrcpyServerArtifactMetadata;
}>;

function sha256Digest(bytes: Uint8Array): string {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function isPlaceholderSha256Digest(digest: string): boolean {
    return /^sha256:0{64}$/i.test(digest.trim());
}

function missingDiagnostic(path: string, error: unknown): Record<string, unknown> {
    return {
        platform: 'android',
        severity: 'error',
        reasonCode: 'scrcpy_server_artifact_missing',
        path,
        errorName: error instanceof Error ? error.name : 'UnknownError',
    };
}

async function readExpectedMetadata(
    readMetadata: ((path: string) => Promise<AndroidScrcpyServerArtifactMetadata> | AndroidScrcpyServerArtifactMetadata) | undefined,
    path: string,
    expected: AndroidScrcpyServerArtifactMetadata,
): Promise<AndroidScrcpyServerArtifactMetadata> {
    return await (readMetadata?.(path) ?? expected);
}

export async function resolveAndroidScrcpyServerArtifact(
    input: AndroidScrcpyServerArtifactResolverInput = {},
): Promise<AndroidScrcpyServerArtifactResolution> {
    const expected = input.expected ?? PINNED_ANDROID_SCRCPY_SERVER_ARTIFACT;
    const source = input.source ?? 'packaged_cli_asset';
    const resolveAssetPath = input.resolveAssetPath ?? resolveCliRuntimeAssetPath;
    const readFile = input.readFile ?? readFileDefault;
    const path = resolveAssetPath(...SCRCPY_SERVER_ASSET_SEGMENTS);

    if (isPlaceholderSha256Digest(expected.digest)) {
        return {
            ok: false,
            reasonCode: 'scrcpy_server_digest_mismatch',
            diagnostics: [{
                platform: 'android',
                severity: 'error',
                reasonCode: 'scrcpy_server_digest_mismatch',
                code: 'scrcpy_server_placeholder_digest',
                path,
                expectedVersion: expected.version,
                expectedDigest: expected.digest,
            }],
        };
    }

    let bytes: Uint8Array;
    try {
        bytes = await readFile(path);
    } catch (error) {
        return {
            ok: false,
            reasonCode: 'scrcpy_server_artifact_missing',
            diagnostics: [missingDiagnostic(path, error)],
        };
    }

    const metadata = await readExpectedMetadata(input.readMetadata, path, expected);
    if (metadata.version !== expected.version) {
        return {
            ok: false,
            reasonCode: 'scrcpy_server_version_mismatch',
            diagnostics: [{
                platform: 'android',
                severity: 'error',
                reasonCode: 'scrcpy_server_version_mismatch',
                path,
                expectedVersion: expected.version,
                actualVersion: metadata.version,
            }],
        };
    }

    const actualDigest = sha256Digest(bytes);
    if (actualDigest !== expected.digest || metadata.digest !== expected.digest) {
        return {
            ok: false,
            reasonCode: 'scrcpy_server_digest_mismatch',
            diagnostics: [{
                platform: 'android',
                severity: 'error',
                reasonCode: 'scrcpy_server_digest_mismatch',
                path,
                expectedDigest: expected.digest,
                actualDigest,
                metadataDigest: metadata.digest,
            }],
        };
    }

    return {
        ok: true,
        path,
        version: metadata.version,
        digest: actualDigest,
        source,
    };
}
