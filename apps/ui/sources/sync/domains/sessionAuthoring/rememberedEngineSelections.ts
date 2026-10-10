import {
    AcpConfigOptionOverridesV1Schema,
    buildBackendTargetKey,
    type AcpConfigOptionOverridesV1,
    type BackendTargetRefV1,
} from '@happier-dev/protocol';
import { z } from 'zod';
import {
    opaqueSessionControlIdentifierSchema,
    readNonBlankSessionControlIdentifier,
} from '@/sync/domains/sessionControl/opaqueIdentifiers';

export type RememberedEngineSelectionV1 = Readonly<{
    modelId: string | null;
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
    updatedAt: number;
}>;

const RememberedEngineSelectionV1Schema = z.object({
    modelId: opaqueSessionControlIdentifierSchema.nullable().default(null),
    acpSessionModeId: opaqueSessionControlIdentifierSchema.nullable().default(null),
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.nullable().default(null),
    updatedAt: z.number().finite(),
});

export const RememberedEngineSelectionsByScopeV1Schema = z.preprocess((value) => {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};

    return Object.fromEntries(
        Object.entries(record).flatMap(([scopeKey, rawSelection]) => {
            const normalizedScopeKey = scopeKey.trim();
            if (!normalizedScopeKey) return [];

            const parsed = RememberedEngineSelectionV1Schema.safeParse(rawSelection);
            return parsed.success ? [[normalizedScopeKey, parsed.data]] : [];
        }),
    );
}, z.record(z.string().min(1), RememberedEngineSelectionV1Schema).default({}));

export type RememberedEngineSelectionsByScopeV1 = z.infer<typeof RememberedEngineSelectionsByScopeV1Schema>;

export function buildRememberedEngineSelectionScopeKey(params: Readonly<{
    serverId: string | null | undefined;
    backendTarget: BackendTargetRefV1;
}>): string {
    const serverId = String(params.serverId ?? '').trim() || 'default';
    return `${serverId}:${buildBackendTargetKey(params.backendTarget)}`;
}

export function readRememberedEngineSelection(params: Readonly<{
    enabled: boolean;
    selectionsByScope: unknown;
    serverId: string | null | undefined;
    backendTarget: BackendTargetRefV1;
}>): RememberedEngineSelectionV1 | null {
    if (!params.enabled) return null;
    const parsed = RememberedEngineSelectionsByScopeV1Schema.safeParse(params.selectionsByScope);
    if (!parsed.success) return null;
    return parsed.data[buildRememberedEngineSelectionScopeKey(params)] ?? null;
}

export function upsertRememberedEngineSelection(params: Readonly<{
    selectionsByScope: unknown;
    serverId: string | null | undefined;
    backendTarget: BackendTargetRefV1;
    selection: Readonly<{
        modelId?: string | null;
        acpSessionModeId?: string | null;
        sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    }>;
    updatedAt: number;
}>): RememberedEngineSelectionsByScopeV1 {
    const parsed = RememberedEngineSelectionsByScopeV1Schema.safeParse(params.selectionsByScope);
    const next = parsed.success ? { ...parsed.data } : {};
    const scopeKey = buildRememberedEngineSelectionScopeKey(params);
    next[scopeKey] = {
        modelId: normalizeOptionalString(params.selection.modelId),
        acpSessionModeId: readNonBlankSessionControlIdentifier(params.selection.acpSessionModeId),
        sessionConfigOptionOverrides: params.selection.sessionConfigOptionOverrides ?? null,
        updatedAt: params.updatedAt,
    };
    return next;
}

function normalizeOptionalString(value: unknown): string | null {
    const normalized = readNonBlankSessionControlIdentifier(value) ?? '';
    return normalized.length > 0 && normalized !== 'default' ? normalized : null;
}
