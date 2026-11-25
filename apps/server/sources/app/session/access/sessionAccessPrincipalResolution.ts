import type { ResolveSessionAccessPrincipalsResponseV1 } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { projectAccountDisplayProfileV1, ACCOUNT_DISPLAY_PROFILE_SELECT } from "@/app/account/profile/accountDisplayProfile";
import { buildShareEligibleAccountWhere } from "@/app/teams/shareEligibility";
import { resolveGrantableTeamsForActorInTx } from "@/app/teams/queries";
import { resolveGrantableTeamGroupsForActorInTx } from "@/app/teams/groups/grantableGroups";
import { projectTeamGroupNameForRecipient } from "@/app/teams/groups/privateLabels";
import { resolveTeamActorContextsInTx } from "@/app/teams/actorContext";
import { qualifySessionTeamAuthenticationsInTx, type SessionAccessAuthentication } from "./sessionAccessAuthentication";
import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { projectTeamCreationPolicy } from "@/app/teams/creationPolicy";
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { SessionAccessCandidatesInspectResponseV1 } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { assertSessionAccessManageAccessInTx } from './sessionAccessGrantService';
import { classifySubjectsExternalToTeamInTx, enforceTeamExternalSharingPolicyInTx } from './sessionAccessExternalSharingPolicy';

/** Preview the same external-audience refusal the grant writer enforces at commit. */
export async function inspectSessionAccessCandidatesInTx(input: Readonly<{
    tx: Tx;
    actorAccountId: string;
    sessionId: string;
    subjects: readonly PrincipalRefV1[];
    authentication: SessionAccessAuthentication;
}>) {
    const error = await assertSessionAccessManageAccessInTx(input.tx, input);
    if (error) return { ok: false as const, error };
    const session = await input.tx.session.findUniqueOrThrow({
        where: { id: input.sessionId }, select: { primaryTeamId: true, primaryTeam: { select: { id: true, name: true, archivedAt: true } } },
    });
    const primaryTeamId = session.primaryTeamId;
    const externalSharingReason = primaryTeamId === null ? null : await enforceTeamExternalSharingPolicyInTx(input.tx, {
        actorAccountId: input.actorAccountId, primaryTeamId, authentication: input.authentication,
    });
    const subjects = [...new Map(input.subjects.map((subject) => [principalKey(subject), subject])).values()];
    const external = externalSharingReason !== null && primaryTeamId !== null
        ? await classifySubjectsExternalToTeamInTx(input.tx, { primaryTeamId, subjects }) : [];
    const candidates = subjects.map((subject, index) => ({
        subject,
        reason: external[index] ? externalSharingReason : null,
    }));
    const value: SessionAccessCandidatesInspectResponseV1 = {
        v: 1,
        context: session.primaryTeam ? { teamId: session.primaryTeam.id, name: session.primaryTeam.name,
            archived: session.primaryTeam.archivedAt !== null, externalSharingReason } : null,
        candidates,
    };
    return { ok: true as const, value };
}

