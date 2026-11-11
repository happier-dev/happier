import type { HomeSessionDefaultsProjectionV1 } from '@happier-dev/protocol/home/governance/projection';
import { decodeKeysetCursorV1, encodeKeysetCursorV1, readKeysetCursorIdV1, readKeysetCursorTextV1 } from '@happier-dev/protocol/pagination/keysetCursorV1';
import { HOME_ACCOUNT_DETAIL_RECENT_EVENTS_LIMIT_V1, HOME_ACCOUNT_PAGE_LIMIT_DEFAULT_V1, isActiveHomeAccountStatus, type HomeAccountDetailV1, type HomeAccountListResultV1, type HomeAccountPickerRowV1, type HomeAccountRowV1, type HomeAccountSearchScopeV1, type HomeAuthenticationPolicyReadV1, type HomeRoleV1 } from '@happier-dev/protocol/home/governance';
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import { type HomeAuthenticationPolicyProjectionV1, type HomeAuthenticationOptionsV1, type HomeGovernancePolicyProjectionV1, type HomeGovernanceProjectionV1, type HomeGovernanceEligibilityV1, type HomeIdentityDeploymentServicesV1 } from '@happier-dev/protocol/home/governance/projection';

import { deploymentAllowsPrivateIdentityNetwork } from "@/app/auth/providers/managed/managedIdentityNetworkPolicy";
import { resolveDeploymentTeamProviderKinds } from "@/app/auth/providers/teamProviderDeploymentCeiling";
import { resolveEffectiveHomeAuthMethodsInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import {
    readAccountAdministrationAuthenticationByIdInTx,
    type AccountAdministrationAuthenticationProjection,
} from "@/app/auth/methods/effectiveAccountLoginMethods";
import { resolveAllowedAccountProvisionModes, resolveRecommendedAccountProvisionMode } from "@/app/auth/methods/accountProvisionModes";
import { resolveWorkosPlatformRuntimeMetadata } from "@/app/integrations/workos/workosPlatform";
import { resolveAuthProviderInstancesFromEnv } from "@/app/auth/providers/oidc/oidcProviderConfig";
import { buildAccountTextPrefixFilter } from "@/app/account/accountTextPrefixFilter";
import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
    resolveAccountDisplayLabelV1,
    type AccountDisplayProfileRow,
} from "@/app/account/profile/accountDisplayProfile";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextInTx,
    type TeamOperationAuthenticationContext,
} from "@/app/teams/actorContext";
import {
    assertTeamOwnershipAllowsAccountErasureInTx,
    readTeamOwnershipErasureDecisionsInTx,
} from "@/app/teams/memberships/erasurePrecondition";
import type { Tx } from "@/storage/inTx";
import { getDbProviderFromEnv, prismaRuntime } from "@/storage/prisma";

import {
    listHomeAdministrationEventsInTx,
    recordHomeAdministrationEventInTx,
} from "@/app/home/audit/homeAdministrationEvents";
import { persistentMachineWhere } from "@/app/machines/machineSelection";
import { listTeamMembershipsForAccountInTx } from "@/app/teams/memberships/memberAdministration";
import { acquireHomeGovernanceAdmissionInTx, publishHomeGovernanceChangedInTx } from "./governanceChanges";
import {
    HOME_ANONYMOUS_SIGNUP_KEY,
    HOME_AUTH_METHOD_ENABLE_KEYS,
    HOME_AUTH_METHOD_PREREQUISITE_KEYS,
    HOME_STORAGE_POLICY_KEY,
    applyHomeAuthenticationPolicyToEnv,
    homeAuthenticationCeilingEnv,
    readHomeAuthenticationLock,
} from "./homeAuthenticationPolicyEnv";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { readHomeGovernancePolicyInTx, type HomeGovernancePolicyRecord } from "./governancePolicy";
import {
    assertHomeOwnershipSurvivesTransitionInTx,
    authorizeHomeAccountErasureActorInTx,
    authorizeHomeGovernanceMutationInTx,
    countActiveHomeOwnersInTx,
    readHomeGovernanceAccountInTx,
    resolveHomeAccountMutationCapabilitiesV1,
    resolveHomePublicProfileManagementCapabilityV1,
    resolveHomeCapabilitiesV1,
    resolveHomeGovernanceAuthority,
    type HomeGovernanceAccountFacts,
} from "./homeCapabilities";

/** One server-authoritative answer for the empty Personal Home affordance. */
export async function readHomeEmptinessInTx(tx: Tx, input: Readonly<{ actorAccountId: string }>): Promise<
    Readonly<{ status: "ok"; isEmpty: boolean }> | Readonly<{ status: "forbidden" }>
> {
    const actor = await authorizeHomeAccountErasureActorInTx(tx, input.actorAccountId);
    if (actor.status === "rejected") return { status: "forbidden" };
    // Invitations belong to Teams, so an existing Team already makes the Home
    // nonempty regardless of whether its invitations are pending or accepted.
    const [session, otherAccount, team] = await Promise.all([
        tx.session.findFirst({ select: { id: true } }),
        tx.account.findFirst({ where: { id: { not: input.actorAccountId } }, select: { id: true } }),
        tx.team.findFirst({ select: { id: true } }),
    ]);
    return { status: "ok", isEmpty: !session && !otherAccount && !team };
}

