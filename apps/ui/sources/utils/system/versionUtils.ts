import { compareVersions } from '@happier-dev/protocol/updates/versionComparison';
export { compareVersions, parseVersion } from '@happier-dev/protocol/updates/versionComparison';

/**
 * Utility functions for version comparison and validation
 */

// Minimum required CLI version for full compatibility
export const MINIMUM_CLI_VERSION = '0.1.0';
// Minimum required CLI version to safely consume server-side pending queue V2.
// Keep separate from MINIMUM_CLI_VERSION so it can be bumped independently.
export const MINIMUM_CLI_PENDING_QUEUE_V2_VERSION = MINIMUM_CLI_VERSION;
// Minimum CLI version that supports the active-session runtime prompt RPC path.
// The protocol landed during 0.1.0 dev builds, before the 0.2.0 release line.
export const MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION = '0.1.0-dev.0';
// Minimum CLI version that accepts the backendTarget-based spawn payload contract.
// The protocol landed during 0.1.0 dev builds, before the 0.2.0 release line.
export const MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION = '0.1.0-dev.0';
// First CLI build whose strict session-fork request schema accepts requestId.
export const MINIMUM_CLI_SESSION_FORK_REQUEST_ID_VERSION = '0.2.10-dev.41';
export type VersionSupportState = 'supported' | 'unsupported' | 'unknown';
/**
 * Check if a version meets the minimum requirement
 * @param version Version to check
 * @param minimumVersion Minimum required version (defaults to MINIMUM_CLI_VERSION)
 * @returns true if version >= minimumVersion
 */
export function isVersionSupported(version: string | undefined, minimumVersion: string = MINIMUM_CLI_VERSION): boolean {
    return getVersionSupportState(version, minimumVersion) === 'supported';
}

export function getVersionSupportState(
    version: string | undefined,
    minimumVersion: string = MINIMUM_CLI_VERSION,
): VersionSupportState {
    if (!version) return 'unknown';

    try {
        return compareVersions(version, minimumVersion) >= 0 ? 'supported' : 'unsupported';
    } catch {
        return 'unknown';
    }
}

export function supportsSessionForkRequestId(daemonCliVersion?: string | null): boolean {
    const normalizedVersion = typeof daemonCliVersion === 'string' ? daemonCliVersion.trim() : '';
    return normalizedVersion.length > 0
        && isVersionSupported(normalizedVersion, MINIMUM_CLI_SESSION_FORK_REQUEST_ID_VERSION);
}
