export const HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY_ENV_KEY =
    'HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY' as const;

export function readSessionConnectedServiceBrokerSelectionIdentity(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
