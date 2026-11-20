import type { HomeAuthenticationPolicyV1 } from '@happier-dev/protocol/home/governance';

import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { createTeamInTx, type CreateTeamError } from "@/app/teams/lifecycle";
import { db, isPrismaErrorCode } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { isPersonalHomeRuntimePurpose } from "@/app/runtime/personalHomeRuntimePurpose";
import { isAuthEmailDeliveryReady } from "@/app/auth/email/resolveAuthEmailDelivery";

import {
    isHomeGovernancePolicyCreateConflictError,
    readHomeGovernancePolicyInTx,
    setHomeGovernancePolicyInTx,
} from "./governancePolicy";
import {
    resolvePersonalHomeBootstrapOwnerInTx,
} from "./ownerAssignment";

const PERSONAL_HOME_DEFAULT_TEAM_REQUEST_KEY = "personal-home-default-team-v1";
/**
 * The canonical identity of the one H6 default Team in a Personal Home.
 *
 * A Personal Home is one Home/database, so this purpose-qualified Team id is
 * stable across process restarts, invited Accounts, and Home-owner transfers.
 * It deliberately lives on the existing Team aggregate: no second marker,
 * kind, ledger, or bootstrap state can drift from the Team it identifies.
 */
const PERSONAL_HOME_DEFAULT_TEAM_ID = "personal-home-default-team-v1";

export type PersonalHomeTeamsBootstrapInput = Readonly<{
    /** Positive runtime-purpose evidence supplied by the managed Home owner. */
    runtimePurpose: string | null;
    /** Product copy remains owned by HOME; Lane 01 validates but never invents it. */
    defaultTeamName: string;
    /** The fixed Personal Home deployment environment used by canonical policy/feature owners. */
    env: NodeJS.ProcessEnv;
}>;

export type PersonalHomeTeamsBootstrapFailure =
    | "not_personal_home"
    | "setup_required"
    | "governance_policy_unavailable"
    | "invalid_default_team_name"
    | "teams_unavailable"
    | "bootstrap_conflict";

export type PersonalHomeTeamsBootstrapResult =
    | Readonly<{
        status: "ready";
        teamId: string;
    }>
    | Readonly<{ status: PersonalHomeTeamsBootstrapFailure }>;

class PersonalHomeTeamsBootstrapAbort extends Error {
    readonly result: Exclude<PersonalHomeTeamsBootstrapResult, { status: "ready" }>;

    constructor(status: PersonalHomeTeamsBootstrapFailure) {
        super(`Personal Home Teams bootstrap stopped: ${status}`);
        this.name = "PersonalHomeTeamsBootstrapAbort";
        this.result = { status };
    }
}

function abort(status: PersonalHomeTeamsBootstrapFailure): never {
    throw new PersonalHomeTeamsBootstrapAbort(status);
}

function withInvitationOnlyAdmission(
    policy: Awaited<ReturnType<typeof readHomeGovernancePolicyInTx>>["authentication"],
): HomeAuthenticationPolicyV1 {
    if (policy.status === "unreadable") abort("governance_policy_unavailable");
    if (policy.status === "inherited") return { v: 1, admission: "invitation_only" };
    return { ...policy.policy, admission: "invitation_only" };
}

function mapTeamCreationFailure(error: CreateTeamError): PersonalHomeTeamsBootstrapFailure {
    switch (error) {
        case "invalid_team_input":
            return "invalid_default_team_name";
        case "teams_unavailable":
            return "teams_unavailable";
        case "team_forbidden":
        case "team_authentication_required":
        case "team_authentication_unavailable":
        case "team_conflict":
            return "bootstrap_conflict";
    }
}

