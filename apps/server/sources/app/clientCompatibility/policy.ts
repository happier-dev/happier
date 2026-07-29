import {
    CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
    ClientCompatibilityCapabilitiesV1Schema,
    type ClientKind,
    type SessionSyncServerRequirementsV1,
} from '@happier-dev/protocol';
import * as semver from 'semver';

export const SESSION_SYNC_COMPATIBILITY_ENV_KEYS = Object.freeze({
    enforcement: 'HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT',
    minimumProtocolVersion: 'HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION',
    minimumVersionsByClientKind: 'HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON',
    upgradeUrlsByClientKind: 'HAPPIER_SESSION_SYNC_COMPATIBILITY__UPGRADE_URLS_JSON',
} as const);

export interface SessionSyncCompatibilityPolicy {
    readonly valid: boolean;
    /** Operator intent retained even when the advertised policy falls back to safe observe defaults. */
    readonly requestedEnforcement: 'observe' | 'required';
    readonly requirements: SessionSyncServerRequirementsV1;
}

const FALLBACK_REQUIREMENTS: SessionSyncServerRequirementsV1 = Object.freeze({
    v: 1,
    enforcement: 'observe',
    minimumSessionSyncProtocolVersion: CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
    currentSessionSyncProtocolVersion: CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
    declarationTransport: 'headers-v1',
});

function readCanonicalPositiveInteger(raw: string | undefined): number | null {
    if (raw === undefined || raw.length === 0) return CURRENT_SESSION_SYNC_PROTOCOL_VERSION;
    if (!/^[1-9][0-9]*$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
}

function readOptionalJsonMap(raw: string | undefined): unknown {
    if (raw === undefined || raw.trim().length === 0) return undefined;
    return JSON.parse(raw) as unknown;
}

function hasOnlyComparableMinimumVersions(
    values: Partial<Record<ClientKind, string>> | undefined,
): boolean {
    return values === undefined || Object.values(values).every((value) => semver.valid(value) !== null);
}

export function resolveSessionSyncCompatibilityPolicy(
    env: Readonly<Record<string, string | undefined>>,
): SessionSyncCompatibilityPolicy {
    const enforcementRaw = env[SESSION_SYNC_COMPATIBILITY_ENV_KEYS.enforcement]?.trim() || 'observe';
    const requestedEnforcement = enforcementRaw === 'required' ? 'required' : 'observe';
    const invalidPolicy = (): SessionSyncCompatibilityPolicy => ({
        valid: false,
        requestedEnforcement,
        requirements: FALLBACK_REQUIREMENTS,
    });
    try {
        if (enforcementRaw !== 'observe' && enforcementRaw !== 'required') {
            return invalidPolicy();
        }

        const minimumProtocolVersion = readCanonicalPositiveInteger(
            env[SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumProtocolVersion]?.trim(),
        );
        if (minimumProtocolVersion === null) {
            return invalidPolicy();
        }

        const candidate = ClientCompatibilityCapabilitiesV1Schema.safeParse({
            v: 1,
            sessionSync: {
                v: 1,
                enforcement: enforcementRaw,
                minimumSessionSyncProtocolVersion: minimumProtocolVersion,
                currentSessionSyncProtocolVersion: CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
                declarationTransport: 'headers-v1',
                minimumVersionsByClientKind: readOptionalJsonMap(
                    env[SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumVersionsByClientKind],
                ) as Partial<Record<ClientKind, string>> | undefined,
                upgradeUrlsByClientKind: readOptionalJsonMap(
                    env[SESSION_SYNC_COMPATIBILITY_ENV_KEYS.upgradeUrlsByClientKind],
                ) as Partial<Record<ClientKind, string>> | undefined,
            },
        });
        if (!candidate.success) return invalidPolicy();

        const requirements = candidate.data.sessionSync;
        if (!hasOnlyComparableMinimumVersions(requirements.minimumVersionsByClientKind)) {
            return invalidPolicy();
        }
        return { valid: true, requestedEnforcement, requirements };
    } catch {
        return invalidPolicy();
    }
}
