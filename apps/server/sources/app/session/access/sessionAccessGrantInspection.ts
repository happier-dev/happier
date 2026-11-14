import { projectResourceGrantRows } from '@/app/teams/resourceGrantAccess';
import { projectSessionAccessGrantTransitionsV1, type SessionAccessGrantRowV1, type SessionAccessGrantsListResponseV1 } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { ACCOUNT_DISPLAY_PROFILE_SELECT, projectAccountDisplayProfileV1 } from "@/app/account/profile/accountDisplayProfile";
import { listSessionTeamCredentialBindingConsequencesInTx } from "@/app/teams/credentials/sessionBinding";
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import { projectSessionEffectiveAccessV1, resolveSessionAccessForOperation } from "./sessionAccess";
import { backgroundDeliveryAuthentication, type SessionAccessAuthentication } from "./sessionAccessAuthentication";
import { classifySubjectsExternalToTeamInTx, enforceTeamExternalSharingPolicyInTx } from "./sessionAccessExternalSharingPolicy";
import { resolveShareSubjectsInTx } from "@/app/teams/shareEligibility";
import { teamsPolicyStillRequireGrants } from "./sessionAccessGrantService";
import { projectTeamGroupNameForRecipient } from "@/app/teams/groups/privateLabels";

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
    recipientAccountId?: string;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionAccessGrantInspectionResult> {
    return await captureReadSnapshot<SessionAccessGrantInspectionResult>(async (tx): Promise<SessionAccessGrantInspectionResult> => {
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
        if (params.recipientAccountId !== undefined && !admission.access.capabilities.manageAccess) {
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
                grants: { select: { principalKind: true, accountId: true, teamId: true, teamGroupId: true,
                    accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true,
                    account: { select: ACCOUNT_DISPLAY_PROFILE_SELECT }, team: { select: { id: true, name: true } },
                    teamGroup: { select: { id: true, name: true, teamId: true, team: { select: { name: true } } } } },
                    orderBy: [{ principalKind: 'asc' }, { accountId: 'asc' }, { teamId: 'asc' }, { teamGroupId: 'asc' }] },
            },
        });
        const grantArms = projectResourceGrantRows(roster.grants);
        const facts: Omit<SessionAccessGrantRowV1, "allowedTransitions">[] = [
            ...grantArms.accountGrants.map((row) => ({
                grant: { subject: { kind: "account" as const, accountId: row.account.id }, accessLevel: row.accessLevel, canApprovePermissions: row.canApprovePermissions },
                principal: { kind: "account" as const, accountId: row.account.id, ...projectAccountDisplayProfileV1(row.account) },
            })),
            ...grantArms.teamGrants.map((row) => ({
                grant: { subject: { kind: "team" as const, teamId: row.team.id }, accessLevel: row.accessLevel, canApprovePermissions: row.canApprovePermissions, requiredByTeamPolicy: row.requiredByTeamPolicy },
                principal: { kind: "team" as const, teamId: row.team.id, name: row.team.name },
            })),
            ...grantArms.groupGrants.map((row) => ({
                grant: { subject: { kind: "group" as const, teamId: row.teamGroup.teamId, groupId: row.teamGroup.id }, accessLevel: row.accessLevel, canApprovePermissions: row.canApprovePermissions },
                principal: { kind: "group" as const, teamId: row.teamGroup.teamId, groupId: row.teamGroup.id,
                    name: projectTeamGroupNameForRecipient({ serialized: row.teamGroup.name, recipientAccountId: params.actorAccountId }),
                    teamName: row.teamGroup.team.name },
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
        const subjects = facts.map((row) => row.grant.subject);
        const eligibilityBySubject = await resolveShareSubjectsInTx(tx, {
            actorAccountId: params.actorAccountId, resourceOwnerAccountId: session.accountId,
            subjects, hasExistingGrant: true,
        });
        const requiredTeamIds = await teamsPolicyStillRequireGrants(tx, facts.flatMap((row) =>
            row.grant.subject.kind === "team" && "requiredByTeamPolicy" in row.grant && row.grant.requiredByTeamPolicy === true
                ? [row.grant.subject.teamId] : []));
        const externalBySubject = externalSharing === null || primaryTeamId === null ? []
            : await classifySubjectsExternalToTeamInTx(tx, { primaryTeamId, subjects });
        const grants: SessionAccessGrantRowV1[] = [];
        for (const [index, row] of facts.entries()) {
            // "May this be changed?" and "may this be removed?" are two questions
            // the one subject resolver already answers in its two modes. The grant
            // writer admits removing a retained grant whose subject has since been
            // archived or deactivated, so the affordance asks it the same way
            // from the same batched facts, without re-reading inactive subjects.
            const { eligibility, removalEligibility } = eligibilityBySubject[index]!;
            const required = row.grant.subject.kind === "team" && requiredTeamIds.has(row.grant.subject.teamId);
            const external = externalBySubject[index] === true;
            grants.push({ ...row, allowedTransitions: projectSessionAccessGrantTransitionsV1({
                current: { accessLevel: row.grant.accessLevel, canApprovePermissions: row.grant.canApprovePermissions },
                canDelegate: admission.access.capabilities.managePermissionDelegation,
                requiredByTeamPolicy: required,
                // Session wire codes keep their released `session_access_` prefix over the shared verdict.
                ...(eligibility.ok ? {} : { ineligible: `session_access_${eligibility.error}` as const }),
                ...(removalEligibility.ok ? {} : { removalIneligible: `session_access_${removalEligibility.error}` as const }),
                ...(external && externalSharing !== null ? { externalSharing } : {}),
            }) });
        }
        // What the access manager is about to break: the Teams whose grant this
        // editor can remove, plus the Team the context currently names, which the
        // same editor can move away.
        const credentialBindingConsequences = await listSessionTeamCredentialBindingConsequencesInTx(tx, {
            sessionId: params.sessionId,
            actorAccountId: params.actorAccountId,
            teamIds: [...new Set([
                ...grantArms.teamGrants.map((row) => row.team.id),
                ...(primaryTeamId === null ? [] : [primaryTeamId]),
            ])],
        });
        // This is a separate subject's admission, captured alongside the
        // manager's roster; the manager's credentials cannot stand in for it.
        const recipient = params.recipientAccountId === undefined ? undefined : await resolveSessionAccessForOperation(tx, {
            accountId: params.recipientAccountId,
            sessionId: params.sessionId,
            authentication: backgroundDeliveryAuthentication(),
        });
        return { ok: true, value: { ...base, visibility: "complete", grants, credentialBindingConsequences: [...credentialBindingConsequences],
            ...(params.recipientAccountId === undefined ? {} : { recipientAccess: {
                accountId: params.recipientAccountId,
                effectiveAccess: recipient?.status === "allowed" ? projectSessionEffectiveAccessV1(recipient.access) : null,
            } }),
        } };
    });
}