/** Every rejection these services can produce, as the wire already names them. */
export type HomeGovernanceRejectionCode =
    | "home_governance_forbidden"
    | "home_governance_setup_required"
    | "home_account_not_found"
    | "home_account_inactive"
    | "home_owner_transfer_required"
    | "invalid_home_cursor";

export type HomeGovernanceResult<T> =
    | Readonly<{ status: "ok"; result: T }>
    | Readonly<{ status: "rejected"; code: HomeGovernanceRejectionCode }>;

/**
 * Flattens the stored authentication narrowing for the administration surface.
 *
 * An absent optional field becomes an explicit `null` rather than being omitted:
 * the form must be able to distinguish "this Home does not narrow methods" from
 * "this Home narrows methods to none", and `unreadable` must stay visible as an
 * actionable configuration problem instead of collapsing into `inherited`.
 */
function projectHomeAuthenticationPolicyV1(
    read: HomeAuthenticationPolicyReadV1,
): HomeAuthenticationPolicyProjectionV1 {
    if (read.status !== "narrowed") return { status: read.status };
    return {
        status: "narrowed",
        enabledMethodIds: read.policy.enabledMethodIds ?? null,
        permittedAccountModes: read.policy.permittedAccountModes ?? null,
        recommendedProvisioningMode: read.policy.recommendedProvisioningMode ?? null,
        admission: read.policy.admission ?? null,
        signInServiceDisabled: read.policy.signInService?.mode === "disabled",
        // Stored, never effective: an editor that replaces the document carries these over (§3.4).
        anonymousSignup: read.policy.anonymousSignup ?? null,
        storagePolicy: read.policy.storagePolicy ?? null,
    };
}

/**
 * Projects the stored policy record onto the wire. Lane 03's provider and
 * network ceilings pass through their own canonical codecs unchanged; this
 * surface renders them and never reinterprets their semantics.
 */
export function projectHomeGovernancePolicyV1(
    record: HomeGovernancePolicyRecord,
): HomeGovernancePolicyProjectionV1 {
    return {
        revision: record.revision,
        teamCreationPolicy: record.teamCreationPolicy,
        teamsVisibleToMembers: record.teamsVisibleToMembers,
        authentication: projectHomeAuthenticationPolicyV1(record.authentication),
        teamProviders: record.teamProviders,
        identityNetwork: record.identityNetwork,
        sessionDefaults: record.sessionDefaults ?? null,
    };
}

/**
 * The deployment's identity-service ceiling as an administration fact.
 *
 * Both answers come from the owners that already enforce them — the WorkOS
 * platform metadata resolver and the managed identity network policy — so the
 * surface cannot drift from the runtime. Only the resulting capability travels;
 * credentials, hosts and environment variable names stay on the server.
 */
function projectHomeIdentityDeploymentServicesV1(
    env: NodeJS.ProcessEnv,
): HomeIdentityDeploymentServicesV1 {
    const workos = resolveWorkosPlatformRuntimeMetadata(env);
    const deploymentOidcSourceKey = (env.AUTH_PROVIDERS_CONFIG_PATH ?? "").trim()
        ? "AUTH_PROVIDERS_CONFIG_PATH" as const
        : "AUTH_PROVIDERS_CONFIG_JSON" as const;
    return {
        workos: workos.available
            ? "configured"
            : workos.reason === "partial_configuration"
                ? "partially_configured"
                : "not_configured",
        privateIdentityNetworkAllowed: deploymentAllowsPrivateIdentityNetwork(env),
        teamProviderKinds: [...resolveDeploymentTeamProviderKinds(env)],
        deploymentOidcProviders: resolveAuthProviderInstancesFromEnv(env).instances.map((instance) => ({
            id: instance.id,
            displayName: instance.displayName,
            sourceKey: deploymentOidcSourceKey,
        })),
    };
}

