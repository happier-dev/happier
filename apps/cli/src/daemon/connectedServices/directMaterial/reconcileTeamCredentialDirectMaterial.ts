import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import type { TeamCredentialDirectMaterialPreparationResponseV1, TeamCredentialDirectMaterialUpsertRequestV1, TeamCredentialSourceBindingV1, TeamCredentialSourceMemberV1 } from '@happier-dev/protocol/teams';

import type { TeamCredentialSourceSnapshot } from '@/providers/broker/teamCredentialSourceSnapshot';
import { produceTeamCredentialDirectMaterial } from './teamCredentialDirectMaterialProducer';

type PreparationInput = Readonly<{
  teamId: string;
  resourceId: string;
  sourceMemberKey: string;
  cursor?: string;
  signal?: AbortSignal;
}>;

export type TeamCredentialDirectMaterialReconcileResult =
  | Readonly<{ ok: true; prepared: number }>
  | Readonly<{
      ok: false;
      reason: 'source_changed' | 'source_unavailable' | 'recipient_unavailable' | 'upload_failed' | 'cancelled';
      prepared: number;
    }>;

/**
 * Reconstructs the derived recipient projection from the Home's current
 * census. The Home owns audience/key/resource admission; the source adapter
 * owns plaintext and sourceVersion. This orchestration owns neither decision.
 */
export async function reconcileTeamCredentialDirectMaterial(input: Readonly<{
  teamId: string;
  resourceId: string;
  sourceMemberKey: string;
  fetchPreparation(input: PreparationInput): Promise<TeamCredentialDirectMaterialPreparationResponseV1>;
  resolveSourceSnapshot(input: Readonly<{
    source: TeamCredentialSourceBindingV1;
    sourceMember: TeamCredentialSourceMemberV1;
    sourceCredentialIncarnation: string | null;
    signal?: AbortSignal;
  }>): Promise<TeamCredentialSourceSnapshot | null>;
  upsert(input: TeamCredentialDirectMaterialUpsertRequestV1['items'][number]): Promise<
    Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>
  >;
  withdrawPublication(input: Readonly<{
    sourceMemberKey: string;
    expectedResourceRevision: number;
    expectedPublishedSourceVersion: string;
  }>): Promise<Readonly<{ ok: boolean }>>;
  signal?: AbortSignal;
}>): Promise<TeamCredentialDirectMaterialReconcileResult> {
  let cursor: string | undefined;
  let prepared = 0;
  do {
    try {
      input.signal?.throwIfAborted();
      const page = await input.fetchPreparation({
        teamId: input.teamId,
        resourceId: input.resourceId,
        sourceMemberKey: input.sourceMemberKey,
        cursor,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (
        page.teamId !== input.teamId
        || page.resourceId !== input.resourceId
        || computeTeamCredentialSourceMemberKeyV1(page.sourceMember) !== input.sourceMemberKey
      ) {
        return { ok: false, reason: 'source_changed', prepared };
      }
      let publishedSourceVersion = page.publishedSourceVersion;
      const withdrawPublication = async () => {
        input.signal?.throwIfAborted();
        if (publishedSourceVersion === null) return;
        await input.withdrawPublication({
          sourceMemberKey: input.sourceMemberKey,
          expectedResourceRevision: page.resourceRevision,
          expectedPublishedSourceVersion: publishedSourceVersion,
        });
      };
      let sourceSnapshot: TeamCredentialSourceSnapshot | null;
      try {
        sourceSnapshot = await input.resolveSourceSnapshot({
          source: page.source,
          sourceMember: page.sourceMember,
          sourceCredentialIncarnation: page.sourceCredentialIncarnation,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch {
        await withdrawPublication();
        return { ok: false, reason: 'source_unavailable', prepared };
      }
      if (!sourceSnapshot) {
        await withdrawPublication();
        return { ok: false, reason: 'source_unavailable', prepared };
      }
      if (computeTeamCredentialSourceMemberKeyV1(sourceSnapshot.currentness.sourceMember) !== input.sourceMemberKey) {
        return { ok: false, reason: 'source_changed', prepared };
      }
      if (!await sourceSnapshot.currentness.isCurrent()) {
        await withdrawPublication();
        return { ok: false, reason: 'source_changed', prepared };
      }
      // The Home advances the resource's published source version on the first
      // tuple this run stores, so the remaining recipients of the page are
      // fenced against the version this run published rather than the one the
      // page was captured at. Every other precondition stays exact.
      for (const recipient of page.recipients) {
        // A missing/stale census, not a whole-audience repair (child 06
        // L10D-R13): a tuple the Home reports current for the version this
        // snapshot would produce is already delivered, and re-sealing it would
        // only publish a Team change that restarts this reconciliation.
        if (recipient.storedTupleCurrent && page.publishedSourceVersion === sourceSnapshot.currentness.sourceVersion) {
          continue;
        }
        const result = await produceTeamCredentialDirectMaterial({
          sourceSnapshot,
          expected: {
            sourceMember: page.sourceMember,
            publishedSourceVersion,
            expectedResourceRevision: page.resourceRevision,
            expectedStoredSourceVersion: recipient.expectedStoredSourceVersion,
            recipientMode: recipient.recipientMode,
            recipientContentPublicKeyFingerprint: recipient.recipientContentPublicKeyFingerprint,
            ...(recipient.recipientContentPublicKey
              ? { recipientContentPublicKey: Buffer.from(recipient.recipientContentPublicKey, 'base64') }
              : {}),
          },
          readCurrentPreparation: async () => {
            const current = await input.fetchPreparation({
              teamId: input.teamId,
              resourceId: input.resourceId,
              sourceMemberKey: input.sourceMemberKey,
              cursor,
              ...(input.signal ? { signal: input.signal } : {}),
            });
            const currentRecipient = current.recipients.find((candidate) => (
              candidate.recipientAccountId === recipient.recipientAccountId
            ));
            return {
              sourceMember: current.sourceMember,
              publishedSourceVersion: current.publishedSourceVersion,
              expectedResourceRevision: current.resourceRevision,
              expectedStoredSourceVersion: currentRecipient?.expectedStoredSourceVersion ?? null,
              recipientMode: currentRecipient?.recipientMode ?? recipient.recipientMode,
              recipientContentPublicKeyFingerprint:
                currentRecipient?.recipientContentPublicKeyFingerprint ?? null,
              ...(currentRecipient?.recipientContentPublicKey
                ? { recipientContentPublicKey: Buffer.from(currentRecipient.recipientContentPublicKey, 'base64') }
                : {}),
            };
          },
          homeServerIdentityId: page.homeServerIdentityId,
          teamId: page.teamId,
          resourceId: page.resourceId,
          recipientAccountId: recipient.recipientAccountId,
          upsert: input.upsert,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!result.ok) {
          if (result.reason !== 'cancelled' && (
            publishedSourceVersion !== sourceSnapshot.currentness.sourceVersion
            || !await sourceSnapshot.currentness.isCurrent()
          )) await withdrawPublication();
          return { ...result, prepared };
        }
        publishedSourceVersion = result.sourceVersion;
        prepared += 1;
      }
      cursor = page.nextCursor ?? undefined;
    } catch {
      return input.signal?.aborted
        ? { ok: false, reason: 'cancelled', prepared }
        : { ok: false, reason: 'source_unavailable', prepared };
    }
  } while (cursor);
  return { ok: true, prepared };
}
