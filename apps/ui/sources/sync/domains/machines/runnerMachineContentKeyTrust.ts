import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { parseToken } from '@/utils/auth/parseToken';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { loadRunnerCreatorMachineContentKeyTrust } from '@/sync/domains/ephemeralRunner/runnerCreatorMachineContentKeyTrust';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type {
    AccountScopedCryptoMaterial} from '@happier-dev/protocol/crypto/accountScopedCipher';
import type {
    ExpectedRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol/machines/machineStoredContent';

/**
 * What this device independently knows about a Runner Machine's content key.
 *
 * `expectedRunnerBinding` is the trusted scope the key proof is verified against.
 * `trustedMachineKind` is present only when this device holds creator custody for
 * that exact Machine, which is a classification the Home cannot rewrite; it is
 * deliberately absent on every other device, where the Account-material route
 * authenticates the binding but identifies nothing on its own.
 */
export type ResolvedRunnerMachineContentKeyTrustV1 = Readonly<{
    expectedRunnerBinding: ExpectedRunnerMachineContentKeyBindingV1;
    trustedMachineKind?: 'ephemeral_session_runner';
}>;

/**
 * Build the independently trusted scope used to verify a Runner Machine key.
 *
 * The Home publishes the signed binding and wrapped key, but never supplies its
 * own verification identity. The verifier is the creator-generated activation
 * signing identity, reached two ways: the creating device recovers it from its
 * own device-local custody, and every other authorized device of the same
 * Account recovers it by opening the creator-sealed verifier fact carried by
 * the binding with Account material the Home does not hold. Both routes make
 * joint substitution of verifier key, binding and an Account-openable envelope
 * fail; a token-only device holds neither and the Runner Machine stays locked.
 *
 * This is resolved for every Machine, never only for rows the Home labels a
 * Runner: gating the lookup on that label would let a relabelling suppress the
 * trusted answer before it is ever asked for.
 */
export async function resolveRunnerMachineContentKeyTrustV1(params: Readonly<{
    credentials: AuthCredentials;
    homeServerIdentityId: string | null | undefined;
    machineId: string;
}>): Promise<ResolvedRunnerMachineContentKeyTrustV1 | null> {
    const homeServerIdentityId = String(params.homeServerIdentityId ?? '').trim();
    const machineId = String(params.machineId ?? '').trim();
    if (!homeServerIdentityId || !machineId) return null;

    let creatorAccountId: string;
    try {
        creatorAccountId = parseToken(params.credentials.token);
    } catch {
        return null;
    }

    const scope = createServerAccountScope(homeServerIdentityId, creatorAccountId);
    if (!scope) return null;
    let trust;
    try {
        trust = await loadRunnerCreatorMachineContentKeyTrust(scope, machineId);
    } catch {
        return null;
    }
    if (trust) {
        return {
            expectedRunnerBinding: {
                homeServerIdentityId,
                creatorAccountId,
                machineId,
                // Field name is the released shape; the value is the creator activation
                // signing public key retained device-locally, never a Home-published one.
                accountSigningPublicKeyBase64Url: trust.activationSigningPublicKey,
            },
            // Creator custody for this exact Machine is a Home-independent fact,
            // so it is also the classification the key resolver may trust.
            trustedMachineKind: 'ephemeral_session_runner',
        };
    }

    let accountScopedMaterial: AccountScopedCryptoMaterial;
    try {
        accountScopedMaterial = resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
    } catch {
        return null;
    }
    return {
        expectedRunnerBinding: { homeServerIdentityId, creatorAccountId, machineId, accountScopedMaterial },
    };
}
