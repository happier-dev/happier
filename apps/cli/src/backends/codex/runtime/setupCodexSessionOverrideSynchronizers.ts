import type { ApiSessionClient } from '@/api/session/sessionClient';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permissions/modeCanonical';
import {
    setupRuntimeMetadataDrivenOverridesSync,
    type RuntimeOverrideSynchronizers,
} from '@/agent/runtime/runtimeOverridesSynchronizer';
import { seedCodexAppServerPendingSessionOverrides } from '../appServer/seedPendingSessionOverrides';

type PermissionMode = import('@/api/types').PermissionMode;

type CodexRemoteRuntimeForOverrides = Readonly<{
    setSessionMode: (modeId: string) => Promise<void>;
    setSessionModel: (modelId: string) => Promise<void>;
    setSessionConfigOption: (key: string, value: string | number | boolean | null) => Promise<void>;
}>;

export async function setupCodexSessionOverrideSynchronizers(args: Readonly<{
    explicitPermissionMode: PermissionMode | undefined;
    existingSessionId: string | undefined;
    resume: string | undefined;
    take: number;
    session: Pick<ApiSessionClient, 'getMetadataSnapshot' | 'fetchLatestUserPermissionIntentFromTranscript' | 'waitForMetadataUpdate'>;
    getRemoteRuntime: () => CodexRemoteRuntimeForOverrides | null;
    isRemoteRuntimeStarted: () => boolean;
    useCodexAppServer: boolean;
    permissionMode: { current: PermissionMode; updatedAt: number };
    modelOverride: { current: string | null; updatedAt: number };
    onPermissionModeApplied: () => void;
    onModelOverrideApplied: () => void;
    persistStartupOverridesCache: () => void;
    shouldExit: () => boolean;
    getAbortSignal: () => AbortSignal;
}>): Promise<{
    runtimeControlSync: RuntimeOverrideSynchronizers | null;
    seedCodexAppServerOverridesBeforeStartOrLoad: () => Promise<void>;
    syncOverridesFromMetadata: () => void;
}> {
    const remoteRuntimeForSync = args.getRemoteRuntime();

    const seedCodexAppServerOverridesBeforeStartOrLoad = async (): Promise<void> => {
        if (!args.useCodexAppServer || args.isRemoteRuntimeStarted()) {
            return;
        }
        const runtime = args.getRemoteRuntime();
        if (!runtime) {
            return;
        }
        await seedCodexAppServerPendingSessionOverrides({
            metadata: args.session.getMetadataSnapshot(),
            runtime,
        });
    };

    const hasExistingSessionId = typeof args.existingSessionId === 'string' && args.existingSessionId.trim().length > 0;
    const hasResumeArg = typeof args.resume === 'string' && args.resume.trim().length > 0;
    const sessionKind = hasExistingSessionId ? 'attach' : hasResumeArg ? 'resume' : 'fresh';

    const normalizedExplicitPermissionMode =
        typeof args.explicitPermissionMode === 'string'
            ? normalizePermissionModeToIntent(args.explicitPermissionMode) ?? undefined
            : undefined;

    const { runtimeControlSync, syncOverridesFromMetadata } = await setupRuntimeMetadataDrivenOverridesSync({
        explicitPermissionMode: normalizedExplicitPermissionMode,
        sessionKind,
        take: args.take,
        session: {
            getMetadataSnapshot: () => args.session.getMetadataSnapshot(),
            fetchLatestUserPermissionIntentFromTranscript: (options) =>
                args.session.fetchLatestUserPermissionIntentFromTranscript(options),
            waitForMetadataUpdate: (signal) => args.session.waitForMetadataUpdate(signal),
        },
        permissionMode: args.permissionMode,
        modelOverride: args.modelOverride,
        runtime: remoteRuntimeForSync
            ? {
                target: {
                    setSessionModel: (modelId) => remoteRuntimeForSync.setSessionModel(modelId),
                    setSessionMode: (modeId) => remoteRuntimeForSync.setSessionMode(modeId),
                    setSessionConfigOption: (configId, valueId) =>
                        remoteRuntimeForSync.setSessionConfigOption(configId, valueId),
                },
                isStarted: () => args.isRemoteRuntimeStarted(),
            }
            : null,
        onPermissionModeApplied: args.onPermissionModeApplied,
        onModelOverrideApplied: args.onModelOverrideApplied,
        persistStartupOverridesCache: args.persistStartupOverridesCache,
        shouldExit: args.shouldExit,
        getAbortSignal: args.getAbortSignal,
    });

    return {
        runtimeControlSync,
        seedCodexAppServerOverridesBeforeStartOrLoad,
        syncOverridesFromMetadata,
    };
}
