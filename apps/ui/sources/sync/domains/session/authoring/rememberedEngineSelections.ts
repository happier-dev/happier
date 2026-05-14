import {
    AcpConfigOptionOverridesV1Schema,
    buildBackendTargetKeyV2,
    type AcpConfigOptionOverridesV1,
    type BackendTargetRefV2,
    type BackendTargetKeyV2,
} from '@happier-dev/protocol';
import { z } from 'zod';

const RememberedEngineSelectionV1Schema = z.object({
    v: z.literal(1),
    modelId: z.string().trim().min(1),
    acpSessionModeId: z.string().trim().min(1).nullable().optional(),
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.nullable().optional(),
    updatedAt: z.number().finite().nonnegative(),
});

export type RememberedEngineSelectionV1 = z.infer<typeof RememberedEngineSelectionV1Schema>;

export const RememberedEngineSelectionsByScopeV1Schema = z.preprocess((value) => {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};

    return Object.fromEntries(
        Object.entries(record).flatMap(([scopeKey, raw]) => {
            const normalizedScopeKey = scopeKey.trim();
            if (!normalizedScopeKey) return [];
            const parsed = RememberedEngineSelectionV1Schema.safeParse(raw);
            return parsed.success ? [[normalizedScopeKey, parsed.data]] : [];
        }),
    );
}, z.record(z.string().min(1), RememberedEngineSelectionV1Schema).default({}));

export type RememberedEngineSelectionsByScopeV1 = z.infer<typeof RememberedEngineSelectionsByScopeV1Schema>;

function normalizeServerScopeId(serverId: string | null | undefined): string {
    const normalized = typeof serverId === 'string' ? serverId.trim() : '';
    return normalized || 'default';
}

function normalizeOptionalSelectionValue(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized && normalized !== 'default' ? normalized : null;
}

export function buildRememberedEngineSelectionScopeKeyForTargetKey(params: Readonly<{
    serverId: string | null | undefined;
    targetKey: BackendTargetKeyV2 | string;
}>): string {
    return `${normalizeServerScopeId(params.serverId)}:${params.targetKey}`;
}

export function buildRememberedEngineSelectionScopeKey(params: Readonly<{
    serverId: string | null | undefined;
    backendTarget: BackendTargetRefV2;
}>): string {
    return buildRememberedEngineSelectionScopeKeyForTargetKey({
        serverId: params.serverId,
        targetKey: buildBackendTargetKeyV2(params.backendTarget),
    });
}

export function readRememberedEngineSelection(params: Readonly<{
    enabled: boolean;
    selectionsByScope: RememberedEngineSelectionsByScopeV1 | null | undefined;
    serverId: string | null | undefined;
    backendTarget: BackendTargetRefV2;
}>): RememberedEngineSelectionV1 | null {
    if (!params.enabled) return null;
    const scopeKey = buildRememberedEngineSelectionScopeKey({
        serverId: params.serverId,
        backendTarget: params.backendTarget,
    });
    return params.selectionsByScope?.[scopeKey] ?? null;
}

export function readRememberedEngineSelectionForTargetKey(params: Readonly<{
    enabled: boolean;
    selectionsByScope: RememberedEngineSelectionsByScopeV1 | null | undefined;
    serverId: string | null | undefined;
    targetKey: BackendTargetKeyV2 | string;
}>): RememberedEngineSelectionV1 | null {
    if (!params.enabled) return null;
    const scopeKey = buildRememberedEngineSelectionScopeKeyForTargetKey({
        serverId: params.serverId,
        targetKey: params.targetKey,
    });
    return params.selectionsByScope?.[scopeKey] ?? null;
}

export function upsertRememberedEngineSelection(params: Readonly<{
    selectionsByScope: RememberedEngineSelectionsByScopeV1 | null | undefined;
    serverId: string | null | undefined;
    backendTarget: BackendTargetRefV2;
    selection: Readonly<{
        modelId: string;
        acpSessionModeId?: string | null;
        sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    }>;
    updatedAt: number;
}>): RememberedEngineSelectionsByScopeV1 {
    const modelId = params.selection.modelId.trim();
    if (!modelId) {
        return params.selectionsByScope ?? {};
    }

    const scopeKey = buildRememberedEngineSelectionScopeKey({
        serverId: params.serverId,
        backendTarget: params.backendTarget,
    });
    const acpSessionModeId = normalizeOptionalSelectionValue(params.selection.acpSessionModeId);
    return {
        ...(params.selectionsByScope ?? {}),
        [scopeKey]: {
            v: 1,
            modelId,
            acpSessionModeId,
            sessionConfigOptionOverrides: params.selection.sessionConfigOptionOverrides ?? null,
            updatedAt: params.updatedAt,
        },
    };
}

export function areRememberedEngineSelectionsEquivalent(
    left: RememberedEngineSelectionV1 | null | undefined,
    right: RememberedEngineSelectionV1 | null | undefined,
): boolean {
    if (!left || !right) return left === right;
    return left.modelId === right.modelId
        && (left.acpSessionModeId ?? null) === (right.acpSessionModeId ?? null)
        && JSON.stringify(left.sessionConfigOptionOverrides ?? null) === JSON.stringify(right.sessionConfigOptionOverrides ?? null);
}
