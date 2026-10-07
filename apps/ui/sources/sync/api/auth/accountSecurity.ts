import { ACCOUNT_EMAIL_CHANGE_PATH_V1, ACCOUNT_PASSWORD_CHANGE_PATH_V1, ACCOUNT_PASSWORD_ENROLL_PATH_V1, ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1, ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1, ACCOUNT_PASSWORD_REMOVE_PATH_V1, ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1, ACCOUNT_SECURITY_PATH_V1, ACCOUNT_TERMINAL_PRESENT_USER_POLICY_PATH_V1, AccountPasswordMutationResponseV1Schema, AccountEmailChangeRequestResponseV1Schema, AccountSecurityGetResponseV1Schema, AccountTerminalPresentUserPolicySetResponseV1Schema, type AccountTerminalPresentUserPolicySetRequestV1, AccountSecurityRouteErrorV1Schema, PasswordMutationPreparationResponseV1Schema, type AccountPasswordChangeRequestV1, type AccountPasswordEnrollRequestV1, type AccountPasswordRemoveRequestV1, type AccountSecurityGetResponseV1 } from '@happier-dev/protocol/auth/accountSecurity';
import { createAccountEncryptionMigrateRequestBindingDigestV1, type AccountEncryptionMigrateRequest, type AccountEncryptionMigrateTransitionPasswordCredential } from '@happier-dev/protocol/account/encryptionMigrate';
import { buildE2eeAccountPasswordEnrollRequestV1, buildE2eeAccountPasswordChangeRequestV1, buildE2eeAccountPasswordRemoveRequestV1, createE2eePasswordMutationChallengeProofV1, readE2eePasswordPreparationV1 } from '@happier-dev/protocol/auth/accountSecurityCrypto';
import { createPasswordCredentialTargetDigestV1 } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { PlainAccountPasswordCredentialV1Schema, type PlainAccountPasswordCredentialV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import type { KeyChallengeV2Audience } from '@happier-dev/protocol/auth/keyChallenge';
import { z } from 'zod';

import type { ServerFetch } from '@/sync/http/client';
import { createHomeIdentityMismatchFailure } from '@/auth/flows/authenticationFailure';
import { HappyError } from '@/utils/errors/errors';
import { preparePasswordCredentialMaterialV1, type PreparedPasswordCredentialMaterialV1 } from '@/auth/password/preparePasswordCredential';
import {
    assertAccountEncryptionMigrationScopeCurrent,
    type AccountEncryptionMigrationScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';

export type AccountSecurityProjectionV1 = AccountSecurityGetResponseV1;

function preparedCredentialOrThrow<T>(build: () => T): T {
    try {
        return build();
    } catch (error) {
        if (error instanceof Error && error.message === 'password_credential_challenge_identity_mismatch') {
            throw createHomeIdentityMismatchFailure();
        }
        if (error instanceof Error && error.message.startsWith('password_credential_')) {
            throw new HappyError('Account security request failed', false, {
                kind: 'auth', code: 'credential_inconsistent',
            });
        }
        throw error;
    }
}

async function call(
    request: ServerFetch,
    path: string,
    body: unknown | null,
    signal?: AbortSignal,
    mutationOutput?: z.ZodType,
): Promise<unknown> {
    signal?.throwIfAborted();
    let issued = false;
    let response: Response;
    try {
        response = await request(path, body === null
        ? { method: 'GET', ...(signal ? { signal } : {}) }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
        }, { retry: 'none', onIssued: () => { issued = true; } });
    } catch (error) {
        if (mutationOutput && classifyHomeDomainHttpMutationFailureV1({
            error, issued, aborted: signal?.aborted === true,
        }) === 'outcome_unknown') {
            throw new HappyError('Account security mutation outcome is unknown', false, { code: 'outcome_unknown' });
        }
        throw error;
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = AccountSecurityRouteErrorV1Schema.safeParse(payload);
        if (mutationOutput && !parsed.success) {
            throw new HappyError('Account security mutation outcome is unknown', false, { code: 'outcome_unknown' });
        }
        throw new HappyError('Account security request failed', response.status >= 500 || response.status === 429, {
            kind: response.status >= 500 ? 'server' : 'auth',
            status: response.status,
            ...(parsed.success ? { code: parsed.data.error } : {}),
        });
    }
    if (mutationOutput && !mutationOutput.safeParse(payload).success) {
        throw new HappyError('Account security mutation outcome is unknown', false, { code: 'outcome_unknown' });
    }
    return payload;
}

export async function fetchAccountSecurity(request: ServerFetch, signal?: AbortSignal): Promise<AccountSecurityProjectionV1> {
    return AccountSecurityGetResponseV1Schema.parse(await call(request, ACCOUNT_SECURITY_PATH_V1, null, signal));
}

/** Exact-Home HTTP leaf for the CLI/daemon approvals policy (`account.security.terminalPresentUser.set`). */
export async function setAccountTerminalPresentUserPolicy(
    request: ServerFetch,
    input: AccountTerminalPresentUserPolicySetRequestV1,
    signal?: AbortSignal,
) {
    return AccountTerminalPresentUserPolicySetResponseV1Schema.parse(await call(
        request, ACCOUNT_TERMINAL_PRESENT_USER_POLICY_PATH_V1, input, signal, AccountTerminalPresentUserPolicySetResponseV1Schema,
    ));
}

/** Exact-Home HTTP leaf used by the shared Account Security Action adapter. */
export async function enrollAccountPassword(
    request: ServerFetch,
    input: AccountPasswordEnrollRequestV1,
    signal?: AbortSignal,
) {
    return AccountPasswordMutationResponseV1Schema.parse(await call(
        request, ACCOUNT_PASSWORD_ENROLL_PATH_V1, input, signal, AccountPasswordMutationResponseV1Schema,
    ));
}

/** Start the mailbox proof consumed only by first password enrollment. */
export async function requestAccountPasswordEnrollmentEmail(
    request: ServerFetch,
    input: Readonly<{ email: string }>,
    signal?: AbortSignal,
): Promise<void> {
    AccountEmailChangeRequestResponseV1Schema.parse(await call(
        request,
        ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1,
        { v: 1, email: input.email },
        signal,
        AccountEmailChangeRequestResponseV1Schema,
    ));
}

/**
 * Replace an existing Plain password. The expected credential revision fences
 * a concurrent change or reset; the Home refuses a stale attempt rather than
 * overwriting a newer credential.
 */
export async function changeAccountPassword(request: ServerFetch, input: Readonly<{
    expectedCredentialRevision: number;
    currentPassword: string;
    newPassword: string;
    verificationToken?: string;
}>, signal?: AbortSignal) {
    return AccountPasswordMutationResponseV1Schema.parse(await call(request, ACCOUNT_PASSWORD_CHANGE_PATH_V1, {
        v: 1,
        kind: 'plain',
        ...input,
    }, signal, AccountPasswordMutationResponseV1Schema));
}

export async function submitAccountPasswordChange(
    request: ServerFetch,
    input: AccountPasswordChangeRequestV1,
    signal?: AbortSignal,
) {
    return AccountPasswordMutationResponseV1Schema.parse(await call(
        request, ACCOUNT_PASSWORD_CHANGE_PATH_V1, input, signal, AccountPasswordMutationResponseV1Schema,
    ));
}

/** Submit a fully prepared E2EE password replacement through the canonical mutation route. */
export async function submitE2eeAccountPasswordChange(
    request: ServerFetch,
    input: Extract<AccountPasswordChangeRequestV1, { kind: 'e2ee' }>,
): Promise<void> {
    AccountPasswordMutationResponseV1Schema.parse(await call(request, ACCOUNT_PASSWORD_CHANGE_PATH_V1, input, undefined, AccountPasswordMutationResponseV1Schema));
}

/** Remove the native password credential and its email login locator. */
export async function removeAccountPassword(request: ServerFetch, input: Readonly<{
    expectedCredentialRevision: number;
    currentPassword: string;
}>, signal?: AbortSignal) {
    return AccountPasswordMutationResponseV1Schema.parse(await call(request, ACCOUNT_PASSWORD_REMOVE_PATH_V1, {
        v: 1,
        kind: 'plain',
        ...input,
    }, signal, AccountPasswordMutationResponseV1Schema));
}

export async function submitAccountPasswordRemove(
    request: ServerFetch,
    input: AccountPasswordRemoveRequestV1,
    signal?: AbortSignal,
) {
    return AccountPasswordMutationResponseV1Schema.parse(await call(
        request, ACCOUNT_PASSWORD_REMOVE_PATH_V1, input, signal, AccountPasswordMutationResponseV1Schema,
    ));
}

export async function requestAccountSignInEmailChange(
    request: ServerFetch,
    input: Readonly<{ v: 1; email: string }>,
    signal?: AbortSignal,
) {
    return AccountEmailChangeRequestResponseV1Schema.parse(await call(
        request, ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1, input, signal, AccountEmailChangeRequestResponseV1Schema,
    ));
}

type E2eePasswordMutationCommon = Readonly<{
    accountId: string;
    expectedCredentialRevision: number;
    normalizedNativeEmail: string | null;
    secret: Uint8Array;
    expectedAudience: Required<KeyChallengeV2Audience>;
}>;

async function prepareE2eePasswordMutation(request: ServerFetch, input: Readonly<{
    action: 'connect' | 'change' | 'recover';
    expectedCredentialRevision: number | null;
    normalizedNativeEmail: string | null;
    preparedCredentialMaterial: PreparedPasswordCredentialMaterialV1;
}>): Promise<unknown> {
    const prepared = PasswordMutationPreparationResponseV1Schema.parse(await call(
        request,
        ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1,
        {
            v: 1,
            action: input.action,
            expectedCredentialRevision: input.expectedCredentialRevision,
            normalizedNativeEmail: input.normalizedNativeEmail,
            newE2eePassword: input.preparedCredentialMaterial,
        },
    ));
    return prepared;
}

/**
 * Prepare the exact salted verifier committed by first Plain password enrollment.
 * The raw password crosses only this authenticated preparation request and is
 * never retained across the external-auth continuation.
 */
export async function preparePlainAccountPasswordEnroll(
    request: ServerFetch,
    input: Readonly<{
        normalizedNativeEmail: string;
        newPassword: string;
        signal?: AbortSignal;
    }>,
): Promise<PlainAccountPasswordCredentialV1> {
    const prepared = PasswordMutationPreparationResponseV1Schema.parse(await call(
        request,
        ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1,
        {
            v: 1,
            action: 'connect',
            expectedCredentialRevision: null,
            normalizedNativeEmail: input.normalizedNativeEmail,
            newPlainPassword: input.newPassword,
        },
        input.signal,
    ));
    if (!('targetCredential' in prepared)) {
        throw new HappyError('Account security request failed', false, {
            kind: 'auth',
            code: 'credential_inconsistent',
        });
    }
    const targetCredential = PlainAccountPasswordCredentialV1Schema.safeParse(
        prepared.targetCredential,
    );
    if (!targetCredential.success) {
        throw new HappyError('Account security request failed', false, {
            kind: 'auth',
            code: 'credential_inconsistent',
        });
    }
    return targetCredential.data;
}

/** Prepare first E2EE password enrollment for the shared present-user Action. */
export async function prepareE2eeAccountPasswordEnroll(request: ServerFetch, input: Readonly<{
    accountId: string;
    email: string;
    normalizedNativeEmail: string;
    secret: Uint8Array;
    expectedAudience: Required<KeyChallengeV2Audience>;
    newPassword: string;
    signal?: AbortSignal;
    verificationToken?: string;
    preparedCredentialMaterial?: PreparedPasswordCredentialMaterialV1;
}>): Promise<Extract<AccountPasswordEnrollRequestV1, { kind: 'e2ee' }>> {
    const preparedCredentialMaterial = input.preparedCredentialMaterial
        ?? await preparePasswordCredentialMaterialV1({
            password: input.newPassword,
            secret: input.secret,
            ...(input.signal ? { signal: input.signal } : {}),
        });
    const prepared = await prepareE2eePasswordMutation(request, {
        action: 'connect',
        expectedCredentialRevision: null,
        normalizedNativeEmail: input.normalizedNativeEmail,
        preparedCredentialMaterial,
    });
    return preparedCredentialOrThrow(() => buildE2eeAccountPasswordEnrollRequestV1({
        email: input.email,
        accountId: input.accountId,
        normalizedNativeEmail: input.normalizedNativeEmail,
        recoverySecret: input.secret,
        expectedAudience: input.expectedAudience,
        expectedEnvelope: preparedCredentialMaterial.envelope,
        preparation: prepared,
        ...(input.verificationToken ? { verificationToken: input.verificationToken } : {}),
    }));
}

/**
 * Replace the E2EE password wrapper without rotating the recovery secret,
 * signing identity, content key, or encrypted Account data.
 */
/** Prepare the final strict request so trusted UI/CLI can submit it as the shared Action. */
export async function prepareE2eeAccountPasswordChange(request: ServerFetch, input: E2eePasswordMutationCommon & Readonly<{
    newPassword: string;
    action?: 'change' | 'recover';
    preparedCredentialMaterial?: PreparedPasswordCredentialMaterialV1;
    signal?: AbortSignal;
}>): Promise<Extract<AccountPasswordChangeRequestV1, { kind: 'e2ee' }>> {
    const action = input.action ?? 'change';
    const preparedCredentialMaterial = input.preparedCredentialMaterial
        ?? await preparePasswordCredentialMaterialV1({
            password: input.newPassword,
            secret: input.secret,
            ...(input.signal ? { signal: input.signal } : {}),
        });
    const prepared = await prepareE2eePasswordMutation(request, {
        ...input,
        action,
        normalizedNativeEmail: input.normalizedNativeEmail,
        preparedCredentialMaterial,
    });
    return preparedCredentialOrThrow(() => buildE2eeAccountPasswordChangeRequestV1({
        action,
        expectedCredentialRevision: input.expectedCredentialRevision,
        accountId: input.accountId,
        normalizedNativeEmail: input.normalizedNativeEmail,
        recoverySecret: input.secret,
        expectedAudience: input.expectedAudience,
        expectedEnvelope: preparedCredentialMaterial.envelope,
        preparation: prepared,
    }));
}

/** Remove only the E2EE password envelope/native locator after fresh key proof. */
/** Prepare the final strict removal request for the shared present-user Action. */
export async function prepareE2eeAccountPasswordRemove(
    request: ServerFetch,
    input: E2eePasswordMutationCommon,
): Promise<Extract<AccountPasswordRemoveRequestV1, { kind: 'e2ee' }>> {
    const prepared = PasswordMutationPreparationResponseV1Schema.parse(await call(
        request,
        ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1,
        {
            v: 1,
            action: 'remove',
            expectedCredentialRevision: input.expectedCredentialRevision,
            normalizedNativeEmail: input.normalizedNativeEmail,
        },
    ));
    if (!('challenge' in prepared) || !prepared.challenge) {
        throw new HappyError('Account security request failed', false, {
            kind: 'auth', code: 'credential_inconsistent',
        });
    }
    return preparedCredentialOrThrow(() => buildE2eeAccountPasswordRemoveRequestV1({
        accountId: input.accountId,
        normalizedNativeEmail: input.normalizedNativeEmail,
        expectedCredentialRevision: input.expectedCredentialRevision,
        recoverySecret: input.secret,
        expectedAudience: input.expectedAudience,
        preparation: prepared,
    }));
}

/** Prepare the password participant consumed by the incumbent atomic mode transition. */
export async function prepareAccountEncryptionModePasswordCredential(
    request: ServerFetch,
    input: E2eePasswordMutationCommon & Readonly<{
        fromMode: 'plain' | 'e2ee';
        toMode: 'plain' | 'e2ee';
        password: string;
        accountId: string;
        baseRequest?: AccountEncryptionMigrateRequest;
        signal?: AbortSignal;
        /** Test/continuation seam for already prepared memory-hard work. */
        preparedCredentialMaterial?: PreparedPasswordCredentialMaterialV1;
        scope: AccountEncryptionMigrationScope;
    }>,
): Promise<AccountEncryptionMigrateTransitionPasswordCredential> {
    assertAccountEncryptionMigrationScopeCurrent(input.scope);
    if (input.fromMode === input.toMode) {
        throw new Error('Password credential transition requires distinct Account modes');
    }
    if (input.toMode === 'e2ee') {
        const material = input.preparedCredentialMaterial
            ?? await preparePasswordCredentialMaterialV1({
                password: input.password,
                secret: input.secret,
                ...(input.signal ? { signal: input.signal } : {}),
            });
        assertAccountEncryptionMigrationScopeCurrent(input.scope);
        const prepared = await call(
            request,
            ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1,
            {
                v: 1,
                action: 'change',
                expectedCredentialRevision: input.expectedCredentialRevision,
                normalizedNativeEmail: input.normalizedNativeEmail,
                newE2eePassword: material,
            },
        );
        assertAccountEncryptionMigrationScopeCurrent(input.scope);
        const targetCredential = preparedCredentialOrThrow(
            () => readE2eePasswordPreparationV1(prepared, material.envelope).targetCredential,
        );
        return { expectedRevision: input.expectedCredentialRevision, credential: targetCredential };
    }
    if (!input.baseRequest) throw new Error('Plain target credential requires its base migration request');
    const transitionRequestDigest = createAccountEncryptionMigrateRequestBindingDigestV1({
        request: input.baseRequest,
        accountId: input.accountId,
        sourceMode: 'e2ee',
    });
    const prepared = PasswordMutationPreparationResponseV1Schema.parse(await call(
        request,
        ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1,
        {
            v: 1,
            action: 'change',
            expectedCredentialRevision: input.expectedCredentialRevision,
            normalizedNativeEmail: input.normalizedNativeEmail,
            newPlainPassword: input.password,
            transitionRequestDigest,
        },
    ));
    assertAccountEncryptionMigrationScopeCurrent(input.scope);
    if (!('targetCredential' in prepared) || prepared.targetCredential.kind !== 'plain_password_hash'
        || !prepared.challenge) {
        throw new HappyError('Account security request failed', false, { kind: 'auth', code: 'credential_inconsistent' });
    }
    // Hoisted so the guard above still holds inside the deferred proof callback,
    // which does not inherit narrowing of a property path.
    const challenge = prepared.challenge;
    const targetCredential = prepared.targetCredential;
    return {
        expectedRevision: input.expectedCredentialRevision,
        credential: targetCredential,
        proof: preparedCredentialOrThrow(() => createE2eePasswordMutationChallengeProofV1(
            input.secret,
            challenge,
            input.expectedAudience,
            {
                v: 1,
                action: 'change',
                accountId: input.accountId,
                expectedCredentialRevision: input.expectedCredentialRevision,
                normalizedNativeEmail: input.normalizedNativeEmail,
                newCredentialDigest: createPasswordCredentialTargetDigestV1(
                    targetCredential,
                    transitionRequestDigest,
                ),
            },
        )),
    };
}

/** Commit a verified target address as the one native sign-in email. */
export async function changeAccountSignInEmail(request: ServerFetch, input: Readonly<{
    verificationToken: string;
}>): Promise<void> {
    AccountPasswordMutationResponseV1Schema.parse(await call(
        request, ACCOUNT_EMAIL_CHANGE_PATH_V1, { v: 1, ...input }, undefined, AccountPasswordMutationResponseV1Schema,
    ));
}
