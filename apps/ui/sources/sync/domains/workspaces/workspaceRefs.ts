import { randomUUID } from '@/platform/randomUUID';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { WorkspaceSyncRelationshipV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

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
        areServerProfileIdentifiersEquivalent(ref.serverId, normalized.serverId)
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
            areServerProfileIdentifiersEquivalent(ref.serverId, normalized.serverId)
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

export type WorkspaceRefRelationshipReference = Readonly<{
    relationshipId: string;
    alphaWorkspaceRefId: string;
    betaWorkspaceRefId: string;
}>;

export type WorkspaceRefRemoval =
    | Readonly<{ ok: true; workspaceRefs: WorkspaceRefV1[] }>
    | Readonly<{ ok: false; code: 'workspace_ref_in_use'; relationshipIds: readonly string[] }>;

export type WorkspaceRefAccountRemovalResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; code: 'workspace_ref_in_use'; relationshipIds: readonly string[] }>
    | Readonly<{ ok: false; code: 'workspace_settings_unreadable' }>;

export type WorkspaceRefAccountMutation =
    | Readonly<{
        kind: 'upsert';
        scope: WorkspaceScopeBase;
        nowMs: number;
        patch: Partial<Pick<WorkspaceRefV1, 'label' | 'lastOpenedAtMs'>>;
    }>
    | Readonly<{
        kind: 'set_label';
        serverId: string;
        workspaceRefId: string;
        label: string | null;
    }>
    | Readonly<{
        kind: 'set_pinned';
        serverId: string;
        workspaceRefId: string;
        pinned: boolean;
    }>
    | Readonly<{
        kind: 'migrate_label';
        scope: WorkspaceScopeBase;
        nowMs: number;
        legacyKey: string;
        label: string;
    }>
    | Readonly<{
        kind: 'remove';
        serverId: string;
        workspaceRefId: string;
    }>;

export type WorkspaceRefAccountMutationResult = WorkspaceRefAccountRemovalResult
    | Readonly<{ ok: true; workspaceRefId: string }>
    | Readonly<{ ok: true; workspaceRefId?: string; migrated: false }>
    | Readonly<{ ok: true; workspaceRefId: string; migrated: true }>
    | Readonly<{ ok: false; code: 'workspace_ref_not_found' }>;

/**
 * A Project may own its own reference and label, but a workspace-sync
 * relationship resolves both of its endpoints through persisted `WorkspaceRef`
 * ids. Removing a referenced ref would leave the relationship pointing at an
 * endpoint the daemon can no longer resolve, so removal fails closed here and
 * the caller must stop syncing through the daemon relationship owner first.
 * A paused relationship still holds its endpoints and still blocks removal.
 */
export function resolveWorkspaceRefRemoval(
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>,
    input: Readonly<{
        serverId: string;
        workspaceRefId: string;
        relationships: ReadonlyArray<WorkspaceRefRelationshipReference>;
    }>,
): WorkspaceRefRemoval {
    const serverId = normalizeId(input.serverId);
    const workspaceRefId = normalizeId(input.workspaceRefId);
    if (!serverId || !workspaceRefId) return { ok: true, workspaceRefs: [...workspaceRefs] };

    const relationshipIds = input.relationships
        .filter((relationship) => (
            normalizeId(relationship.alphaWorkspaceRefId) === workspaceRefId
            || normalizeId(relationship.betaWorkspaceRefId) === workspaceRefId
        ))
        .map((relationship) => normalizeId(relationship.relationshipId))
        .filter((relationshipId) => relationshipId.length > 0);
    if (relationshipIds.length > 0) {
        return { ok: false, code: 'workspace_ref_in_use', relationshipIds };
    }

    return {
        ok: true,
        workspaceRefs: workspaceRefs.filter((ref) => (
            !areServerProfileIdentifiersEquivalent(ref.serverId, serverId)
            || normalizeId(ref.id) !== workspaceRefId
        )),
    };
}

/**
 * Applies one Project-owned field intent to the exact Account Settings CAS
 * winner. Removal also checks relationship references from that same winner,
 * while every operation preserves independently changed refs and pins.
 */
