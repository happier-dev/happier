import type { Session } from '@/sync/domains/state/storageTypes';
import {
    buildSessionProjectGroupingIdentity,
    resolveSessionProjectGroupingKeyParts,
    sessionProjectGroupingIdentityKey,
} from '@/sync/domains/session/listing/sessionListProjectGroupingKeys';
import { inferProjectTitleFromPath } from '@/utils/path/browseSegments';

/**
 * What Home's composer suggests, using starter prompts and data the app already holds. Each suggestion
 * names its source; pressing one fills the composer (text and, when known, where to start) and
 * never sends.
 *
 * Sources today:
 * - `sessionHistory`: the project with the most sessions this week → "Summarize what changed in
 *   <project> since <day>", started in that project's folder on its machine.
 *
 * Starter prompts name tasks without claiming any activity. Automation authoring is offered only
 * when the Home supports Automations (the workflow definition and trigger Actions own creation).
 * No Automation outcome or PR/issue request is invented; those remain in their source widgets.
 */
export type HomeComposerSuggestionSession = Readonly<Pick<Session, 'id' | 'serverId' | 'createdAt'> & {
    metadata: Readonly<{ path?: unknown; machineId?: unknown; homeDir?: unknown; host?: unknown }> | null;
}>;

export type HomeComposerSuggestionSince =
    | Readonly<{ kind: 'today'; atMs: number }>
    | Readonly<{ kind: 'yesterday'; atMs: number }>
    | Readonly<{ kind: 'weekday'; atMs: number }>;

export type HomeComposerSuggestionPlacement = Readonly<{
    serverId: string | null;
    machineId: string;
    directory: string;
}>;

export type HomeComposerSuggestion = Readonly<{
    id: string;
    source: 'sessionHistory';
    project: string;
    sessionCount: number;
    since: HomeComposerSuggestionSince;
    fill: Readonly<{ placement: HomeComposerSuggestionPlacement }>;
}> | Readonly<{
    id: string;
    source: 'starter';
    intent: 'explain' | 'fixTest' | 'automation';
    fill: Readonly<{ placement: null }>;
}>;

const STARTER_SUGGESTIONS: readonly HomeComposerSuggestion[] = Object.freeze([
    { id: 'starter:explain', source: 'starter', intent: 'explain', fill: { placement: null } },
    { id: 'starter:fixTest', source: 'starter', intent: 'fixTest', fill: { placement: null } },
]);
const AUTOMATION_STARTER: HomeComposerSuggestion = {
    id: 'starter:automation', source: 'starter', intent: 'automation', fill: { placement: null },
};

/** "This week": today and the six days before it, whole days, so a weekday name is unambiguous. */
const WINDOW_DAYS = 7;

function startOfLocalDay(ms: number): number {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function daysBefore(dayStartMs: number, days: number): number {
    const date = new Date(dayStartMs);
    date.setDate(date.getDate() - days);
    return date.getTime();
}

function resolveSince(atMs: number, nowMs: number): HomeComposerSuggestionSince {
    const today = startOfLocalDay(nowMs);
    if (atMs >= today) return { kind: 'today', atMs };
    if (atMs >= daysBefore(today, 1)) return { kind: 'yesterday', atMs };
    return { kind: 'weekday', atMs };
}

type ProjectGroup = {
    key: string;
    serverId: string | null;
    machineId: string;
    pathKey: string;
    count: number;
    firstAtMs: number;
    lastAtMs: number;
};

export function deriveHomeComposerSuggestions(input: Readonly<{
    sessions: Iterable<HomeComposerSuggestionSession>;
    nowMs: number;
    automationsEnabled?: boolean;
}>): readonly HomeComposerSuggestion[] {
    const windowStart = daysBefore(startOfLocalDay(input.nowMs), WINDOW_DAYS - 1);
    const groups = new Map<string, ProjectGroup>();
    for (const session of input.sessions) {
        if (!(session.createdAt >= windowStart) || session.createdAt > input.nowMs) continue;
        const parts = resolveSessionProjectGroupingKeyParts(session.metadata);
        if (!parts.machineId || !parts.pathKey) continue;
        const serverId = typeof session.serverId === 'string' && session.serverId.trim() ? session.serverId.trim() : null;
        const key = sessionProjectGroupingIdentityKey(buildSessionProjectGroupingIdentity(serverId, parts));
        const group = groups.get(key);
        if (group) {
            group.count += 1;
            group.firstAtMs = Math.min(group.firstAtMs, session.createdAt);
            group.lastAtMs = Math.max(group.lastAtMs, session.createdAt);
        } else {
            groups.set(key, {
                key,
                serverId,
                machineId: parts.machineId,
                pathKey: parts.pathKey,
                count: 1,
                firstAtMs: session.createdAt,
                lastAtMs: session.createdAt,
            });
        }
    }

    let busiest: ProjectGroup | null = null;
    for (const group of groups.values()) {
        if (!busiest || group.count > busiest.count || (group.count === busiest.count && group.lastAtMs > busiest.lastAtMs)) {
            busiest = group;
        }
    }
    const starters = input.automationsEnabled ? [...STARTER_SUGGESTIONS, AUTOMATION_STARTER] : STARTER_SUGGESTIONS;
    if (!busiest) return starters;
    const project = inferProjectTitleFromPath(busiest.pathKey);
    if (!project) return starters;

    return [{
        id: `sessionHistory:${busiest.key}`,
        source: 'sessionHistory',
        project,
        sessionCount: busiest.count,
        since: resolveSince(busiest.firstAtMs, input.nowMs),
        fill: {
            placement: { serverId: busiest.serverId, machineId: busiest.machineId, directory: busiest.pathKey },
        },
    }, ...STARTER_SUGGESTIONS];
}
