import { AuthTokenProvenanceSchema, AuthTokenProvenanceV2Schema, AuthTokenAuthoritySchema, type AuthTokenKind, type AuthTokenProvenanceAny, type AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';

import { auth, type VerifiedApiTokenPrincipal } from "@/app/auth/auth";
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import type { LoginEligibilityResult } from "@/app/auth/loginEligibilityResult";

/**
 * The one bearer-credential verification every HTTP entry point performs.
 *
 * The authenticating decorator and the public auth-entry projection ask exactly
 * the same question — is this an actual, currently eligible Home credential, and
 * which closed provenance did the server itself sign — so it is answered once
 * here. A second verifier is the split brain this module exists to prevent: a
 * public route that decided membership disclosure from a differently-parsed
 * credential would be a security divergence, not a convenience.
 *
 * What this module deliberately does not do is decide HTTP status, route
 * admission, or what an unverified caller may see. Rejection shape belongs to
 * the decorator; treating absence as anonymity belongs to the optional caller.
 */

export type VerifiedRequestPrincipal = Readonly<{
    accountId: string;
    tokenEpoch?: number;
    kind: AuthTokenKind;
    authority: AuthTokenProvenanceAny["authority"];
    legacy: boolean;
    apiTokenPrincipal: VerifiedApiTokenPrincipal | null;
    sessionRuntimePrincipal: VerifiedEphemeralSessionRunnerPrincipal | null;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
    terminalAuthRequestId?: string;
}>;

export type RequestPrincipalVerification =
    /** No bearer credential was presented at all. */
    | Readonly<{ status: "absent" }>
    /**
     * A credential was presented but is not a currently valid, server-signed
     * Home credential, or its provenance is missing/unknown. Unknown provenance
     * is invalid rather than an ordinary Account credential.
     */
    | Readonly<{ status: "invalid" }>
    /** A verified restricted credential whose live scope is no longer current. */
    | Readonly<{
        status: "rejected_restricted";
        kind: "ephemeral_session_runner";
    }>
    /** The credential verified, but its Account may not currently sign in. */
    | Readonly<{ status: "ineligible"; eligibility: Extract<LoginEligibilityResult, { ok: false }> }>
    | Readonly<{ status: "verified"; principal: VerifiedRequestPrincipal }>;

type VerifiedTokenProvenance = Readonly<{
    userId: string;
    tokenEpoch?: number;
    extras?: unknown;
    authTokenKind?: unknown;
    authority?: unknown;
    authTokenMintedAuthority?: unknown;
    legacy: boolean;
    apiTokenPrincipal?: VerifiedApiTokenPrincipal;
    ephemeralSessionRunnerPrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
}>;

function resolveVerifiedAuthProvenance(
    verified: VerifiedTokenProvenance,
): AuthTokenProvenanceAny | null {
    // Database-backed API tokens are resolved by their row owner and are not
    // signed-session V2 tokens. Reuse the closed kind/authority mapping only
    // to validate that explicit principal; never route it through the signed
    // provenance reader or invent authentication evidence for it.
    if (verified.apiTokenPrincipal) {
        if (verified.legacy) return null;
        const parsedApiToken = AuthTokenProvenanceSchema.safeParse({
            v: 1,
            kind: verified.authTokenKind,
            authority: verified.authTokenMintedAuthority ?? verified.authority,
        });
        return parsedApiToken.success && parsedApiToken.data.kind === "api_token"
            ? parsedApiToken.data
            : null;
    }
    const parsed = verified.legacy || verified.authenticationEvidence === undefined
        ? AuthTokenProvenanceSchema.safeParse({
            v: 1,
            kind: verified.authTokenKind,
            authority: verified.authTokenMintedAuthority ?? verified.authority,
        })
        : AuthTokenProvenanceV2Schema.safeParse({
            v: 2,
            kind: verified.authTokenKind,
            authority: verified.authTokenMintedAuthority ?? verified.authority,
            evidence: verified.authenticationEvidence,
        });
    return parsed.success ? parsed.data : null;
}

/**
 * An automation principal is only usable when the token owner's own row agrees
 * with the signed credential. A mismatch is a rejected credential rather than a
 * downgrade to an ordinary Account.
 */
export function resolveVerifiedApiTokenPrincipal(
    verified: VerifiedTokenProvenance,
    tokenKind: AuthTokenKind,
): VerifiedApiTokenPrincipal | null {
    if (tokenKind !== "api_token") return null;
    const principal = verified.apiTokenPrincipal;
    if (
        !principal
        || principal.authority !== "account_automation"
        || principal.accountId !== verified.userId
        || !principal.accountId.trim()
        || !principal.principalId.trim()
        || !principal.credentialId.trim()
    ) {
        return null;
    }
    return principal;
}

/**
 * `null` means no bearer credential was presented. An empty bearer value is a
 * presented credential that fails verification, which is a different outcome
 * from absence and must not be collapsed into it.
 */
export function readBearerCredential(authorizationHeader: unknown): string | null {
    if (typeof authorizationHeader !== "string" || !authorizationHeader.startsWith("Bearer ")) {
        return null;
    }
    return authorizationHeader.substring(7);
}

/**
 * Verify one request's bearer credential through the canonical token and
 * login-eligibility owners.
 *
 * `allowLegacyHomeToken` preserves ordinary-Home compatibility without
 * granting pre-marker credentials authority in route families (including
 * Account Directory and Teams) that require the strict current verifier.
 */
export async function verifyRequestPrincipal(input: Readonly<{
    authorizationHeader: unknown;
    allowLegacyHomeToken: boolean;
    /** The request's Home overlay reader, which carries the live sign-in policy. */
    readEnv: () => Promise<NodeJS.ProcessEnv>;
}>): Promise<RequestPrincipalVerification> {
    const token = readBearerCredential(input.authorizationHeader);
    if (token === null) return { status: "absent" };

    const disposition = await auth.verifyTokenDisposition(token, {
        allowLegacyHome: input.allowLegacyHomeToken,
    });
    if (disposition.status === "rejected_restricted") {
        return { status: "rejected_restricted", kind: disposition.authTokenKind };
    }
    if (disposition.status === "invalid") return { status: "invalid" };
    const verified: VerifiedTokenProvenance = disposition.credential;

    // Provenance is resolved before eligibility or any consumer can observe the
    // subject, so a missing or future marker cannot default to an ordinary
    // Account credential.
    const provenance = resolveVerifiedAuthProvenance(verified);
    if (!provenance) return { status: "invalid" };
    const effectiveAuthority = AuthTokenAuthoritySchema.safeParse(verified.authority);
    if (!effectiveAuthority.success) return { status: "invalid" };

    const sessionRuntimePrincipal = provenance.kind === "ephemeral_session_runner"
        ? verified.ephemeralSessionRunnerPrincipal ?? null
        : null;
    if (
        provenance.kind === "ephemeral_session_runner"
        && (
            sessionRuntimePrincipal === null
            || sessionRuntimePrincipal.accountId !== verified.userId
        )
    ) return { status: "invalid" };

    const eligibility = await enforceLoginEligibility({
        accountId: verified.userId,
        readEnv: input.readEnv,
        verifiedCredential: disposition.credential,
    });
    if (!eligibility.ok) return { status: "ineligible", eligibility };

    return {
        status: "verified",
        principal: {
            accountId: verified.userId,
            ...(verified.tokenEpoch !== undefined ? { tokenEpoch: verified.tokenEpoch } : {}),
            kind: provenance.kind,
            ...(provenance.kind === 'terminal' && typeof verified.extras === 'object' && verified.extras !== null
                && 'session' in verified.extras && typeof verified.extras.session === 'string'
                ? { terminalAuthRequestId: verified.extras.session } : {}),
            authority: effectiveAuthority.data,
            legacy: verified.legacy,
            apiTokenPrincipal: resolveVerifiedApiTokenPrincipal(verified, provenance.kind),
            sessionRuntimePrincipal,
            ...(verified.authenticationEvidence ? { authenticationEvidence: verified.authenticationEvidence } : {}),
        },
    };
}
