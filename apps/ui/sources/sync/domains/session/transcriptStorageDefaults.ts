import { BackendTargetKeySchema, buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { AgentId } from '@/agents/catalog/catalog';

export const SESSION_TRANSCRIPT_STORAGE_MODES = ['persisted', 'direct'] as const;

export type SessionTranscriptStorageMode = typeof SESSION_TRANSCRIPT_STORAGE_MODES[number];

export type AccountTranscriptStorageDefaults = Readonly<{
    globalDefault: SessionTranscriptStorageMode;
    byTargetKey: Readonly<Partial<Record<string, SessionTranscriptStorageMode>>>;
}>;

export function normalizeSessionTranscriptStorageMode(
    value: unknown,
): SessionTranscriptStorageMode | null {
    return value === 'direct' || value === 'persisted' ? value : null;
}

export function serializeTranscriptStorageModeByTargetKeyAnalytics(
    value: unknown,
): Record<string, SessionTranscriptStorageMode> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(value)
            .flatMap(([targetKey, rawValue]) => {
                if (!BackendTargetKeySchema.safeParse(targetKey).success) {
                    return [];
                }
                const normalized = normalizeSessionTranscriptStorageMode(rawValue);
                if (!normalized) {
                    return [];
                }
                return [[targetKey, normalized] as const];
            })
            .sort(([left], [right]) => left.localeCompare(right)),
    );
}

export function readAccountTranscriptStorageDefaults(params: Readonly<{
    globalDefault: unknown;
    byTargetKey: unknown;
    enabledBackendTargets: readonly BackendTargetRefV1[];
}>): AccountTranscriptStorageDefaults {
    const rawByTargetKey = params.byTargetKey && typeof params.byTargetKey === 'object'
        ? params.byTargetKey as Record<string, unknown>
        : {};

    const byTargetKey: Partial<Record<string, SessionTranscriptStorageMode>> = {};
    for (const target of params.enabledBackendTargets) {
        const targetKey = buildBackendTargetKey(target);
        const parsed = normalizeSessionTranscriptStorageMode(rawByTargetKey[targetKey]);
        if (parsed) {
            byTargetKey[targetKey] = parsed;
        }
    }

    return {
        globalDefault: normalizeSessionTranscriptStorageMode(params.globalDefault) ?? 'persisted',
        byTargetKey,
    };
}

export function resolveNewSessionDefaultTranscriptStorage(params: Readonly<{
    agentType: AgentId;
    backendTarget?: BackendTargetRefV1 | null;
    accountDefaults: AccountTranscriptStorageDefaults;
    profileDefaultsByTargetKey?: Record<string, SessionTranscriptStorageMode | undefined> | null;
}>): SessionTranscriptStorageMode {
    const targetKey = buildBackendTargetKey(
        params.backendTarget ?? { kind: 'builtInAgent', agentId: params.agentType },
    );
    const profileDefaultForTarget = params.profileDefaultsByTargetKey?.[targetKey];
    if (profileDefaultForTarget === 'direct' || profileDefaultForTarget === 'persisted') {
        return profileDefaultForTarget;
    }

    const accountByTargetKey = params.accountDefaults.byTargetKey[targetKey];
    if (accountByTargetKey === 'direct' || accountByTargetKey === 'persisted') {
        return accountByTargetKey;
    }

    return params.accountDefaults.globalDefault;
}