async function projectHomeAuthenticationOptionsV1(
    tx: Tx,
    env: NodeJS.ProcessEnv,
    emailDeliveryReady: boolean,
    home: HomeGovernancePolicyRecord,
): Promise<HomeAuthenticationOptionsV1> {
    const stored = home.authentication;
    // The choices are what this Home could offer if it turned everything on that the deployment
    // leaves unset (§3.4: both directions within the env locks); the persisted-Home decision supplies
    // their current action state. Both are projections of the same canonical resolver, never
    // parallel availability formulas. A method that can never run here stays in the list as fixed
    // (its enable key is set by the deployment) or unavailable (a prerequisite is missing), so the
    // console can say why instead of hiding it.
    const ceilingEnv = homeAuthenticationCeilingEnv(env);
    const ceiling = await resolveEffectiveHomeAuthMethodsInTx(tx, {
        env: ceilingEnv,
        homeAuthenticationPolicyOverride: { status: "inherited" },
        homeGovernancePolicy: home,
        emailDeliveryReady,
    });
    const effective = await resolveEffectiveHomeAuthMethodsInTx(tx, {
        env, emailDeliveryReady, homeAuthenticationPolicyOverride: stored,
        homeGovernancePolicy: home,
    });
    const permittedAccountModes = [...resolveAllowedAccountProvisionModes(ceilingEnv)];
    const recommendedProvisioningMode = resolveRecommendedAccountProvisionMode(env);
    const anonymousSignup = {
        enabled: resolveAuthPolicyFromEnv(applyHomeAuthenticationPolicyToEnv(env, stored)).anonymousSignupEnabled,
        fixedBy: readHomeAuthenticationLock(env, HOME_ANONYMOUS_SIGNUP_KEY),
    };
    // The storage policy applies at the next start: `running` is what this process uses.
    const runningStoragePolicy = readEncryptionFeatureEnv(env).storagePolicy;
    const storagePolicyFixedBy = readHomeAuthenticationLock(env, HOME_STORAGE_POLICY_KEY);
    const storedStoragePolicy = stored.status === "narrowed" ? stored.policy.storagePolicy : undefined;
    const storagePolicy = {
        running: runningStoragePolicy,
        pending: !storagePolicyFixedBy && storedStoragePolicy && storedStoragePolicy !== runningStoragePolicy
            ? storedStoragePolicy
            : null,
        fixedBy: storagePolicyFixedBy,
    };
    if (ceiling.status !== "ready" || effective.status !== "ready") {
        return {
            methods: [],
            permittedAccountModes,
            recommendedProvisioningMode,
            signInService: { deploymentMode: null, canDisable: false },
            anonymousSignup,
            storagePolicy,
        };
    }
    const effectiveById = new Map(effective.decisions.map((decision) => [decision.id, decision]));
    return {
        methods: ceiling.decisions.map((decision) => {
            const viable = decision.actions.some((action) =>
                action.enabled && (action.id === "login" || action.id === "provision"));
            const enableKey = Object.prototype.hasOwnProperty.call(HOME_AUTH_METHOD_ENABLE_KEYS, decision.id)
                ? HOME_AUTH_METHOD_ENABLE_KEYS[decision.id]!
                : null;
            const fixedBy = enableKey ? readHomeAuthenticationLock(env, enableKey) : null;
            const current = effectiveById.get(decision.id) ?? decision;
            return {
                id: decision.id,
                actions: current.actions.map(({ id, enabled, mode, reason }) => ({
                    id,
                    enabled,
                    mode,
                    ...(reason ? { reason } : {}),
                })),
                ...(decision.ui?.displayName ? { displayName: decision.ui.displayName } : {}),
                ...(decision.ui?.iconHint !== undefined ? { iconHint: decision.ui.iconHint } : {}),
                ...(fixedBy ? { fixedBy } : {}),
                ...(!viable && !fixedBy
                    ? { unavailable: { requires: [...(HOME_AUTH_METHOD_PREREQUISITE_KEYS[decision.id] ?? [])] } }
                    : {}),
            };
        }),
        permittedAccountModes,
        recommendedProvisioningMode,
        signInService: {
            deploymentMode: ceiling.signInService?.mode ?? null,
            canDisable: ceiling.signInService !== null && ceiling.signInService.mode !== "disabled",
        },
        anonymousSignup,
        storagePolicy,
    };
}

/**
 * The Home Administration snapshot for one viewer of one explicit Home.
 *
 * Administration stays admin-only. The explicit session_defaults projection
 * authorizes active Home membership once and discloses no other policy fields.
 */
type HomeGovernanceReadInput = Readonly<{
    viewerAccountId: string;
    teamsEnabled: boolean;
    env: NodeJS.ProcessEnv;
    emailDeliveryReady: boolean;
    projection?: 'session_defaults';
}>;
export function readHomeGovernanceProjectionInTx(tx: Tx, input: HomeGovernanceReadInput & { projection: 'session_defaults' }): Promise<HomeGovernanceResult<HomeSessionDefaultsProjectionV1>>;
export function readHomeGovernanceProjectionInTx(tx: Tx, input: HomeGovernanceReadInput & { projection?: undefined }): Promise<HomeGovernanceResult<HomeGovernanceProjectionV1>>;
export function readHomeGovernanceProjectionInTx(tx: Tx, input: HomeGovernanceReadInput): Promise<HomeGovernanceResult<HomeGovernanceProjectionV1 | HomeSessionDefaultsProjectionV1>>;
export async function readHomeGovernanceProjectionInTx(tx: Tx, input: HomeGovernanceReadInput): Promise<HomeGovernanceResult<HomeGovernanceProjectionV1 | HomeSessionDefaultsProjectionV1>> {
    if (input.projection === 'session_defaults') {
        const member = await readHomeGovernanceAccountInTx(tx, input.viewerAccountId);
        if (!member || !isActiveHomeAccountStatus(member.status)) {
            return { status: 'rejected', code: 'home_governance_forbidden' };
        }
        const policy = await readHomeGovernancePolicyInTx(tx);
        return { status: 'ok', result: { homeDefaults: policy.sessionDefaults ?? null } };
    }
    // Ownerless Homes are a deployment-recovery state, not an authorization
    // opportunity. Return only the typed setup signal before reading policy,
    // provider/network configuration, or any other administration fact.
    const activeOwnerCount = await countActiveHomeOwnersInTx(tx);
    if (activeOwnerCount === 0) {
        return { status: "rejected", code: "home_governance_setup_required" };
    }
    const authorization = await authorizeHomeGovernanceMutationInTx(tx, {
        actorAccountId: input.viewerAccountId,
        request: { operation: "view" },
    });
    if (authorization.status === "rejected") return authorization;
    const viewer = authorization.actor;
    const policy = await readHomeGovernancePolicyInTx(tx);
    const authenticationOptions = await projectHomeAuthenticationOptionsV1(tx, input.env, input.emailDeliveryReady, policy);
    return { status: "ok", result: {
        identityServices: projectHomeIdentityDeploymentServicesV1(input.env),
        viewer: { accountId: viewer.accountId, homeRole: viewer.homeRole, status: viewer.status },
        capabilities: resolveHomeCapabilitiesV1({
            account: viewer,
            teamCreationPolicy: policy.teamCreationPolicy,
            teamsEnabled: input.teamsEnabled,
        }),
        policy: projectHomeGovernancePolicyV1(policy),
        setupState: "owned",
        activeOwnerCount,
        teamsEnabled: input.teamsEnabled,
        authenticationOptions,
    } };
}

