import {
    ConnectedServiceMaterializationIdentityV1Schema,
    type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

export const HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY =
    'HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON' as const;

export function serializeSessionConnectedServiceMaterializationIdentityForEnv(value: unknown): string | null {
    const parsed = ConnectedServiceMaterializationIdentityV1Schema.safeParse(value);
    return parsed.success ? JSON.stringify(parsed.data) : null;
}

export function parseSessionConnectedServiceMaterializationIdentityJson(
    raw: string | null,
): ConnectedServiceMaterializationIdentityV1 | null {
    if (raw === null) return null;

    try {
        const parsed = JSON.parse(raw);
        const validated = ConnectedServiceMaterializationIdentityV1Schema.safeParse(parsed);
        return validated.success ? validated.data : null;
    } catch {
        return null;
    }
}
