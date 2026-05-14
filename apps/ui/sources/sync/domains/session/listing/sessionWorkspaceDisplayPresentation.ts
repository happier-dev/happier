import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import {
    type WorkspaceDisplayEllipsizeMode,
    type WorkspacePathDisplayModeV1,
    resolveWorkspaceDisplayPresentation,
} from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { normalizeWorkspaceRootPath, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { formatPathRelativeToHome } from '@/utils/sessions/sessionUtils';
import { normalizeSessionPathForProjectGrouping } from './sessionListProjectGroupingKeys';

type SessionWorkspaceDisplayMetadata = Readonly<{
    homeDir?: unknown;
    machineId?: unknown;
    path?: unknown;
}> | null | undefined;

type SessionWorkspaceDisplayMachineTarget = Readonly<{
    machineId?: unknown;
    basePath?: unknown;
}> | null | undefined;

export type SessionWorkspaceDisplayPresentation = Readonly<{
    displayTitle: string;
    subtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
    hasCustomLabel: boolean;
    workspaceRefId: string | null;
    workspaceScope: WorkspaceScopeBase | null;
}>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

export function resolveSessionWorkspaceDisplayPresentation(input: Readonly<{
    serverId: string | null | undefined;
    metadata: SessionWorkspaceDisplayMetadata;
    machineTarget?: SessionWorkspaceDisplayMachineTarget;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
}>): SessionWorkspaceDisplayPresentation {
    const rawRootPath = input.machineTarget?.basePath ?? input.metadata?.path ?? null;
    const homeDir = normalizeId(input.metadata?.homeDir) || undefined;
    const canonicalRootPath = normalizeSessionPathForProjectGrouping(rawRootPath, homeDir);
    const rootPath = normalizeWorkspaceRootPath(canonicalRootPath);
    const machineId = normalizeId(input.machineTarget?.machineId ?? input.metadata?.machineId);
    const serverId = normalizeId(input.serverId);
    const workspaceScope = serverId && machineId && rootPath
        ? { serverId, machineId, rootPath }
        : null;
    const fallbackPathLabel = rootPath ? formatPathRelativeToHome(rootPath, homeDir) : '';
    const presentation = resolveWorkspaceDisplayPresentation({
        scope: workspaceScope,
        workspaceRefs: input.workspaceRefs,
        fallbackPathLabel,
        fallbackPathDisplayMode: input.workspacePathDisplayModeV1,
    });

    return {
        ...presentation,
        workspaceScope,
    };
}
