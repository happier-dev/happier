import { z } from 'zod';

/**
 * When each app client was last seen. Liveness only: reporting it never creates an account change,
 * bumps a settings version or notifies other clients. Client identity (name, platform, version)
 * stays in synced account settings and changes only when it really changes.
 */
export const CONNECTED_CLIENT_ROUTES = Object.freeze({
    list: '/v1/account/connected-clients',
    seen: '/v1/account/connected-clients/seen',
});

export const ConnectedClientIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const ConnectedClientSeenRequestSchema = z.object({
    clientId: ConnectedClientIdSchema,
});
export type ConnectedClientSeenRequest = z.infer<typeof ConnectedClientSeenRequestSchema>;

export const ConnectedClientsResponseSchema = z.object({
    clients: z.array(z.object({
        clientId: ConnectedClientIdSchema,
        /** Epoch milliseconds. */
        lastSeenAt: z.number().int().nonnegative(),
    })),
});
export type ConnectedClientsResponse = z.infer<typeof ConnectedClientsResponseSchema>;
