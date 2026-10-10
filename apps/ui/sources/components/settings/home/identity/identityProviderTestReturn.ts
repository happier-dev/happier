import type { IdentityConnectionTestDiagnosticsV1 } from '@happier-dev/protocol';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    clearPendingAdministrationOAuth,
    consumePendingAdministrationOAuth,
    setPendingAdministrationOAuth,
    type PendingIdentityProviderTestRecord,
} from '@/sync/domains/pending/pendingAdministrationOAuth';

export type PendingIdentityProviderTest = PendingIdentityProviderTestRecord;

/**
 * Non-secret custody for an OAuth test return, held by the shared administration handoff owner.
 *
 * The authorize URL opens a new document on web (`openExternalUrl` → `window.open(…, 'noopener')`),
 * so this cannot live in module state: the return route runs with its own module registry and would
 * find nothing. The owner is the same durable pending-intent custody the rest of the app uses.
 */
export function recordPendingIdentityProviderTest(pending: PendingIdentityProviderTest): void {
    returnByProviderId.delete(pending.providerId);
    setPendingAdministrationOAuth({ kind: 'identity_provider_test', test: { ...pending } });
}

export function consumePendingIdentityProviderTest(providerId: string): PendingIdentityProviderTest | null {
    return consumePendingAdministrationOAuth(
        'identity_provider_test',
        (pending) => pending.test.providerId === providerId,
    )?.test ?? null;
}

export function discardPendingIdentityProviderTest(providerId: string): void {
    consumePendingAdministrationOAuth(
        'identity_provider_test',
        (pending) => pending.test.providerId === providerId,
    );
}

export type IdentityProviderTestReturnPayload =
    | Readonly<{
        kind: 'completed';
        diagnostics: IdentityConnectionTestDiagnosticsV1 | null;
    }>
    | Readonly<{
        kind: 'approval_pending';
        artifactId: string;
        actionId: 'identity.providers.test.consume';
        scope: ServerAccountScope;
    }>
    | Readonly<{
        kind: 'failed';
        code: string;
    }>;

export type IdentityProviderTestReturn = Readonly<{
    attemptId: string;
}> & IdentityProviderTestReturnPayload;

type ScopedIdentityProviderTestReturn = Readonly<{
    serverId: string;
    accountId: string;
    providerId: string;
    value: IdentityProviderTestReturn;
}>;

const returnByProviderId = new Map<string, ScopedIdentityProviderTestReturn>();

/**
 * The Home test is consumed on the shared OAuth return route, which then navigates
 * back to the provider it belongs to. The sanitized result or exact deferred-Action
 * descriptor rides along in this same one-shot, process-local custody. It never
 * enters URL or durable storage. The destination shell constructs the incumbent
 * approval continuation so its mounted diagnostics callback is used for both the
 * immediate and deferred result.
 */
export function recordIdentityProviderTestReturn(
    pending: PendingIdentityProviderTest,
    value: IdentityProviderTestReturnPayload,
): void {
    const returnedValue: IdentityProviderTestReturn = Object.freeze({
        ...value,
        attemptId: pending.attemptId,
    });
    returnByProviderId.set(pending.providerId, Object.freeze({
        serverId: pending.serverId,
        accountId: pending.accountId,
        providerId: pending.providerId,
        value: returnedValue,
    }));
}

export function consumeIdentityProviderTestReturn(input: Readonly<{
    serverId: string;
    accountId: string;
    providerId: string;
}>): IdentityProviderTestReturn | null {
    const returned = returnByProviderId.get(input.providerId) ?? null;
    if (!returned) return null;
    // A same-provider mismatch must retire the handoff. Keeping it would let a
    // later screen claim a result after an intervening wrong-scope navigation.
    returnByProviderId.delete(input.providerId);
    if (
        returned.accountId !== input.accountId
        || returned.providerId !== input.providerId
        || (
            returned.serverId !== input.serverId
            && !areServerProfileIdentifiersEquivalent(returned.serverId, input.serverId)
        )
    ) return null;
    return returned.value;
}

export function resetPendingIdentityProviderTestsForTests(): void {
    clearPendingAdministrationOAuth();
    returnByProviderId.clear();
}

export async function runTeamIdentityProviderTestReturn(input: Readonly<{
    purpose: string | null;
    resultHandle: string | null;
    error: string | null;
    teamId: string | null;
    connectionId: string;
    consume: (value: Readonly<{
        teamId: string | null;
        connectionId: string;
        resultHandle: string;
    }>) => Promise<Readonly<
        | { ok: true; value?: Readonly<{ diagnostics?: IdentityConnectionTestDiagnosticsV1 }> }
        | { ok: false; failure: Readonly<{ code: string }> }
        | {
            ok: false;
            approvalPending: true;
            artifactId: string;
            failure: Readonly<{ code: 'approval_pending' }>;
        }
    >>;
}>): Promise<Readonly<
    | { kind: 'absent' }
    | { kind: 'consumed'; diagnostics: IdentityConnectionTestDiagnosticsV1 | null }
    | { kind: 'approval_pending'; artifactId: string }
    | { kind: 'failed'; code: string }
>> {
    if (input.purpose !== 'identity_connection_test') return { kind: 'absent' };
    if (input.error || !input.resultHandle) {
        return { kind: 'failed', code: input.error ?? 'identity_connection_test_invalid' };
    }
    const result = await input.consume({
        teamId: input.teamId,
        connectionId: input.connectionId,
        resultHandle: input.resultHandle,
    });
    if (result.ok) return { kind: 'consumed', diagnostics: result.value?.diagnostics ?? null };
    if ('approvalPending' in result && result.approvalPending === true) {
        return { kind: 'approval_pending', artifactId: result.artifactId };
    }
    return { kind: 'failed', code: result.failure?.code ?? 'identity_connection_test_invalid' };
}