/**
 * Projects only the effective Team eligibility facts ordinary members
 * consume. Role, deployment-service, owner-count and every other policy fact
 * never enter this result, so transport serialization is not relied on for
 * nondisclosure.
 *
 * An active Account additionally learns how Teams are created here (the policy
 * class) and who administers the Home (display names only, never ids or
 * emails), so a member who cannot create a Team is told whom to ask, and
 * whether its Teams destination is shown. That disclosure is a 2026-09-26 user
 * ruling; an Account that is not active on this Home receives none of it.
 */
export async function readHomeGovernanceEligibilityInTx(tx: Tx, input: Readonly<{
    viewerAccountId: string;
    teamsEnabled: boolean;
}>): Promise<HomeGovernanceEligibilityV1 | null> {
    const viewer = await readHomeGovernanceAccountInTx(tx, input.viewerAccountId);
    if (!viewer) return null;
    const policy = await readHomeGovernancePolicyInTx(tx);
    const createTeam = resolveHomeCapabilitiesV1({
        account: viewer,
        teamCreationPolicy: policy.teamCreationPolicy,
        teamsEnabled: input.teamsEnabled,
    }).createTeam;
    return {
        teamsEnabled: input.teamsEnabled,
        createTeam,
        // Managed creation must name its first owner (`createTeamInTx` refuses it
        // otherwise). Only a viewer who may create learns this, and such a viewer
        // already administers the policy it reflects.
        createTeamForChosenAccount: createTeam && policy.teamCreationPolicy === "managed_only",
        ...(isActiveHomeAccountStatus(viewer.status) ? {
            teamCreationPolicy: policy.teamCreationPolicy,
            administratorNames: await readActiveHomeAdministratorNamesInTx(tx),
            showTeams: input.teamsEnabled && await resolveTeamsDestinationShownInTx(tx, { viewer, policy }),
        } : {}),
    };
}

/**
 * Whether this viewer is offered the Teams destination on this Home.
 *
 * Belonging to a Team always keeps it: those Teams stay reachable whatever the
 * policy says. Otherwise creation turned off leaves nothing to find there, and
 * a Home may hide it from members who are in no Team; its administrators keep
 * it so they can still create Teams for others.
 */
async function resolveTeamsDestinationShownInTx(tx: Tx, input: Readonly<{
    viewer: HomeGovernanceAccountFacts;
    policy: HomeGovernancePolicyRecord;
}>): Promise<boolean> {
    const membership = await tx.teamMembership.findFirst({
        where: { accountId: input.viewer.accountId, status: "active" },
        select: { id: true },
    });
    if (membership) return true;
    if (input.policy.teamCreationPolicy === "disabled") return false;
    return input.policy.teamsVisibleToMembers || resolveHomeGovernanceAuthority(input.viewer).viewAdministration;
}

/**
 * The active Home owners and administrators as a member would name them:
 * owners first, then administrators, each in the order they joined. Only the
 * canonical display label crosses; an administrator without one is omitted
 * rather than identified another way.
 */
