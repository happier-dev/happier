import type { TeamIdentityErrorCodeV1 } from "@happier-dev/protocol/teams";

import type { Tx } from "@/storage/inTx";
import { authorizeHomeGovernanceMutationInTx } from "@/app/home/governance/homeCapabilities";
import { HOME_PROVIDER_CONTEXT, type ProviderCatalogContext } from "@/app/auth/providers/providerReference";
import {
    qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextInTx,
    type TeamOperationAuthenticationContext,
} from "../actorContext";

export type TeamIdentityAdministrationAuthorityError = Extract<TeamIdentityErrorCodeV1,
    | "team_not_found"
    | "team_forbidden"
    | "team_authentication_required"
    | "team_authentication_unavailable"
    | "home_forbidden"
>;

/** The same provider-instance namespace carries Home and exact Team bindings. */
export function identityConnectionOwner(teamId: string | null): ProviderCatalogContext {
    return teamId === null ? HOME_PROVIDER_CONTEXT : { kind: "team", teamId };
}

export async function authorizeTeamIdentityAdministrationInTx(
    tx: Tx,
    input: Partial<TeamOperationAuthenticationContext> & Readonly<{
        teamId: string | null;
        actorAccountId: string;
    }>,
    operation: "view" | "mutate" = "mutate",
): Promise<Readonly<{ ok: true; canMutate: boolean }> | Readonly<{ ok: false; error: TeamIdentityAdministrationAuthorityError }>> {
    if (input.teamId === null) {
        const authorization = await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: input.actorAccountId,
            request: { operation: operation === "view" ? "view" : "set_authentication_policy" },
        });
        return authorization.status === "authorized"
            ? { ok: true, canMutate: authorization.authority.manageAuthentication }
            : { ok: false, error: "home_forbidden" };
    }
    const actor = await resolveTeamActorContextInTx(tx, input);
    // Identity and directory administration are Team-only surfaces. Home's
    // manageAllTeams projection deliberately grants detail/metadata/lifecycle
    // authority, but must not reveal these surfaces to a non-member.
    if (!actor || !actor.teamCapabilities.viewTeam) return { ok: false, error: "team_not_found" };
    if (!actor.teamCapabilities.manageAuthentication) return { ok: false, error: "team_forbidden" };

    const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
        context: actor,
        ...input,
    });
    return qualification.ok ? { ok: true, canMutate: true } : qualification;
}
