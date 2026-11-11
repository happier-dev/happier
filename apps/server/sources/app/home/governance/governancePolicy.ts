import { HOME_TEAM_CREATION_POLICY_DEFAULT_V1, HOME_TEAMS_VISIBLE_TO_MEMBERS_DEFAULT_V1, readHomeAuthenticationPolicyV1, readHomeIdentityNetworkPolicyV1, readHomeTeamProviderPolicyV1, readTeamCreationPolicyV1, type HomeAuthenticationPolicyReadV1, type HomeAuthenticationPolicyV1, type HomeGovernancePolicySetInputV1, type HomeIdentityNetworkPolicyReadV1, type HomeTeamProviderPolicyReadV1, type ManagedIdentityProviderKindV1, type TeamCreationPolicyV1 } from '@happier-dev/protocol/home/governance';
import { type HomeSignInServicePolicyV1 } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { db, isPrismaErrorCode } from "@/storage/db";
import { resolveEffectiveHomeAuthMethodsInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { checkHomeAuthenticationPolicyRetainsLoginRoutesInTx } from "@/app/auth/methods/effectiveAccountLoginMethods";
import { isAuthEmailDeliveryReady } from "@/app/auth/email/resolveAuthEmailDelivery";
import { validateManagedIdentityNetworkPolicyForSave } from "@/app/auth/providers/managed/managedIdentityNetworkPolicyValidation";
import { isHomeTeamProviderPolicyWithinDeploymentCeiling } from "@/app/auth/providers/teamProviderDeploymentCeiling";
import { getActivePrismaRuntime } from "@/storage/prisma";
import { inTx, type Tx } from "@/storage/inTx";

import { authorizeHomeGovernanceMutationInTx } from "./homeCapabilities";
import { recordHomeAdministrationEventInTx } from "@/app/home/audit/homeAdministrationEvents";
import { acquireHomeGovernanceAdmissionInTx, publishHomeGovernanceChangedInTx } from "./governanceChanges";
import {
    HOME_STORAGE_POLICY_KEY,
    readHomeAuthenticationLock,
    readHomeAuthenticationLockEnv,
} from "./homeAuthenticationPolicyEnv";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import type { EffectiveAuthMethodDecision } from "@/app/auth/methods/effectiveAuthMethods";
import type { ProviderCatalogContext } from "@/app/auth/providers/providerReference";

/**
 * The Home database holds exactly one governance policy. There is no separate
 * Home row to key it by, so the identity is this constant.
 */
export const HOME_GOVERNANCE_POLICY_ID = "home";

export type HomeGovernancePolicyRecord = Readonly<{
    /** `0` while no row exists; the first persisted revision is `1`. */
    revision: number;
    teamCreationPolicy: TeamCreationPolicyV1;
    /**
     * Whether a member outside every Team is still shown the Teams destination.
     * Members of a Team and Home administrators always are.
     */
    teamsVisibleToMembers: boolean;
    authentication: HomeAuthenticationPolicyReadV1;
    teamProviders: HomeTeamProviderPolicyReadV1;
    identityNetwork: HomeIdentityNetworkPolicyReadV1;
}>;

type HomeGovernancePolicyRow = Readonly<{
    revision: number;
    teamCreationPolicy: string;
    teamsVisibleToMembers: boolean;
    authenticationPolicy: unknown;
    teamProviderPolicy: unknown;
    identityNetworkPolicy: unknown;
}>;

const DEPLOYMENT_DEFAULT_POLICY: HomeGovernancePolicyRecord = Object.freeze({
    revision: 0,
    teamCreationPolicy: HOME_TEAM_CREATION_POLICY_DEFAULT_V1,
    teamsVisibleToMembers: HOME_TEAMS_VISIBLE_TO_MEMBERS_DEFAULT_V1,
    authentication: Object.freeze({ status: "inherited" as const }),
    teamProviders: Object.freeze({ status: "inherited" as const }),
    identityNetwork: Object.freeze({ status: "inherited" as const }),
});

function projectPolicyRow(row: HomeGovernancePolicyRow | null): HomeGovernancePolicyRecord {
    if (!row) return DEPLOYMENT_DEFAULT_POLICY;
    return Object.freeze({
        revision: row.revision,
        teamCreationPolicy: readTeamCreationPolicyV1(row.teamCreationPolicy),
        teamsVisibleToMembers: row.teamsVisibleToMembers,
        authentication: readHomeAuthenticationPolicyV1(row.authenticationPolicy),
        teamProviders: readHomeTeamProviderPolicyV1(row.teamProviderPolicy),
        identityNetwork: readHomeIdentityNetworkPolicyV1(row.identityNetworkPolicy),
    });
}

async function findPolicyRowInTx(tx: Tx): Promise<HomeGovernancePolicyRow | null> {
    return await tx.homeGovernancePolicy.findUnique({
        where: { id: HOME_GOVERNANCE_POLICY_ID },
        select: {
            revision: true,
            teamCreationPolicy: true,
            teamsVisibleToMembers: true,
            authenticationPolicy: true,
            teamProviderPolicy: true,
            identityNetworkPolicy: true,
        },
    });
}

/**
 * Reads the Home policy. An absent row is the deployment default, so ordinary
 * reads never write; only a mutation or bootstrap creates the row.
 */
export async function readHomeGovernancePolicyInTx(tx: Tx): Promise<HomeGovernancePolicyRecord> {
    return projectPolicyRow(await findPolicyRowInTx(tx));
}

export async function readHomeGovernancePolicy(): Promise<HomeGovernancePolicyRecord> {
    const row = await db.homeGovernancePolicy.findUnique({
        where: { id: HOME_GOVERNANCE_POLICY_ID },
        select: {
            revision: true,
            teamCreationPolicy: true,
            teamsVisibleToMembers: true,
            authenticationPolicy: true,
            teamProviderPolicy: true,
            identityNetworkPolicy: true,
        },
    });
    return projectPolicyRow(row);
}

export function resolveTeamProviderKindPolicy(
    policy: HomeGovernancePolicyRecord,
    kind: ManagedIdentityProviderKindV1,
): "allowed" | "prohibited" | "unavailable" {
    if (policy.teamProviders.status === "unreadable") return "unavailable";
    // An absent policy inherits the deployment ceiling (teams-lane-01/02 :230,
    // :234): the Home adds no narrowing of its own. Whether the deployment can
    // run a kind is Lane 03's `resolveTeamProviderKindDeploymentAvailability`,
    // which every setup choice and managed runtime already enforces on top of
    // this answer. Team JIT and approved GHES origins stay off under
    // inheritance because each requires an explicit Home allowance.
    if (policy.teamProviders.status === "inherited") return "allowed";
    return policy.teamProviders.policy.allowedTeamProviderKinds.includes(kind)
        ? "allowed"
        : "prohibited";
}

/** Team-kind narrowing governs Team bindings; Home sign-in uses its authentication policy. */
export function resolveIdentityConnectionProviderKindPolicy(
    policy: HomeGovernancePolicyRecord,
    context: ProviderCatalogContext,
    kind: ManagedIdentityProviderKindV1,
): "allowed" | "prohibited" | "unavailable" {
    return context.kind === "home" ? "allowed" : resolveTeamProviderKindPolicy(policy, kind);
}

export type HomeGovernancePolicySetResult =
    | Readonly<{ status: "applied"; policy: HomeGovernancePolicyRecord }>
    | Readonly<{ status: "revision_conflict"; policy: HomeGovernancePolicyRecord }>
    | Readonly<{ status: "forbidden" }>
    | Readonly<{ status: "invalid_policy" }>
    /** The patch widens sign-in, admission or storage policy without `confirmWidening`; nothing was written. */
    | Readonly<{ status: "widening_unconfirmed" }>;

class HomeGovernancePolicyCreateConflictError extends Error {
    constructor() {
        super("Home governance policy was created concurrently");
        this.name = "HomeGovernancePolicyCreateConflictError";
    }
}

/**
 * Lets compositions that include the singleton's first write leave the failed
 * transaction before retrying their complete atomic operation.
 */
export function isHomeGovernancePolicyCreateConflictError(
    error: unknown,
): boolean {
    return error instanceof HomeGovernancePolicyCreateConflictError;
}

/**
 * Applies the singleton policy mutation and its invalidation atomically.
 *
 * A first-writer uniqueness race must leave the failed database transaction
 * before it is translated into the normal CAS conflict. PostgreSQL marks a
 * transaction failed after the unique violation, so querying from the catch
 * block inside that transaction would mask the intended conflict with a
 * transaction-aborted error. The settlement attempt starts a fresh transaction,
 * reauthorizes the actor, and observes the winning revision through the same
 * canonical owner.
 */
function homeGovernancePolicyChangeAudience(patch: HomeGovernancePolicySetInputV1): "all_active_accounts" | "administrators" {
    return patch.teamCreationPolicy !== undefined || patch.teamsVisibleToMembers !== undefined
        || patch.authenticationPolicy !== undefined || patch.teamProviderPolicy !== undefined
        || patch.identityNetworkPolicy !== undefined ? "all_active_accounts" : "administrators";
}

export async function setHomeGovernancePolicy(input: Readonly<{
    actorAccountId: string;
    patch: HomeGovernancePolicySetInputV1;
    env: NodeJS.ProcessEnv;
}>): Promise<HomeGovernancePolicySetResult> {
    const emailDeliveryReady = input.patch.authenticationPolicy !== undefined
        && await isAuthEmailDeliveryReady({ env: input.env });
    const attempt = async () => await inTx(async (tx) => {
        const result = await setHomeGovernancePolicyInTx(tx, { ...input, emailDeliveryReady });
        if (result.status === "applied") {
            await publishHomeGovernanceChangedInTx(tx, {
                audience: homeGovernancePolicyChangeAudience(input.patch),
            });
        }
        return result;
    }, { isolationLevel: "Serializable" });

    try {
        return await attempt();
    } catch (error) {
        if (!isHomeGovernancePolicyCreateConflictError(error)) throw error;
        return await attempt();
    }
}

const STORAGE_POLICY_RANK = { required_e2ee: 0, optional: 1, plaintext_only: 2 } as const;

function enabledActionKeys(decisions: readonly EffectiveAuthMethodDecision[]): Set<string> {
    return new Set(decisions.flatMap((decision) => decision.actions
        .filter((action) => action.enabled)
        .map((action) => `${decision.id}\u0000${action.id}\u0000${action.mode}`)));
}

function provisionModeKeys(decisions: readonly EffectiveAuthMethodDecision[]): Set<string> {
    return new Set(decisions.flatMap((decision) =>
        decision.allowedProvisionModes.map((mode) => `${decision.id}\u0000${mode}`)));
}

function addsAny(current: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
    for (const key of next) if (!current.has(key)) return true;
    return false;
}

/**
 * Whether the stored storage policy moves toward less protection. The storage policy applies at the
 * next start, so it is compared as stored, not through the running decision; a deployment lock
 * means the document cannot change it at all.
 */
function storagePolicyWidens(
    env: NodeJS.ProcessEnv,
    current: HomeAuthenticationPolicyReadV1,
    next: HomeAuthenticationPolicyV1 | null,
): boolean {
    if (readHomeAuthenticationLock(env, HOME_STORAGE_POLICY_KEY)) return false;
    const deployment = readEncryptionFeatureEnv(readHomeAuthenticationLockEnv(env) as NodeJS.ProcessEnv).storagePolicy;
    const stored = current.status === "narrowed" ? current.policy.storagePolicy ?? deployment : deployment;
    return STORAGE_POLICY_RANK[next?.storagePolicy ?? deployment] > STORAGE_POLICY_RANK[stored];
}

type AuthenticationPolicyAssessment =
    | Readonly<{ valid: false }>
    | Readonly<{ valid: true; widens: boolean }>;

/**
 * Whether this Home could still be used under the prospective policy, and whether it widens.
 *
 * Usability is a route question, not an Account-mode question: the deployment's
 * permitted Account modes decide which Accounts may be *constructed*, while an
 * Account that already exists keeps its stored mode and its login. A policy
 * is refused only when it leaves no enabled login or provision action at all,
 * names a method this deployment does not have, removes every provisioning
 * mode, or — through the auth-domain stranding owner — takes away the last
 * current login route of an Account that has one.
 *
 * It widens (§3.4 bound 5, the owner must confirm) when any sign-in action or
 * Account mode is offered that the current decision does not offer, when the
 * sign-in service comes back, or when the stored storage policy protects less.
 * Both answers come from the one effective decision owner, current against
 * prospective, so no second list of "permissive" fields exists.
 */
async function assessAuthenticationPolicyChangeInTx(
    tx: Tx,
    policy: HomeAuthenticationPolicyV1 | null,
    env: NodeJS.ProcessEnv,
    emailDeliveryReady: boolean,
): Promise<AuthenticationPolicyAssessment> {
    const stored = (await readHomeGovernancePolicyInTx(tx)).authentication;
    const current = await resolveEffectiveHomeAuthMethodsInTx(tx, {
        env,
        homeAuthenticationPolicyOverride: stored,
        emailDeliveryReady,
    });
    const prospective = policy === null
        ? { status: "inherited" as const }
        : { status: "narrowed" as const, policy };
    const effective = await resolveEffectiveHomeAuthMethodsInTx(tx, {
        env,
        homeAuthenticationPolicyOverride: prospective,
        emailDeliveryReady,
    });
    if (effective.status !== "ready") return { valid: false };

    if (policy?.enabledMethodIds) {
        const knownIds = new Set(effective.decisions.map((decision) => decision.id));
        if (policy.enabledMethodIds.some((id) => !knownIds.has(id))) return { valid: false };
    }
    if (!effective.decisions.some((decision) => decision.allowedProvisionModes.length > 0)) return { valid: false };
    if (policy?.recommendedProvisioningMode
        && !effective.decisions.some((decision) =>
            decision.allowedProvisionModes.includes(policy.recommendedProvisioningMode!))) return { valid: false };
    if (!effective.decisions.some((decision) => decision.actions.some((action) =>
        action.enabled && (action.id === "login" || action.id === "provision")))) return { valid: false };

    const loginStranding = await checkHomeAuthenticationPolicyRetainsLoginRoutesInTx(tx, {
        env,
        currentDecisions: current.status === "ready" ? current.decisions : [],
        prospectiveDecisions: effective.decisions,
    });
    if (!loginStranding.ok) return { valid: false };

    const currentDecisions = current.status === "ready" ? current.decisions : [];
    const signInServiceOn = (service: HomeSignInServicePolicyV1 | null | undefined) =>
        service !== null && service !== undefined && service.mode !== "disabled";
    const widens = addsAny(enabledActionKeys(currentDecisions), enabledActionKeys(effective.decisions))
        || addsAny(provisionModeKeys(currentDecisions), provisionModeKeys(effective.decisions))
        || (!signInServiceOn(current.status === "ready" ? current.signInService : null) && signInServiceOn(effective.signInService))
        || storagePolicyWidens(env, stored, policy);
    return { valid: true, widens };
}

const POLICY_FIELDS = [
    "teamCreationPolicy",
    "teamsVisibleToMembers",
    "authenticationPolicy",
    "teamProviderPolicy",
    "identityNetworkPolicy",
] as const;

/** Records the fields this patch changed, as stored before and after (§3.9). */
async function recordPolicyChangeInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    before: HomeGovernancePolicyRow | null;
    patch: HomeGovernancePolicySetInputV1;
    revision: number;
    widening: boolean;
}>): Promise<void> {
    const changes = POLICY_FIELDS.flatMap((field) => {
        const next = input.patch[field];
        if (next === undefined) return [];
        const from = input.before ? (input.before[field] ?? null) : null;
        return JSON.stringify(from) === JSON.stringify(next) ? [] : [{ field, from, to: next }];
    });
    if (changes.length === 0) return;
    await recordHomeAdministrationEventInTx(tx, {
        actor: { kind: "account", accountId: input.actorAccountId },
        target: null,
        detail: {
            action: "home.policy.set",
            summary: { revision: input.revision, changes, ...(input.widening ? { widening: true as const } : {}) },
        },
    });
}