async function readActiveHomeAdministratorNamesInTx(tx: Tx): Promise<string[]> {
    const rows = await tx.account.findMany({
        where: { homeRole: { in: ["owner", "admin"] }, status: "active" },
        select: { homeRole: true, name: true, username: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return [...rows.filter((row) => row.homeRole === "owner"), ...rows.filter((row) => row.homeRole !== "owner")]
        .flatMap((row) => {
            const label = resolveAccountDisplayLabelV1(row);
            return label ? [label] : [];
        });
}

type HomeAccountRow = AccountDisplayProfileRow & Readonly<{
    homeRole: HomeRoleV1;
    status: HomeAccountRowV1["status"];
    createdAt: Date;
}>;

const HOME_ACCOUNT_ROW_SELECT = {
    ...ACCOUNT_DISPLAY_PROFILE_SELECT,
    homeRole: true,
    status: true,
    createdAt: true,
} as const;

function projectHomeAccountRowV1(row: HomeAccountRow, input: Readonly<{
    actor: NonNullable<Awaited<ReturnType<typeof readHomeGovernanceAccountInTx>>>;
    activeOwnerCount: number;
    teamOwnershipAllowsErasure: boolean;
    authentication: AccountAdministrationAuthenticationProjection;
}>): HomeAccountRowV1 {
    return {
        accountId: row.id,
        homeRole: row.homeRole,
        status: row.status,
        profile: projectAccountDisplayProfileV1(row),
        createdAt: row.createdAt.getTime(),
        authentication: {
            signInEmail: input.authentication.signInEmail,
            usableMethodIds: [...input.authentication.usableMethodIds],
        },
        mutationCapabilities: resolveHomeAccountMutationCapabilitiesV1({
            actor: input.actor,
            target: { accountId: row.id, homeRole: row.homeRole, status: row.status },
            activeOwnerCount: input.activeOwnerCount,
            teamOwnershipAllowsErasure: input.teamOwnershipAllowsErasure,
        }),
    };
}

async function projectHomeAccountRowForViewerInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    actor?: NonNullable<Awaited<ReturnType<typeof readHomeGovernanceAccountInTx>>>;
    activeOwnerCount?: number;
    teamOwnershipAllowsErasure?: boolean;
    authentication?: AccountAdministrationAuthenticationProjection;
    env: NodeJS.ProcessEnv;
    emailDeliveryReady: boolean;
    row: HomeAccountRow;
}>): Promise<HomeAccountRowV1 | null> {
    const actor = input.actor ?? await readHomeGovernanceAccountInTx(tx, input.actorAccountId);
    if (!actor) return null;
    const activeOwnerCount = input.activeOwnerCount ?? await countActiveHomeOwnersInTx(tx);
    const teamOwnershipAllowsErasure = input.teamOwnershipAllowsErasure
        ?? (resolveHomeGovernanceAuthority(actor).eraseAccounts
            && (await assertTeamOwnershipAllowsAccountErasureInTx(tx, { accountId: input.row.id })).status === "ok");
    const authentication = input.authentication ?? (await readHomeAccountAuthenticationByIdInTx(tx, {
        accountIds: [input.row.id],
        env: input.env,
        emailDeliveryReady: input.emailDeliveryReady,
    })).get(input.row.id) ?? { signInEmail: null, usableMethodIds: [], linkedProviderIds: [] };
    return projectHomeAccountRowV1(input.row, {
        actor,
        activeOwnerCount,
        teamOwnershipAllowsErasure,
        authentication,
    });
}

async function readHomeAccountAuthenticationByIdInTx(
    tx: Tx,
    input: Readonly<{ accountIds: readonly string[]; env: NodeJS.ProcessEnv; emailDeliveryReady: boolean }>,
): Promise<ReadonlyMap<string, AccountAdministrationAuthenticationProjection>> {
    const effective = await resolveEffectiveHomeAuthMethodsInTx(tx, {
        env: input.env,
        emailDeliveryReady: input.emailDeliveryReady,
    });
    return await readAccountAdministrationAuthenticationByIdInTx(tx, {
        accountIds: input.accountIds,
        env: input.env,
        decisions: effective.status === "ready" ? effective.decisions : [],
    });
}

const HOME_ACCOUNT_CURSOR_QUERY_V1 = "home-accounts:role-label:v1";
// Sort precision, not a name limit: 32 code points at up to 6 JSON-escaped
// bytes each leave room for the tuple/query binding and UUID under the 512-character cursor ceiling.
const HOME_ACCOUNT_SORT_PRECISION_CODE_POINTS = 32;
type HomeAccountCursor = Readonly<{ roleRank: number; unnamedFlag: number; sortKey: string; accountId: string }>;

function encodeHomeAccountCursor(cursor: HomeAccountCursor): string {
    return encodeKeysetCursorV1({
        queryKey: HOME_ACCOUNT_CURSOR_QUERY_V1,
        parts: [cursor.roleRank, cursor.unnamedFlag, cursor.sortKey, cursor.accountId],
    });
}

function decodeHomeAccountCursor(cursor: string): HomeAccountCursor | null {
    const decoded = decodeKeysetCursorV1(cursor, HOME_ACCOUNT_CURSOR_QUERY_V1);
    if (decoded.status !== "ok" || decoded.parts.length !== 4) return null;
    const roleRank = decoded.parts[0];
    const unnamedFlag = decoded.parts[1];
    const sortKey = readKeysetCursorTextV1(decoded.parts[2]);
    const accountId = readKeysetCursorIdV1(decoded.parts[3]);
    if (typeof roleRank !== "number" || !Number.isInteger(roleRank) || roleRank < 0 || roleRank > 2
        || (unnamedFlag !== 0 && unnamedFlag !== 1)
        || sortKey === null || [...sortKey].length > HOME_ACCOUNT_SORT_PRECISION_CODE_POINTS
        || accountId === null) return null;
    return { roleRank, unnamedFlag, sortKey, accountId };
}

/**
 * The administrator People page.
 *
 * Captures `(roleRank, unnamedFlag, sortKey, accountId)` from the ordering query.
 * Renamed rows can cross the boundary (and recur); unchanged rows stay complete
 * even if the boundary Account is renamed or deleted. No boundary reread occurs.
 * A malformed or foreign cursor is rejected rather
 * than silently restarting and duplicating rows already rendered by the client.
 */
export async function listHomeAccountsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    env: NodeJS.ProcessEnv;
    emailDeliveryReady: boolean;
    cursor?: string | null;
    limit?: number;
}>): Promise<HomeGovernanceResult<HomeAccountListResultV1>> {
    const actor = await readHomeGovernanceAccountInTx(tx, input.actorAccountId);
    const actorAuthority = resolveHomeGovernanceAuthority(actor);
    if (!actor || !actorAuthority.manageAccounts) {
        return { status: "rejected", code: "home_governance_forbidden" };
    }

    const limit = input.limit ?? HOME_ACCOUNT_PAGE_LIMIT_DEFAULT_V1;
    const after = input.cursor ? decodeHomeAccountCursor(input.cursor) : null;
    if (input.cursor && !after) return { status: "rejected", code: "invalid_home_cursor" };
    const sql = prismaRuntime.sql;
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const postgres = provider === "postgres" || provider === "pglite";
    const identifier = (name: string) => prismaRuntime.raw(provider === "mysql" ? `\`${name}\`` : `"${name}"`);
    // Match the display-label owner's JavaScript trim, including whitespace-only
    // names falling back to username. SQL TRIM's default only removes spaces.
    const whitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
    const trimmed = (column: string) => provider === "mysql"
        ? sql`REGEXP_REPLACE(${identifier(column)}, ${`^[${whitespace}]+|[${whitespace}]+$`}, '')`
        : postgres
            ? sql`BTRIM(${identifier(column)}, ${whitespace})`
            : sql`TRIM(${identifier(column)}, ${whitespace})`;
    const label = sql`COALESCE(NULLIF(${trimmed("name")}, ''), NULLIF(${trimmed("username")}, ''), '')`;
    // Prisma binds this number as int8; PostgreSQL SUBSTR takes an int4 length.
    const sortKeyLength = postgres
        ? sql`${HOME_ACCOUNT_SORT_PRECISION_CODE_POINTS}::integer`
        : sql`${HOME_ACCOUNT_SORT_PRECISION_CODE_POINTS}`;
    const sortKeyExpression = sql`SUBSTR(LOWER(${label}), 1, ${sortKeyLength})`;
    // Provider-native folding, with one bytewise comparison for both ordering
    // and the captured boundary (not a second JavaScript sort/normalizer).
    const orderedText = (expression: ReturnType<typeof sql>) => provider === "mysql"
        ? sql`CAST(${expression} AS BINARY)`
        : sql`${expression} COLLATE ${prismaRuntime.raw(postgres ? '"C"' : "BINARY")}`;
    const roleRank = identifier("roleRank");
    const unnamedFlag = identifier("unnamedFlag");
    const sortKey = orderedText(sql`${identifier("sortKey")}`);
    const accountId = orderedText(sql`${identifier("accountId")}`);
    const boundary = after
        ? sql`WHERE (${roleRank}, ${unnamedFlag}, ${sortKey}, ${accountId}) >
            (${after.roleRank}, ${after.unnamedFlag}, ${orderedText(sql`${after.sortKey}`)}, ${orderedText(sql`${after.accountId}`)})`
        : prismaRuntime.empty;
    const positions = await tx.$queryRaw<readonly Readonly<{
        roleRank: number | bigint;
        unnamedFlag: number | bigint;
        sortKey: string;
        accountId: string;
    }>[]>(sql`
        SELECT ${roleRank}, ${unnamedFlag}, ${identifier("sortKey")}, ${identifier("accountId")}
        FROM (
            SELECT ${identifier("id")} AS ${identifier("accountId")},
                CASE ${identifier("homeRole")} WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END AS ${roleRank},
                CASE WHEN ${label} = '' THEN 1 ELSE 0 END AS ${unnamedFlag},
                ${sortKeyExpression} AS ${identifier("sortKey")}
            FROM ${identifier("Account")}
        ) roster
        ${boundary}
        ORDER BY ${roleRank}, ${unnamedFlag}, ${sortKey}, ${accountId}
        LIMIT ${limit + 1}
    `);
    const selected = await tx.account.findMany({
        where: { id: { in: positions.slice(0, limit).map((position) => position.accountId) } },
        select: HOME_ACCOUNT_ROW_SELECT,
    });
    const byId = new Map(selected.map((row) => [row.id, row]));
    const page: readonly HomeAccountRow[] = positions.slice(0, limit).map((position) => {
        const row = byId.get(position.accountId);
        if (!row) throw new Error("home_governance_account_disappeared_in_transaction");
        return row;
    });

    const last = positions.length > limit ? positions[limit - 1] : undefined;
    const activeOwnerCount = await countActiveHomeOwnersInTx(tx);
    const total = await tx.account.count();
    const teamOwnership = actorAuthority.eraseAccounts
        ? await readTeamOwnershipErasureDecisionsInTx(tx, { accountIds: page.map((row) => row.id) })
        : null;
    const authenticationByAccountId = await readHomeAccountAuthenticationByIdInTx(tx, {
        accountIds: page.map((row) => row.id),
        env: input.env,
        emailDeliveryReady: input.emailDeliveryReady,
    });
    return {
        status: "ok",
        result: {
            total,
            items: await Promise.all(page.map(async (row) => {
                const projected = await projectHomeAccountRowForViewerInTx(tx, {
                    actorAccountId: input.actorAccountId,
                    actor,
                    activeOwnerCount,
                    teamOwnershipAllowsErasure: teamOwnership?.get(row.id)?.status === "ok",
                    authentication: authenticationByAccountId.get(row.id)
                        ?? { signInEmail: null, usableMethodIds: [], linkedProviderIds: [] },
                    env: input.env,
                    emailDeliveryReady: input.emailDeliveryReady,
                    row,
                });
                if (!projected) throw new Error("home_governance_actor_disappeared_in_transaction");
                return projected;
            })),
            nextCursor: last
                ? encodeHomeAccountCursor({
                    roleRank: Number(last.roleRank), unnamedFlag: Number(last.unnamedFlag),
                    sortKey: last.sortKey, accountId: last.accountId,
                })
                : null,
        },
    };
}

