import type { FileSuggestionScope } from '@/sync/domains/input/fileSuggestionScope';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';

/**
 * Resolves the machine + folder an existing session's composer searches.
 *
 * This is the ONLY place a session is turned into a file-suggestion scope, so every composer
 * host asks the same question and no host reinvents "which machine and folder is this?".
 *
 * `basePath` — not `metadata.path` — is deliberate: `readMachineControlTargetForSession`
 * rebases a workspace-located session off its `agentBasePath`, so this is the path as the
 * MACHINE sees it, which is the only one a machine-scoped RPC can act on. It is the same
 * target `sessionCatalogs` uses to reach an inactive session's catalogs.
 */
export function resolveSessionFileSuggestionScope(
    sessionId: string | null | undefined,
): FileSuggestionScope | null {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return null;
    const target = readMachineControlTargetForSession(id);
    if (!target) return null;
    const path = target.basePath.trim();
    if (!path) return null;
    return {
        machineId: target.machineId,
        path,
        serverId: resolvePreferredServerIdForSessionId(id),
    };
}
