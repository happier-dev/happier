import {
    isAccountIdentityEligibleForGenericPresentation,
    resolveAuthMethodIdForAccountIdentityProvider,
} from "@/app/auth/methods/registry";
import type { Tx } from "@/storage/inTx";
import type { TeamAuthenticationReadCapture } from '@/app/auth/entry/teamAuthenticationReadCapture';

import type { EffectiveAuthMethodDecision } from "@/app/auth/methods/effectiveAuthMethods";

/**
 * A concrete way this Account can still get back in.
 *
 * The existing recovery key authenticates through Key Challenge. It preserves
 * the Account's cryptographic identity, but cannot bypass Home method policy.
 */
export type AccountLoginRoute =
    | Readonly<{ kind: "email_password" }>
    | Readonly<{ kind: "key_challenge" }>
    | Readonly<{ kind: "mtls" }>
    | Readonly<{ kind: "external_provider"; providerId: string }>
    | Readonly<{ kind: "recovery_key" }>;

export type AccountProviderIdentityFact = Readonly<{
    providerId: string;
    /** Lane 03 `AccountIdentityLifecycle` blocker, e.g. offboarded or disabled upstream. */
    blocked: boolean;
}>;

function accountLoginRouteMethodId(route: AccountLoginRoute): string {
    if (route.kind === "email_password") return "email_password";
    if (route.kind === "key_challenge" || route.kind === "recovery_key") return "key_challenge";
    if (route.kind === "mtls") return "mtls";
    return route.providerId;
}

/**
 * Account-scoped facts the caller already holds inside its mutation transaction.
 *
 * This resolver reads no database of its own so it can be called from within the
 * exact transaction that is about to change a credential or Home policy.
 */
export type AccountLoginViabilityFacts = Readonly<{
    encryptionMode: "plain" | "e2ee";
    /** Terminal/disabled Accounts have no viable login until lifecycle restores them. */
    accountActive: boolean;
    hasPasswordCredential: boolean;
    hasNativeEmailIdentity: boolean;
    providerIdentities: readonly AccountProviderIdentityFact[];
    /** The Account holds key-challenge-capable material (seed or recovery secret). */
    hasKeyChallengeCapableCredential: boolean;
    /**
     * Lane 01 Home role fact. `undefined` means the Home governance owner did not
     * supply it; callers that guard last-administrator safety must treat unknown
     * as unproven rather than as `false`.
     */
    isLastHomeAdministrator?: boolean;
}>;

export type AccountLoginViabilityIdentityEligibility = "current" | "identity_presence";

export type AccountLoginViabilitySourceFacts = Readonly<{
    status: string;
    publicKey: string | null;
    encryptionMode: string;
    hasPasswordCredential: boolean;
    identities: readonly Readonly<{
        provider: string;
        eligibilityStatus: "unknown" | "eligible" | "ineligible";
    }>[];
}>;

/** Canonical Account-row to authentication-facts translation used by identity removal owners. */
export function buildAccountLoginViabilityFactsAfterProviderRemoval(
    source: AccountLoginViabilitySourceFacts,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        excludedProviderId: string | null;
        identityEligibility: AccountLoginViabilityIdentityEligibility;
    }>,
): AccountLoginViabilityFacts {
    const excluded = input.excludedProviderId?.trim().toLowerCase() ?? null;
    const identities = source.identities
        .map((identity) => ({ ...identity, provider: identity.provider.trim().toLowerCase() }))
        .filter((identity) => identity.provider.length > 0 && identity.provider !== excluded);
    const methodIdByProvider = new Map(identities.map(({ provider }) => [
        provider,
        resolveAuthMethodIdForAccountIdentityProvider(input.env, provider) ?? provider,
    ]));
    return Object.freeze({
        encryptionMode: source.encryptionMode === "plain" ? "plain" : "e2ee",
        accountActive: source.status === "active",
        hasPasswordCredential: source.hasPasswordCredential,
        hasNativeEmailIdentity: identities.some(({ provider }) => methodIdByProvider.get(provider) === "email_password"),
        providerIdentities: Object.freeze(identities
            .filter(({ provider }) => methodIdByProvider.get(provider) !== "email_password")
            .map(({ provider, eligibilityStatus }) => Object.freeze({
                providerId: methodIdByProvider.get(provider) ?? provider,
                blocked: input.identityEligibility === "current" && eligibilityStatus === "ineligible",
            }))),
        hasKeyChallengeCapableCredential: source.publicKey !== null,
    });
}

