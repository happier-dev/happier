/**
 * What a file suggestion search is addressed BY.
 *
 * A session is not the scoping unit for reading a workspace's files — the machine and the
 * folder are. A session merely *has* a machine and a folder, so addressing the search by
 * session id names the wrong identity, and it is why the search could not be offered before
 * a session existed and silently returned nothing once a session went inactive.
 *
 * This mirrors the addressing the rest of the machine-scoped surface already uses:
 * `openMachinePathBrowserModal` takes `machineId` + `serverId`, `machineFileBrowser` calls
 * `machineRpcWithServerScope`, and `sessionCatalogs` routes an inactive session's catalogs the
 * same way with an explicit `cwd`.
 *
 * This module stays free of store and `sync/ops` imports so the search owner can depend on the
 * identity without pulling the sync barrel in behind it; resolving a *session* to one of these
 * lives at `@/sync/ops/resolveSessionFileSuggestionScope`.
 */
export type FileSuggestionScope = Readonly<{
    machineId: string;
    /** Absolute folder ON THAT MACHINE the search is rooted at. */
    path: string;
    /** Server the machine is reached through; omitted means the active server. */
    serverId?: string | undefined;
}>;

/**
 * Trailing separators are spelling, not identity: a session's `metadata.path` and a
 * user-picked directory disagree about them routinely, and two spellings of one folder must
 * not build two ripgrep indexes.
 *
 * Only exact equality is derived from this key — nothing does prefix matching on it — so
 * sibling-prefix collisions (`/srv/app` vs `/srv/app2`) cannot arise here.
 */
function normalizeScopeRoot(path: string): string {
    const trimmed = path.trim();
    if (trimmed.length <= 1) return trimmed;
    let end = trimmed.length;
    while (end > 1 && (trimmed[end - 1] === '/' || trimmed[end - 1] === '\\')) end -= 1;
    // Keep a Windows drive root addressable as `C:\` rather than collapsing it to `C:`,
    // which names the drive's *current* directory instead of its root.
    if (end === 2 && trimmed[1] === ':') return trimmed.slice(0, 3);
    return trimmed.slice(0, end);
}

/**
 * The cache identity. `serverId` participates because a machine id is only unique within the
 * server that issued it; two sessions on one workspace resolve the same server, so including
 * it costs no sharing.
 */
export function fileSuggestionScopeKey(scope: FileSuggestionScope): string {
    return JSON.stringify([scope.serverId ?? '', scope.machineId.trim(), normalizeScopeRoot(scope.path)]);
}

/**
 * Appends a scope-relative child path to the scope root, in the root's own separator style.
 *
 * Deliberately NOT `resolveMachinePathFromSessionBase`: that answers a different question —
 * rebasing an agent-absolute request path onto a machine base — and importing it here would
 * pull `sync/ops` (and the sync barrel behind it) into the search owner.
 */
export function resolveFileSuggestionScopeChildPath(scope: FileSuggestionScope, relativePath: string): string {
    const root = normalizeScopeRoot(scope.path);
    if (!relativePath) return root;
    const separator = root.includes('\\') ? '\\' : '/';
    return `${root}${separator}${relativePath.split('/').join(separator)}`;
}
