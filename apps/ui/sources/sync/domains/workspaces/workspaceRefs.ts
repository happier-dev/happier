import { randomUUID } from '@/platform/randomUUID';

import type { WorkspaceScopeBase } from './workspaceScope';
import { normalizeWorkspaceRootPath } from './workspaceScope';
import type { WorkspaceRefV1 } from './workspaceRefModel';

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizeScope(input: WorkspaceScopeBase): WorkspaceScopeBase | null {
    const serverId = normalizeId(input.serverId);
    const machineId = normalizeId(input.machineId);
    const rootPath = normalizeWorkspaceRootPath(input.rootPath);
    if (!serverId || !machineId || !rootPath) return null;
    return { serverId, machineId, rootPath };
}

function normalizeOptionalLabel(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function findWorkspaceRefByScope(
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>,
    scope: WorkspaceScopeBase,
): WorkspaceRefV1 | null {
    const normalized = normalizeScope(scope);
    if (!normalized) return null;
    return workspaceRefs.find((ref) =>
        normalizeId(ref.serverId) === normalized.serverId
        && normalizeId(ref.machineId) === normalized.machineId
        && normalizeWorkspaceRootPath(ref.rootPath) === normalized.rootPath
    ) ?? null;
}

export function upsertWorkspaceRefByScope(
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>,
    input: Readonly<{
        scope: WorkspaceScopeBase;
        nowMs: number;
        patch: Partial<Pick<WorkspaceRefV1, 'label' | 'lastOpenedAtMs'>>;
    }>,
): WorkspaceRefV1[] {
    const normalized = normalizeScope(input.scope);
    if (!normalized) return [...workspaceRefs];

    const matches: WorkspaceRefV1[] = [];
    const nonMatches: WorkspaceRefV1[] = [];
    for (const ref of workspaceRefs) {
        const rootPath = normalizeWorkspaceRootPath(ref.rootPath);
        if (
            normalizeId(ref.serverId) === normalized.serverId
            && normalizeId(ref.machineId) === normalized.machineId
            && rootPath === normalized.rootPath
        ) {
            matches.push(ref);
        } else {
            nonMatches.push(ref);
        }
    }

    const base = matches[0] ?? {
        id: randomUUID(),
        serverId: normalized.serverId,
        machineId: normalized.machineId,
        rootPath: normalized.rootPath,
        label: null,
        createdAtMs: Math.floor(input.nowMs),
        lastOpenedAtMs: null,
    };

    const next: WorkspaceRefV1 = {
        ...base,
        label: input.patch.label !== undefined ? normalizeOptionalLabel(input.patch.label) : base.label ?? null,
        lastOpenedAtMs: input.patch.lastOpenedAtMs !== undefined ? input.patch.lastOpenedAtMs : base.lastOpenedAtMs ?? null,
    };

    return [...nonMatches, next];
}
