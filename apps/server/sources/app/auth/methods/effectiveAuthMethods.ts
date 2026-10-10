import type {
    AccountProvisionMode,
    AuthMethod,
    AuthMethodActionId,
    AuthMethodUnavailableReason,
    EffectiveAuthMethodAction,
} from "@/app/auth/methods/types";
import type { HomeAuthenticationPolicyReadV1 } from "@happier-dev/protocol";
import type { TeamIdentityProviderKindV1 } from "@happier-dev/protocol/teams";

import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { resolveAuthMethodRegistry } from "@/app/auth/methods/registry";
import {
    resolveAllowedAccountProvisionModes,
    resolveRecommendedAccountProvisionMode,
} from "@/app/auth/methods/accountProvisionModes";
import { resolveDeploymentAuthProviderFeatures } from "@/app/auth/providers/deploymentProviderFeatures";
import type { AuthProviderFeatures } from "@/app/auth/providers/types";
import { resolveKeylessAutoProvisionEligibility } from "@/app/auth/keyless/resolveKeylessAutoProvisionEligibility";
import { resolveKeylessAccountsEnabled } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";
import { readAuthOauthKeylessFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { applyHomeAuthenticationPolicyToEnv } from "@/app/home/governance/homeAuthenticationPolicyEnv";

export type EffectiveAuthMethodDecision = Readonly<{
    id: string;
    actions: readonly EffectiveAuthMethodAction[];
    allowedProvisionModes: readonly AccountProvisionMode[];
    recommendedProvisionMode: AccountProvisionMode | null;
    ui?: EffectiveAuthMethodPresentation;
}>;

/**
 * A method's safe presentation, as the provider descriptor projects it
 * (teams-lane-03/01 §10.2): provider kind, display name, icon hint,
 * connect-button colour and profile-badge support. The auth-entry projector
 * carries all of it; the retained `/v1/features` method list publishes only its
 * own `ui` fields.
 */
export type EffectiveAuthMethodPresentation = NonNullable<AuthMethod["ui"]> & Readonly<{
    providerKind?: TeamIdentityProviderKindV1;
    connectButtonColor?: string | null;
    supportsProfileBadge?: boolean;
}>;

/**
 * The one mapping from a provider descriptor's `ui` to its decision's
 * presentation, shared by the deployment and managed-provider decision
 * builders so neither can drop a descriptor field the other carries.
 */
export function projectProviderDecisionPresentation(
    ui: AuthProviderFeatures["ui"],
    providerKind?: TeamIdentityProviderKindV1,
): Readonly<{ ui?: EffectiveAuthMethodPresentation }> {
    if (!ui?.displayName) return {};
    return {
        ui: {
            displayName: ui.displayName,
            iconHint: ui.iconHint ?? null,
            ...(providerKind ? { providerKind } : {}),
            ...(ui.connectButtonColor ? { connectButtonColor: ui.connectButtonColor } : {}),
            ...(ui.supportsProfileBadge !== undefined ? { supportsProfileBadge: ui.supportsProfileBadge } : {}),
        },
    };
}

export type EffectiveAuthMethodInputs = Readonly<{
    env: NodeJS.ProcessEnv;
    /** Persisted Home policy (both directions within the env locks). Omitted means the deployment policy is inherited. */
    homeAuthenticationPolicy?: HomeAuthenticationPolicyReadV1;
    /**
     * Transactional-mail readiness from the composed `AuthEmailDelivery`
     * boundary. When readiness is undetermined, mail-dependent actions resolve
     * disabled so the server never advertises an action its request boundary
     * would reject.
     */
    emailDeliveryReady?: boolean;
    /** A server-validated bounded Team source may admit provisioning under a closed Home. */
    admission?: Readonly<{
        kind: "team_invitation" | "team_provisioned_identity" | "team_jit_identity";
    }>;
}>;

function normalizeId(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

function narrowForMailReadiness(
    actions: readonly EffectiveAuthMethodAction[],
    mailDependentActions: readonly AuthMethodActionId[] | undefined,
    emailDeliveryReady: boolean | undefined,
): readonly EffectiveAuthMethodAction[] {
    if (!mailDependentActions || mailDependentActions.length === 0) return actions;
    if (emailDeliveryReady === true) return actions;
    return actions.map((action) =>
        action.enabled && mailDependentActions.includes(action.id)
            ? { ...action, enabled: false, reason: "email_delivery_unavailable" as const }
            : action,
    );
}

export type ProviderAuthMethodActionInput = Readonly<{
    id: string;
    enabled: boolean;
    configured: boolean;
    /** The one row the provider's owner decides: keyed (E2EE) fresh-Account provisioning. */
    keyedProvision: Readonly<{ enabled: boolean; reason?: AuthMethodUnavailableReason }>;
}>;

/**
 * The one OAuth provider action table. Deployment-contributed and managed
 * providers share every row — `connect`, keyed `provision`, keyless `login`,
 * keyless `provision` — and differ only in who decides keyed provisioning, so
 * that predicate is an input rather than a second copy of the table. A provider
 * that is disabled or unconfigured offers nothing.
 */
export function createProviderAuthMethodActionTable(
    env: NodeJS.ProcessEnv,
): (input: ProviderAuthMethodActionInput) => readonly EffectiveAuthMethodAction[] {
    const keyless = readAuthOauthKeylessFeatureEnv(env);
    const keylessAccountsEnabled = resolveKeylessAccountsEnabled(env);
    const keylessAutoProvisionEligible = resolveKeylessAutoProvisionEligibility(env).ok;
    return (input) => {
        const available = input.enabled && input.configured;
        const keylessLoginEnabled = available
            && keylessAccountsEnabled
            && keyless.enabled
            && keyless.providers.includes(normalizeId(input.id));
        return Object.freeze([
            { id: "connect", enabled: available, mode: "either" },
            {
                id: "provision",
                enabled: available && input.keyedProvision.enabled,
                mode: "keyed",
                ...(!input.keyedProvision.enabled && input.keyedProvision.reason
                    ? { reason: input.keyedProvision.reason }
                    : {}),
            },
            { id: "login", enabled: keylessLoginEnabled, mode: "keyless" },
            {
                id: "provision",
                enabled: keylessLoginEnabled && keyless.autoProvision && keylessAutoProvisionEligible,
                mode: "keyless",
            },
        ]);
    };
}

function actionHasPermittedAccountMode(
    action: EffectiveAuthMethodAction,
    permittedModes: readonly AccountProvisionMode[],
): boolean {
    if (action.mode === "either") return permittedModes.length > 0;
    return permittedModes.includes(action.mode === "keyed" ? "e2ee" : "plain");
}

/**
 * The persisted Home narrowing, asked about one Account mode.
 *
 * Every admission path that may construct an Account answers this question, so
 * it has one owner: the ordinary decision narrowing below filters
 * `allowedProvisionModes` through it, and the Team-provider admission fallback
 * in `effectiveHomeAuthMethods.ts` bounds its requested mode with it. An
 * unreadable document fails closed, exactly as the decision narrowing does.
 */
export function isAccountProvisionModePermittedByHomePolicy(
    homePolicy: HomeAuthenticationPolicyReadV1 | undefined,
    mode: AccountProvisionMode,
): boolean {
    if (!homePolicy || homePolicy.status === "inherited") return true;
    if (homePolicy.status === "unreadable") return false;
    const permitted = homePolicy.policy.permittedAccountModes;
    return !permitted || permitted.includes(mode);
}

/**
 * The narrowing half of the persisted Home policy (plan `2026-09-26-home-owner-console` §3.4).
 *
 * The widening half never reaches this function as a special case: a document value for a key the
 * deployment left unset is already in the env the decision was built from
 * (`applyHomeAuthenticationPolicyToEnv`), so a method the Home turned on arrives here enabled and an
 * explicitly set deployment key stays a lock. What remains is subtractive: unlisted methods,
 * excluded Account modes and a narrower admission.
 */
export function applyHomePolicyToAuthMethodDecision(
    decision: EffectiveAuthMethodDecision,
    homePolicy: HomeAuthenticationPolicyReadV1 | undefined,
    admission?: EffectiveAuthMethodInputs["admission"],
): EffectiveAuthMethodDecision {
    // Only the Home catalog publishes WorkOS here. Team-owned bindings reach
    // the separately bounded Team admission owner and never this Home table.
    // A company proof cannot create an Account under inherited admission.
    if (decision.ui?.providerKind === "workos_sso" && !admission
        && !(homePolicy?.status === "narrowed" && homePolicy.policy.admission === "self_service")) {
        decision = {
            ...decision,
            actions: decision.actions.map((action) => action.id === "provision"
                ? { ...action, enabled: false, reason: "provisioning_not_enabled" as const }
                : action),
        };
    }
    if (!homePolicy || homePolicy.status === "inherited") return decision;
    if (homePolicy.status === "unreadable") {
        return {
            ...decision,
            actions: decision.actions.map((action) => ({
                ...action,
                enabled: false,
                reason: "method_not_enabled" as const,
            })),
            allowedProvisionModes: [],
            recommendedProvisionMode: null,
        };
    }

    const policy = homePolicy.policy;
    const enabledMethodIds = policy.enabledMethodIds?.map(normalizeId);
    const methodEnabled = !enabledMethodIds || enabledMethodIds.includes(normalizeId(decision.id));
    const allowedProvisionModes = decision.allowedProvisionModes
        .filter((mode) => isAccountProvisionModePermittedByHomePolicy(homePolicy, mode));
    const recommendedProvisionMode = policy.recommendedProvisioningMode
        ? (allowedProvisionModes.includes(policy.recommendedProvisioningMode)
            ? policy.recommendedProvisioningMode
            : null)
        : (decision.recommendedProvisionMode && allowedProvisionModes.includes(decision.recommendedProvisionMode)
            ? decision.recommendedProvisionMode
            : allowedProvisionModes.length === 1 ? allowedProvisionModes[0]! : null);

    return {
        ...decision,
        actions: decision.actions.map((action) => {
            if (!action.enabled) return action;
            if (!methodEnabled) return { ...action, enabled: false, reason: "method_not_enabled" as const };
            // Persisted permitted Account modes govern construction of new
            // Accounts only. Existing Accounts retain their stored mode, so
            // applying this narrowing to login/connect would strand a valid
            // Account merely because the Home later changed its provisioning
            // policy.
            if (action.id === "provision" && !actionHasPermittedAccountMode(action, allowedProvisionModes)) {
                return { ...action, enabled: false, reason: "account_mode_unavailable" as const };
            }
            if (action.id === "provision" && policy.admission && policy.admission !== "self_service"
                && !(admission && policy.admission === "invitation_only")) {
                return { ...action, enabled: false, reason: "provisioning_not_enabled" as const };
            }
            if (action.id === "provision" && action.mode === "either" && allowedProvisionModes.length === 1) {
                return { ...action, mode: allowedProvisionModes[0] === "plain" ? "keyless" as const : "keyed" as const };
            }
            return action;
        }),
        allowedProvisionModes,
        recommendedProvisionMode,
    };
}

/**
 * The single effective authentication-method decision for this Home.
 *
 * Publication (`/v1/features`), request admission, startup lockout safety and
 * Home administration all read this one result. Consumers must not recompute
 * availability formulas from environment variables or provider registries.
 */
export function resolveEffectiveAuthMethodDecisions(
    inputs: EffectiveAuthMethodInputs,
): readonly EffectiveAuthMethodDecision[] {
    const { emailDeliveryReady } = inputs;
    // Both directions: the document's values for keys the deployment left unset, then the narrowing.
    const env = inputs.homeAuthenticationPolicy
        ? applyHomeAuthenticationPolicyToEnv(inputs.env, inputs.homeAuthenticationPolicy)
        : inputs.env;
    const policy = resolveAuthPolicyFromEnv(env);
    const allowedProvisionModes = resolveAllowedAccountProvisionModes(env);
    const recommendedProvisionMode = resolveRecommendedAccountProvisionMode(env);

    const coreDecisions: EffectiveAuthMethodDecision[] = resolveAuthMethodRegistry(env).map((module) => {
        const resolved = module.resolveAuthMethod({
            env,
            policy,
            ...(inputs.admission ? { admission: inputs.admission } : {}),
        });
        return applyHomePolicyToAuthMethodDecision({
            id: normalizeId(resolved.id),
            actions: narrowForMailReadiness(
                resolved.actions as readonly EffectiveAuthMethodAction[],
                module.mailDependentActions,
                emailDeliveryReady,
            ),
            allowedProvisionModes,
            recommendedProvisionMode,
            ...(resolved.ui ? { ui: resolved.ui } : {}),
        }, inputs.homeAuthenticationPolicy, inputs.admission);
    });

    // External provider contributions share the same decision surface so that a
    // provider and a built-in method can never disagree about availability.
    const providerRegistry = resolveDeploymentAuthProviderFeatures(env).providers;
    const providerActions = createProviderAuthMethodActionTable(env);
    const signupProviders = policy.signupProviders.map(normalizeId);

    const providerDecisions: EffectiveAuthMethodDecision[] = providerRegistry
        .map((provider) => {
            const id = normalizeId(provider.id);
            const details = provider.resolveFeatures({ env, policy });
            return applyHomePolicyToAuthMethodDecision({
                id,
                actions: providerActions({
                    id,
                    enabled: Boolean(details.enabled),
                    configured: details.configured === true,
                    // Deployment providers provision only from the operator's signup allowlist.
                    keyedProvision: { enabled: signupProviders.includes(id) },
                }),
                allowedProvisionModes,
                recommendedProvisionMode,
                ...projectProviderDecisionPresentation(details.ui, provider.providerKind),
            } satisfies EffectiveAuthMethodDecision, inputs.homeAuthenticationPolicy, inputs.admission);
        })
        .sort((a, b) => a.id.localeCompare(b.id));

    // Native E2EE password login completes through the Key Challenge finalizer,
    // but that finalizer qualifies a password-stamped challenge as
    // `email_password` and gates on this method's own decision
    // (`registerKeyChallengeAuthRoute.ts`). So `key_challenge` policy does not
    // bound keyed password login: narrowing it here would let a Home create
    // E2EE Accounts it then refuses to sign in.
    return Object.freeze([...coreDecisions, ...providerDecisions]);
}

export function findEffectiveAuthMethodDecision(
    inputs: EffectiveAuthMethodInputs,
    methodId: string,
): EffectiveAuthMethodDecision | null {
    const wanted = normalizeId(methodId);
    if (!wanted) return null;
    return resolveEffectiveAuthMethodDecisions(inputs).find((decision) => decision.id === wanted) ?? null;
}

/**
 * Route admission. An unknown method, an unknown action, or a disabled action
 * all fail closed.
 */
export function isEffectiveAuthMethodActionEnabled(
    inputs: EffectiveAuthMethodInputs,
    methodId: string,
    actionId: AuthMethodActionId,
): boolean {
    const decision = findEffectiveAuthMethodDecision(inputs, methodId);
    if (!decision) return false;
    return decision.actions.some((action) => action.id === actionId && action.enabled === true);
}

/**
 * Wire shape of the effective decisions for the `/v1/features` method list. It
 * translates only and decides nothing.
 */
export function toPublishedAuthMethods(
    decisions: readonly EffectiveAuthMethodDecision[],
): AuthMethod[] {
    return decisions
        .map((decision) => ({
            id: decision.id,
            actions: decision.actions.map(({ id, enabled, mode }) => ({ id, enabled, mode })),
            ...(decision.ui
                ? {
                    ui: {
                        ...(decision.ui.displayName !== undefined ? { displayName: decision.ui.displayName } : {}),
                        ...(decision.ui.iconHint !== undefined ? { iconHint: decision.ui.iconHint } : {}),
                    },
                }
                : {}),
        }));
}
