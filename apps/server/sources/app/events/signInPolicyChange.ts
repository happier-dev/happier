import type { Server } from 'socket.io';

/** Server-side (cluster) notice that the Home sign-in policy changed; it carries no data. */
export const SIGN_IN_POLICY_CHANGED_EVENT = 'happier:sign-in-policy-changed:v1';

/** Reuse the authenticated server-side adapter path; this event is never accepted from a client socket. */
export function registerSignInPolicyChangeHandler(io: Pick<Server, 'on' | 'off'>, receive: () => void): () => void {
    const handler = () => { receive(); };
    io.on(SIGN_IN_POLICY_CHANGED_EVENT, handler);
    return () => { io.off(SIGN_IN_POLICY_CHANGED_EVENT, handler); };
}