/**
 * Applies one partial policy patch under compare-and-set on `revision`.
 *
 * Every changed field is authorized before any field is written, so a patch
 * that mixes an authorized and an unauthorized field changes nothing. A stale
 * expected revision is reported with the current policy so the editor can
 * reload and reapply instead of silently overwriting another administrator.
 */
export async function setHomeGovernancePolicyInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        patch: HomeGovernancePolicySetInputV1;
        env: NodeJS.ProcessEnv;
        emailDeliveryReady: boolean;
    }>,
): Promise<HomeGovernancePolicySetResult> {
    const operations = new Set<"set_team_creation_policy" | "set_authentication_policy">();
    // Who may create Teams and whether members outside every Team see them are
    // one Teams-policy authority.
    if (input.patch.teamCreationPolicy !== undefined
        || input.patch.teamsVisibleToMembers !== undefined) operations.add("set_team_creation_policy");
    if (input.patch.authenticationPolicy !== undefined
        || input.patch.teamProviderPolicy !== undefined
        || input.patch.identityNetworkPolicy !== undefined) operations.add("set_authentication_policy");
    await acquireHomeGovernanceAdmissionInTx(tx, {
        accountIds: [input.actorAccountId],
        intent: operations.has("set_authentication_policy") ? "exclusive" : "content",
        audience: homeGovernancePolicyChangeAudience(input.patch),
    });
    for (const operation of operations) {
        const authorization = await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: input.actorAccountId,
            request: { operation },
        });
        if (authorization.status === "rejected") return { status: "forbidden" };
    }

    const current = await findPolicyRowInTx(tx);
    const currentRevision = current?.revision ?? 0;
    if (input.patch.expectedRevision !== currentRevision) {
        return { status: "revision_conflict", policy: projectPolicyRow(current) };
    }

    // The strict codec proves shape; Lane 03's deployment ceiling decides which
    // provider kinds a save may add. A fresh (inherited) or unreadable Home can
    // therefore save its first narrowing, and clearing back to inheritance is
    // always a recoverable write.
    if (input.patch.teamProviderPolicy !== undefined
        && !isHomeTeamProviderPolicyWithinDeploymentCeiling({
            env: input.env,
            current: projectPolicyRow(current).teamProviders,
            next: input.patch.teamProviderPolicy,
        })) {
        return { status: "invalid_policy" };
    }

    let widening = false;
    if (input.patch.authenticationPolicy !== undefined) {
        const assessment = await assessAuthenticationPolicyChangeInTx(tx, input.patch.authenticationPolicy, input.env, input.emailDeliveryReady);
        if (!assessment.valid) return { status: "invalid_policy" };
        // §3.4 bound 5: widening is the owner's confirmed decision, never a side effect of a save.
        if (assessment.widens && input.patch.confirmWidening !== true) return { status: "widening_unconfirmed" };
        widening = assessment.widens;
    }

    if (input.patch.identityNetworkPolicy !== undefined
        && input.patch.identityNetworkPolicy !== null
        && validateManagedIdentityNetworkPolicyForSave({
            env: input.env,
            policy: input.patch.identityNetworkPolicy,
        }).status === "invalid") return { status: "invalid_policy" };

    const teamsVisibleToMembersWrite = input.patch.teamsVisibleToMembers === undefined
        ? {}
        : { teamsVisibleToMembers: input.patch.teamsVisibleToMembers };
    const authenticationPolicyWrite = input.patch.authenticationPolicy === undefined
        ? {}
        : {
            authenticationPolicy: input.patch.authenticationPolicy === null
                ? getActivePrismaRuntime().DbNull
                : input.patch.authenticationPolicy,
        };
    const teamProviderPolicyWrite = input.patch.teamProviderPolicy === undefined
        ? {}
        : {
            teamProviderPolicy: input.patch.teamProviderPolicy === null
                ? getActivePrismaRuntime().DbNull
                : input.patch.teamProviderPolicy,
        };
    const identityNetworkPolicyWrite = input.patch.identityNetworkPolicy === undefined
        ? {}
        : {
            identityNetworkPolicy: input.patch.identityNetworkPolicy === null
                ? getActivePrismaRuntime().DbNull
                : input.patch.identityNetworkPolicy,
        };

    if (!current) {
        try {
            await tx.homeGovernancePolicy.create({
                data: {
                    id: HOME_GOVERNANCE_POLICY_ID,
                    revision: 1,
                    ...(input.patch.teamCreationPolicy ? { teamCreationPolicy: input.patch.teamCreationPolicy } : {}),
                    ...teamsVisibleToMembersWrite,
                    ...authenticationPolicyWrite,
                    ...teamProviderPolicyWrite,
                    ...identityNetworkPolicyWrite,
                },
                select: { id: true },
            });
        } catch (error) {
            if (isPrismaErrorCode(error, "P2002")) {
                throw new HomeGovernancePolicyCreateConflictError();
            }
            throw error;
        }
        await recordPolicyChangeInTx(tx, { actorAccountId: input.actorAccountId, before: null, patch: input.patch, revision: 1, widening });
        return { status: "applied", policy: projectPolicyRow(await findPolicyRowInTx(tx)) };
    }

    const applied = await tx.homeGovernancePolicy.updateMany({
        where: { id: HOME_GOVERNANCE_POLICY_ID, revision: currentRevision },
        data: {
            revision: currentRevision + 1,
            ...(input.patch.teamCreationPolicy ? { teamCreationPolicy: input.patch.teamCreationPolicy } : {}),
            ...teamsVisibleToMembersWrite,
            ...authenticationPolicyWrite,
            ...teamProviderPolicyWrite,
            ...identityNetworkPolicyWrite,
        },
    });
    if (applied.count === 0) {
        return { status: "revision_conflict", policy: projectPolicyRow(await findPolicyRowInTx(tx)) };
    }
    await recordPolicyChangeInTx(tx, {
        actorAccountId: input.actorAccountId,
        before: current,
        patch: input.patch,
        revision: currentRevision + 1,
        widening,
    });
    return { status: "applied", policy: projectPolicyRow(await findPolicyRowInTx(tx)) };
}
