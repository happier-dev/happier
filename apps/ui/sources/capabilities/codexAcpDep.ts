import type { CapabilitiesDetectRequest, CapabilityDetectResult, CapabilityId, CodexAcpDepData } from '@/sync/api/capabilities/capabilitiesProtocol';
import { compareVersions, parseVersion } from '@/utils/system/versionUtils';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';

function isCodexAcpLatestVersionSuccess(
    value: CodexAcpDepData['latestVersionCheck'],
): value is Extract<NonNullable<CodexAcpDepData['latestVersionCheck']>, { ok: true }> {
    return value != null && value.ok === true;
}

function isCodexAcpLatestVersionFailure(
    value: CodexAcpDepData['latestVersionCheck'],
): value is Extract<NonNullable<CodexAcpDepData['latestVersionCheck']>, { ok: false }> {
    return value != null && value.ok === false;
}

function getCodexAcpLatestVersionCheckedAt(
    result: CapabilityDetectResult | null,
    latestVersionCheck: CodexAcpDepData['latestVersionCheck'],
): number {
    const durableCheckedAt = latestVersionCheck && typeof latestVersionCheck.checkedAt === 'number'
        ? latestVersionCheck.checkedAt
        : 0;
    if (durableCheckedAt > 0) return durableCheckedAt;
    return result && typeof result.checkedAt === 'number' ? result.checkedAt : 0;
}

type CodexAcpLatestVersionAwareData = Pick<CodexAcpDepData, 'installed' | 'latestVersionCheck'>;

export function getCodexAcpDetectResult(
    results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
): CapabilityDetectResult | null {
    const res = results?.[CODEX_ACP_DEP_ID];
    return res ? res : null;
}

export function getCodexAcpDepData(
    results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
): CodexAcpDepData | null {
    const result = getCodexAcpDetectResult(results);
    if (!result || result.ok !== true) return null;
    const data = result.data;
    return data && typeof data === 'object' ? (data as CodexAcpDepData) : null;
}

export function getCodexAcpLatestVersion(data: CodexAcpDepData | null | undefined): string | null {
    const latestVersionCheck = data?.latestVersionCheck;
    if (!isCodexAcpLatestVersionSuccess(latestVersionCheck)) return null;
    return typeof latestVersionCheck.latestVersion === 'string' ? latestVersionCheck.latestVersion : null;
}

export function getCodexAcpLatestVersionError(data: CodexAcpDepData | null | undefined): string | null {
    const latestVersionCheck = data?.latestVersionCheck;
    if (!isCodexAcpLatestVersionFailure(latestVersionCheck)) return null;
    return typeof latestVersionCheck.errorMessage === 'string' ? latestVersionCheck.errorMessage : null;
}

export function isCodexAcpUpdateAvailable(data: CodexAcpDepData | null | undefined): boolean {
    if (data?.installed !== true) return false;
    const installed = typeof data.installedVersion === 'string' ? data.installedVersion : null;
    const latest = getCodexAcpLatestVersion(data);
    if (!installed || !latest) return false;
    const installedParsed = parseVersion(installed);
    const latestParsed = parseVersion(latest);
    if (!installedParsed || !latestParsed) return false;
    return compareVersions(installed, latest) < 0;
}

export function shouldPrefetchCodexAcpLatestVersion(params: {
    result?: CapabilityDetectResult | null;
    data?: CodexAcpLatestVersionAwareData | null;
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
    const checkedAt = getCodexAcpLatestVersionCheckedAt(result, latestVersionCheck);

    if (!hasLatestVersionCheck) return true;
    if (checkedAt <= 0) return true;

    const ok = isCodexAcpLatestVersionSuccess(latestVersionCheck);
    const ageMs = now - checkedAt;
    const threshold = ok ? OK_STALE_MS : ERROR_RETRY_MS;
    return ageMs > threshold;
}

export function buildCodexAcpLatestVersionDetectRequest(): CapabilitiesDetectRequest {
    return {
        requests: [
            {
                id: CODEX_ACP_DEP_ID,
                params: { includeLatestVersion: true, onlyIfInstalled: true },
            },
        ],
    };
}
