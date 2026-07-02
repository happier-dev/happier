import {
    ConnectedServiceBindingsV1Schema,
    type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

export const HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY =
    'HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_JSON' as const;

export function serializeSessionConnectedServicesBindingsForEnv(value: unknown): string | null {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(value);
    return parsed.success ? JSON.stringify(parsed.data) : null;
}

export function parseSessionConnectedServicesBindingsJson(raw: string | null): ConnectedServiceBindingsV1 | null {
    if (raw === null) return null;

    try {
        const parsed = JSON.parse(raw);
        const validated = ConnectedServiceBindingsV1Schema.safeParse(parsed);
        return validated.success ? validated.data : null;
    } catch {
        return null;
    }
}
