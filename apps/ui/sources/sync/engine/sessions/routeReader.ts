import type { Encryption } from '@/sync/encryption/encryption';
import type { ResolvedServerAccountRequestContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext';

/** Carry the by-ID owner's captured reader to readiness checks and coalesced borrowers. */
export function createSessionRouteReader(initial: Readonly<{
    sessionId: string;
    accountId: string;
    encryption: Encryption | null;
}>) {
    let accountId = initial.accountId;
    let encryption = initial.encryption;
    return {
        get accountId() { return accountId; },
        get encryption() { return encryption; },
        capture(context: ResolvedServerAccountRequestContext): void {
            if (context.scope === 'scoped') {
                accountId = context.targetAccountId;
                encryption = context.encryption;
            }
        },
        readSessionEncryption: () => encryption?.getSessionEncryption(initial.sessionId) ?? null,
    };
}