/**
 * The Account picker behind Home People, Team member add, and initial-owner
 * selection.
 *
 * One query answers the identities the Home already owns, as a union: the
 * exact Account id, the exact verified mailbox (the same `AccountEmail`
 * evidence admission and invitations write, compared only after the shared
 * normalizer canonicalized the typed address), and — in Home scope only — a
 * case-insensitive username prefix through the directory's existing prefix
 * filter.
 *
 * The prefix arm's ceiling: it is offered only where the actor already holds
 * Home-list authority. `manageAccounts` pages the entire roster through
 * `home.accounts.list`, so exact-only there would protect nothing and only
 * degrade the administrator's picker. Team management carries no such reach,
 * and the Homes-owned directory/privacy classification that could widen it
 * does not exist, so Team scope takes the plan's fallback and resolves exact
 * identifiers only. Do not re-add the arm for Team scope without that
 * classification producer. The page stays bounded to the People page size so a
 * one-letter prefix can never enumerate a whole Home in one answer.
 *
 * Nothing here changes who may ask: Home scope still needs `manageAccounts`,
 * and Team scope still needs management of that exact Team — resolved and
 * qualified by the Team corridor's own owners, so a restricted Team refuses the
 * picker for exactly the credentials for which it already refuses the member
 * mutations the picker feeds.
 */
