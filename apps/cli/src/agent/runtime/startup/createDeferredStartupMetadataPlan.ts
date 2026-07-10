import type { PermissionMode } from '@/api/types';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol';

import {
    createSessionMetadata,
    type BackendFlavor,
    type SessionMetadataResult,
    type SessionLaunchControlMetadata,
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
    modelSelection?: SessionModelSelectionV1;
    launchControlMetadata: SessionLaunchControlMetadata;
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
        modelSelectionIntent: params.modelSelection
            ? { v: 1, updatedAt: params.modelSelection.updatedAt, selection: params.modelSelection.ref }
            : undefined,
        launchControlMetadata: params.launchControlMetadata,
    });

    return {
        initialMetadata: createMetadata(params.initialMachineId).metadata,
        createInitializedSessionMetadata: createMetadata,
        startupMetadataOverrides: createStartupMetadataOverrides({
            permissionMode: params.explicitPermissionMode,
            permissionModeUpdatedAt: params.explicitPermissionModeUpdatedAt,
            modelSelection: params.modelSelection,
        }),
    };
}
