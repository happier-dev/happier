import * as React from 'react';
import { renderSessionRoleBlockV1 } from '@happier-dev/protocol/prompts/roles/renderSessionRoleBlockV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ResolvedRoleV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getPromptLibraryCatalogValue, subscribePromptLibraryCatalogSnapshots } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { observePromptLibraryCatalog } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createRoleCatalogProjection, findRoleDisplayName, parseRolesListOutput, resolveRoleDisplayName, type RoleCatalogEntry, type RolesListItem } from '@/sync/domains/roles/roleCatalog';
import type { WorkflowRoleV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';

export type RoleCatalogState = Readonly<{
    status: 'loading' | 'ready' | 'failed';
    entries: ReadonlyArray<RoleCatalogEntry>;
    refresh: () => void;
}>;

type ScopeSnapshot = Readonly<{ items: ReadonlyArray<RolesListItem> | null; failed: boolean }>;

const EMPTY_ENTRIES: ReadonlyArray<RoleCatalogEntry> = Object.freeze([]);
type ScopeCell = { snapshot: ScopeSnapshot; project: ReturnType<typeof createRoleCatalogProjection>; invalidated: boolean };
const lastKnownByScope = new Map<string, ScopeCell>();
const listeners = new Set<() => void>();
const inFlightByScope = new Map<string, Promise<void>>();
let execute: ReturnType<typeof createFrontDoorActionExecute> | null = null;

function publish(scopeKey: string, snapshot: ScopeSnapshot): void {
    const cell = lastKnownByScope.get(scopeKey);
    if (!cell || sameStrictJsonValue(cell.snapshot, snapshot)) return;
    cell.snapshot = snapshot;
    for (const listener of listeners) listener();
}

/** One `roles.list` per scope at a time; concurrent opens share it. */
function loadRoleCatalog(scope: ServerAccountScope, invalidated = false): Promise<void> {
    const scopeKey = serverAccountScopeKeySuffix(scope);
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !areServerAccountScopesEqual(lifetime.scope, scope)) return Promise.resolve();
    const pending = inFlightByScope.get(scopeKey);
    if (pending) {
        const cell = lastKnownByScope.get(scopeKey);
        if (invalidated && cell) cell.invalidated = true;
        return pending;
    }
    if (!lastKnownByScope.has(scopeKey)) {
        const cell: ScopeCell = { snapshot: { items: null, failed: false }, project: createRoleCatalogProjection(), invalidated: false };
        lastKnownByScope.set(scopeKey, cell);
        lifetime.onRetire(() => {
            if (lastKnownByScope.get(scopeKey) !== cell) return;
            lastKnownByScope.delete(scopeKey);
            inFlightByScope.delete(scopeKey);
            for (const listener of listeners) listener();
        });
    }
    execute ??= createFrontDoorActionExecute();
    const request = execute('roles.list', {}, { surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId })
        .then((result) => {
            if (!lifetime.isCurrent()) return;
            const items = result.ok ? parseRolesListOutput(result.result) : null;
            const previous = lastKnownByScope.get(scopeKey)?.snapshot;
            publish(scopeKey, items === null
                ? { items: previous?.items ?? null, failed: true }
                : { items, failed: false });
        }, () => {
            if (!lifetime.isCurrent()) return;
            const previous = lastKnownByScope.get(scopeKey)?.snapshot;
            publish(scopeKey, { items: previous?.items ?? null, failed: true });
        })
        .finally(() => {
            if (inFlightByScope.get(scopeKey) !== request) return;
            inFlightByScope.delete(scopeKey);
            const cell = lastKnownByScope.get(scopeKey);
            if (lifetime.isCurrent() && cell?.invalidated) {
                cell.invalidated = false;
                return loadRoleCatalog(scope);
            }
        });
    inFlightByScope.set(scopeKey, request);
    return request;
}

/** Re-reads the catalog after a role write, for every open surface of that scope. */
export function invalidateRoleCatalog(scopeKey?: string): void {
    const scope = getActiveServerAccountScope();
    if (scope && (scopeKey === undefined || scopeKey === serverAccountScopeKeySuffix(scope))) void loadRoleCatalog(scope, true);
}

/**
 * Every role the reader can use: the documents `roles.list` returns (built-in, plugin, own and
 * shared), each resolved with the reader's current catalog override by the one resolver. Mount it only in
 * an open surface: the read happens on mount and keeps the last known list per account while it
 * refreshes.
 */
const subscribeCatalog = (listener: () => void) => {
    listeners.add(listener);
    const unsubscribeOverrides = subscribePromptLibraryCatalogSnapshots(listener);
    return () => { listeners.delete(listener); unsubscribeOverrides(); };
};
const selectEntries = (entries: ReadonlyArray<RoleCatalogEntry>) => entries;
const subscribeNoCatalog = () => () => {};

