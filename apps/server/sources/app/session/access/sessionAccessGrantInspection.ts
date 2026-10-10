import {
    projectSessionAccessGrantTransitionsV1,
    type SessionAccessGrantRowV1,
    type SessionAccessGrantsListResponseV1,
} from "@happier-dev/protocol";
import { ACCOUNT_DISPLAY_PROFILE_SELECT, projectAccountDisplayProfileV1 } from "@/app/account/profile/accountDisplayProfile";
import { listSessionTeamCredentialBindingConsequencesInTx } from "@/app/teams/credentials/sessionBinding";
import { inTx } from "@/storage/inTx";
import { projectSessionEffectiveAccessV1, resolveSessionAccessForOperation } from "./sessionAccess";
import type { SessionAccessAuthentication } from "./sessionAccessAuthentication";
import { enforceTeamExternalSharingPolicyInTx, isSubjectExternalToTeamInTx } from "./sessionAccessExternalSharingPolicy";
import { resolveSessionAccessGrantSubjectInTx } from "./sessionAccessGrantEligibility";
import { teamPolicyStillRequiresGrant } from "./sessionAccessGrantService";

/** What the grant inspector answers: the roster projection, or a typed refusal. */
type SessionAccessGrantInspectionResult =
    | { ok: true; value: SessionAccessGrantsListResponseV1 }
    | { ok: false; error:
        | "session_access_forbidden"
        | "session_access_authentication_required"
        | "session_access_authentication_unavailable"
    };

