import { readFileSync } from 'node:fs';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';

// Compute-and-pin-at-build, verify-at-launch digest mechanism for the vendored iOS simulator
// helper.
//
// The build/sign/notarize pipeline (scripts/buildIosSimulatorHelper.mjs) is the PRODUCER: it
// computes the SHA-256 of the signed+notarized+stapled binary and writes it (with the version and
// a `pinned_signed_notarized_helper` status) into the vendored `manifest.json`. This reader is the
// CONSUMER: it reads that manifest at daemon boot and derives the launch-time pin from it, so no
// human has to hand-edit a digest constant after running the signer. The artifact resolver then
// re-hashes the bytes on disk and verifies they match this pin before the helper is ever launched.
//
// Fail-closed by construction: any of {unreadable manifest, malformed fields, non-production
// distribution, placeholder all-zero digest, placeholder version} downgrades to the placeholder
// pin, whose all-zero digest the resolver rejects up front — so iOS capture stays unavailable.

export type IosSimulatorHelperPin = Readonly<{
    version: string;
    digest: string;
}>;

/**
 * The fail-closed placeholder pin. Its all-zero digest is rejected by the artifact resolver's
 * placeholder guard, keeping iOS capture unavailable until a real signed/notarized helper is
 * vendored and its real digest lands in the manifest.
 */
export const PLACEHOLDER_IOS_SIMULATOR_HELPER_PIN: IosSimulatorHelperPin = {
    version: '0.0.0-unavailable',
    digest: `sha256:${'0'.repeat(64)}`,
};

export type IosSimulatorHelperManifest = Readonly<{
    status?: unknown;
    helperDistribution?: unknown;
    version?: unknown;
    sha256?: unknown;
}>;

export type ResolveIosSimulatorHelperPinInput = Readonly<{
    readManifest?: () => IosSimulatorHelperManifest;
}>;

function defaultManifestPath(): string {
    return resolveCliRuntimeAssetPath('assets', 'ios', 'simulator-helper', 'manifest.json');
}

function defaultReadManifest(): IosSimulatorHelperManifest {
    const raw = readFileSync(defaultManifestPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as IosSimulatorHelperManifest;
}

function isNonPlaceholderSha256(value: unknown): value is string {
    return typeof value === 'string'
        && /^sha256:[0-9a-f]{64}$/i.test(value.trim())
        && !/^sha256:0{64}$/i.test(value.trim());
}

function isRealVersion(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value !== '0.0.0-unavailable';
}

/**
 * Resolve the launch-time helper pin from the vendored manifest, falling back to the fail-closed
 * placeholder for any unverified / unproduced state.
 */
export function resolveIosSimulatorHelperPin(
    input: ResolveIosSimulatorHelperPinInput = {},
): IosSimulatorHelperPin {
    const readManifest = input.readManifest ?? defaultReadManifest;
    let manifest: IosSimulatorHelperManifest;
    try {
        manifest = readManifest();
    } catch {
        return PLACEHOLDER_IOS_SIMULATOR_HELPER_PIN;
    }

    if (
        manifest.status !== 'pinned_signed_notarized_helper'
        || manifest.helperDistribution !== 'prebuilt-signed'
        || !isRealVersion(manifest.version)
        || !isNonPlaceholderSha256(manifest.sha256)
    ) {
        return PLACEHOLDER_IOS_SIMULATOR_HELPER_PIN;
    }

    return {
        version: manifest.version,
        digest: manifest.sha256.trim(),
    };
}
