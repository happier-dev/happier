import {
    AcpConfigOptionOverridesV1Schema,
    buildBackendTargetKeyV2,
    BackendTargetKeyV2Schema,
    parseBackendTargetKeyV2,
    readBackendTargetRefV2,
    SessionModelSelectionV1Schema,
    type AcpConfigOptionOverridesV1,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
    type BackendTargetKeyV2,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

const RememberedEngineSelectionV1Schema = z.object({
    v: z.literal(1),
    modelSelection: SessionModelSelectionV1Schema.nullable(),
    acpSessionModeId: z.string().trim().min(1).nullable().optional(),
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.nullable().optional(),
    updatedAt: z.number().finite().nonnegative(),
});

export type RememberedEngineSelectionV1 = z.infer<typeof RememberedEngineSelectionV1Schema>;

function normalizeTargetKey(rawTargetKey: string): BackendTargetKeyV2 | null {
    const parsedV2 = BackendTargetKeyV2Schema.safeParse(rawTargetKey);
    try {
        const target = parsedV2.success
            ? parseBackendTargetKeyV2(parsedV2.data)
            : readBackendTargetRefV2(rawTargetKey as BackendTargetRefV2Input);
        return buildBackendTargetKeyV2(target);
    } catch {
        return null;
    }
}

function readTargetKeyFromScopeKey(scopeKey: string): BackendTargetKeyV2 | null {
    const markerIndex = Math.max(
        scopeKey.lastIndexOf(':backend:'),
        scopeKey.lastIndexOf(':agent:'),
    );
    if (markerIndex < 0) return null;
    return normalizeTargetKey(scopeKey.slice(markerIndex + 1));
}

function normalizeScopeKey(scopeKey: string): string | null {
    const markerIndex = Math.max(
        scopeKey.lastIndexOf(':backend:'),
        scopeKey.lastIndexOf(':agent:'),
    );
    if (markerIndex < 0) return null;
    const targetKey = readTargetKeyFromScopeKey(scopeKey);
    if (!targetKey) return null;
    return `${scopeKey.slice(0, markerIndex)}:${targetKey}`;
}

function normalizeRememberedSelectionForScope(scopeKey: string, raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const record = raw as Record<string, unknown>;
    if (record.modelSelection !== undefined) {
        const parsed = SessionModelSelectionV1Schema.safeParse(record.modelSelection);
        if (!parsed.success) return raw;
        const targetKey = readTargetKeyFromScopeKey(scopeKey);
        if (!targetKey) return raw;
        const canonicalSelectionTargetKey = normalizeTargetKey(parsed.data.ref.agentTargetKey);
        if (!canonicalSelectionTargetKey) return raw;
        return {
            ...record,
            modelSelection: {
                ...parsed.data,
                ref: {
                    ...parsed.data.ref,
                    agentTargetKey: canonicalSelectionTargetKey,
                },
            },
        };
    }
    if (typeof record.modelId !== 'string') return raw;
    const targetKey = readTargetKeyFromScopeKey(scopeKey);
    if (!targetKey) return null;
    const modelId = record.modelId.trim();
    const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
        ? Math.max(0, record.updatedAt)
        : 0;
    const { modelId: _legacyModelId, ...rest } = record;
    return {
        ...rest,
        modelSelection: !modelId || modelId === 'default'
            ? null
            : {
                v: 1,
                updatedAt,
                ref: {
                    agentTargetKey: targetKey,
                    providerConnectionId: null,
                    modelId,
                },
            },
    };
}

export const RememberedEngineSelectionsByScopeV1Schema = z.preprocess((value) => {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};

    return Object.fromEntries(
        Object.entries(record).flatMap(([scopeKey, raw]) => {
            const normalizedScopeKey = normalizeScopeKey(scopeKey.trim());
            if (!normalizedScopeKey) return [];
            const normalized = normalizeRememberedSelectionForScope(normalizedScopeKey, raw);
            if (normalized === null) return [];
            const parsed = RememberedEngineSelectionV1Schema.safeParse(normalized);
            const scopedTargetKey = readTargetKeyFromScopeKey(normalizedScopeKey);
            if (!scopedTargetKey) return [];
            if (parsed.success
                && parsed.data.modelSelection !== null
                && parsed.data.modelSelection.ref.agentTargetKey !== scopedTargetKey) return [];
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
        modelSelection: SessionModelSelectionV1 | null;
        acpSessionModeId?: string | null;
        sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    }>;
    updatedAt: number;
}>): RememberedEngineSelectionsByScopeV1 {
    const scopeKey = buildRememberedEngineSelectionScopeKey({
        serverId: params.serverId,
        backendTarget: params.backendTarget,
    });
    const acpSessionModeId = normalizeOptionalSelectionValue(params.selection.acpSessionModeId);
    const agentTargetKey = buildBackendTargetKeyV2(params.backendTarget);
    const modelSelection = params.selection.modelSelection === null
        ? null
        : SessionModelSelectionV1Schema.parse(params.selection.modelSelection);
    if (modelSelection && modelSelection.ref.agentTargetKey !== agentTargetKey) {
        throw new Error('Remembered engine model selection target mismatch');
    }
    return {
        ...(params.selectionsByScope ?? {}),
        [scopeKey]: {
            v: 1,
            modelSelection,
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
    return JSON.stringify(left.modelSelection) === JSON.stringify(right.modelSelection)
        && (left.acpSessionModeId ?? null) === (right.acpSessionModeId ?? null)
        && JSON.stringify(left.sessionConfigOptionOverrides ?? null) === JSON.stringify(right.sessionConfigOptionOverrides ?? null);
}
