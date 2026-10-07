import {
    AUTH_TOKEN_AUTHENTICATION_EVIDENCE_MAX_ITEMS,
    AuthTokenAuthenticationEvidenceSnapshotV1Schema,
    StoredAuthTokenAuthenticationEvidenceSnapshotV1Schema,
    authTokenAuthenticationEvidenceIdentityV1,
    type AuthTokenAuthenticationEvidenceSnapshotV1,
    type AuthTokenAuthenticationEvidenceV1,
} from "@happier-dev/protocol";

import {
    readAccountLoginViabilityFactsAfterProviderRemovalInTx,
    resolveAvailableAccountAuthenticationMethodIdsForDecisions,
} from "@/app/auth/methods/effectiveAccountLoginMethods";
import {
    isEffectiveHomeAuthMethodActionEnabledInTx,
    resolveEffectiveHomeAuthMethodsInTx,
} from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveAuthMethodRegistry } from "@/app/auth/methods/registry";
import {
    listProviderDescriptorsInTx,
    readTeamAuthenticationConnectionDescriptorsInTx,
    resolveRuntimeInTx,
    type ProviderDescriptorResolution,
    type TeamAuthenticationConnectionDescriptorRead,
} from "@/app/auth/providers/identityProviderCatalog";
import { teamIdentityConnectionReferenceKey } from "@/app/teams/identity/teamIdentityConnectionLifecycle";
import type { Tx } from "@/storage/inTx";

function normalized(value: string): string {
    return value.trim().toLowerCase();
}

export class AuthenticationEvidenceLimitError extends Error {
    readonly code = "credential_authentication_evidence_limit" as const;

    constructor() {
        super("The credential authentication-evidence bound would be exceeded");
        this.name = "AuthenticationEvidenceLimitError";
    }
}

export function parseAuthenticationEvidenceSnapshot(value: unknown): AuthTokenAuthenticationEvidenceSnapshotV1 | null {
    const parsed = StoredAuthTokenAuthenticationEvidenceSnapshotV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export async function isAuthenticationEvidenceCurrentInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        accountId: string;
        evidence: AuthTokenAuthenticationEvidenceV1;
    }>,
): Promise<boolean> {
    if (input.evidence.kind === "home_method") {
        const methodId = normalized(input.evidence.methodId);
        if (!resolveAuthMethodRegistry(input.env).some((method) => normalized(method.id) === methodId)) return false;
        const [effectiveHome, accountFacts] = await Promise.all([
            resolveEffectiveHomeAuthMethodsInTx(tx, { env: input.env }),
            readAccountLoginViabilityFactsAfterProviderRemovalInTx(tx, {
                accountId: input.accountId,
                env: input.env,
                excludedProviderId: null,
                identityEligibility: "current",
            }),
        ]);
        if (effectiveHome.status !== "ready" || accountFacts === null) return false;
        return resolveAvailableAccountAuthenticationMethodIdsForDecisions(
            effectiveHome.decisions,
            accountFacts,
        ).includes(methodId);
    }

    const account = await tx.account.findUnique({
        where: { id: input.accountId },
        select: { status: true },
    });
    if (account?.status !== "active") return false;

    const providerEvidence = input.evidence;

    const identity = await tx.accountIdentity.findUnique({
        where: { id: providerEvidence.identityId },
        select: {
            accountId: true,
            provider: true,
            eligibilityStatus: true,
        },
    });
    if (identity?.accountId !== input.accountId
        || normalized(identity.provider) !== normalized(providerEvidence.providerId)
        || identity.eligibilityStatus === "ineligible") return false;

    if (providerEvidence.teamConnectionId) {
        // The row read resolves the exact Team only; usability is the connection
        // lifecycle owner's derived `state`, which is also what qualification,
        // policy resolution, admission finalization and the Home method gate
        // compare. Reading the raw `enabled` column here would keep a second
        // answer to one question, and the exact-connection descriptor is the
        // same one the batch branch below consumes.
        const connection = await tx.teamIdentityConnection.findUnique({
            where: { id: providerEvidence.teamConnectionId },
            select: { id: true, teamId: true },
        });
        if (!connection) return false;
        const read = (await readTeamAuthenticationConnectionDescriptorsInTx(tx, {
            env: input.env,
            references: [connection],
        })).get(teamIdentityConnectionReferenceKey(connection));
        if (read?.status !== "ready"
            || read.connection.state !== "connected"
            || normalized(read.connection.providerInstanceId) !== normalized(providerEvidence.providerId)
            || read.descriptor?.reference.runtimeFingerprint !== providerEvidence.runtimeFingerprint) return false;
        return (await resolveRuntimeInTx(tx, {
            env: input.env,
            reference: read.descriptor.reference,
            purpose: "oauth_finalize",
        })).ok;
    }

    const descriptors = await listProviderDescriptorsInTx(tx, input.env);
    const exact = descriptors.find(({ reference }) =>
        normalized(reference.id) === normalized(providerEvidence.providerId)
        && reference.runtimeFingerprint === providerEvidence.runtimeFingerprint);
    if (!exact || !(await resolveRuntimeInTx(tx, {
        env: input.env,
        reference: exact.reference,
        purpose: "oauth_finalize",
    })).ok) return false;
    if (await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
        env: input.env,
        methodId: providerEvidence.providerId,
        actionId: "login",
    })) return true;
    // A successful authenticated connection is itself accepted Home
    // authentication evidence even when that provider is not offered as a
    // standalone sign-in route. This matches the canonical Account-method
    // availability owner, which treats connect-only identities as usable for
    // Team authentication qualification without making them login routes.
    return await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
        env: input.env,
        methodId: providerEvidence.providerId,
        actionId: "connect",
    });
}

