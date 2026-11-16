import type {
  TeamLabelEnvelopeBindingV1,
  TeamLabelEnvelopeRepairsV1,
  TeamLabelEnvelopeWorkV1,
} from '@happier-dev/protocol/teams';
import {
  parsePrivateLabelStoredV1,
  projectPrivateLabelForRecipientV1,
  serializePrivateLabelStoredV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import {
  RESOURCE_RECIPIENT_ACCOUNT_SELECT,
  projectSavedSecretRecipientEnvelopeCensusRecipientsV1,
  readRequiredResourceRecipientEnvelopeRejectionV1,
  resolveSavedSecretAudienceAccountIdsInTx,
  readTeamRecipientEnvelopeCensusesInTx,
} from '@/app/encryption/savedSecretRecipientEnvelopeCensus';
import { readMachinePoolPublicationAudienceInTx } from '@/app/machines/pools/machinePoolAccess';
import type { Tx } from '@/storage/inTx';
import { acquireTeamMutationAccountAdmissionInTx } from './memberships/sessionAccessEffects';
import { EFFECTIVE_TEAM_MEMBERSHIP_WHERE } from './memberships/effectiveMembership';
import {
  acquireTeamMutationLockInTx,
  qualifyTeamOperationAuthenticationsInTx,
  resolveTeamActorContextsInTx,
  type TeamOperationAuthenticationContext,
} from './actorContext';
import { publishTeamChangedInTx } from './teamChanges';
import { toEnvelopeRows } from './groups/privateLabels';

type Census =
  TeamLabelEnvelopeWorkV1['teams'][number]['labels'][number]['recipients'];

/**
 * One stored Team-audience label. Every kind is sealed to the current Team principals; a Team Pool
 * also keeps its owning Account, exactly as its writer (`prepareMachinePoolPrivateLabelsForWriteInTx`) does.
 */
type StoredTeamLabel = Readonly<{
  binding: TeamLabelEnvelopeBindingV1;
  teamId: string;
  serialized: string | null;
  extraAudienceAccountId?: string;
}>;

async function eligibleTeams(
  tx: Tx,
  actorAccountId: string,
  authentication: TeamOperationAuthenticationContext | undefined,
  teamIds?: readonly string[],
) {
  const memberships = await tx.teamMembership.findMany({
    where: {
      accountId: actorAccountId,
      ...EFFECTIVE_TEAM_MEMBERSHIP_WHERE,
      ...(teamIds ? { teamId: { in: [...teamIds] } } : {}),
    },
    select: { teamId: true },
  });
  const contexts = await resolveTeamActorContextsInTx(tx, {
    actorAccountId,
    teamIds: memberships.map((row) => row.teamId),
  });
  const qualifications = await qualifyTeamOperationAuthenticationsInTx(tx, {
    contexts: [...contexts.values()],
    ...authentication,
  });
  return [...contexts.values()]
    .filter(
      (context) =>
        context.teamCapabilities.viewTeam &&
        qualifications.get(context.team.id)?.ok,
    )
    .map((context) => context.team.id);
}

/** Reads every Team-audience label in the given Teams, optionally only the bindings named by a repair. */
async function readStoredTeamLabelsInTx(
  tx: Tx,
  teamIds: readonly string[],
  only?: readonly TeamLabelEnvelopeBindingV1[],
): Promise<StoredTeamLabel[]> {
  const ids = (entity: TeamLabelEnvelopeBindingV1['entity']) =>
    only
      ? {
          id: {
            in: [
              ...new Set(
                only
                  .filter((binding) => binding.entity === entity)
                  .map((binding) => binding.id),
              ),
            ],
          },
        }
      : {};
  const wants = (entity: TeamLabelEnvelopeBindingV1['entity']) =>
    !only || only.some((binding) => binding.entity === entity);
  const [groups, resources, keys, pools] = await Promise.all([
    wants('team_group')
      ? tx.teamGroup.findMany({
          where: { teamId: { in: [...teamIds] }, ...ids('team_group') },
          select: { id: true, teamId: true, name: true, description: true },
        })
      : [],
    wants('team_credential_resource')
      ? tx.teamCredentialResource.findMany({
          where: {
            teamId: { in: [...teamIds] },
            ...ids('team_credential_resource'),
          },
          select: { id: true, teamId: true, displayName: true },
        })
      : [],
    wants('team_credential_external_api_key')
      ? tx.teamCredentialExternalApiKey.findMany({
          where: {
            resource: { teamId: { in: [...teamIds] } },
            ...ids('team_credential_external_api_key'),
          },
          select: {
            id: true,
            label: true,
            resource: { select: { teamId: true } },
          },
        })
      : [],
    wants('machine_pool')
      ? tx.machinePool.findMany({
          where: { teamId: { in: [...teamIds] }, ...ids('machine_pool') },
          select: {
            id: true,
            teamId: true,
            accountId: true,
            name: true,
            description: true,
          },
        })
      : [],
  ]);
  return [
    ...groups.flatMap((row) =>
      (['name', 'description'] as const).map((field) => ({
        binding: { entity: 'team_group' as const, field, id: row.id },
        teamId: row.teamId,
        serialized: row[field],
      })),
    ),
    ...resources.map((row) => ({
      binding: {
        entity: 'team_credential_resource' as const,
        field: 'displayName' as const,
        id: row.id,
      },
      teamId: row.teamId,
      serialized: row.displayName,
    })),
    ...keys.map((row) => ({
      binding: {
        entity: 'team_credential_external_api_key' as const,
        field: 'label' as const,
        id: row.id,
      },
      teamId: row.resource.teamId,
      serialized: row.label,
    })),
    ...pools.flatMap((row) =>
      (['name', 'description'] as const).map((field) => ({
        binding: { entity: 'machine_pool' as const, field, id: row.id },
        teamId: row.teamId!,
        serialized: row[field],
        extraAudienceAccountId: row.accountId,
      })),
    ),
  ];
}

/** Discover only encrypted labels this current member can open and whose current audience needs envelopes. */
export async function readTeamLabelEnvelopeWorkInTx(
  tx: Tx,
  actorAccountId: string,
  authentication?: TeamOperationAuthenticationContext,
): Promise<TeamLabelEnvelopeWorkV1> {
  const teamIds = await eligibleTeams(tx, actorAccountId, authentication);
  if (!teamIds.length) return { teams: [] };
  const [rows, censuses] = await Promise.all([
    readStoredTeamLabelsInTx(tx, teamIds),
    readTeamRecipientEnvelopeCensusesInTx(tx, teamIds),
  ]);
  const readable = rows.flatMap((row) => {
    if (row.serialized === null) return [];
    const parsed = parsePrivateLabelStoredV1(row.serialized);
    if (parsed.kind !== 'current' || parsed.stored.content.t !== 'encrypted')
      return [];
    const label = projectPrivateLabelForRecipientV1({
      stored: parsed.stored,
      recipientAccountId: actorAccountId,
    });
    return label.recipientEnvelope
      ? [{ row, stored: parsed.stored, label }]
      : [];
  });
  const teamCensus = (teamId: string) => censuses.get(teamId) ?? [];
  const extraIds = [
    ...new Set(
      readable.flatMap(({ row }) =>
        row.extraAudienceAccountId &&
        !teamCensus(row.teamId).some(
          (recipient) =>
            recipient.account.accountId === row.extraAudienceAccountId,
        )
          ? [row.extraAudienceAccountId]
          : [],
      ),
    ),
  ];
  const extraAccounts = extraIds.length
    ? await tx.account.findMany({
        where: { id: { in: extraIds } },
        select: RESOURCE_RECIPIENT_ACCOUNT_SELECT,
      })
    : [];
  const extraById = new Map(
    projectSavedSecretRecipientEnvelopeCensusRecipientsV1({
      accounts: extraAccounts,
      envelopes: [],
    }).map((recipient) => [recipient.account.accountId, recipient]),
  );
  const byTeam = new Map<
    string,
    TeamLabelEnvelopeWorkV1['teams'][number]['labels']
  >();
  for (const { row, stored, label } of readable) {
    const extra = row.extraAudienceAccountId
      ? extraById.get(row.extraAudienceAccountId)
      : undefined;
    const recipients: Census = extra
      ? [extra, ...teamCensus(row.teamId)]
      : [...teamCensus(row.teamId)];
    const needsRepair = recipients.some(
      ({ account, readiness }) =>
        readiness.status === 'available' &&
        !stored.recipients.some(
          (existing) =>
            existing.accountId === account.accountId &&
            existing.envelope.recipientContentPublicKeyFingerprint ===
              readiness.contentPublicKeyFingerprint,
        ),
    );
    if (!needsRepair) continue;
    const labels = byTeam.get(row.teamId) ?? [];
    labels.push({ binding: row.binding, label, recipients });
    byTeam.set(row.teamId, labels);
  }
  return { teams: [...byTeam].map(([teamId, labels]) => ({ teamId, labels })) };
}

function sameBinding(
  left: TeamLabelEnvelopeBindingV1,
  right: TeamLabelEnvelopeBindingV1,
) {
  return (
    left.entity === right.entity &&
    left.field === right.field &&
    left.id === right.id
  );
}

/** Compare-and-swap so a concurrent ordinary save (already validated against the full audience) always wins. */
async function writeRepairedLabelInTx(
  tx: Tx,
  binding: TeamLabelEnvelopeBindingV1,
  prior: string,
  next: string,
) {
  switch (binding.entity) {
    case 'team_group':
      return (
        await tx.teamGroup.updateMany({
          where: { id: binding.id, [binding.field]: prior },
          data: { [binding.field]: next },
        })
      ).count;
    case 'team_credential_resource':
      return (
        await tx.teamCredentialResource.updateMany({
          where: { id: binding.id, displayName: prior },
          data: { displayName: next },
        })
      ).count;
    case 'team_credential_external_api_key':
      return (
        await tx.teamCredentialExternalApiKey.updateMany({
          where: { id: binding.id, label: prior },
          data: { label: next },
        })
      ).count;
    case 'machine_pool':
      return (
        await tx.machinePool.updateMany({
          where: { id: binding.id, [binding.field]: prior },
          data: { [binding.field]: next },
        })
      ).count;
  }
}

/**
 * A current member who already holds a label's key may distribute it to the current audience; it can
 * never change ciphertext, replace a working wrap, or seal to a departed or non-member Account.
 */
export async function repairTeamLabelEnvelopesInTx(
  tx: Tx,
  actorAccountId: string,
  input: TeamLabelEnvelopeRepairsV1,
  authentication?: TeamOperationAuthenticationContext,
): Promise<
  'ready' | 'team_forbidden' | 'invalid_team_input' | 'team_conflict'
> {
  await acquireTeamMutationAccountAdmissionInTx(tx, {
    teamId: input.teamId,
    accountIds: [actorAccountId],
  });
  await acquireTeamMutationLockInTx(tx, input.teamId);
  if (
    !(await eligibleTeams(tx, actorAccountId, authentication, [input.teamId]))
      .length
  )
    return 'team_forbidden';
  const rows = await readStoredTeamLabelsInTx(
    tx,
    [input.teamId],
    input.labels.map((item) => item.binding),
  );
  const teamAudience = await resolveSavedSecretAudienceAccountIdsInTx(tx, {
    accountIds: [],
    teamIds: [input.teamId],
    groupIds: [],
  });
  const audienceIds = [
    ...new Set([
      ...teamAudience,
      ...rows.flatMap((row) =>
        row.extraAudienceAccountId ? [row.extraAudienceAccountId] : [],
      ),
    ]),
  ];
  const accounts = await tx.account.findMany({
    where: { id: { in: audienceIds } },
    select: RESOURCE_RECIPIENT_ACCOUNT_SELECT,
  });
  const recipientsById = new Map(
    accounts.map((account) => [account.id, account]),
  );
  const writes: { row: StoredTeamLabel; prior: string; next: string }[] = [];
  for (const item of input.labels) {
    const row = rows.find((candidate) =>
      sameBinding(candidate.binding, item.binding),
    );
    if (!row?.serialized) return 'team_conflict';
    const parsed = parsePrivateLabelStoredV1(row.serialized);
    if (
      parsed.kind !== 'current' ||
      parsed.stored.content.t !== 'encrypted' ||
      item.label.content.t !== 'encrypted' ||
      parsed.stored.content.c !== item.label.content.c
    )
      return 'team_conflict';
    if (
      !parsed.stored.recipients.some(
        (recipient) => recipient.accountId === actorAccountId,
      )
    )
      return 'team_forbidden';
    const expectedRecipientAccountIds =
      row.extraAudienceAccountId &&
      !teamAudience.includes(row.extraAudienceAccountId)
        ? [row.extraAudienceAccountId, ...teamAudience]
        : teamAudience;
    const envelopes = toEnvelopeRows(item.label);
    if (
      !envelopes ||
      readRequiredResourceRecipientEnvelopeRejectionV1({
        expectedRecipientAccountIds,
        envelopes,
        recipientsById,
      })
    ) {
      return 'invalid_team_input';
    }
    // Admission established the submitted fingerprints are current; members cannot replace existing current wraps.
    const priorRecipientsById = new Map(
      parsed.stored.recipients.map((recipient) => [
        recipient.accountId,
        recipient,
      ]),
    );
    const recipients = item.label.recipients.map((recipient) => {
      const priorRecipient = priorRecipientsById.get(recipient.accountId);
      return priorRecipient?.envelope.recipientContentPublicKeyFingerprint ===
        recipient.envelope.recipientContentPublicKeyFingerprint
        ? priorRecipient
        : recipient;
    });
    writes.push({
      row,
      prior: row.serialized,
      next: serializePrivateLabelStoredV1({ ...item.label, recipients }),
    });
  }
  // No content or revision is minted by repair; a lost compare-and-swap leaves the newer save in place.
  let teamChanged = false;
  const changedPools = new Map<string, string>();
  for (const write of writes) {
    if (
      !(await writeRepairedLabelInTx(
        tx,
        write.row.binding,
        write.prior,
        write.next,
      ))
    )
      continue;
    if (write.row.binding.entity === 'machine_pool')
      changedPools.set(write.row.binding.id, write.row.extraAudienceAccountId!);
    else teamChanged = true;
  }
  if (teamChanged) await publishTeamChangedInTx(tx, { teamId: input.teamId });
  for (const [poolId, accountId] of changedPools) {
    await markAccountsChanged(tx, {
      accountIds: await readMachinePoolPublicationAudienceInTx(tx, {
        accountId,
        teamId: input.teamId,
      }),
      kind: 'machinePool',
      entityId: poolId,
    });
  }
  return 'ready';
}