function useRoleCatalogSelectionValue<T>(select: (entries: ReadonlyArray<RoleCatalogEntry>) => T, refreshOnMount = true, serverId?: string | null, active = true) {
    const profileScope = useActiveServerAccountScope();
    const scope = useActiveServerAccountScope(serverId === undefined ? profileScope?.serverId ?? null : serverId);
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : 'local';
    const read = React.useCallback(() => {
        if (!active) return select(EMPTY_ENTRIES);
        const overrides = getPromptLibraryCatalogValue(scope, 'role-overrides').value?.overrides;
        const cell = lastKnownByScope.get(scopeKey);
        return select(cell?.snapshot.items && overrides ? cell.project({ items: cell.snapshot.items, overrides }) : EMPTY_ENTRIES);
    }, [active, scopeKey, scope, select]);
    const selection = React.useSyncExternalStore(active ? subscribeCatalog : subscribeNoCatalog, read, read);
    React.useEffect(() => active && scope ? observePromptLibraryCatalog(scope) : undefined, [active, scopeKey]);
    React.useEffect(() => {
        if (active && scope && refreshOnMount) void loadRoleCatalog(scope);
    }, [active, scopeKey, refreshOnMount]);
    const refresh = React.useCallback(() => { if (scope) void loadRoleCatalog(scope); }, [scopeKey]);
    return { selection, refresh, scopeKey, scope };
}

function useRoleCatalogSelection<T>(select: (entries: ReadonlyArray<RoleCatalogEntry>) => T, refreshOnMount = true, serverId?: string | null, active = true) {
    const { selection, refresh, scopeKey, scope } = useRoleCatalogSelectionValue(select, refreshOnMount, serverId, active);
    const readStatus = React.useCallback((): RoleCatalogState['status'] => {
        if (!scope) return 'failed';
        const overrideCatalog = getPromptLibraryCatalogValue(scope, 'role-overrides');
        if (overrideCatalog.status === 'unavailable') return 'failed';
        if (!overrideCatalog.value?.overrides) return 'loading';
        const snapshot = lastKnownByScope.get(scopeKey)?.snapshot;
        return snapshot?.items ? 'ready' : snapshot?.failed ? 'failed' : 'loading';
    }, [scopeKey, scope]);
    const status = React.useSyncExternalStore(subscribeCatalog, readStatus, readStatus);
    return React.useMemo(() => ({
        status,
        selection,
        refresh,
    }), [selection, refresh, status]);
}

export function useRoleCatalog(serverId?: string | null): RoleCatalogState {
    const { selection: entries, status, refresh } = useRoleCatalogSelection(selectEntries, true, serverId);
    return React.useMemo(() => ({ entries, status, refresh }), [entries, status, refresh]);
}

/** Detail reads subscribe to the exact Role; cross-Role consumers use the same projection separately. */
export function useRoleCatalogEntry(roleId: string | null, serverId?: string | null): Readonly<Pick<RoleCatalogState, 'status' | 'refresh'> & { entry: RoleCatalogEntry | null }> {
    const select = React.useCallback((entries: ReadonlyArray<RoleCatalogEntry>) => entries.find((entry) => entry.roleId === roleId) ?? null, [roleId]);
    const { selection: entry, status, refresh } = useRoleCatalogSelection(select, true, serverId);
    return React.useMemo(() => ({ entry, status, refresh }), [entry, status, refresh]);
}

/**
 * A role's name as people read it, never its id (`null` only without a role). Built-in and workflow
 * roles name themselves; only an Account Role reads the catalog, and says so while it loads.
 */
export function useRoleDisplayName(roleId: string | null, workflowRoles?: readonly WorkflowRoleV1[], serverId?: string | null): string | null {
    const inlineName = roleId === null ? null : findRoleDisplayName(roleId, workflowRoles);
    const select = React.useCallback((entries: ReadonlyArray<RoleCatalogEntry>) => entries.find((entry) => entry.roleId === roleId) ?? null, [roleId]);
    const { selection: entry, status } = useRoleCatalogSelection(select, true, serverId, roleId !== null && inlineName === null);
    if (roleId === null) return null;
    return inlineName ?? resolveRoleDisplayName(roleId, workflowRoles, { entry, status });
}

/** The scope's last-read catalog entry, for a non-rendering caller naming a role it opens; never reads. */
export function readKnownRoleCatalogEntry(scope: ServerAccountScope, roleId: string): RoleCatalogEntry | null {
    const overrides = getPromptLibraryCatalogValue(scope, 'role-overrides').value?.overrides;
    const cell = lastKnownByScope.get(serverAccountScopeKeySuffix(scope));
    if (!cell?.snapshot.items || !overrides) return null;
    return cell.project({ items: cell.snapshot.items, overrides }).find((entry) => entry.roleId === roleId) ?? null;
}

/** Summary readers observe the selected value, not unrelated catalog loading/status changes. */
export function useRoleCatalogEntryValue(roleId: string | null, serverId?: string | null, refreshOnMount = true): RoleCatalogEntry | null {
    const select = React.useCallback((entries: ReadonlyArray<RoleCatalogEntry>) => entries.find((entry) => entry.roleId === roleId) ?? null, [roleId]);
    return useRoleCatalogSelectionValue(select, refreshOnMount, serverId).selection;
}

/** Delegating role previews consume the callable-role list through the canonical renderer. */
export function useRoleCatalogPromptPreview(role: ResolvedRoleV1): string {
    const select = React.useCallback((entries: ReadonlyArray<RoleCatalogEntry>) => renderSessionRoleBlockV1({
        role, source: 'dispatch', availableRoles: entries.map((entry) => entry.role),
    }), [role]);
    return useRoleCatalogSelectionValue(select, false, undefined, role.canDelegateToOtherRoles === true).selection;
}
