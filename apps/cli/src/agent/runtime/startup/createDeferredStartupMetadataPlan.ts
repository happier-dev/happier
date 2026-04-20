import type { PermissionMode } from '@/api/types';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';

import {
    createSessionMetadata,
    type BackendFlavor,
    type SessionMetadataResult,
} from '@/agent/runtime/createSessionMetadata';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import type { InitializeBackendRunSessionOptions } from '@/agent/runtime/initializeBackendRunSession';

export type DeferredStartupMetadataPlan = Readonly<{
    initialMetadata: SessionMetadataResult['metadata'];
    createInitializedSessionMetadata: (machineId: string) => SessionMetadataResult;
    startupMetadataOverrides: InitializeBackendRunSessionOptions['startupMetadataOverrides'];
}>;

export function createDeferredStartupMetadataPlan(params: Readonly<{
    flavor: BackendFlavor;
    initialMachineId: string;
    directory?: string;
    startedBy?: 'daemon' | 'terminal';
    terminalRuntime?: TerminalRuntimeFlags | null;
    initialPermissionMode: PermissionMode;
    explicitPermissionMode?: PermissionMode;
    explicitPermissionModeUpdatedAt?: number;
    sessionModeId?: string;
    sessionModeUpdatedAt?: number;
    modelId?: string;
    modelUpdatedAt?: number;
}>): DeferredStartupMetadataPlan {
    const createMetadata = (machineId: string): SessionMetadataResult => createSessionMetadata({
        flavor: params.flavor,
        machineId,
        directory: params.directory,
        startedBy: params.startedBy,
        terminalRuntime: params.terminalRuntime ?? null,
        permissionMode: params.initialPermissionMode,
        permissionModeUpdatedAt:
            typeof params.explicitPermissionModeUpdatedAt === 'number'
                ? params.explicitPermissionModeUpdatedAt
                : Date.now(),
        sessionModeId: params.sessionModeId,
        sessionModeUpdatedAt: params.sessionModeUpdatedAt,
        modelId: params.modelId,
        modelUpdatedAt: params.modelUpdatedAt,
    });

    return {
        initialMetadata: createMetadata(params.initialMachineId).metadata,
        createInitializedSessionMetadata: createMetadata,
        startupMetadataOverrides: createStartupMetadataOverrides({
            permissionMode: params.explicitPermissionMode,
            permissionModeUpdatedAt: params.explicitPermissionModeUpdatedAt,
            modelId: params.modelId,
            modelUpdatedAt: params.modelUpdatedAt,
        }),
    };
}
