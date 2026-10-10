import {
    resolveHomeTargetSummary,
    type HomeConnectionStatusKey,
    type HomeConnectionSummary,
} from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import { resolveHomeDisplayLabel, resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import {
    areServerProfileIdentifiersEquivalent,
    isServerProfilePersonalHomeBootstrapCompleted,
    resolveServerProfileScopeId,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import type { ServerSelectionGroup } from '@/sync/domains/server/selection/serverSelectionTypes';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { t } from '@/text';

export const HOMES_COLLECTION_ROOT = SETTINGS_ROUTES.servers;
export const HOMES_ADD_ROUTE = `${HOMES_COLLECTION_ROOT}/add` as const;
export const HOMES_DEVICE_ROUTE = `${HOMES_COLLECTION_ROOT}/device` as const;
export const HOMES_GROUP_NEW_ROUTE = `${HOMES_COLLECTION_ROOT}/groups/new` as const;

export type HomeCollectionRow = Readonly<{
    /** The Home's scope id: its route segment and selection key. */
    id: string;
    profile: ServerProfile;
    title: string;
    serverUrl: string;
    current: boolean;
    deviceDefault: boolean;
    summary: HomeConnectionSummary;
    statusKey: HomeConnectionStatusKey;
    /** The Home needs the person (sign in again, or it cannot be reached). */
    needsAttention: boolean;
}>;

export type HomeCollectionGroupRow = Readonly<{
    id: string;
    group: ServerSelectionGroup;
    title: string;
    count: number;
    current: boolean;
}>;

export type HomeCollection = Readonly<{
    homes: readonly HomeCollectionRow[];
    groups: readonly HomeCollectionGroupRow[];
}>;

/** A Home's metadata: its location or address, use here, and any trouble. */
export function describeHomeRow(row: HomeCollectionRow): string {
    const facts: string[] = [];
    // A generic human title must not erase the identifier that distinguishes
    // unnamed Homes. Keep it in metadata even when there is also a status fact.
    if (!resolveHomeDisplayName(row.profile)) facts.push(toServerUrlDisplay(row.serverUrl));
    if (isServerProfilePersonalHomeBootstrapCompleted(row.profile)) facts.push(t('homesJourneys.livesOnThisComputer'));
    if (row.current) facts.push(t('addFlows.homesInUse'));
    if (row.needsAttention || row.summary.kind === 'reconnecting') facts.push(t(row.summary.statusLabelKey));
    if (facts.length === 0) facts.push(toServerUrlDisplay(row.serverUrl));
    return facts.join(' · ');
}

/**
 * The Homes this device knows, as Settings → Homes lists them: the Home in use first, then the other
 * saved Homes in their saved order, then the groups of Homes. Each Home carries its connection
 * summary from the one summary owner, so the list and the Home's page say the same thing.
 */
export function buildHomeCollection(input: Readonly<{
    servers: readonly ServerProfile[];
    groups: readonly ServerSelectionGroup[];
    activeServerId: string;
    activeTargetKey: string | null;
    deviceDefaultServerId: string | null;
    authStatusByServerId: Readonly<Record<string, 'signedIn' | 'signedOut' | 'unknown'>>;
    homeConnectionSummaryByServerId: Readonly<Record<string, HomeConnectionSummary>>;
}>): HomeCollection {
    const rows = input.servers.map((profile): HomeCollectionRow => {
        const id = resolveServerProfileScopeId(profile);
        const current = input.activeTargetKey
            ? input.activeTargetKey === `server:${id}`
            : id === input.activeServerId || profile.id === input.activeServerId;
        const authStatus = input.authStatusByServerId[id] ?? input.authStatusByServerId[profile.id] ?? 'unknown';
        const summary = input.homeConnectionSummaryByServerId[id]
            ?? input.homeConnectionSummaryByServerId[profile.id]
            ?? resolveHomeTargetSummary({ authStatus });
        return {
            id,
            profile,
            title: resolveHomeDisplayLabel(profile, profile.id),
            serverUrl: profile.canonicalServerUrl ?? profile.serverUrl,
            current,
            deviceDefault: input.deviceDefaultServerId != null
                && areServerProfileIdentifiersEquivalent(id, input.deviceDefaultServerId),
            summary,
            statusKey: summary.statusKey,
            needsAttention: summary.kind === 'sign_in' || summary.kind === 'unavailable',
        };
    });
    const current = rows.filter((row) => row.current);
    const others = rows.filter((row) => !row.current);
    return {
        homes: [...current, ...others],
        groups: input.groups.map((group) => ({
            id: group.id,
            group,
            title: group.name,
            count: group.serverIds.length,
            current: input.activeTargetKey === `group:${group.id}`,
        })),
    };
}

export function homeCollectionHref(homeId: string): string {
    return `${HOMES_COLLECTION_ROOT}/${encodeURIComponent(homeId)}`;
}

export function homeGroupCollectionHref(groupId: string): string {
    return `${HOMES_COLLECTION_ROOT}/groups/${encodeURIComponent(groupId)}`;
}

/**
 * The rail row the route selects: `device` (the Homes page: how this device reaches its Homes),
 * `homeDraft` (a Home being added), `home:<id>`, `groupDraft` (a group being made) or `group:<id>`.
 */
export function resolveSelectedHomeCollectionKey(pathname: string): string | null {
    const normalized = pathname.replace(/\/+$/, '');
    if (normalized === HOMES_COLLECTION_ROOT || normalized === HOMES_DEVICE_ROUTE) return 'device';
    if (!normalized.startsWith(`${HOMES_COLLECTION_ROOT}/`)) return null;
    const segments = normalized.slice(HOMES_COLLECTION_ROOT.length + 1).split('/').map(decodeSegment);
    if (segments[0] === 'add' && segments.length === 1) return 'homeDraft';
    if (segments[0] === 'device' && segments.length === 1) return 'device';
    if (segments[0] === 'groups') {
        if (segments[1] === 'new') return 'groupDraft';
        return segments[1] ? `group:${segments[1]}` : null;
    }
    return segments.length === 1 && segments[0] ? `home:${segments[0]}` : null;
}

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}