/** Inspect explicit grants only after admission, keeping roster topology private to access managers. */
export async function inspectSessionAccessGrants(params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionAccessGrantInspectionResult> {
    return await inTx(async (tx): Promise<SessionAccessGrantInspectionResult> => {
        const admission = await resolveSessionAccessForOperation(tx, {
            accountId: params.actorAccountId,
            sessionId: params.sessionId,
            authentication: params.authentication,
        });
        if (admission.status === "authentication_required") {
            return { ok: false, error: "session_access_authentication_required" };
        }
        if (admission.status === "authentication_unavailable") {
            return { ok: false, error: "session_access_authentication_unavailable" };
        }
        if (admission.status !== "allowed" || !admission.access.capabilities.readTranscript) {
            return { ok: false, error: "session_access_forbidden" };
        }
        const session = await tx.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: { accountId: true, primaryTeamId: true, account: { select: ACCOUNT_DISPLAY_PROFILE_SELECT } },
        });
        const base = {
            owner: { kind: "account" as const, accountId: session.accountId, ...projectAccountDisplayProfileV1(session.account) },
            effectiveAccess: projectSessionEffectiveAccessV1(admission.access),
            primaryTeamId: session.primaryTeamId,
        };
        if (!admission.access.capabilities.manageAccess) {
            return { ok: true, value: { ...base, visibility: "self", grants: [] } };
        }
        const roster = await tx.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: {
                shares: { select: { accessLevel: true, canApprovePermissions: true, sharedWithUser: { select: ACCOUNT_DISPLAY_PROFILE_SELECT } }, orderBy: { sharedWithUserId: "asc" } },
                teamGrants: { select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true, team: { select: { id: true, name: true } } }, orderBy: { teamId: "asc" } },
                groupGrants: { select: { accessLevel: true, canApprovePermissions: true, teamGroup: { select: { id: true, name: true, teamId: true, team: { select: { name: true } } } } }, orderBy: { teamGroupId: "asc" } },
            },
        });
        const facts: Omit<SessionAccessGrantRowV1, "allowedTransitions">[] = [
            ...roster.shares.map((row) => ({
                grant: { subject: { kind: "account" as const, accountId: row.sharedWithUser.id }, accessLevel: row.accessLevel, canApprovePermissions: row.canApprovePermissions },
                principal: { kind: "account" as const, accountId: row.sharedWithUser.id, ...projectAccountDisplayProfileV1(row.sharedWithUser) },
            })),
            ...roster.teamGrants.map((row) => ({
                grant: { subject: { kind: "team" as const, teamId: row.team.id }, accessLevel: row.accessLevel, canApprovePermissions: row.canApprovePermissions, requiredByTeamPolicy: row.requiredByTeamPolicy },
                principal: { kind: "team" as const, teamId: row.team.id, name: row.team.name },
            })),
            ...roster.groupGrants.map((row) => ({
                grant: { subject: { kind: "group" as const, teamId: row.teamGroup.teamId, groupId: row.teamGroup.id }, accessLevel: row.accessLevel, canApprovePermissions: row.canApprovePermissions },
                principal: { kind: "group" as const, teamId: row.teamGroup.teamId, groupId: row.teamGroup.id, name: row.teamGroup.name, teamName: row.teamGroup.team.name },
            })),
        ];
        // Transcript shareability is a disclosure rule owned by the access decision,
        // not an admission rule: a grant on a not-yet-published Session pre-authorizes
        // its recipient, so every transition the writer admits is offered here too.
        // The external-sharing verdict depends only on actor and primary Team, so it
        // is resolved once; each row then only asks whether its subject is external.
        const primaryTeamId = session.primaryTeamId;
        const externalSharing = primaryTeamId === null ? null : await enforceTeamExternalSharingPolicyInTx(tx, {
            actorAccountId: params.actorAccountId, primaryTeamId, authentication: params.authentication,
        });
        const grants: SessionAccessGrantRowV1[] = [];
        for (const row of facts) {
            // "May this be changed?" and "may this be removed?" are two questions
            // the one subject resolver already answers in its two modes. The grant
            // writer admits removing a retained grant whose subject has since been
            // archived or deactivated, so the affordance asks it the same way
            // instead of deriving removal from the set verdict. Removal mode only
            // skips checks the set mode also applies, so an accepted set verdict
            // needs no second read.
            const eligibility = await resolveSessionAccessGrantSubjectInTx(tx, { actorAccountId: params.actorAccountId, sessionOwnerAccountId: session.accountId, subject: row.grant.subject, hasExistingGrant: true });
            const removalEligibility = eligibility.ok
                ? eligibility
                : await resolveSessionAccessGrantSubjectInTx(tx, { actorAccountId: params.actorAccountId, sessionOwnerAccountId: session.accountId, subject: row.grant.subject, hasExistingGrant: true, removingExistingGrant: true });
            const required = row.grant.subject.kind === "team" && "requiredByTeamPolicy" in row.grant && row.grant.requiredByTeamPolicy === true
                && await teamPolicyStillRequiresGrant(tx, row.grant.subject.teamId);
            const external = externalSharing !== null && primaryTeamId !== null
                && await isSubjectExternalToTeamInTx(tx, { primaryTeamId, subject: row.grant.subject });
            grants.push({ ...row, allowedTransitions: projectSessionAccessGrantTransitionsV1({
                current: { accessLevel: row.grant.accessLevel, canApprovePermissions: row.grant.canApprovePermissions },
                canDelegate: admission.access.capabilities.managePermissionDelegation,
                requiredByTeamPolicy: required,
                ...(eligibility.ok ? {} : { ineligible: eligibility.error }),
                ...(removalEligibility.ok ? {} : { removalIneligible: removalEligibility.error }),
                ...(external && externalSharing !== null ? { externalSharing } : {}),
            }) });
        }
        // What the access manager is about to break: the Teams whose grant this
        // editor can remove, plus the Team the context currently names, which the
        // same editor can move away.
        const credentialBindingConsequences = await listSessionTeamCredentialBindingConsequencesInTx(tx, {
            sessionId: params.sessionId,
            teamIds: [...new Set([
                ...roster.teamGrants.map((row) => row.team.id),
                ...(primaryTeamId === null ? [] : [primaryTeamId]),
            ])],
        });
        return { ok: true, value: { ...base, visibility: "complete", grants, credentialBindingConsequences: [...credentialBindingConsequences] } };
    }, { readOnly: true });
}
