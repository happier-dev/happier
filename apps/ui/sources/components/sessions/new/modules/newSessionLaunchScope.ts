import { normalizeMachineFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

type NewSessionLaunchScopeMachineMetadata = Readonly<{
    homeDir?: unknown;
    platform?: unknown;
}> | null | undefined;

export function normalizeLaunchScopePart(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readMachineMetadataString(
    metadata: NewSessionLaunchScopeMachineMetadata,
    key: 'homeDir' | 'platform',
): string | null {
    const value = metadata?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeNewSessionLaunchPath(
    selectedPath: string,
    machineMetadata: NewSessionLaunchScopeMachineMetadata,
): string {
    const trimmedPath = normalizeLaunchScopePart(selectedPath);
    const homeDir = readMachineMetadataString(machineMetadata, 'homeDir');
    const platform = readMachineMetadataString(machineMetadata, 'platform');
    const expandedPath = homeDir ? resolveAbsolutePath(trimmedPath, homeDir) : trimmedPath;
    return normalizeMachineFileSystemPath(expandedPath, { platform }) ?? trimmedPath;
}

export function buildNewSessionLaunchScopeKey(params: Readonly<{
    machineId: string | null;
    serverId: string | null;
    selectedPath: string;
    selectedMachineMetadata?: NewSessionLaunchScopeMachineMetadata;
    useProfiles: boolean;
    selectedProfileId: string | null;
}>): string {
    return [
        `machine:${normalizeLaunchScopePart(params.machineId)}`,
        `server:${normalizeLaunchScopePart(params.serverId)}`,
        `path:${normalizeNewSessionLaunchPath(params.selectedPath, params.selectedMachineMetadata)}`,
        `profiles:${params.useProfiles ? 'on' : 'off'}`,
        `profile:${normalizeLaunchScopePart(params.selectedProfileId)}`,
    ].join('|');
}