export async function readAccountLoginViabilityFactsAfterProviderRemovalInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        env: NodeJS.ProcessEnv;
        excludedProviderId: string | null;
        identityEligibility: AccountLoginViabilityIdentityEligibility;
    }>,
    readCapture?: TeamAuthenticationReadCapture,
): Promise<AccountLoginViabilityFacts | null> {
    if (readCapture) return readCapture.account?.id === input.accountId
        ? buildAccountLoginViabilityFactsAfterProviderRemoval({ ...readCapture.account,
            hasPasswordCredential: readCapture.hasPasswordCredential, identities: readCapture.identities }, input)
        : null;
    const facts = await readAccountLoginViabilityFactsByAccountIdAfterProviderRemovalInTx(tx, {
        accountIds: [input.accountId],
        env: input.env,
        excludedProviderId: input.excludedProviderId,
        identityEligibility: input.identityEligibility,
    });
    return facts.get(input.accountId) ?? null;
}

export async function readAccountLoginViabilityFactsByAccountIdAfterProviderRemovalInTx(
    tx: Tx,
    input: Readonly<{
        accountIds: readonly string[];
        env: NodeJS.ProcessEnv;
        excludedProviderId: string | null;
        identityEligibility: AccountLoginViabilityIdentityEligibility;
    }>,
): Promise<ReadonlyMap<string, AccountLoginViabilityFacts>> {
    const accountIds = [...new Set(input.accountIds.map((id) => id.trim()).filter(Boolean))];
    if (accountIds.length === 0) return new Map();
    const accounts = await tx.account.findMany({
        where: { id: { in: accountIds } },
        select: {
            id: true,
            status: true,
            publicKey: true,
            encryptionMode: true,
            AccountPasswordCredential: { select: { accountId: true } },
            AccountIdentity: {
                select: { provider: true, eligibilityStatus: true },
            },
        },
    });
    return new Map(accounts.map((account) => [
        account.id,
        buildAccountLoginViabilityFactsAfterProviderRemoval({
            status: account.status,
            publicKey: account.publicKey,
            encryptionMode: account.encryptionMode,
            hasPasswordCredential: account.AccountPasswordCredential !== null,
            identities: account.AccountIdentity,
        }, input),
    ]));
}

type HomeAccountLoginViabilityFact = Readonly<{
    homeRole: "owner" | "admin" | "member";
    facts: AccountLoginViabilityFacts;
}>;

/**
 * Reads the complete active-Account input for a prospective Home authentication
 * policy in one transaction query. The Home governance writer consumes this
 * auth-domain projection rather than reconstructing password, identity, method,
 * or recovery viability itself.
 */
async function readHomeAccountLoginViabilityFactsInTx(
    tx: Tx,
    input: Readonly<{ env: NodeJS.ProcessEnv }>,
): Promise<readonly HomeAccountLoginViabilityFact[]> {
    const accounts = await tx.account.findMany({
        where: { status: "active" },
        select: {
            homeRole: true,
            status: true,
            publicKey: true,
            encryptionMode: true,
            AccountPasswordCredential: { select: { accountId: true } },
            AccountIdentity: {
                select: { provider: true, eligibilityStatus: true },
            },
        },
    });
    const activeAdministratorCount = accounts.filter(({ homeRole }) =>
        homeRole === "owner" || homeRole === "admin").length;

    return Object.freeze(accounts.map((account) => Object.freeze({
        homeRole: account.homeRole,
        facts: Object.freeze({
            ...buildAccountLoginViabilityFactsAfterProviderRemoval({
                status: account.status,
                publicKey: account.publicKey,
                encryptionMode: account.encryptionMode,
                hasPasswordCredential: account.AccountPasswordCredential !== null,
                identities: account.AccountIdentity,
            }, {
                env: input.env,
                excludedProviderId: null,
                identityEligibility: "current",
            }),
            isLastHomeAdministrator: activeAdministratorCount === 1
                && (account.homeRole === "owner" || account.homeRole === "admin"),
        }),
    })));
}

