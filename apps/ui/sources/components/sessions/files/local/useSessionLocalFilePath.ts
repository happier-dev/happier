import * as React from 'react';

import { desktopSetupCoordinator, resolveThisComputerServiceForActiveRelay } from '@/setup/desktopSetupCoordinator';
import { resolveSessionLocalFilePath } from '@/sync/domains/files/localFilePath';
import {
    useLocalSetting,
    useSessionHomeDir,
    useSessionMachineId,
    useSessionWorkspacePath,
} from '@/sync/domains/state/storage';
import { isTauriDesktop } from '@/utils/platform/tauri';

/**
 * Where a session file is on this computer, or null when the desktop app cannot reach it (not the
 * desktop app, or the session runs elsewhere and no folder mapping covers it). Mount it only where
 * the answer is needed, e.g. inside an open menu.
 */
export function useSessionLocalFilePath(sessionId: string, relativePath: string): string | null {
    const desktop = React.useMemo(() => isTauriDesktop(), []);
    const inspection = React.useSyncExternalStore(
        desktopSetupCoordinator.subscribe,
        desktopSetupCoordinator.readInspectionSnapshot,
        desktopSetupCoordinator.readInspectionSnapshot,
    );
    const thisComputerMachineId = desktop
        ? resolveThisComputerServiceForActiveRelay(inspection)?.facts.auth.machineId ?? null
        : null;
    const sessionMachineId = useSessionMachineId(sessionId);
    const workspacePath = useSessionWorkspacePath(sessionId);
    const homeDir = useSessionHomeDir(sessionId);
    const mappings = useLocalSetting('desktopPathMappingsV1');

    if (!desktop) return null;
    return resolveSessionLocalFilePath({
        workspacePath,
        homeDir,
        relativePath,
        sessionOnThisComputer: Boolean(sessionMachineId && sessionMachineId === thisComputerMachineId),
        mappings,
    });
}
