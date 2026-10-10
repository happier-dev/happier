import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';
import type { WorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    normalizeWorkspaceScopeBase,
    type WorkspaceScopeBase,
} from '@/sync/domains/workspaces/workspaceScope';
import type { UniversalSearchTarget } from './universalSearchResult';
import { SETTINGS_ROUTES, settingsRoutePathname } from '@/components/settings/catalog/routes';
import { resolveWorkspaceRefByAddress } from '@/sync/domains/workspaces/workspaceRefs';

function areWorkspaceScopesEqual(left: WorkspaceScopeBase, right: WorkspaceScopeBase): boolean {
    const normalizedLeft = normalizeWorkspaceScopeBase(left);
    const normalizedRight = normalizeWorkspaceScopeBase(right);
    return normalizedLeft !== null
        && normalizedRight !== null
        && areServerProfileIdentifiersEquivalent(normalizedLeft.serverId, normalizedRight.serverId)
        && normalizedLeft.machineId === normalizedRight.machineId
        && normalizedLeft.rootPath === normalizedRight.rootPath;
}

/**
 * Currentness fences authority/scope, not hydration. A transcript hit may name
 * an archived or unloaded session which the scoped navigation owner can still
 * materialize, so session presence in the UI store is deliberately irrelevant.
 */
export function isUniversalSearchTargetCurrent(input: Readonly<{
    target: UniversalSearchTarget;
    accountScope: Readonly<{ serverId: string; accountId: string; current: boolean }> | null;
    workspaces: readonly WorkspaceRefV1[];
    settingsPages: ReadonlyMap<string, ResolvedSettingsPageNode>;
    resolveSessionWorkspaceTarget: (target: Readonly<{
        serverId: string;
        accountId: string;
        sessionId: string;
    }>) => WorkspaceTargetForSession | null;
    isWorkspaceScopeReachable: (scope: WorkspaceScopeBase) => boolean;
}>): boolean {
    const { target } = input;
    if (target.kind === 'session' || target.kind === 'memoryDocument' || target.kind === 'externalConversation') {
        return input.accountScope?.current === true
            && input.accountScope.accountId === target.accountId
            && areServerProfileIdentifiersEquivalent(input.accountScope.serverId, target.serverId);
    }
    if (target.kind === 'project') {
        return input.accountScope?.current === true
            && input.accountScope.accountId === target.accountId
            && areServerProfileIdentifiersEquivalent(input.accountScope.serverId, target.serverId)
            && resolveWorkspaceRefByAddress(input.workspaces, { serverId: target.serverId,
                workspaceId: target.workspaceRefId, machineId: target.machineId, rootPath: target.rootPath }).kind === 'resolved'
            && input.isWorkspaceScopeReachable(target);
    }
    if (target.kind === 'settingsPage') {
        // A result may name one row (`?setting=`) or a sub-page below its catalog page; either is
        // current while that page is offered. The Overview owns only its own route.
        const pathname = target.route.split('?')[0];
        return [...input.settingsPages.values()].some((page) => typeof page.route === 'string' && (
            settingsRoutePathname(page.route) === pathname
            || (page.route !== SETTINGS_ROUTES.general && pathname.startsWith(`${settingsRoutePathname(page.route)}/`))
        ));
    }
    if (!target.serverId) return false;
    const capturedScope = normalizeWorkspaceScopeBase(target.scope);
    if (
        input.accountScope?.current !== true
        || input.accountScope.accountId !== target.accountId
        || !areServerProfileIdentifiersEquivalent(input.accountScope.serverId, target.serverId)
        || capturedScope === null
        || !areServerProfileIdentifiersEquivalent(target.serverId, capturedScope.serverId)
    ) return false;
    if (target.workspaceRefId) {
        return resolveWorkspaceRefByAddress(input.workspaces, { ...capturedScope, workspaceId: target.workspaceRefId }).kind === 'resolved'
            && input.isWorkspaceScopeReachable(capturedScope);
    }
    if (!target.sessionId) return false;
    const currentScope = input.resolveSessionWorkspaceTarget({
        serverId: target.serverId,
        accountId: target.accountId,
        sessionId: target.sessionId,
    });
    return currentScope !== null
        && areWorkspaceScopesEqual(capturedScope, currentScope)
        && input.isWorkspaceScopeReachable(currentScope);
}
