import type { HomeAuthenticationPolicyReadV1, HomeSignInServicePolicyV1 } from "@happier-dev/protocol";

import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import {
    createProviderAuthMethodActionTable,
    isAccountProvisionModePermittedByHomePolicy,
    applyHomePolicyToAuthMethodDecision,
    projectProviderDecisionPresentation,
    resolveEffectiveAuthMethodDecisions,
    type EffectiveAuthMethodDecision,
} from "@/app/auth/methods/effectiveAuthMethods";
import type { AuthMethodActionId, EffectiveAuthMethodAction } from "@/app/auth/methods/types";
import { resolveAllowedAccountProvisionModes, resolveRecommendedAccountProvisionMode } from "@/app/auth/methods/accountProvisionModes";
import { resolveAuthMethodRegistry } from "@/app/auth/methods/registry";
import { resolveEffectiveHomeSignInServicePolicy } from "@/app/auth/methods/signInServicePolicy";
import { listProviderDescriptorsInTx, resolveOAuthRuntimeByIdInTx } from "@/app/auth/providers/identityProviderCatalog";
import { resolveAccountDirectoryFeature } from "@/app/features/accountDirectoryFeature";
import { readHomeGovernancePolicyInTx, resolveTeamProviderKindPolicy } from "@/app/home/governance/governancePolicy";
import { applyHomeAuthenticationPolicyToEnv } from "@/app/home/governance/homeAuthenticationPolicyEnv";
import { readTeamIdentityConnectionInTx } from "@/app/teams/identity/teamIdentityConnectionLifecycle";
import { inTx, type Tx } from "@/storage/inTx";
import type { TeamOAuthAdmissionSource } from "@/app/teams/memberships/teamOAuthAdmissionSource";

export type EffectiveHomeAuthMethodsResult =
    | Readonly<{
        status: "ready";
        decisions: readonly EffectiveAuthMethodDecision[];
        signInService: HomeSignInServicePolicyV1 | null;
    }>
    | Readonly<{ status: "unavailable" }>;

export type HomeAuthMethodAdmissionContext =
    | TeamOAuthAdmissionSource
    | Readonly<{ kind: "team_invitation" }>;

function normalizeId(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Resolves the complete current Home authentication decision, including managed providers.
 * Request admission and auth-entry publication consume this owner rather than reconstructing
 * managed availability from catalog rows or deployment feature metadata.
 */
async function resolveEffectiveHomeAuthMethodsForPolicyInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        homeAuthenticationPolicy: HomeAuthenticationPolicyReadV1;
        emailDeliveryReady?: boolean;
        admission?: Readonly<{ kind: "team_invitation" | "team_provisioned_identity" | "team_jit_identity" }>;
    }>,
): Promise<EffectiveHomeAuthMethodsResult> {
    if (input.homeAuthenticationPolicy.status === "unreadable") return { status: "unavailable" };

    // The Home policy decides in both directions where the deployment left a key unset (§3.4).
    const env = applyHomeAuthenticationPolicyToEnv(input.env, input.homeAuthenticationPolicy);

    const policy = resolveAuthPolicyFromEnv(env);
    const baseDecisions = resolveEffectiveAuthMethodDecisions({
        env: env,
        homeAuthenticationPolicy: input.homeAuthenticationPolicy,
        ...(input.emailDeliveryReady === undefined ? {} : { emailDeliveryReady: input.emailDeliveryReady }),
        ...(input.admission === undefined ? {} : { admission: input.admission }),
    });
    const existingIds = new Set(baseDecisions.map((decision) => normalizeId(decision.id)));
    const allowedProvisionModes = resolveAllowedAccountProvisionModes(env);
    const recommendedProvisionMode = resolveRecommendedAccountProvisionMode(env);
    const providerActions = createProviderAuthMethodActionTable(env);
    const managedDecisions = (await listProviderDescriptorsInTx(tx, env))
        .flatMap(({ descriptor: details, reference, providerKind }) => {
            if (reference.source !== "managed" || existingIds.has(reference.id)) return [];
            const decision = applyHomePolicyToAuthMethodDecision({
                id: reference.id,
                actions: providerActions({
                    id: reference.id,
                    enabled: details.enabled === true,
                    configured: details.configured === true,
                    // Company proof is independent of anonymous key-only signup;
                    // the shared Home policy owner enforces explicit company admission.
                    keyedProvision: {
                        enabled: providerKind === "workos_sso" || policy.anonymousSignupEnabled,
                        reason: "provisioning_not_enabled",
                    },
                }),
                allowedProvisionModes,
                recommendedProvisionMode,
                ...projectProviderDecisionPresentation(details.ui, providerKind),
            }, input.homeAuthenticationPolicy, input.admission);
            return [decision];
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    const signInService = resolveEffectiveHomeSignInServicePolicy({
        envPolicy: policy.signInService ?? null,
        narrowing: input.homeAuthenticationPolicy.status === "narrowed"
            ? input.homeAuthenticationPolicy.policy.signInService
            : undefined,
        accountDirectoryCapable: resolveAccountDirectoryFeature(env)
            .capabilities?.accountDirectory?.homeDirectory === true,
    });
    const coreIds = new Set(resolveAuthMethodRegistry(env).map((method) => normalizeId(method.id)));
    const coreDecisions = baseDecisions.filter((decision) => coreIds.has(normalizeId(decision.id)));
    const providerDecisions = [
        ...baseDecisions.filter((decision) => !coreIds.has(normalizeId(decision.id))),
        ...managedDecisions,
    ].sort((a, b) => a.id.localeCompare(b.id));
    return {
        status: "ready",
        decisions: Object.freeze([...coreDecisions, ...providerDecisions]),
        signInService,
    };
}

/** Resolves the persisted Home policy through the same effective owner. */
export async function resolveEffectiveHomeAuthMethodsInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        emailDeliveryReady?: boolean;
        admission?: Readonly<{ kind: "team_invitation" | "team_provisioned_identity" | "team_jit_identity" }>;
        /** Server-owned prospective override used by Home policy validation/projection. */
        homeAuthenticationPolicyOverride?: HomeAuthenticationPolicyReadV1;
    }>,
): Promise<EffectiveHomeAuthMethodsResult> {
    const authentication = input.homeAuthenticationPolicyOverride
        ?? (await readHomeGovernancePolicyInTx(tx)).authentication;
    return await resolveEffectiveHomeAuthMethodsForPolicyInTx(tx, {
        env: input.env,
        ...(input.emailDeliveryReady === undefined ? {} : { emailDeliveryReady: input.emailDeliveryReady }),
        ...(input.admission === undefined ? {} : { admission: input.admission }),
        homeAuthenticationPolicy: authentication,
    });
}

