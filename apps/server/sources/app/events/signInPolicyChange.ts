import { z } from 'zod';
import type { Server } from 'socket.io';

/** Server-side (cluster) notice that the Home sign-in policy changed; it carries no data. */
export const SIGN_IN_POLICY_CHANGED_EVENT = 'happier:sign-in-policy-changed:v1';

/** Reuse the authenticated server-side adapter path; this event is never accepted from a client socket. */
export function registerSignInPolicyChangeHandler(io: Pick<Server, 'on' | 'off'>, receive: () => void): () => void {
    const handler = () => { receive(); };
    io.on(SIGN_IN_POLICY_CHANGED_EVENT, handler);
    return () => { io.off(SIGN_IN_POLICY_CHANGED_EVENT, handler); };
}

/** Server-side (cluster) notice that one Account's sign-in was revoked (an offboarding verdict). */
export const ACCOUNT_SIGN_IN_REVOKED_EVENT = 'happier:account-sign-in-revoked:v1';
const accountSignInRevokedSchema = z.object({ accountId: z.string().min(1) }).strict();

/** Reuse the authenticated server-side adapter path; this event is never accepted from a client socket. */
export function registerAccountSignInRevokedHandler(io: Pick<Server, 'on' | 'off'>, receive: (accountId: string) => void): () => void {
    const handler = (raw: unknown) => {
        const parsed = accountSignInRevokedSchema.safeParse(raw);
        if (parsed.success) receive(parsed.data.accountId);
    };
    io.on(ACCOUNT_SIGN_IN_REVOKED_EVENT, handler);
    return () => { io.off(ACCOUNT_SIGN_IN_REVOKED_EVENT, handler); };
}