async function bootstrapPersonalHomeTeamsInTx(
    tx: Tx,
    input: PersonalHomeTeamsBootstrapInput & Readonly<{ emailDeliveryReady: boolean }>,
): Promise<Extract<PersonalHomeTeamsBootstrapResult, { status: "ready" }>> {
    // Resolve the durable product identity before actor-specific initial-claim
    // checks. Startup may legitimately run as an invited member or a new Home
    // owner after the first bootstrap. Replaying in either context must find the
    // same Team, not fail because the original actor-scoped RepeatKey expired or
    // create a second Team under a different actor key. The initial transaction
    // already committed policy + Team + owner atomically, so an existing Team is
    // also sufficient proof that the one-time defaults were established. User
    // edits made afterward (including display-name changes) are preserved.
    const existingTeam = await tx.team.findUnique({
        where: { id: PERSONAL_HOME_DEFAULT_TEAM_ID },
        select: { id: true },
    });
    if (existingTeam) {
        return {
            status: "ready",
            teamId: existingTeam.id,
        };
    }

    const ownerResolution = await resolvePersonalHomeBootstrapOwnerInTx(tx, {
        runtimePurpose: input.runtimePurpose,
    });
    if (ownerResolution.status === "not_personal_home") abort("not_personal_home");
    if (ownerResolution.status === "setup_required") abort("setup_required");
    const initialOwnerAccountId = ownerResolution.ownerAccountId;

    const currentPolicy = await readHomeGovernancePolicyInTx(tx);
    const authenticationPolicy = withInvitationOnlyAdmission(currentPolicy.authentication);
    const policyAlreadyApplied = currentPolicy.teamCreationPolicy === "managed_only"
        && currentPolicy.authentication.status === "narrowed"
        && currentPolicy.authentication.policy.admission === "invitation_only";

    if (!policyAlreadyApplied) {
        const applied = await setHomeGovernancePolicyInTx(tx, {
            actorAccountId: initialOwnerAccountId,
            env: input.env,
            emailDeliveryReady: input.emailDeliveryReady,
            patch: {
                expectedRevision: currentPolicy.revision,
                teamCreationPolicy: "managed_only",
                authenticationPolicy,
            },
        });
        if (applied.status !== "applied") abort("governance_policy_unavailable");
    }

    const team = await createTeamInTx(tx, {
        actorAccountId: initialOwnerAccountId,
        initialOwnerAccountId,
        internalTeamId: PERSONAL_HOME_DEFAULT_TEAM_ID,
        name: input.defaultTeamName,
        requestKey: PERSONAL_HOME_DEFAULT_TEAM_REQUEST_KEY,
        env: input.env,
    });
    if (!team.ok) abort(mapTeamCreationFailure(team.error));

    return {
        status: "ready",
        teamId: team.team.id,
    };
}

/**
 * Establishes the Teams portion of a Personal Home's first-owner bootstrap.
 *
 * The managed HOME startup owner supplies positive Personal Home purpose,
 * fixed environment, and product-owned Team copy. Lane 01 derives the only
 * safe owner from canonical Home facts inside the same transaction; HOME never
 * stores or guesses a bootstrap Account identity.
 * This composition then reuses the canonical Home owner, governance policy,
 * Team lifecycle, membership, and AccountChange owners in one serializable
 * transaction. Any failure after owner reconciliation aborts the complete
 * transaction; callers can retry the same operation without creating a second
 * Team. This is not a public Action/HTTP endpoint and is never available to a
 * generic Home or ordinary signed-in actor.
 */
export async function bootstrapPersonalHomeTeams(
    input: PersonalHomeTeamsBootstrapInput,
): Promise<PersonalHomeTeamsBootstrapResult> {
    if (!isPersonalHomeRuntimePurpose(input.runtimePurpose)) return { status: "not_personal_home" };
    if (!await isServerFeatureEnabledForHome("teams", { env: input.env })) return { status: "teams_unavailable" };
    const emailDeliveryReady = await isAuthEmailDeliveryReady({ env: input.env });

    // The absent singleton policy and reserved Team identity can each move only
    // once from absent to present. A competing committed creator therefore gives
    // this operation durable progress to rejoin; no timer, attempt counter, or
    // second bootstrap marker is needed. PostgreSQL requires both settlements to
    // happen after leaving the failed transaction.
    while (true) {
        try {
            return await inTx(
                async (tx) => await bootstrapPersonalHomeTeamsInTx(tx, { ...input, emailDeliveryReady }),
                { isolationLevel: "Serializable" },
            );
        } catch (error) {
            if (error instanceof PersonalHomeTeamsBootstrapAbort) return error.result;
            if (isHomeGovernancePolicyCreateConflictError(error)) continue;
            if (isPrismaErrorCode(error, "P2002")) {
                const existingTeam = await db.team.findUnique({
                    where: { id: PERSONAL_HOME_DEFAULT_TEAM_ID },
                    select: { id: true },
                });
                if (existingTeam) {
                    return { status: "ready", teamId: existingTeam.id };
                }
            }
            throw error;
        }
    }
}
