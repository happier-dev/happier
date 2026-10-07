import type { Session } from '@/sync/domains/state/storageTypes';
import { isModelMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveMergedSessionPermissionMode } from './resolveMergedSessionPermissionMode';
import { readSessionModelSelectionIntentFromMetadata } from '@/sync/domains/models/readSessionModelSelectionIntent';

type InputModes = Pick<Session, 'permissionMode' | 'permissionModeUpdatedAt' | 'modelMode' | 'modelModeUpdatedAt'>;

/** Merge scoped local choices and runtime metadata identically for mounted and remote Sessions. */
export function resolveSessionInputModes(params: Readonly<{
    session: Session;
    existing?: InputModes;
    saved?: InputModes;
    nowMs: number;
}>): Readonly<{
    permissionMode: PermissionMode;
    permissionModeUpdatedAt: number | null;
    modelMode: string;
    modelModeUpdatedAt: number | null;
}> {
    const { session } = params;
    const existingPermissionMode = params.existing?.permissionMode;
    const existingPermissionModeUpdatedAt = params.existing?.permissionModeUpdatedAt;
    const existingModelMode = params.existing?.modelMode;
    const existingModelModeUpdatedAt = params.existing?.modelModeUpdatedAt;
    const savedPermissionMode = params.saved?.permissionMode;
    const savedPermissionModeUpdatedAt = params.saved?.permissionModeUpdatedAt;
    const savedModelMode = params.saved?.modelMode;
    const savedModelModeUpdatedAt = params.saved?.modelModeUpdatedAt;
    // CLI may publish a session permission mode in encrypted metadata for local-only starts.
    // This is a fallback signal for when there are no app-sent user messages carrying meta.permissionMode yet.
    const ownerMetadataView = readSessionOwnerMetadataView(session);
    const metadataPermission = resolvePermissionIntentFromSessionMetadata(ownerMetadataView);
    const metadataCanonicalPermissionMode = metadataPermission?.intent ?? null;
    const metadataPermissionModeUpdatedAt = metadataPermission?.updatedAt ?? null;

    const basePermissionMode: PermissionMode =
        session.permissionMode ||
        'default';
    const basePermissionModeUpdatedAt =
        typeof session.permissionModeUpdatedAt === 'number'
            ? session.permissionModeUpdatedAt
            : null;

    const mergedPermission = resolveMergedSessionPermissionMode({
        baseMode: basePermissionMode,
        baseUpdatedAt: basePermissionModeUpdatedAt,
        candidates: [
            { mode: savedPermissionMode, updatedAt: savedPermissionModeUpdatedAt },
            { mode: existingPermissionMode, updatedAt: existingPermissionModeUpdatedAt },
            { mode: metadataCanonicalPermissionMode, updatedAt: metadataPermissionModeUpdatedAt },
        ],
    });

    const mergedPermissionMode = mergedPermission.mode;
    const mergedPermissionModeUpdatedAt = mergedPermission.updatedAt;

    const resolvedBackend = resolveSessionActionDefaultBackend({ session });
    const resolvedTarget = resolveSessionActionDefaultTarget(resolvedBackend);
    const modelIntent = resolvedTarget
        ? readSessionModelSelectionIntentFromMetadata(
            ownerMetadataView,
            buildBackendTargetKeyV2(resolvedTarget),
        )
        : null;
    const metadataModelId = modelIntent
        ? modelIntent.selection?.modelId ?? 'default'
        : null;
    const metadataModelUpdatedAt = modelIntent?.updatedAt ?? null;

    let mergedModelMode =
        existingModelMode ||
        savedModelMode ||
        session.modelMode ||
        'default';

    let mergedModelModeUpdatedAt: number | null =
        existingModelModeUpdatedAt ??
        savedModelModeUpdatedAt ??
        null;

    if (typeof metadataModelId === 'string' && isModelMode(metadataModelId) && typeof metadataModelUpdatedAt === 'number') {
        const localUpdatedAt = mergedModelModeUpdatedAt ?? 0;
        if (metadataModelUpdatedAt > localUpdatedAt) {
            mergedModelMode = metadataModelId;
            mergedModelModeUpdatedAt = metadataModelUpdatedAt;
        }
    }

    // Catalog omission is not rejection of an already admitted or persisted intent.
    // Explicit newer intent (including a transition clear) owns reconciliation.

    return {
        permissionMode: mergedPermissionMode,
        permissionModeUpdatedAt: mergedPermissionModeUpdatedAt,
        modelMode: mergedModelMode,
        modelModeUpdatedAt: mergedModelModeUpdatedAt,
    };
}
