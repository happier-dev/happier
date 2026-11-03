import {
    getOrganizationPolicyLock,
    assertOrganizationPolicyEndpointAllowed,
    parseOrganizationPolicyV1,
    type OrganizationPolicyField,
    type OrganizationPolicyLoadResult,
    type OrganizationPolicyLock,
} from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { readWebRuntimeConfig, type HappierWebRuntimeConfig } from '@/sync/runtime/webRuntimeConfig';

const absent: OrganizationPolicyLoadResult = Object.freeze({ status: 'absent' });
let loadedConfig: HappierWebRuntimeConfig | null = null;
let loadedPolicy: OrganizationPolicyLoadResult = absent;

/** Native startup supplies one immutable file read; renderer reads never touch the filesystem. */
export function readOrganizationPolicy(): OrganizationPolicyLoadResult {
    if (desktopHostKind() !== 'tauri') return absent;
    const config = readWebRuntimeConfig();
    if (config === loadedConfig) return loadedPolicy;
    loadedConfig = config;
    loadedPolicy = config?.organizationPolicyError
        ? { status: 'invalid', error: config.organizationPolicyError }
        : typeof config?.organizationPolicyJson === 'string'
            ? parseOrganizationPolicyV1(config.organizationPolicyJson)
            : absent;
    return loadedPolicy;
}

export function getOrganizationPolicyFieldLock(field: OrganizationPolicyField): OrganizationPolicyLock | null {
    return getOrganizationPolicyLock(readOrganizationPolicy(), field);
}

/** Home adoption and focus share this admission; the configured locked Home remains usable. */
export function assertOrganizationHomeSelectionAllowed(serverUrl: string): void {
    assertOrganizationPolicyEndpointAllowed(readOrganizationPolicy(), 'home', serverUrl);
}
