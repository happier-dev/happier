import type {
  TeamLabelEnvelopeBindingV1,
  TeamLabelEnvelopeRepairsV1,
  TeamLabelEnvelopeWorkV1,
} from '@happier-dev/protocol/teams';
import {
  parsePrivateLabelStoredV1,
  PrivateLabelReadV1Schema,
  type PrivateLabelStoredV1,
  serializePrivateLabelStoredV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import {
  RESOURCE_RECIPIENT_ACCOUNT_SELECT,
  projectStoredResourceRecipientEnvelopeCensusV1,
  readRequiredResourceRecipientEnvelopeRejectionV1,
  resolveSavedSecretAudienceAccountIdsInTx,
  readTeamResourceRecipientAccountsInTx,
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

/** Writers admit and serialize the full roster. Read only the member's envelope and current fingerprints. */
function projectOwedTeamLabel(
  serialized: string | null,
  actorAccountId: string,
  ready: ReadonlyMap<string, string>,
  extraAccountId: string | undefined,
  extraFingerprint: string | undefined,
) {
  const expected = ready.size + Number(extraFingerprint !== undefined);
  if (!expected || !serialized?.startsWith('{')) return null;
  let stored: PrivateLabelStoredV1 | null;
  try {
    stored = JSON.parse(serialized) as PrivateLabelStoredV1 | null;
  } catch {
    return null;
  }
  if (stored?.content?.t !== 'encrypted' || !Array.isArray(stored.recipients)) return null;
  let actorEnvelope: PrivateLabelStoredV1['recipients'][number]['envelope'] | undefined;
  let prepared = 0;
  for (const recipient of stored.recipients) {
    if (!recipient?.envelope) continue;
    const { accountId, envelope } = recipient;
    if (accountId === actorAccountId) actorEnvelope = envelope;
    const fingerprint = accountId === extraAccountId ? extraFingerprint : ready.get(accountId);
    if (fingerprint !== undefined && envelope.recipientContentPublicKeyFingerprint === fingerprint) prepared++;
  }
  if (!actorEnvelope || prepared >= expected) return null;
  const projected = PrivateLabelReadV1Schema.safeParse({
    content: { t: 'encrypted', c: stored.content.c },
    recipientEnvelope: {
      encryptedDataKey: actorEnvelope.encryptedDataKey,
      recipientContentPublicKeyFingerprint: actorEnvelope.recipientContentPublicKeyFingerprint,
    },
  });
  return projected.success ? { label: projected.data, storedRecipients: stored.recipients } : null;
}

/** Discover only encrypted labels this current member can open and whose current audience needs envelopes. */
export async function readTeamLabelEnvelopeWorkInTx(
  tx: Tx,
  actorAccountId: string,
  authentication?: TeamOperationAuthenticationContext,
): Promise<TeamLabelEnvelopeWorkV1> {
  const teamIds = await eligibleTeams(tx, actorAccountId, authentication);
  if (!teamIds.length) return { teams: [] };
  const rows = await readStoredTeamLabelsInTx(tx, teamIds);
  if (rows.every(row => row.serialized === null)) return { teams: [] };
  const { memberIdsByTeam, accountsById } = await readTeamResourceRecipientAccountsInTx(
    tx, teamIds, rows.flatMap(row => row.extraAudienceAccountId ?? []),
  );
  // Unverified fingerprints can exclude a prepared row from repair. Only
  // verified Account bindings can become recipients in a response.
  const candidates = new Map([...accountsById].flatMap(([id, account]) =>
    account.encryptionMode === 'e2ee' && account.contentPublicKey !== null && account.contentPublicKeySig !== null
      ? [[id, computeContentPublicKeyFingerprint(account.contentPublicKey)] as const] : [],
  ));
  const readyByTeam = new Map([...memberIdsByTeam].map(([teamId, ids]) => [
    teamId, new Map(ids.flatMap(id => {
      const fingerprint = candidates.get(id);
      return fingerprint === undefined ? [] : [[id, fingerprint] as const];
    })),
  ]));
  const memberSetsByTeam = new Map([...memberIdsByTeam].map(([teamId, ids]) => [teamId, new Set(ids)]));
  const projected = new Map<string, Census[number]>();
  const projectRecipient = (id: string) => {
    const existing = projected.get(id);
    if (existing) return existing;
    const account = accountsById.get(id);
    if (!account) return undefined;
    const recipient = projectStoredResourceRecipientEnvelopeCensusV1(account, null);
    projected.set(id, recipient);
    return recipient;
  };

  const byTeam = new Map<string, TeamLabelEnvelopeWorkV1['teams'][number]['labels']>();
  for (const row of rows) {
    const ready = readyByTeam.get(row.teamId);
    const members = memberIdsByTeam.get(row.teamId);
    if (!ready || !members) continue;
    const extraId = row.extraAudienceAccountId && !memberSetsByTeam.get(row.teamId)?.has(row.extraAudienceAccountId)
      ? row.extraAudienceAccountId : undefined;
    const extraFingerprint = extraId === undefined ? undefined : candidates.get(extraId);
    const work = projectOwedTeamLabel(row.serialized, actorAccountId, ready, extraId, extraFingerprint);
    if (!work) continue;
    const storedFingerprints = new Map(work.storedRecipients.flatMap(recipient => recipient?.envelope
      ? [[recipient.accountId, recipient.envelope.recipientContentPublicKeyFingerprint] as const] : []));
    const ids = extraId === undefined ? members : [extraId, ...members];
    const owed = ids.some(id => {
      const candidate = candidates.get(id);
      return candidate !== undefined && candidate !== storedFingerprints.get(id)
        && projectRecipient(id)?.readiness.status === 'available';
    });
    if (!owed) continue;
    const recipients: Census = ids.flatMap(id => projectRecipient(id) ?? []);
    const labels = byTeam.get(row.teamId) ?? [];
    labels.push({ binding: row.binding, label: work.label, recipients });
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
