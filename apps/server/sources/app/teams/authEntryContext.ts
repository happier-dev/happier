import type { AuthEntryProjectionV1 } from '@happier-dev/protocol/auth/entry';

import type { Tx } from "@/storage/inTx";

import { projectTeamLogoRefV1 } from "./projections";

export type TeamAuthEntryContext = Readonly<{
    team: Extract<AuthEntryProjectionV1, { scope: { kind: "team" }; state: "admission_required" }>["team"];
    authenticationPolicy: unknown;
    /**
     * How this Team admits people. A `provisioned` Team's membership arrives
     * from its directory, which is why a signed-in non-member is told to wait
     * rather than to try a different sign-in.
     */
    admissionMode: "invite_only" | "provisioned" | "jit";
}>;

/**
 * The Team owner's bounded public entry projection. Unknown and archived Teams
 * intentionally share the same null result so unauthenticated entry cannot
 * enumerate lifecycle state.
 */
export async function resolveTeamAuthEntryContextInTx(
    tx: Tx,
    input: Readonly<{ teamId: string }>,
): Promise<TeamAuthEntryContext | null> {
    const row = await tx.team.findUnique({
        where: { id: input.teamId },
        select: { id: true, name: true, logo: true, authenticationPolicy: true, admissionMode: true, archivedAt: true },
    });
    if (!row || row.archivedAt !== null) return null;
    return {
        team: {
            teamId: row.id,
            name: row.name,
            logo: projectTeamLogoRefV1(row),
        },
        authenticationPolicy: row.authenticationPolicy,
        admissionMode: row.admissionMode,
    };
}
