import { admitOpaqueInternalReturnPath } from '@/utils/path/routeUtils';

type ParamValue = string | string[] | undefined;

const HOME_RECOVERY_ROUTE = '/server' as const;

function firstString(value: ParamValue): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[0] ?? '';
    return '';
}

function parseBoolean(value: string): boolean {
    const v = value.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parseSource(value: string): 'notification' | null {
    const v = value.trim().toLowerCase();
    if (v === 'notification') return 'notification';
    return null;
}

function normalizeServerIds(values: readonly unknown[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of values) {
        if (typeof raw !== 'string') continue;
        const serverId = raw.trim();
        if (!serverId || seen.has(serverId)) continue;
        seen.add(serverId);
        result.push(serverId);
    }
    return result;
}

function parseServerIds(value: string): string[] {
    if (!value.trim()) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? normalizeServerIds(parsed) : [];
    } catch {
        return [];
    }
}

export function parseServerSettingsRouteParams(params: Readonly<{
    url?: ParamValue;
    auto?: ParamValue;
    source?: ParamValue;
    groupEditor?: ParamValue;
    groupServerIds?: ParamValue;
    recoveryProfile?: ParamValue;
    recoveryReturnTo?: ParamValue;
}>): Readonly<{
    url: string | null;
    auto: boolean;
    source: 'notification' | null;
    groupEditor: boolean;
    initialGroupServerIds: readonly string[];
    /** Exact saved Home addressed by the recovery action, never inferred from focus. */
    recovery: Readonly<{ profileRef: string; returnTo: string }> | null;
}> {
    const url = firstString(params.url).trim();
    const autoRaw = firstString(params.auto);
    const sourceRaw = firstString(params.source);
    const groupEditorRaw = firstString(params.groupEditor);
    const groupServerIdsRaw = firstString(params.groupServerIds);
    const recoveryProfile = firstString(params.recoveryProfile).trim();
    const recoveryReturnTo = admitOpaqueInternalReturnPath(firstString(params.recoveryReturnTo))
        ?? HOME_RECOVERY_ROUTE;
    return {
        url: url ? url : null,
        auto: autoRaw ? parseBoolean(autoRaw) : false,
        source: sourceRaw ? parseSource(sourceRaw) : null,
        groupEditor: groupEditorRaw ? parseBoolean(groupEditorRaw) : false,
        initialGroupServerIds: parseServerIds(groupServerIdsRaw),
        recovery: recoveryProfile ? { profileRef: recoveryProfile, returnTo: recoveryReturnTo } : null,
    };
}

/**
 * Canonical full-screen Home recovery route. The saved profile is the exact
 * authentication target; the invoking path is normalized before an external
 * method is allowed to persist it as a return destination.
 */
export function buildHomeRecoveryHref(input: Readonly<{
    profileRef: string;
    returnTo: string;
}>): Readonly<{
    pathname: typeof HOME_RECOVERY_ROUTE;
    params: Readonly<{ recoveryProfile: string; recoveryReturnTo: string }>;
}> {
    const profileRef = input.profileRef.trim();
    if (!profileRef) throw new Error('Home recovery requires an exact saved profile');
    return {
        pathname: HOME_RECOVERY_ROUTE,
        params: {
            recoveryProfile: profileRef,
            recoveryReturnTo: admitOpaqueInternalReturnPath(input.returnTo) ?? HOME_RECOVERY_ROUTE,
        },
    };
}

export function buildServerSettingsGroupEditorHref(input: Readonly<{
    initialGroupServerIds: readonly string[];
}>): Readonly<{
    pathname: '/settings/server/groups/new';
    params: Readonly<{ groupServerIds: string }>;
}> {
    return {
        pathname: '/settings/server/groups/new',
        params: {
            groupServerIds: JSON.stringify(normalizeServerIds(input.initialGroupServerIds)),
        },
    };
}
