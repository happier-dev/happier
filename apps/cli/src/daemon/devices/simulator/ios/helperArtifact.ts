import { createHash } from 'node:crypto';

import type { IosSimulatorAdapterUnavailableReasonV1 } from '@happier-dev/protocol';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';

import { verifyIosSimulatorHelperSignature } from './signature';

export type IosSimulatorHelperArtifactMetadata = Readonly<{
    version: string;
}>;

export type IosSimulatorHelperSignatureResult = Readonly<
    | { ok: true }
    | { ok: false; reasonCode: string; diagnostics?: readonly Record<string, unknown>[] }
>;

export type IosSimulatorHelperArtifactResolution = Readonly<
    | {
        ok: true;
        path: string;
        version: string;
        digest: string;
    }
    | {
        ok: false;
        reasonCode: Extract<
            IosSimulatorAdapterUnavailableReasonV1,
            | 'helper_artifact_missing'
            | 'helper_artifact_digest_mismatch'
            | 'helper_artifact_unsigned'
            | 'helper_version_mismatch'
        >;
        diagnostics: readonly Record<string, unknown>[];
    }
>;

export type ResolveIosSimulatorHelperArtifactInput = Readonly<{
    expectedVersion: string;
    expectedDigest: string;
    resolveArtifactPath?: () => string;
    readFile?: (path: string) => Promise<Uint8Array>;
    readMetadata?: (path: string) => Promise<IosSimulatorHelperArtifactMetadata>;
    verifySignature?: (path: string) => Promise<IosSimulatorHelperSignatureResult>;
}>;

async function defaultReadFile(path: string): Promise<Uint8Array> {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path);
}

async function defaultReadMetadata(path: string): Promise<IosSimulatorHelperArtifactMetadata> {
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(`${path}.json`, 'utf8');
    const parsed = JSON.parse(bytes) as { version?: unknown };
    return {
        version: typeof parsed.version === 'string' ? parsed.version : '',
    };
}

async function defaultVerifySignature(path: string): Promise<IosSimulatorHelperSignatureResult> {
    return await verifyIosSimulatorHelperSignature({ path });
}

function defaultArtifactPath(): string {
    return resolveCliRuntimeAssetPath(
        'assets',
        'ios',
        'simulator-helper',
        'happier-ios-simulator-helper',
    );
}

function sha256Digest(bytes: Uint8Array): string {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function isPlaceholderSha256Digest(digest: string): boolean {
    return /^sha256:0{64}$/i.test(digest.trim());
}

function failedArtifactResolution(
    reasonCode: Extract<IosSimulatorHelperArtifactResolution, { ok: false }>['reasonCode'],
    diagnostics: readonly Record<string, unknown>[] = [],
): IosSimulatorHelperArtifactResolution {
    return { ok: false, reasonCode, diagnostics };
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
}

export async function resolveIosSimulatorHelperArtifact(
    input: ResolveIosSimulatorHelperArtifactInput,
): Promise<IosSimulatorHelperArtifactResolution> {
    const path = (input.resolveArtifactPath ?? defaultArtifactPath)();
    const readFile = input.readFile ?? defaultReadFile;
    const readMetadata = input.readMetadata ?? defaultReadMetadata;
    const verifySignature = input.verifySignature ?? defaultVerifySignature;

    // Boundary guard: the pinned placeholder digest (all-zero) means no real signed/notarized
    // artifact has been produced yet. Fail closed before touching disk so iOS capture stays
    // unavailable until a genuine vendored artifact + digest is pinned. Mirrors the Android
    // scrcpy resolver's placeholder guard.
    if (isPlaceholderSha256Digest(input.expectedDigest)) {
        return failedArtifactResolution('helper_artifact_missing', [{
            code: 'helper_artifact_placeholder_digest',
            expectedDigest: input.expectedDigest,
        }]);
    }

    let bytes: Uint8Array;
    try {
        bytes = await readFile(path);
    } catch (error) {
        return failedArtifactResolution('helper_artifact_missing', [{
            code: 'helper_artifact_read_failed',
            errorName: errorName(error),
        }]);
    }

    const digest = sha256Digest(bytes);
    if (digest !== input.expectedDigest) {
        return failedArtifactResolution('helper_artifact_digest_mismatch', [{
            code: 'helper_artifact_digest_mismatch',
            expectedDigest: input.expectedDigest,
            actualDigest: digest,
        }]);
    }

    const signature = await verifySignature(path);
    if (!signature.ok) {
        return failedArtifactResolution('helper_artifact_unsigned', [{
            code: 'helper_artifact_signature_failed',
            reasonCode: signature.reasonCode,
            diagnostics: signature.diagnostics ?? [],
        }]);
    }

    const metadata = await readMetadata(path).catch((error: unknown) => ({
        version: '',
        diagnostics: [{
            code: 'helper_artifact_metadata_read_failed',
            errorName: errorName(error),
        }],
    }));
    if (metadata.version !== input.expectedVersion) {
        return failedArtifactResolution('helper_version_mismatch', [{
            code: 'helper_version_mismatch',
            expectedVersion: input.expectedVersion,
            actualVersion: metadata.version,
        }]);
    }

    return {
        ok: true,
        path,
        version: metadata.version,
        digest,
    };
}
