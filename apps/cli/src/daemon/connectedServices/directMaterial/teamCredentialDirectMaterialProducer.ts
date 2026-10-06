import { computeTeamCredentialSourceMemberKeyV1, createTeamCredentialDirectMaterialStoredV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import type { TeamCredentialDirectMaterialPayloadV1, TeamCredentialDirectMaterialStoredV1, TeamCredentialSourceMemberV1 } from '@happier-dev/protocol/teams';
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
  readCurrentPreparation(): Promise<DirectMaterialPreparation>;
  homeServerIdentityId: string;
  teamId: string;
  resourceId: string;
  recipientAccountId: string;
  randomBytes?: (length: number) => Uint8Array;
  upsert(input: Readonly<{
    resourceId: string;
    recipientAccountId: string;
    sourceMemberKey: string;
    sourceVersion: string;
    recipientMode: RecipientMode;
    recipientContentPublicKeyFingerprint: string | null;
    stored: TeamCredentialDirectMaterialStoredV1;
    expectedResourceRevision: number;
    expectedStoredSourceVersion: string | null;
    expectedPublishedSourceVersion: string | null;
  }>): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>>;
  signal?: AbortSignal;
}>;

export type TeamCredentialDirectMaterialProducerResult =
  | Readonly<{ ok: true; sourceVersion: string }>
  | Readonly<{
      ok: false;
      reason: 'source_changed' | 'source_unavailable' | 'recipient_unavailable' | 'upload_failed' | 'cancelled';
    }>;

function samePreparation(left: DirectMaterialPreparation, right: DirectMaterialPreparation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Produces one revision-fenced direct-material projection. */
export async function produceTeamCredentialDirectMaterial(
  input: TeamCredentialDirectMaterialProducerInput,
): Promise<TeamCredentialDirectMaterialProducerResult> {
  try {
    input.signal?.throwIfAborted();
    const expected = input.expected;
    if (!samePreparation(await input.readCurrentPreparation(), expected)) {
      return { ok: false, reason: 'source_changed' };
    }
    const snapshot = input.sourceSnapshot;
    input.signal?.throwIfAborted();
    if (
      computeTeamCredentialSourceMemberKeyV1(snapshot.currentness.sourceMember)
        !== computeTeamCredentialSourceMemberKeyV1(expected.sourceMember)
    ) {
      return { ok: false, reason: 'source_changed' };
    }
    const sourceVersion = snapshot.currentness.sourceVersion;
    if (!(await snapshot.currentness.isCurrent())) return { ok: false, reason: 'source_changed' };
    if (!samePreparation(await input.readCurrentPreparation(), expected)) {
      return { ok: false, reason: 'source_changed' };
    }
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
        ...(input.randomBytes ? { randomBytes: input.randomBytes } : {}),
      });
    } catch {
      return { ok: false, reason: 'recipient_unavailable' };
    }
    input.signal?.throwIfAborted();
    const result = await input.upsert({
      resourceId: input.resourceId,
      recipientAccountId: input.recipientAccountId,
      sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(expected.sourceMember),
      sourceVersion,
      recipientMode: expected.recipientMode,
      recipientContentPublicKeyFingerprint: expected.recipientContentPublicKeyFingerprint,
      stored,
      expectedResourceRevision: expected.expectedResourceRevision,
      expectedStoredSourceVersion: expected.expectedStoredSourceVersion,
      expectedPublishedSourceVersion: expected.publishedSourceVersion,
    });
    if (!result.ok) {
      return { ok: false, reason: result.reason === 'source_changed' ? 'source_changed' : 'upload_failed' };
    }
    return { ok: true, sourceVersion };
  } catch {
    return input.signal?.aborted
      ? { ok: false, reason: 'cancelled' }
      : { ok: false, reason: 'source_unavailable' };
  }
}
