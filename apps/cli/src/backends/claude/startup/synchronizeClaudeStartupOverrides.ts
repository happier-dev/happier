import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { initializeRuntimeOverridesSynchronizer } from '@/agent/runtime/runtimeOverridesSynchronizer';
import { writeStartupOverridesCacheForBackend } from '@/agent/runtime/startup/startupOverridesCache';
import { configuration } from '@/configuration';

type ClaudeStartupOverrideCarrier = {
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    model?: string;
    modelId?: string;
    modelUpdatedAt?: number;
};

export async function synchronizeClaudeStartupOverrides(params: Readonly<{
    session: Pick<ApiSessionClient, 'getMetadataSnapshot' | 'fetchLatestUserPermissionIntentFromTranscript'>;
    sessionKind: 'fresh' | 'attach' | 'resume';
    opts: ClaudeStartupOverrideCarrier;
}>): Promise<void> {
    const explicitPermissionMode = params.opts.permissionMode;
    const explicitModelId = resolveInitialModelId(params.opts);
    const permissionModeRef = {
        current: params.opts.permissionMode ?? 'default',
        updatedAt: typeof params.opts.permissionModeUpdatedAt === 'number' ? params.opts.permissionModeUpdatedAt : 0,
    };
    const modelOverrideRef = {
        current: explicitModelId,
        updatedAt: typeof params.opts.modelUpdatedAt === 'number' ? params.opts.modelUpdatedAt : 0,
    };

    const overridesSync = await initializeRuntimeOverridesSynchronizer({
        explicitPermissionMode,
        sessionKind: params.sessionKind,
        take: configuration.startupPermissionSeedTranscriptTake,
        session: params.session,
        permissionMode: permissionModeRef,
        modelOverride: modelOverrideRef,
        onPermissionModeApplied: () => {
            params.opts.permissionMode = permissionModeRef.current;
            params.opts.permissionModeUpdatedAt = permissionModeRef.updatedAt;
        },
        onModelOverrideApplied: () => {
            if (explicitModelId) return;
            params.opts.modelId = modelOverrideRef.current ?? undefined;
            if ('model' in params.opts) {
                params.opts.model = modelOverrideRef.current ?? undefined;
            }
            params.opts.modelUpdatedAt = modelOverrideRef.updatedAt;
        },
    });

    await overridesSync.seedFromSession();
    overridesSync.syncFromMetadata();

    try {
        const snapshot = overridesSync.getSnapshot();
        writeStartupOverridesCacheForBackend({
            backendId: 'claude',
            permissionMode: snapshot.permissionMode.current,
            permissionModeUpdatedAt: snapshot.permissionMode.updatedAt,
            modelId: snapshot.modelOverride.current,
            modelUpdatedAt: snapshot.modelOverride.updatedAt,
            updatedAt: Date.now(),
        });
    } catch {
        // Best-effort cache write only.
    }
}

function resolveInitialModelId(opts: ClaudeStartupOverrideCarrier): string | null {
    const modelId = typeof opts.modelId === 'string' ? opts.modelId.trim() : '';
    if (modelId.length > 0) {
        return modelId;
    }
    const model = typeof opts.model === 'string' ? opts.model.trim() : '';
    return model.length > 0 ? model : null;
}
