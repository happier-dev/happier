/**
 * Test-only RPC boundary for permission-response behavior. Production account
 * actors are minted by the authenticated server; tests that exercise a normal
 * present-user response must model that boundary instead of calling the daemon
 * handler raw.
 */
type RegisteredRpcHandler = (payload: unknown, context?: unknown) => unknown | Promise<unknown>;

function serverStampedPermissionContext(sessionId: string) {
    return {
        signal: new AbortController().signal,
        authorization: {
            kind: 'session.permission.respond' as const,
            sessionId,
            actor: {
                kind: 'accountUser' as const,
                accountId: 'account-owner',
                relationship: 'owner' as const,
            },
        },
    };
}

export class ServerBoundPermissionRpcHandlerManager {
    handlers = new Map<string, RegisteredRpcHandler>();

    constructor(private readonly sessionId: string) {}

    registerHandler(name: string, handler: RegisteredRpcHandler): void {
        if (name !== 'permission' && name !== 'session.permission.respond') {
            this.handlers.set(name, handler);
            return;
        }
        this.handlers.set(name, (payload, context) => handler(
            payload,
            context ?? serverStampedPermissionContext(this.sessionId),
        ));
    }
}
