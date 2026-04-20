import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol';

export type SessionMetadataConfigOptionOverrides = Readonly<{
    v: 1;
    updatedAt: number;
    overrides: Record<string, Readonly<{
        updatedAt: number;
        value: string | number | boolean | null;
    }>>;
}>;

export type SessionMetadataStringOverrideV1 = Readonly<{
    v: 1;
    updatedAt: number;
    modeId: string | null;
}>;

export function parseSessionMetadataConfigOptionOverridesJson(
    raw: string | null,
): SessionMetadataConfigOptionOverrides | null {
    if (raw === null) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw);
        const validated = AcpConfigOptionOverridesV1Schema.safeParse(parsed);
        return validated.success ? validated.data : null;
    } catch {
        return null;
    }
}

export function buildSessionModeOverrideV1(params: Readonly<{
    updatedAt: number;
    modeId: string | null;
}>): SessionMetadataStringOverrideV1 {
    return {
        v: 1,
        updatedAt: params.updatedAt,
        modeId: params.modeId,
    };
}
