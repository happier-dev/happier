import { TeamGroupLabelEnvelopeRepairsV1Schema, TeamGroupLabelEnvelopeWorkV1Schema } from '@happier-dev/protocol/teams';
import { parsePrivateLabelStoredV1, projectPrivateLabelForRecipientV1, serializePrivateLabelStoredV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { RESOURCE_RECIPIENT_ACCOUNT_SELECT, readRequiredResourceRecipientEnvelopeRejectionV1,
    resolveSavedSecretAudienceAccountIdsInTx, readTeamRecipientEnvelopeCensusesInTx } from '@/app/encryption/savedSecretRecipientEnvelopeCensus';
import type { Tx } from '@/storage/inTx';
import { acquireTeamMutationAccountAdmissionInTx } from '../memberships/sessionAccessEffects';
import { EFFECTIVE_TEAM_MEMBERSHIP_WHERE } from '../memberships/effectiveMembership';
import { acquireTeamMutationLockInTx, qualifyTeamOperationAuthenticationsInTx, resolveTeamActorContextsInTx,
    type TeamOperationAuthenticationContext } from '../actorContext';
import { publishTeamChangedInTx } from '../teamChanges';
import { toEnvelopeRows } from './privateLabels';

type Work = ReturnType<typeof TeamGroupLabelEnvelopeWorkV1Schema.parse>;
type Repairs = ReturnType<typeof TeamGroupLabelEnvelopeRepairsV1Schema.parse>;

async function eligibleTeams(tx: Tx, actorAccountId: string, authentication: TeamOperationAuthenticationContext | undefined,
    teamIds?: readonly string[]) {
    const memberships = await tx.teamMembership.findMany({ where: { accountId: actorAccountId,
        ...EFFECTIVE_TEAM_MEMBERSHIP_WHERE, ...(teamIds ? { teamId: { in: [...teamIds] } } : {}) }, select: { teamId: true } });
    const contexts = await resolveTeamActorContextsInTx(tx, { actorAccountId, teamIds: memberships.map(row => row.teamId) });
    const qualifications = await qualifyTeamOperationAuthenticationsInTx(tx, { contexts: [...contexts.values()], ...authentication });
    return [...contexts.values()].filter(context => context.teamCapabilities.viewTeam
        && qualifications.get(context.team.id)?.ok).map(context => context.team.id);
}

/** Discover only encrypted labels this current member can open and whose current audience needs envelopes. */
export async function readTeamGroupLabelEnvelopeWorkInTx(tx: Tx, actorAccountId: string,
    authentication?: TeamOperationAuthenticationContext): Promise<Work> {
    const teamIds = await eligibleTeams(tx, actorAccountId, authentication);
    const rows = await tx.teamGroup.findMany({ where: { teamId: { in: teamIds } },
        select: { id: true, teamId: true, name: true, description: true } });
    const censuses = await readTeamRecipientEnvelopeCensusesInTx(tx, teamIds);
    const groupsByTeam = new Map(teamIds.map(teamId => [teamId, [] as typeof rows]));
    for (const row of rows) groupsByTeam.get(row.teamId)?.push(row);
    const teams: Work['teams'] = [];
    for (const teamId of teamIds) {
        const recipients = censuses.get(teamId) ?? [];
        const labels: Work['teams'][number]['labels'] = [];
        for (const row of groupsByTeam.get(teamId) ?? []) {
            for (const field of ['name', 'description'] as const) {
                const raw = row[field];
                if (raw === null) continue;
                const parsed = parsePrivateLabelStoredV1(raw);
                if (parsed.kind !== 'current' || parsed.stored.content.t !== 'encrypted') continue;
                const label = projectPrivateLabelForRecipientV1({ stored: parsed.stored, recipientAccountId: actorAccountId });
                if (!label.recipientEnvelope) continue;
                const needsRepair = recipients.some(recipient => {
                    if (recipient.readiness.status !== 'available') return false;
                    const fingerprint = recipient.readiness.contentPublicKeyFingerprint;
                    return !parsed.stored.recipients.some(existing => existing.accountId === recipient.account.accountId
                        && existing.envelope.recipientContentPublicKeyFingerprint === fingerprint);
                });
                if (needsRepair) labels.push({ groupId: row.id, field, label });
            }
        }
        if (labels.length) teams.push({ teamId, recipients, labels });
    }
    return { teams };
}

/** A member may distribute an already-readable label key, never edit content or disclose to departed members. */
export async function repairTeamGroupLabelEnvelopesInTx(tx: Tx, actorAccountId: string, input: Repairs,
    authentication?: TeamOperationAuthenticationContext): Promise<'ready' | 'team_forbidden' | 'invalid_team_input' | 'team_conflict'> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [actorAccountId] });
    await acquireTeamMutationLockInTx(tx, input.teamId);
    if (!(await eligibleTeams(tx, actorAccountId, authentication, [input.teamId])).length) return 'team_forbidden';
    const expectedRecipientAccountIds = await resolveSavedSecretAudienceAccountIdsInTx(tx, {
        accountIds: [], teamIds: [input.teamId], groupIds: [],
    });
    const accounts = await tx.account.findMany({ where: { id: { in: expectedRecipientAccountIds } }, select: RESOURCE_RECIPIENT_ACCOUNT_SELECT });
    const recipientsById = new Map(accounts.map(account => [account.id, account]));
    const rows = await tx.teamGroup.findMany({ where: { teamId: input.teamId, id: { in: input.labels.map(label => label.groupId) } },
        select: { id: true, name: true, description: true } });
    const writes: { groupId: string; field: 'name' | 'description'; next: string }[] = [];
    for (const item of input.labels) {
        const prior = rows.find(row => row.id === item.groupId)?.[item.field];
        if (!prior) return 'team_conflict';
        const parsed = parsePrivateLabelStoredV1(prior);
        if (parsed.kind !== 'current' || parsed.stored.content.t !== 'encrypted' || item.label.content.t !== 'encrypted'
            || parsed.stored.content.c !== item.label.content.c) return 'team_conflict';
        if (!parsed.stored.recipients.some(recipient => recipient.accountId === actorAccountId)) return 'team_forbidden';
        const envelopes = toEnvelopeRows(item.label);
        if (!envelopes || readRequiredResourceRecipientEnvelopeRejectionV1({ expectedRecipientAccountIds, envelopes, recipientsById })) {
            return 'invalid_team_input';
        }
        writes.push({ groupId: item.groupId, field: item.field, next: serializePrivateLabelStoredV1(item.label) });
    }
    // The Team mutation lock serializes normal saves too. No content or revision is minted by repair.
    for (const write of writes) await tx.teamGroup.update({ where: { id: write.groupId }, data: { [write.field]: write.next } });
    if (writes.length) await publishTeamChangedInTx(tx, { teamId: input.teamId });
    return 'ready';
}
