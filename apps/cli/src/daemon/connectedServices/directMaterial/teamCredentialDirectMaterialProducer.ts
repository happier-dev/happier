import { randomBytes } from 'node:crypto';
import { computeTeamCredentialSourceMemberKeyV1, createTeamCredentialDirectMaterialStoredV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import type { TeamCredentialDirectMaterialPayloadV1, TeamCredentialDirectMaterialUpsertRequestV1, TeamCredentialSourceMemberV1 } from '@happier-dev/protocol/teams';
import type { TeamCredentialSourceSnapshot } from '@/providers/broker/teamCredentialSourceSnapshot';

type RecipientMode = 'plain' | 'e2ee';

type DirectMaterialPreparation = Readonly<{
  sourceMember: TeamCredentialSourceMemberV1;
  /** Last Home-published opaque source version used by the resource CAS. */
  publishedSourceVersion: string | null;
  expectedResourceRevision: number;
  expectedStoredSourceVersion: string | null;
  recipientMode: RecipientMode;
  recipientContentPublicKeyFingerprint: string | null;
  recipientContentPublicKey?: Uint8Array;
}>;

export type TeamCredentialDirectMaterialProducerInput = Readonly<{
  /**
   * Captured by the existing source owner. The producer deliberately cannot
   * derive a credential/configuration version itself: doing so would make this
   * transport adapter a second currentness authority and would exclude Pool
   * and Provider source adapters.
   */
  sourceSnapshot: TeamCredentialSourceSnapshot;
  expected: DirectMaterialPreparation;
  homeServerIdentityId: string;
  teamId: string;
  resourceId: string;
  recipientAccountId: string;
  randomBytes?: (length: number) => Uint8Array;
  signal?: AbortSignal;
}>;

type DirectMaterialItem = TeamCredentialDirectMaterialUpsertRequestV1['items'][number];

export type TeamCredentialDirectMaterialProducerResult =
  | Readonly<{ ok: true; item: DirectMaterialItem }>
  | Readonly<{
      ok: false;
      reason: 'source_changed' | 'recipient_unavailable' | 'cancelled';
    }>;

/** Seals one recipient's material with the Home-provided write preconditions. */
export function prepareTeamCredentialDirectMaterial(
  input: TeamCredentialDirectMaterialProducerInput,
): TeamCredentialDirectMaterialProducerResult {
  if (input.signal?.aborted) return { ok: false, reason: 'cancelled' };
  const expected = input.expected;
  const snapshot = input.sourceSnapshot;
  if (
    computeTeamCredentialSourceMemberKeyV1(snapshot.currentness.sourceMember)
      !== computeTeamCredentialSourceMemberKeyV1(expected.sourceMember)
  ) {
    return { ok: false, reason: 'source_changed' };
  }
  const sourceVersion = snapshot.currentness.sourceVersion;
  const payload: TeamCredentialDirectMaterialPayloadV1 = {
    v: 1,
    domain: 'happier.team-credential-direct-material',
    homeServerIdentityId: input.homeServerIdentityId,
    teamId: input.teamId,
    resourceId: input.resourceId,
    resourceRevision: expected.expectedResourceRevision,
    recipientAccountId: input.recipientAccountId,
    sourceMember: expected.sourceMember,
    sourceVersion,
    material: snapshot.material,
  };
  let stored;
  try {
    stored = createTeamCredentialDirectMaterialStoredV1({
      payload,
      recipientMode: expected.recipientMode,
      ...(expected.recipientContentPublicKey ? { recipientContentPublicKey: expected.recipientContentPublicKey } : {}),
      randomBytes: input.randomBytes ?? randomBytes,
    });
  } catch {
    return { ok: false, reason: 'recipient_unavailable' };
  }
  return { ok: true, item: {
    recipientAccountId: input.recipientAccountId,
    sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(expected.sourceMember),
    sourceVersion,
    recipientMode: expected.recipientMode,
    recipientContentPublicKeyFingerprint: expected.recipientContentPublicKeyFingerprint,
    stored,
    expectedResourceRevision: expected.expectedResourceRevision,
    expectedStoredSourceVersion: expected.expectedStoredSourceVersion,
    expectedPublishedSourceVersion: expected.publishedSourceVersion,
  } };
}
