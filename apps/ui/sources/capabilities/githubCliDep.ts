import type { CapabilitiesDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { GH_DEP_ID } from '@happier-dev/protocol/installables';

import type { InstallableDepDataLike } from './installablesRegistry';

type LatestVersionCheck = InstallableDepDataLike['latestVersionCheck'];

function isLatestVersionSuccess(value: LatestVersionCheck): value is Extract<NonNullable<LatestVersionCheck>, { ok: true }> {
    return value != null && value.ok === true;
}

function getLatestVersionCheckedAt(result: CapabilityDetectResult | null, latestVersionCheck: LatestVersionCheck): number {
    const durableCheckedAt = latestVersionCheck && typeof latestVersionCheck.checkedAt === 'number'
        ? latestVersionCheck.checkedAt
        : 0;
    if (durableCheckedAt > 0) return durableCheckedAt;
    return result && typeof result.checkedAt === 'number' ? result.checkedAt : 0;
}

export function getGithubCliDetectResult(
    results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
): CapabilityDetectResult | null {
    const res = results?.[GH_DEP_ID];
    return res ? res : null;
}

export function getGithubCliDepData(
    results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
): InstallableDepDataLike | null {
    const result = getGithubCliDetectResult(results);
    if (!result || result.ok !== true) return null;
    const data = result.data;
    return data && typeof data === 'object' ? (data as InstallableDepDataLike) : null;
}

export function shouldPrefetchGithubCliLatestVersion(params: {
    result?: CapabilityDetectResult | null;
    data?: Pick<InstallableDepDataLike, 'installed' | 'latestVersionCheck'> | null;
    requireExistingResult?: boolean;
}): boolean {
    const OK_STALE_MS = 24 * 60 * 60 * 1000;
    const ERROR_RETRY_MS = 30 * 60 * 1000;

    const now = Date.now();
    const requireExistingResult = params.requireExistingResult === true;
    const result = params.result ?? null;
    const data = params.data ?? null;

    if (!result || result.ok !== true) {
        return requireExistingResult ? false : true;
    }

    if (!data || data.installed !== true) {
        return requireExistingResult ? false : true;
    }

    const latestVersionCheck = data.latestVersionCheck;
    const hasLatestVersionCheck = latestVersionCheck != null;
    const checkedAt = getLatestVersionCheckedAt(result, latestVersionCheck);

    if (!hasLatestVersionCheck) return true;
    if (checkedAt <= 0) return true;

    const ageMs = now - checkedAt;
    const threshold = isLatestVersionSuccess(latestVersionCheck) ? OK_STALE_MS : ERROR_RETRY_MS;
    return ageMs > threshold;
}

export function buildGithubCliLatestVersionDetectRequest(): CapabilitiesDetectRequest {
    return {
        requests: [
            {
                id: GH_DEP_ID,
                params: { includeLatestVersion: true, onlyIfInstalled: true },
            },
        ],
    };
}