export async function searchHomeAccountsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    query: string;
    scope: HomeAccountSearchScopeV1;
    teamsEnabled: boolean;
    env: NodeJS.ProcessEnv;
    authentication?: TeamOperationAuthenticationContext;
}>): Promise<HomeGovernanceResult<readonly HomeAccountPickerRowV1[]>> {
    if (input.scope.kind === "home") {
        const actor = await readHomeGovernanceAccountInTx(tx, input.actorAccountId);
        if (!resolveHomeGovernanceAuthority(actor).manageAccounts) {
            return { status: "rejected", code: "home_governance_forbidden" };
        }
    } else {
        if (!input.teamsEnabled) return { status: "rejected", code: "home_governance_forbidden" };
        const context = await resolveTeamActorContextInTx(tx, {
            teamId: input.scope.teamId,
            actorAccountId: input.actorAccountId,
        });
        if (!context?.teamCapabilities.manageMembers) {
            return { status: "rejected", code: "home_governance_forbidden" };
        }
        // Team-derived authority is qualified before it discloses anything,
        // exactly as every other Team-derived read is. The picker keeps the
        // Home's single refusal code: an unqualified caller learns nothing
        // about the Team's policy from a disclosure surface, and the Team's own
        // entry surface is where they qualify.
        const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
            ...input.authentication,
            context,
        });
        if (!qualification.ok) return { status: "rejected", code: "home_governance_forbidden" };
    }

    const query = input.query.trim();
    if (query.length === 0) return { status: "ok", result: [] };
    const mailbox = normalizeVerifiedEmail(query);
    const matches = await tx.account.findMany({
        where: {
            OR: [
                { id: query },
                ...(mailbox ? [{ AccountEmail: { some: { normalizedEmail: mailbox.normalizedEmail } } }] : []),
                ...(input.scope.kind === "home"
                    ? [{ username: buildAccountTextPrefixFilter(query, getDbProviderFromEnv(input.env, "postgres")) }]
                    : []),
            ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: HOME_ACCOUNT_PAGE_LIMIT_DEFAULT_V1,
        select: { ...ACCOUNT_DISPLAY_PROFILE_SELECT, status: true },
    });
    if (matches.length === 0) return { status: "ok", result: [] };

    // Eligibility is what the picker's own next mutation will recheck: an
    // active Account, and for Team scope one that is not already a member.
    const existingMembers = input.scope.kind === "team"
        ? new Set((await tx.teamMembership.findMany({
            where: { teamId: input.scope.teamId, accountId: { in: matches.map((match) => match.id) } },
            select: { accountId: true },
        })).map((membership) => membership.accountId))
        : new Set<string>();
    return {
        status: "ok",
        result: matches.map((match) => ({
            accountId: match.id,
            profile: projectAccountDisplayProfileV1(match),
            eligible: isActiveHomeAccountStatus(match.status) && !existingMembers.has(match.id),
        })),
    };
}

export type HomeRoleSetOutcome = Readonly<{ account: HomeAccountRowV1 }>;

/**
 * Changes one Account's Home role.
 *
 * Authority, target state, and the last-active-owner invariant are all read
 * inside the caller's serializable transaction, so a concurrent demotion cannot
 * be raced into a Home with zero active owners. Only an active Account may be
 * given authority: a suspended or retired Account can never be promoted.
 */
export async function setHomeRoleInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    targetAccountId: string;
    homeRole: HomeRoleV1;
    env: NodeJS.ProcessEnv;
    emailDeliveryReady: boolean;
}>): Promise<HomeGovernanceResult<HomeRoleSetOutcome>> {
    await acquireHomeGovernanceAdmissionInTx(tx,
        { accountIds: [input.actorAccountId, input.targetAccountId], intent: "exclusive" });
    const admission = await authorizeHomeGovernanceMutationInTx(tx, {
        actorAccountId: input.actorAccountId,
        request: {
            operation: "set_home_role",
            targetAccountId: input.targetAccountId,
            nextHomeRole: input.homeRole,
        },
    });
    if (admission.status === "rejected") return { status: "rejected", code: admission.code };
    const target = admission.target;
    if (!target) return { status: "rejected", code: "home_account_not_found" };

    if (target.homeRole !== input.homeRole) {
        if (input.homeRole !== "member" && !isActiveHomeAccountStatus(target.status)) {
            return { status: "rejected", code: "home_account_inactive" };
        }
        const ownership = await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: target.accountId,
            nextHomeRole: input.homeRole,
        });
        if (ownership.status === "rejected") return { status: "rejected", code: ownership.code };
        if (ownership.status === "target_not_found") {
            return { status: "rejected", code: "home_account_not_found" };
        }
        await tx.account.update({
            where: { id: target.accountId },
            data: { homeRole: input.homeRole },
        });
        await recordHomeAdministrationEventInTx(tx, {
            actor: { kind: "account", accountId: input.actorAccountId },
            target: { kind: "account", id: target.accountId },
            detail: { action: "account.role.set", summary: { from: target.homeRole, to: input.homeRole } },
        });
        await markAccountChanged(tx, { accountId: target.accountId, kind: "account", entityId: "self" });
        await publishHomeGovernanceChangedInTx(tx, { excludeAccountIds: [target.accountId] });
    }

    const row = await tx.account.findUniqueOrThrow({
        where: { id: target.accountId },
        select: HOME_ACCOUNT_ROW_SELECT,
    });
    const account = await projectHomeAccountRowForViewerInTx(tx, {
        actorAccountId: input.actorAccountId,
        env: input.env,
        emailDeliveryReady: input.emailDeliveryReady,
        row,
    });
    if (!account) return { status: "rejected", code: "home_governance_forbidden" };
    return { status: "ok", result: { account } };
}