/**
 * Resolves current evidence for one bounded Team-qualification batch while
 * consuming the same transaction-scoped descriptor facts the qualifier uses.
 * Other authentication flows retain the scalar API below and its narrower
 * read pattern; Team paging is the only caller that needs this set boundary.
 */
export async function resolveCurrentAuthenticationEvidenceForTeamQualificationInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        accountId: string;
        evidence: readonly AuthTokenAuthenticationEvidenceV1[] | undefined;
        teamConnectionDescriptors?: ReadonlyMap<string, TeamAuthenticationConnectionDescriptorRead>;
        effectiveHomeMethods?: Awaited<ReturnType<typeof resolveEffectiveHomeAuthMethodsInTx>>;
        homeProviderDescriptors?: readonly ProviderDescriptorResolution[];
    }>,
): Promise<readonly AuthTokenAuthenticationEvidenceV1[]> {
    const seen = new Set<string>();
    const evidence = (input.evidence ?? []).filter((item) => {
        const key = authTokenAuthenticationEvidenceIdentityV1(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    if (evidence.length === 0) return [];

    const homeMethods = evidence.filter((item) => item.kind === "home_method");
    const providers = evidence.filter((item): item is Extract<AuthTokenAuthenticationEvidenceV1, { kind: "provider" }> =>
        item.kind === "provider");
    const teamProviderConnectionIds = [...new Set(providers.flatMap((item) =>
        item.teamConnectionId ? [item.teamConnectionId] : []))];
    const [effectiveHome, accountFacts, account, identities, teamConnectionRows, homeDescriptors] = await Promise.all([
        (homeMethods.length > 0 || providers.some((item) => !item.teamConnectionId))
            && input.effectiveHomeMethods === undefined
            ? resolveEffectiveHomeAuthMethodsInTx(tx, { env: input.env })
            : null,
        homeMethods.length > 0
            ? readAccountLoginViabilityFactsAfterProviderRemovalInTx(tx, {
                accountId: input.accountId,
                env: input.env,
                excludedProviderId: null,
                identityEligibility: "current",
            })
            : null,
        providers.length > 0
            ? tx.account.findUnique({ where: { id: input.accountId }, select: { status: true } })
            : null,
        providers.length > 0
            ? tx.accountIdentity.findMany({
                where: { id: { in: [...new Set(providers.map((item) => item.identityId))] } },
                select: { id: true, accountId: true, provider: true, eligibilityStatus: true },
            })
            : [],
        teamProviderConnectionIds.length > 0 && input.teamConnectionDescriptors === undefined
            ? tx.teamIdentityConnection.findMany({
                where: { id: { in: teamProviderConnectionIds } },
                select: { id: true, teamId: true },
            })
            : [],
        providers.some((item) => !item.teamConnectionId) && input.homeProviderDescriptors === undefined
            ? listProviderDescriptorsInTx(tx, input.env)
            : [],
    ]);
    const resolvedEffectiveHome = input.effectiveHomeMethods ?? effectiveHome;
    const resolvedHomeDescriptors = input.homeProviderDescriptors ?? homeDescriptors;
    const teamDescriptors = input.teamConnectionDescriptors
        ?? await readTeamAuthenticationConnectionDescriptorsInTx(tx, {
            env: input.env,
            references: teamConnectionRows.map((connection) => ({
                id: connection.id,
                teamId: connection.teamId,
            })),
        });
    const availableHomeMethods = resolvedEffectiveHome?.status === "ready" && accountFacts !== null
        ? new Set(resolveAvailableAccountAuthenticationMethodIdsForDecisions(
            resolvedEffectiveHome.decisions,
            accountFacts,
        ))
        : new Set<string>();
    const effectiveHomeById = new Map(resolvedEffectiveHome?.status === "ready"
        ? resolvedEffectiveHome.decisions.map((decision) => [normalized(decision.id), decision] as const)
        : []);
    const identityById = new Map(identities.map((identity) => [identity.id, identity] as const));
    const teamConnectionById = new Map([
        ...teamConnectionRows.map((connection) => [connection.id, connection] as const),
        ...[...teamDescriptors.values()].flatMap((read) => read.status === "ready"
            ? [[read.connection.id, { id: read.connection.id, teamId: read.connection.teamId }] as const]
            : []),
    ]);
    const homeDescriptorById = new Map(resolvedHomeDescriptors.map((descriptor) => [
        normalized(descriptor.reference.id),
        descriptor,
    ]));

    const current: AuthTokenAuthenticationEvidenceV1[] = [];
    for (const item of evidence) {
        if (item.kind === "home_method") {
            const methodId = normalized(item.methodId);
            if (resolveAuthMethodRegistry(input.env).some((method) => normalized(method.id) === methodId)
                && availableHomeMethods.has(methodId)) current.push(item);
            continue;
        }
        const identity = identityById.get(item.identityId);
        if (account?.status !== "active"
            || identity?.accountId !== input.accountId
            || normalized(identity.provider) !== normalized(item.providerId)
            || identity.eligibilityStatus === "ineligible") continue;

        const descriptor = item.teamConnectionId
            ? (() => {
                const connection = teamConnectionById.get(item.teamConnectionId!);
                if (!connection) return null;
                const read = teamDescriptors.get(teamIdentityConnectionReferenceKey(connection));
                if (read?.status !== "ready"
                    || read.connection.state !== "connected"
                    || normalized(read.connection.providerInstanceId) !== normalized(item.providerId)
                    || read.descriptor?.reference.runtimeFingerprint !== item.runtimeFingerprint) return null;
                return read.descriptor;
            })()
            : (() => {
                const resolved = homeDescriptorById.get(normalized(item.providerId));
                return resolved?.reference.runtimeFingerprint === item.runtimeFingerprint ? resolved : null;
            })();
        if (!descriptor || !(await resolveRuntimeInTx(tx, {
            env: input.env,
            reference: descriptor.reference,
            purpose: "oauth_finalize",
        })).ok) continue;
        if (item.teamConnectionId) {
            current.push(item);
            continue;
        }
        const decision = effectiveHomeById.get(normalized(item.providerId));
        if (decision?.actions.some((action) =>
            (action.id === "login" || action.id === "connect") && action.enabled)) current.push(item);
    }
    return current;
}

export async function resolveCurrentAuthenticationEvidenceInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        accountId: string;
        evidence: readonly AuthTokenAuthenticationEvidenceV1[] | undefined;
    }>,
): Promise<readonly AuthTokenAuthenticationEvidenceV1[]> {
    const current: AuthTokenAuthenticationEvidenceV1[] = [];
    const seen = new Set<string>();
    for (const evidence of input.evidence ?? []) {
        const key = authTokenAuthenticationEvidenceIdentityV1(evidence);
        if (seen.has(key)) continue;
        if (await isAuthenticationEvidenceCurrentInTx(tx, { ...input, evidence })) {
            current.push(evidence);
            seen.add(key);
        }
    }
    return current;
}

export async function mergeCurrentAuthenticationEvidenceInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        accountId: string;
        initiating: readonly AuthTokenAuthenticationEvidenceV1[] | undefined;
        newlyVerified: readonly AuthTokenAuthenticationEvidenceV1[] | undefined;
    }>,
): Promise<readonly AuthTokenAuthenticationEvidenceV1[]> {
    const merged = await resolveCurrentAuthenticationEvidenceInTx(tx, {
        env: input.env,
        accountId: input.accountId,
        evidence: [...(input.initiating ?? []), ...(input.newlyVerified ?? [])],
    });
    if (merged.length > AUTH_TOKEN_AUTHENTICATION_EVIDENCE_MAX_ITEMS) throw new AuthenticationEvidenceLimitError();
    return merged;
}

/**
 * Resolve the exact AccountIdentity row after the provider lifecycle owner has
 * linked it. The OAuth reference is copied opaquely; callers never derive or
 * interpret its fingerprint.
 */
export async function readOAuthAuthenticationEvidenceInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        providerId: string;
        runtimeFingerprint: string;
        teamConnectionId?: string;
    }>,
): Promise<readonly AuthTokenAuthenticationEvidenceV1[] | undefined> {
    const identity = await tx.accountIdentity.findFirst({
        where: { accountId: input.accountId, provider: input.providerId },
        select: { id: true },
    });
    if (!identity) return undefined;
    return [{
        kind: "provider",
        providerId: input.providerId,
        identityId: identity.id,
        runtimeFingerprint: input.runtimeFingerprint,
        ...(input.teamConnectionId ? { teamConnectionId: input.teamConnectionId } : {}),
    }];
}
