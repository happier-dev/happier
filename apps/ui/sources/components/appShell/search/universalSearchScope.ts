import type { Session } from '@/sync/domains/state/storageTypes';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { resolveServerProfileScopeIdForSelectionIdentifier } from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import type { UniversalSearchScopeSeed } from './UniversalSearchRuntimeContext';
import { buildUniversalSearchScopeKey } from './universalSearchResult';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';

export type UniversalSearchScopeChoice = Readonly<{
    key: string;
    label: string;
    scope: UniversalSearchScopeSeed;
}>;

type UniversalSearchRouteScopeParams = Readonly<{
    accountId?: string | string[];
    serverId?: string | string[];
    sessionId?: string | string[];
    machineId?: string | string[];
    rootPath?: string | string[];
}>;

function routeScopePart(value: string | string[] | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * A route with no scope facts uses the normal ambient invocation owner. Once any
 * scope parameter is supplied, the route represents one complete explicit scope;
 * omitted/empty dimensions stay null and never inherit unrelated ambient state.
 */
export function resolveUniversalSearchRouteInitialScope(
    params: UniversalSearchRouteScopeParams,
): UniversalSearchScopeSeed | undefined {
    const hasScopeParameter = [
        params.accountId,
        params.serverId,
        params.sessionId,
        params.machineId,
        params.rootPath,
    ].some((value) => value !== undefined);
    if (!hasScopeParameter) return undefined;
    return {
        accountId: routeScopePart(params.accountId),
        serverId: routeScopePart(params.serverId),
        sessionId: routeScopePart(params.sessionId),
        machineId: routeScopePart(params.machineId),
        rootPath: routeScopePart(params.rootPath),
    };
}

export function buildUniversalSearchScopeKeyFromSeed(scope: UniversalSearchScopeSeed): string {
    return buildUniversalSearchScopeKey([
        scope.accountId,
        scope.serverId,
        scope.sessionId,
        scope.machineId,
        scope.rootPath,
        ...(scope.machineScope ? [scope.machineScope] : []),
    ]);
}

export function buildUniversalSearchScopeChoices(input: Readonly<{
    accountIdByServerId: ReadonlyMap<string, string>;
    profiles: readonly ServerProfile[];
    workspaces: readonly WorkspaceRefV1[];
    sessions: readonly Session[];
    includeAllMachines?: boolean;
    allMachinesLabel?: string;
    readMachineTarget(target: Readonly<{
        accountId: string;
        serverId: string;
        sessionId: string;
    }>): Readonly<{ machineId?: string; basePath?: string }> | null;
}>): readonly UniversalSearchScopeChoice[] {
    const choices: UniversalSearchScopeChoice[] = input.profiles.flatMap((profile) => {
        const serverId = resolveServerProfileScopeId(profile);
        const accountId = input.accountIdByServerId.get(serverId);
        if (!accountId) return [];
        const scope = {
            accountId,
            serverId,
            sessionId: null,
            machineId: null,
            rootPath: null,
        } satisfies UniversalSearchScopeSeed;
        const home = { key: buildUniversalSearchScopeKeyFromSeed(scope), label: resolveHomeDisplayLabel(profile, profile.id), scope };
        const allScope = { ...scope, machineScope: 'all' as const };
        return input.includeAllMachines ? [home, { key: buildUniversalSearchScopeKeyFromSeed(allScope),
            // With one Home the Home is implied; with several, the choice says whose machines.
            label: input.profiles.length > 1 || !input.allMachinesLabel ? `${home.label} · ${input.allMachinesLabel ?? home.label}` : input.allMachinesLabel,
            scope: allScope }] : [home];
    });
    for (const workspace of input.workspaces) {
        const serverId = resolveServerProfileScopeIdForSelectionIdentifier(input.profiles, workspace.serverId);
        if (!serverId) continue;
        const accountId = input.accountIdByServerId.get(serverId);
        if (!accountId) continue;
        const session = input.sessions.find((candidate) => {
            if (resolveServerProfileScopeIdForSelectionIdentifier(input.profiles, candidate.serverId) !== serverId) return false;
            const target = input.readMachineTarget({
                accountId,
                serverId,
                sessionId: candidate.id,
            });
            return target?.machineId === workspace.machineId && target.basePath === workspace.rootPath;
        });
        const scope = {
            accountId,
            serverId,
            machineId: workspace.machineId,
            rootPath: workspace.rootPath,
            sessionId: session?.id ?? null,
        } satisfies UniversalSearchScopeSeed;
        choices.push({
            key: buildUniversalSearchScopeKeyFromSeed(scope),
            label: workspace.label?.trim() || workspace.rootPath,
            scope,
        });
    }
    return choices;
}
