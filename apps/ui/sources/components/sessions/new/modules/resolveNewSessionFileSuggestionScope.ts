import type { FileSuggestionScope } from '@/sync/domains/input/suggestionFile';
import { normalizeWorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

function normalizeText(value: unknown): string {
    return String(value ?? '').trim();
}

/**
 * Resolves the machine + folder the NEW-session composer searches.
 *
 * The counterpart of `@/sync/domains/session/resolveWorkspaceTargetForSession`: an existing
 * session resolves its machine and folder from itself, this host takes the ones the user just
 * picked. Both produce the same workspace scope, so the file kind has one implementation and
 * no host-specific branch.
 *
 * Two things it must do that the raw picker state does not:
 *
 * 1. **Expand `~`.** `selectedPath` is display state and is routinely home-relative — it comes
 *    from route params, a persisted draft, or a recent-path entry. A machine RPC cwd is passed
 *    to ripgrep verbatim, so `~/code/app` would address a literally-named directory. The
 *    sibling scope resolver `resolveNewSessionReviewCommentsScope` normalizes for exactly this
 *    reason, against the same `metadata.homeDir`.
 * 2. **Fail closed.** With no server, no machine, no folder, or a folder that cannot be made
 *    absolute there is nothing to search. Returning `null` means the file kind contributes no
 *    rows; returning a partial scope would make the daemon search its OWN working directory
 *    (HOME) and offer the user files from an unrelated tree.
 *
 * It deliberately does NOT prefer an SCM repository root the way the review-comments scope
 * does: this is the folder the session will actually run in, and it must be the same folder an
 * existing session on that path would search.
 */
export function resolveNewSessionFileSuggestionScope(params: Readonly<{
    targetServerId?: string | null;
    selectedMachineId?: string | null;
    selectedMachineHomeDir?: string | null;
    selectedPath?: string | null;
}>): FileSuggestionScope | null {
    const serverId = normalizeText(params.targetServerId);
    const machineId = normalizeText(params.selectedMachineId);
    const selectedPath = normalizeText(params.selectedPath);
    if (!serverId || !machineId || !selectedPath) return null;

    const homeDir = normalizeText(params.selectedMachineHomeDir);
    const resolvedPath = resolveAbsolutePath(selectedPath, homeDir || undefined).trim();
    // `resolveAbsolutePath` leaves a home-relative path alone when it has no home directory to
    // expand it against, so a still-relative path here means the machine has not reported one
    // yet. Searching it would silently address the daemon's own directory.
    if (!resolvedPath || resolvedPath.startsWith('~')) return null;

    return normalizeWorkspaceScopeBase({ serverId, machineId, rootPath: resolvedPath });
}