export function applyWorkspaceRefMutationToAccountSettings(
    raw: Readonly<Record<string, unknown>>,
    mutation: Extract<WorkspaceRefAccountMutation, { kind: 'remove' }>,
): Readonly<{
    settings: Record<string, unknown>;
    value: WorkspaceRefAccountRemovalResult;
}>;
export function applyWorkspaceRefMutationToAccountSettings(
    raw: Readonly<Record<string, unknown>>,
    mutation: WorkspaceRefAccountMutation,
): Readonly<{
    settings: Record<string, unknown>;
    value: WorkspaceRefAccountMutationResult;
}>;
export function applyWorkspaceRefMutationToAccountSettings(
    raw: Readonly<Record<string, unknown>>,
    mutation: WorkspaceRefAccountMutation,
): Readonly<{
    settings: Record<string, unknown>;
    value: WorkspaceRefAccountMutationResult;
}> {
    const refs = WorkspaceRefV1Schema.array().safeParse(raw.workspaceRefsV1 ?? []);
    const relationships = WorkspaceSyncRelationshipV1Schema.array().safeParse(
        raw.workspaceSyncRelationshipsV1 ?? [],
    );
    const rawPinnedIds = raw.pinnedWorkspaceRefIdsV1 ?? [];
    const pinnedIds = Array.isArray(rawPinnedIds)
        && rawPinnedIds.every((value) => typeof value === 'string')
        ? rawPinnedIds
        : null;
    if (!refs.success || !relationships.success || pinnedIds === null) {
        return {
            settings: raw as Record<string, unknown>,
            value: { ok: false, code: 'workspace_settings_unreadable' },
        };
    }

    if (mutation.kind === 'upsert' || mutation.kind === 'migrate_label') {
        const existing = findWorkspaceRefByScope(refs.data, mutation.scope);
        if (mutation.kind === 'migrate_label') {
            const rawWorkspaceLabels = raw.workspaceLabelsV1 ?? {};
            const workspaceLabels = typeof rawWorkspaceLabels === 'object'
                && rawWorkspaceLabels !== null
                && !Array.isArray(rawWorkspaceLabels)
                && Object.values(rawWorkspaceLabels).every((value) => typeof value === 'string')
                ? rawWorkspaceLabels as Record<string, string>
                : null;
            if (!workspaceLabels) {
                return {
                    settings: raw as Record<string, unknown>,
                    value: { ok: false, code: 'workspace_settings_unreadable' },
                };
            }
            if (
                workspaceLabels[mutation.legacyKey] !== mutation.label
                || normalizeOptionalLabel(existing?.label)
            ) {
                return {
                    settings: raw as Record<string, unknown>,
                    value: { ok: true, workspaceRefId: existing?.id, migrated: false },
                };
            }
        }
        const workspaceRefs = upsertWorkspaceRefByScope(refs.data, mutation.kind === 'migrate_label'
            ? {
                scope: mutation.scope,
                nowMs: mutation.nowMs,
                patch: { label: mutation.label },
            }
            : mutation);
        const upserted = findWorkspaceRefByScope(workspaceRefs, mutation.scope);
        if (!upserted) {
            return {
                settings: raw as Record<string, unknown>,
                value: { ok: false, code: 'workspace_ref_not_found' },
            };
        }
        return {
            settings: mutation.kind === 'migrate_label'
                ? {
                    ...raw,
                    workspaceRefsV1: workspaceRefs,
                    workspaceLabelsV1: Object.fromEntries(
                        Object.entries(raw.workspaceLabelsV1 as Record<string, string>)
                            .filter(([key]) => key !== mutation.legacyKey),
                    ),
                }
                : { ...raw, workspaceRefsV1: workspaceRefs },
            value: mutation.kind === 'migrate_label'
                ? { ok: true, workspaceRefId: upserted.id, migrated: true }
                : { ok: true, workspaceRefId: upserted.id },
        };
    }

    const serverId = normalizeId(mutation.serverId);
    const workspaceRefId = normalizeId(mutation.workspaceRefId);
    const targetExists = refs.data.some((ref) => (
        areServerProfileIdentifiersEquivalent(ref.serverId, serverId)
        && normalizeId(ref.id) === workspaceRefId
    ));

    if (mutation.kind === 'set_label') {
        if (!targetExists) {
            return {
                settings: raw as Record<string, unknown>,
                value: { ok: false, code: 'workspace_ref_not_found' },
            };
        }
        return {
            settings: {
                ...raw,
                workspaceRefsV1: refs.data.map((ref) => (
                    areServerProfileIdentifiersEquivalent(ref.serverId, serverId)
                    && normalizeId(ref.id) === workspaceRefId
                        ? { ...ref, label: normalizeOptionalLabel(mutation.label) }
                        : ref
                )),
            },
            value: { ok: true },
        };
    }

    if (mutation.kind === 'set_pinned') {
        if (!targetExists) {
            return {
                settings: raw as Record<string, unknown>,
                value: { ok: false, code: 'workspace_ref_not_found' },
            };
        }
        const alreadyPinned = pinnedIds.some((id) => normalizeId(id) === workspaceRefId);
        return {
            settings: {
                ...raw,
                pinnedWorkspaceRefIdsV1: mutation.pinned
                    ? alreadyPinned ? [...pinnedIds] : [...pinnedIds, workspaceRefId]
                    : pinnedIds.filter((id) => normalizeId(id) !== workspaceRefId),
            },
            value: { ok: true },
        };
    }

    const removal = resolveWorkspaceRefRemoval(refs.data, {
        serverId,
        workspaceRefId,
        relationships: relationships.data,
    });
    if (!removal.ok) {
        return { settings: raw as Record<string, unknown>, value: removal };
    }

    const idStillExists = removal.workspaceRefs.some((ref) => normalizeId(ref.id) === workspaceRefId);
    return {
        settings: {
            ...raw,
            workspaceRefsV1: removal.workspaceRefs,
            pinnedWorkspaceRefIdsV1: idStillExists
                ? [...pinnedIds]
                : pinnedIds.filter((id) => normalizeId(id) !== workspaceRefId),
        },
        value: { ok: true },
    };
}

export function applyWorkspaceRefRemovalToAccountSettings(
    raw: Readonly<Record<string, unknown>>,
    input: Readonly<{ serverId: string; workspaceRefId: string }>,
): Readonly<{
    settings: Record<string, unknown>;
    value: WorkspaceRefAccountRemovalResult;
}> {
    return applyWorkspaceRefMutationToAccountSettings(raw, { kind: 'remove', ...input });
}