/** Resolve only the explicitly requested, currently discoverable principals. */
export async function resolveSessionAccessPrincipalsInTx(input: Readonly<{
    tx: Tx;
    actorAccountId: string;
    subjects: readonly PrincipalRefV1[];
    creationTeamId?: string;
    authentication?: SessionAccessAuthentication;
}>): Promise<ResolveSessionAccessPrincipalsResponseV1> {
    const subjects = [...new Map(input.subjects.map((subject) => [principalKey(subject), subject])).values()];
    const accountIds = subjects.filter((subject): subject is Extract<PrincipalRefV1, { kind: "account" }> => subject.kind === "account")
        .map((subject) => subject.accountId);
    // Nine collaboration bindings plus Prisma's unbounded-findMany OFFSET binding.
    const accounts = (await Promise.all(portableQueryChunks({ values: accountIds, bindingsPerValue: 1, fixedBindings: 10 }).map(ids => input.tx.account.findMany({
        where: { AND: [{ id: { in: [...ids] } }, buildShareEligibleAccountWhere(input.actorAccountId)] },
        select: ACCOUNT_DISPLAY_PROFILE_SELECT,
    })))).flat();
    const accountsById = new Map(accounts.map((account) => [account.id, account]));

    const teamSubjects = subjects.filter((subject): subject is Extract<PrincipalRefV1, { kind: "team" }> => subject.kind === "team");
    const groupSubjects = subjects.filter((subject): subject is Extract<PrincipalRefV1, { kind: "group" }> => subject.kind === "group");
    const teamIds = [...new Set([
        ...teamSubjects.map((subject) => subject.teamId),
        ...groupSubjects.map((subject) => subject.teamId),
        ...(input.creationTeamId ? [input.creationTeamId] : []),
    ])];
    const contexts = await resolveTeamActorContextsInTx(input.tx, { teamIds, actorAccountId: input.actorAccountId });
    const memberTeamIds = await resolveGrantableTeamsForActorInTx(input.tx, {
        actorAccountId: input.actorAccountId, teamIds: [...contexts.keys()], actorContexts: contexts,
    });
    const memberTeams = [...contexts.values()].filter(context => memberTeamIds.has(context.team.id));
    // This read previews Session admission. The Team settings exception for
    // repairing a malformed policy does not qualify a Session attachment.
    const qualifications = await qualifySessionTeamAuthenticationsInTx(input.tx, {
        accountId: input.actorAccountId,
        teams: memberTeams.map(context => context.team),
        authentication: input.authentication ?? { env: process.env, authority: "present_user", authenticationEvidence: undefined },
    });
    const grantableTeamIds = new Set([...qualifications].filter(([, qualification]) => qualification.status === "satisfied")
        .map(([teamId]) => teamId));
    const grantableGroups = await resolveGrantableTeamGroupsForActorInTx(input.tx, {
        actorAccountId: input.actorAccountId,
        groups: groupSubjects.filter(subject => grantableTeamIds.has(subject.teamId)),
        grantableTeamIds,
    });
    // Grantability remains the membership owner's identity-only answer. Display
    // bytes are read separately at this output boundary and projected only to
    // the admitted requester.
    const grantableGroupLabels = grantableGroups.size === 0 ? [] : await input.tx.teamGroup.findMany({
        where: { id: { in: [...grantableGroups.keys()] } },
        select: { id: true, name: true },
    });
    const groupLabelsById = new Map(grantableGroupLabels.map((group) => [group.id, group.name]));
    const result: ResolveSessionAccessPrincipalsResponseV1["principals"] = [];
    for (const subject of subjects) {
        if (subject.kind === "account") {
            const account = accountsById.get(subject.accountId);
            if (account) result.push({ kind: "account", accountId: account.id, ...projectAccountDisplayProfileV1(account) });
            continue;
        }
        const context = contexts.get(subject.teamId);
        if (!context || !grantableTeamIds.has(subject.teamId)) continue;
        if (subject.kind === "team") {
            result.push({ kind: "team", teamId: context.team.id, name: context.team.name });
            continue;
        }
        const group = grantableGroups.get(subject.groupId);
        const serializedName = groupLabelsById.get(subject.groupId);
        if (group?.teamId === subject.teamId && serializedName !== undefined) {
            result.push({ kind: "group", teamId: group.teamId, groupId: group.groupId,
                name: projectTeamGroupNameForRecipient({ serialized: serializedName, recipientAccountId: input.actorAccountId }),
                teamName: context.team.name });
        }
    }
    let creationDecision: ResolveSessionAccessPrincipalsResponseV1["creationDecision"] = null;
    let creationRefusal: ResolveSessionAccessPrincipalsResponseV1["creationRefusal"];
    if (input.creationTeamId) {
        const context = contexts.get(input.creationTeamId);
        const qualification = qualifications.get(input.creationTeamId);
        // A member whose current sign-in this Team does not accept is told so: the same
        // qualification decides the Session write, which refuses with the same code.
        // Anyone else learns nothing about the Team.
        if (context && qualification && qualification.status !== "satisfied") {
            creationRefusal = {
                v: 1,
                teamId: context.team.id,
                teamName: context.team.name,
                code: qualification.status === "authentication_required"
                    ? "session_access_authentication_required"
                    : "session_access_authentication_unavailable",
                accepted: qualification.status === "authentication_required" ? [...qualification.accepted] : [],
            };
        }
        if (context && qualification?.status === "satisfied") {
            creationDecision = {
                v: 1,
                teamId: context.team.id,
                teamName: context.team.name,
                ...projectTeamCreationPolicy(context.team.sessionCreationPolicy),
                externalSharingPolicy: context.team.externalSharingPolicy,
            };
        }
    }
    return { v: 1, principals: result, ...(input.creationTeamId !== undefined ? { creationDecision } : {}),
        ...(creationRefusal ? { creationRefusal } : {}) };
}

function principalKey(subject: PrincipalRefV1): string {
    return subject.kind === "account" ? `account:${subject.accountId}`
        : subject.kind === "team" ? `team:${subject.teamId}`
            : `group:${subject.teamId}:${subject.groupId}`;
}