export type AccountLoginViability = Readonly<{
    routes: readonly AccountLoginRoute[];
    viable: boolean;
    /** True when a last-administrator guard was requested but Lane 01 supplied no role fact. */
    lastHomeAdministratorUnknown: boolean;
}>;

export type AccountAdministrationAuthenticationProjection = Readonly<{
    signInEmail: string | null;
    usableMethodIds: readonly string[];
    /**
     * Provider ids of the Account's linked identities (GitHub, an OIDC provider), never the
     * provider's user id or login. Native email locators are Account Security's, not providers.
     */
    linkedProviderIds: readonly string[];
}>;

/**
 * Projects the privacy-safe authentication facts consumed by Home People.
 *
 * This stays in the authentication domain because provider aliases, current
 * eligibility, credential shape and effective Home policy all participate in
 * the answer. Governance receives only the resulting email and method ids and
 * therefore cannot grow a competing login-viability evaluator.
 */
export async function readAccountAdministrationAuthenticationByIdInTx(
    tx: Tx,
    input: Readonly<{
        accountIds: readonly string[];
        env: NodeJS.ProcessEnv;
        decisions: readonly EffectiveAuthMethodDecision[];
    }>,
): Promise<ReadonlyMap<string, AccountAdministrationAuthenticationProjection>> {
    const accountIds = [...new Set(input.accountIds.map((id) => id.trim()).filter(Boolean))];
    if (accountIds.length === 0) return new Map();
    const accounts = await tx.account.findMany({
        where: { id: { in: accountIds } },
        select: {
            id: true,
            status: true,
            publicKey: true,
            encryptionMode: true,
            AccountPasswordCredential: { select: { accountId: true } },
            AccountIdentity: {
                select: { provider: true, providerUserId: true, eligibilityStatus: true },
            },
        },
    });

    return new Map(accounts.map((account) => {
        const facts = buildAccountLoginViabilityFactsAfterProviderRemoval({
            status: account.status,
            publicKey: account.publicKey,
            encryptionMode: account.encryptionMode,
            hasPasswordCredential: account.AccountPasswordCredential !== null,
            identities: account.AccountIdentity,
        }, {
            env: input.env,
            excludedProviderId: null,
            identityEligibility: "current",
        });
        const usableMethodIds = [...new Set(resolveEffectiveAccountLoginMethodsForDecisions(
            input.decisions,
            facts,
        ).routes.map(accountLoginRouteMethodId))];
        const signInEmail = account.AccountIdentity.find((identity) =>
            resolveAuthMethodIdForAccountIdentityProvider(input.env, identity.provider) === "email_password")
            ?.providerUserId ?? null;
        const linkedProviderIds = [...new Set(account.AccountIdentity
            .map((identity) => identity.provider)
            .filter((provider) => isAccountIdentityEligibleForGenericPresentation(input.env, provider)))]
            .sort();
        return [account.id, Object.freeze({ signInEmail, usableMethodIds, linkedProviderIds })] as const;
    }));
}

export function resolveEffectiveAccountLoginMethodsForDecisions(
    decisions: readonly EffectiveAuthMethodDecision[],
    facts: AccountLoginViabilityFacts,
): AccountLoginViability {
    return resolveAccountAuthenticationRoutesForDecisions(decisions, facts, (action) =>
        action.id === "login" && action.enabled);
}

function resolveAccountAuthenticationRoutesForDecisions(
    decisions: readonly EffectiveAuthMethodDecision[],
    facts: AccountLoginViabilityFacts,
    actionIsAvailable: (action: EffectiveAuthMethodDecision["actions"][number]) => boolean,
): AccountLoginViability {
    const routes: AccountLoginRoute[] = [];
    const lastHomeAdministratorUnknown = facts.isLastHomeAdministrator === undefined;
    const methodAvailable = (methodId: string): boolean => decisions.some((decision) =>
        decision.id === methodId.trim().toLowerCase()
        && decision.actions.some((action) => actionIsAvailable(action)
            && (action.mode === "either"
                || action.mode === (facts.encryptionMode === "e2ee" ? "keyed" : "keyless"))));

    if (!facts.accountActive) {
        return Object.freeze({
            routes: Object.freeze([]),
            viable: false,
            lastHomeAdministratorUnknown,
        });
    }

    if (
        facts.hasPasswordCredential
        && facts.hasNativeEmailIdentity
        && methodAvailable("email_password")
    ) {
        routes.push({ kind: "email_password" });
    }

    if (
        facts.hasKeyChallengeCapableCredential
        && methodAvailable("key_challenge")
    ) {
        routes.push({ kind: "key_challenge" });
    }

    for (const identity of facts.providerIdentities) {
        if (identity.blocked) continue;
        const providerId = identity.providerId.trim().toLowerCase();
        if (!providerId) continue;
        if (providerId === "mtls") {
            if (methodAvailable("mtls")) {
                routes.push({ kind: "mtls" });
            }
            continue;
        }
        if (methodAvailable(providerId)) {
            routes.push({ kind: "external_provider", providerId });
        }
    }

    if (facts.encryptionMode === "e2ee"
        && facts.hasKeyChallengeCapableCredential
        && methodAvailable("key_challenge")) {
        routes.push({ kind: "recovery_key" });
    }

    return Object.freeze({
        routes: Object.freeze(routes),
        viable: routes.length > 0,
        lastHomeAdministratorUnknown,
    });
}