export async function resolveEffectiveHomeAuthMethods(
    input: Readonly<{ env: NodeJS.ProcessEnv; emailDeliveryReady?: boolean }>,
): Promise<EffectiveHomeAuthMethodsResult> {
    return await inTx(async (tx) => await resolveEffectiveHomeAuthMethodsInTx(tx, input));
}

export async function isEffectiveHomeAuthMethodActionEnabledInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        methodId: string;
        actionId: AuthMethodActionId;
        mode?: EffectiveAuthMethodAction["mode"];
        admission?: HomeAuthMethodAdmissionContext;
    }>,
): Promise<boolean> {
    const result = await resolveEffectiveHomeAuthMethodsInTx(tx, {
        env: input.env,
        ...(input.admission ? { admission: input.admission } : {}),
    });
    if (result.status !== "ready") return false;
    const decision = result.decisions.find((candidate) => candidate.id === normalizeId(input.methodId));
    const ordinaryEnabled = decision?.actions.some((action) => action.enabled
        && action.id === input.actionId
        && (input.mode === undefined || action.mode === input.mode || action.mode === "either")) === true;
    if (ordinaryEnabled && (!input.admission
        || !("connectionId" in input.admission)
        || input.admission.connectionId === null)) return true;
    const admission = input.admission;
    if (!admission
        || !("providerId" in admission)
        || input.actionId !== "provision"
        || admission.connectionId === null) return false;
    if (normalizeId(admission.providerId) !== normalizeId(input.methodId)) return false;
    const requestedAccountMode = input.mode === "keyed" ? "e2ee" : input.mode === "keyless" ? "plain" : null;
    const [governance, team, connectionRead, runtime] = await Promise.all([
        readHomeGovernancePolicyInTx(tx),
        tx.team.findUnique({
            where: { id: admission.teamId },
            select: { admissionMode: true, archivedAt: true },
        }),
        // Connection usability is the lifecycle owner's derived `state`, not a
        // pair of raw enabled flags: a `setting_up` or `needs_attention`
        // connection admitted here is refused again by qualification
        // (`qualifyTeamAuthentication`) and by admission finalization
        // (`teamOAuthAdmission`), which both already read it through this owner.
        // The reader keys on `{teamId, id}`, so it also carries the exact-Team
        // check this gate used to spell out.
        readTeamIdentityConnectionInTx(tx, {
            id: admission.connectionId,
            teamId: admission.teamId,
        }),
        resolveOAuthRuntimeByIdInTx(tx, input.env, admission.providerId, {
            kind: "team",
            teamId: admission.teamId,
        }, "oauth_finalize"),
    ]);
    if (requestedAccountMode
        && !resolveAllowedAccountProvisionModes(applyHomeAuthenticationPolicyToEnv(input.env, governance.authentication))
            .includes(requestedAccountMode)) {
        return false;
    }
    // The Home's own storage narrowing bounds this admission exactly as it
    // bounds the ordinary path (`applyHomePolicyToAuthMethodDecision`): a Team
    // identity connection admits members, it does not widen the Account
    // protections this Home stores.
    if (requestedAccountMode
        && !isAccountProvisionModePermittedByHomePolicy(governance.authentication, requestedAccountMode)) {
        return false;
    }
    if (!team || team.archivedAt !== null || team.admissionMode !== admission.admissionMode) return false;
    const connection = connectionRead.status === "ready" ? connectionRead.connection : null;
    if (!connection
        || connection.state !== "connected"
        || connection.providerInstanceId !== admission.providerId
        || connection.revision !== admission.connectionRevision
        || !runtime
        || runtime.reference.id !== admission.providerId
        || runtime.reference.context.kind !== "team"
        || runtime.reference.context.teamId !== admission.teamId
        || resolveTeamProviderKindPolicy(governance, connection.providerKind) !== "allowed") {
        return false;
    }
    if (admission.kind === "team_invitation" && admission.providerOrigin !== "team") return false;
    if (admission.kind === "team_jit_identity") {
        return governance.teamProviders.status === "narrowed"
            && governance.teamProviders.policy.teamJitAllowed;
    }
    return true;
}

export async function isEffectiveHomeAuthMethodActionEnabled(
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        methodId: string;
        actionId: AuthMethodActionId;
        mode?: EffectiveAuthMethodAction["mode"];
        admission?: HomeAuthMethodAdmissionContext;
    }>,
): Promise<boolean> {
    return await inTx(async (tx) => await isEffectiveHomeAuthMethodActionEnabledInTx(tx, input));
}
