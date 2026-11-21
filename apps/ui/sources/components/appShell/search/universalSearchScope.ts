import type { Session } from '@/sync/domains/state/storageTypes';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { resolveServerProfileScopeIdForSelectionIdentifier } from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import type { UniversalSearchScopeSeed } from './UniversalSearchRuntimeContext';
import { buildUniversalSearchScopeKey, buildUniversalSearchWorkspaceScopeKey } from './universalSearchResult';
import { workspaceScopeFromProject } from '@/sync/domains/workspaces/workspaceScope';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { ManagedWorkspaceAddressV2Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';

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
    workspace?: string | string[];
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
        params.workspace,
    ].some((value) => value !== undefined);
    if (!hasScopeParameter) return undefined;
    const scope = {
        accountId: routeScopePart(params.accountId),
        serverId: routeScopePart(params.serverId),
        sessionId: routeScopePart(params.sessionId),
        machineId: routeScopePart(params.machineId),
        rootPath: routeScopePart(params.rootPath),
    };
    if (params.workspace === undefined) return scope;
    try {
        const workspace = ManagedWorkspaceAddressV2Schema.parse(JSON.parse(routeScopePart(params.workspace) ?? 'null'));
        return { ...scope, serverId: workspace.serverId, machineId: workspace.controller.machineId,
            rootPath: workspace.rootPath, workspace };
    } catch {
        return { ...scope, machineId: null, rootPath: null, sessionId: null };
    }
}

export function buildUniversalSearchScopeKeyFromSeed(scope: UniversalSearchScopeSeed): string {
    if (scope.workspace && scope.accountId && scope.serverId && scope.machineId && scope.rootPath) {
        return buildUniversalSearchWorkspaceScopeKey(scope.accountId, {
            serverId: scope.serverId, machineId: scope.machineId, rootPath: scope.rootPath, workspace: scope.workspace,
        }, [scope.sessionId]);
    }
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
    sessions: readonly Pick<Session, 'id' | 'serverId'>[];
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
        const workspaceScope = workspaceScopeFromProject(workspace, workspace.rootPath);
        const session = workspaceScope.workspace ? undefined : input.sessions.find((candidate) => {
            if (resolveServerProfileScopeIdForSelectionIdentifier(input.profiles, candidate.serverId) !== serverId) return false;
            const target = input.readMachineTarget({
                accountId,
                serverId,
                sessionId: candidate.id,
            });
            return target?.machineId === workspaceScope.machineId && target?.basePath === workspaceScope.rootPath;
        });
        const scope = {
            accountId,
            ...workspaceScope,
            serverId,
            sessionId: session?.id ?? null,
        } satisfies UniversalSearchScopeSeed;
        choices.push({
            key: buildUniversalSearchScopeKeyFromSeed(scope),
            // The project's name, as the Projects list shows it; never the absolute path.
            label: workspace.label?.trim() || workspace.rootPath.split(/[\\/]/).filter(Boolean).pop() || workspace.rootPath,
            scope,
        });
    }
    return choices;
}