/**
 * Current Home methods through which this Account could establish authentication evidence.
 * Unlike login-stranding checks, an authenticated connect action is sufficient for Team
 * qualification. Callers supply Account facts after their proposed mutation.
 */
export function resolveAvailableAccountAuthenticationMethodIdsForDecisions(
    decisions: readonly EffectiveAuthMethodDecision[],
    factsAfterMutation: AccountLoginViabilityFacts,
): readonly string[] {
    const routes = resolveAccountAuthenticationRoutesForDecisions(
        decisions,
        factsAfterMutation,
        (action) => action.enabled,
    ).routes;
    return Object.freeze([...new Set(routes.map(accountLoginRouteMethodId))]);
}

export type LoginStrandingVerdict =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: "account_would_lose_all_login_routes" | "last_home_administrator_unproven" }>;

/**
 * Auth-domain verdict for a prospective Home authentication policy.
 *
 * Lane 01 owns policy persistence and CAS, but it must not duplicate the rules
 * that decide whether an Account's installed credentials and identities still
 * have a usable login route. An active Account is affected only when it has a
 * current route that the prospective policy would remove. Already-inactive or
 * already-stranded rows cannot block a policy repair, while the last current
 * administrative route is still protected. Authentication internals do not
 * escape to the policy writer.
 */
export async function checkHomeAuthenticationPolicyRetainsLoginRoutesInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        currentDecisions: readonly EffectiveAuthMethodDecision[];
        prospectiveDecisions: readonly EffectiveAuthMethodDecision[];
    }>,
): Promise<LoginStrandingVerdict> {
    const accounts = await readHomeAccountLoginViabilityFactsInTx(tx, { env: input.env });
    for (const account of accounts) {
        const options = {
            requireLastAdministratorProof: account.homeRole === "owner" || account.homeRole === "admin",
        } as const;
        const current = checkAccountRetainsLoginRouteForDecisions(
            input.currentDecisions,
            account.facts,
            options,
        );
        if (!current.ok) continue;
        const verdict = checkAccountRetainsLoginRouteForDecisions(
            input.prospectiveDecisions,
            account.facts,
            options,
        );
        if (!verdict.ok) return verdict;
    }
    return Object.freeze({ ok: true });
}

/**
 * Guard for a mutation that is about to remove a login route. The caller supplies
 * the facts as they would be *after* the mutation commits.
 *
 * When the mutation affects a Home administrator and Lane 01 supplied no role
 * fact, this fails closed rather than assuming the Account is an ordinary member.
 */
export function checkAccountRetainsLoginRouteForDecisions(
    decisions: readonly EffectiveAuthMethodDecision[],
    factsAfterMutation: AccountLoginViabilityFacts,
    options: Readonly<{ requireLastAdministratorProof?: boolean }> = {},
): LoginStrandingVerdict {
    const viability = resolveEffectiveAccountLoginMethodsForDecisions(decisions, factsAfterMutation);
    if (!viability.viable) {
        return Object.freeze({ ok: false, reason: "account_would_lose_all_login_routes" as const });
    }
    if (options.requireLastAdministratorProof === true && viability.lastHomeAdministratorUnknown) {
        return Object.freeze({ ok: false, reason: "last_home_administrator_unproven" as const });
    }
    return Object.freeze({ ok: true });
}