/** Reads one Account row with capabilities for the currently authenticated actor. */
export async function readHomeAccountRowInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; accountId: string; env: NodeJS.ProcessEnv; emailDeliveryReady: boolean }>,
): Promise<HomeAccountRowV1 | null> {
    const row = await tx.account.findUnique({ where: { id: input.accountId }, select: HOME_ACCOUNT_ROW_SELECT });
    return row ? await projectHomeAccountRowForViewerInTx(tx, {
        actorAccountId: input.actorAccountId,
        env: input.env,
        emailDeliveryReady: input.emailDeliveryReady,
        row,
    }) : null;
}

/**
 * One person as Home administration sees them (plan §3.12), in one read.
 *
 * The row half is the People row with its capabilities, unchanged. The rest comes from each fact's
 * own owner: sign-in facts and linked provider ids from the authentication domain, Team names and
 * roles from the Team membership owner, the latest events about this person from the audit reader,
 * and two indexed counts. Nothing here is a second decision: no device model exists (D-8), so the
 * detail carries Machine and API-token counts, never token labels, prefixes or provider user ids.
 */
export async function readHomeAccountDetailInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    accountId: string;
    env: NodeJS.ProcessEnv;
    emailDeliveryReady: boolean;
}>): Promise<HomeGovernanceResult<HomeAccountDetailV1>> {
    const actor = await readHomeGovernanceAccountInTx(tx, input.actorAccountId);
    if (!actor || !resolveHomeGovernanceAuthority(actor).viewAdministration) {
        return { status: "rejected", code: "home_governance_forbidden" };
    }
    const row = await tx.account.findUnique({ where: { id: input.accountId }, select: {
        ...HOME_ACCOUNT_ROW_SELECT,
        publicProfile: { select: { removedAt: true } },
    } });
    if (!row) return { status: "rejected", code: "home_account_not_found" };

    const authentication = (await readHomeAccountAuthenticationByIdInTx(tx, {
        accountIds: [row.id],
        env: input.env,
        emailDeliveryReady: input.emailDeliveryReady,
    })).get(row.id) ?? { signInEmail: null, usableMethodIds: [], linkedProviderIds: [] };
    const account = await projectHomeAccountRowForViewerInTx(tx, {
        actorAccountId: input.actorAccountId,
        actor,
        env: input.env,
        emailDeliveryReady: input.emailDeliveryReady,
        row,
        authentication,
    });
    if (!account) return { status: "rejected", code: "home_governance_forbidden" };

    const teams = await listTeamMembershipsForAccountInTx(tx, {
        actorAccountId: input.actorAccountId,
        accountId: row.id,
    });
    if (!teams.ok) return { status: "rejected", code: "home_governance_forbidden" };
    const machineCount = await tx.machine.count({ where: { accountId: row.id, ...persistentMachineWhere } });
    const apiTokens = await tx.accountApiToken.aggregate({
        where: { accountId: row.id },
        _count: { _all: true },
        _max: { lastUsedAt: true },
    });
    const events = await listHomeAdministrationEventsInTx(tx, {
        targetId: row.id,
        limit: HOME_ACCOUNT_DETAIL_RECENT_EVENTS_LIMIT_V1,
    });

    return {
        status: "ok",
        result: {
            ...account,
            publicProfile: {
                managementCapability: resolveHomePublicProfileManagementCapabilityV1({ actor, target: {
                    accountId: row.id, homeRole: row.homeRole, status: row.status,
                } }),
                restricted: row.publicProfile?.removedAt != null,
            },
            authentication: {
                ...account.authentication,
                linkedProviderIds: [...authentication.linkedProviderIds],
            },
            teams: teams.value.map((team) => ({ ...team })),
            machines: { count: machineCount },
            apiTokens: {
                count: apiTokens._count._all,
                lastUsedAt: apiTokens._max.lastUsedAt?.getTime() ?? null,
            },
            recentEvents: events.status === "ok" ? [...events.result.items] : [],
        },
    };
}
