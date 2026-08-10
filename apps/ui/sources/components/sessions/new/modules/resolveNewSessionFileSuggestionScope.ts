import type { FileSuggestionScope } from '@/sync/domains/input/fileSuggestionScope';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

/**
 * Resolves the machine + folder the NEW-session composer searches.
 *
 * The counterpart of `@/sync/ops/resolveSessionFileSuggestionScope`: an existing session
 * resolves its machine and folder from itself, this host takes the ones the user just picked.
 * Both produce the same `FileSuggestionScope`, so the file kind has one implementation and no
 * host-specific branch.
 *
 * Two things it must do that the raw picker state does not:
 *
 * 1. **Expand `~`.** `selectedPath` is display state and is routinely home-relative — it comes
 *    from route params, a persisted draft, or a recent-path entry, and only
 *    `PathSelectionList`'s own commit path absolutizes it. A machine RPC cwd is passed to
 *    ripgrep verbatim, so `~/code/app` would address a literally-named directory. The
 *    sibling scope resolver `resolveNewSessionReviewCommentsScope` normalizes for exactly
 *    this reason, against the same `metadata.homeDir`.
 * 2. **Fail closed.** With no machine, no folder, or a folder that cannot be made absolute
 *    there is nothing to search. Returning `null` means the file kind contributes no rows;
 *    returning a partial scope would make the daemon search its OWN working directory (HOME)
 *    and offer the user files from an unrelated tree.
 */
export function resolveNewSessionFileSuggestionScope(params: Readonly<{
    targetServerId?: string | null;
    selectedMachineId?: string | null;
    selectedMachineHomeDir?: string | null;
    selectedPath?: string | null;
}>): FileSuggestionScope | null {
    const machineId = (params.selectedMachineId ?? '').trim();
    const selectedPath = (params.selectedPath ?? '').trim();
    if (!machineId || !selectedPath) return null;

    const homeDir = (params.selectedMachineHomeDir ?? '').trim();
    const path = resolveAbsolutePath(selectedPath, homeDir || undefined).trim();
    // `resolveAbsolutePath` leaves a home-relative path alone when it has no home directory to
    // expand it against, so a still-relative path here means the machine has not reported one
    // yet. Searching it would silently address the daemon's own directory.
    if (!path || path.startsWith('~')) return null;

    const serverId = (params.targetServerId ?? '').trim();
    return serverId ? { machineId, path, serverId } : { machineId, path };
}
