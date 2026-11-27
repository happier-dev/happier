import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { createServerHttpRequestBodyItemBudgetV1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import type { TeamCredentialDirectMaterialPreparationResponseV1, TeamCredentialDirectMaterialUpsertRequestV1, TeamCredentialSourceBindingV1, TeamCredentialSourceMemberV1 } from '@happier-dev/protocol/teams';
import type { TeamCredentialDirectMaterialUpsertResponseV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';

import type { TeamCredentialSourceSnapshot } from '@/providers/broker/teamCredentialSourceSnapshot';
import { prepareTeamCredentialDirectMaterial } from './teamCredentialDirectMaterialProducer';
import { TeamCredentialDirectMaterialHttpContractError } from './teamCredentialDirectMaterialContractError';
import { QualifiedConnectedAccountMaterialError } from '../qualifiedConnectedAccountMaterialError';

type PreparationInput = Readonly<{
  teamId: string;
  resourceId: string;
  sourceMemberKey: string;
  cursor?: string;
  signal?: AbortSignal;
}>;

type ReconcileFailure = 'source_changed' | 'source_unavailable' | 'recipient_unavailable'
  | 'upload_failed' | 'cancelled' | 'access_only_expiry_unavailable';

export type TeamCredentialDirectMaterialReconcileResult =
  | Readonly<{ ok: true; prepared: number }>
  | Readonly<{
      ok: false;
      reason: ReconcileFailure;
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
  upsert(input: TeamCredentialDirectMaterialUpsertRequestV1): Promise<TeamCredentialDirectMaterialUpsertResponseV1>;
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
      const readPage = () => input.fetchPreparation({
        teamId: input.teamId,
        resourceId: input.resourceId,
        sourceMemberKey: input.sourceMemberKey,
        cursor,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const page = await readPage();
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
      } catch (error) {
        await withdrawPublication();
        return { ok: false, reason: error instanceof QualifiedConnectedAccountMaterialError
          && error.code === 'access_only_expiry_unavailable' ? error.code : 'source_unavailable', prepared };
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
      const fail = async (reason: ReconcileFailure): Promise<TeamCredentialDirectMaterialReconcileResult> => {
        if (reason !== 'cancelled' && (
          publishedSourceVersion !== sourceSnapshot.currentness.sourceVersion
          || !await sourceSnapshot.currentness.isCurrent()
        )) await withdrawPublication();
        return { ok: false, reason, prepared };
      };
      let items: TeamCredentialDirectMaterialUpsertRequestV1['items'] = [];
      let budget = createServerHttpRequestBodyItemBudgetV1({ items });
      const preparedRecipients = new Map(page.recipients.map(recipient => [recipient.recipientAccountId, recipient]));
      const flush = async (): Promise<ReconcileFailure | null> => {
        if (!items.length) return null;
        let response: TeamCredentialDirectMaterialUpsertResponseV1;
        try {
          // Confirm the local capture, then read current Home recipient
          // bindings before any sealed bytes leave this Machine. Home owns
          // the final recipient/resource/source CAS for the whole write.
          if (!await sourceSnapshot.currentness.isCurrent()) return 'source_changed';
          const current = await readPage();
          if (current.teamId !== page.teamId || current.resourceId !== page.resourceId
            || current.homeServerIdentityId !== page.homeServerIdentityId || current.resourceRevision !== page.resourceRevision
            || computeTeamCredentialSourceMemberKeyV1(current.sourceMember) !== input.sourceMemberKey
            || current.sourceCredentialIncarnation !== page.sourceCredentialIncarnation
            || current.publishedSourceVersion !== publishedSourceVersion) return 'source_changed';
          const currentRecipients = new Map(current.recipients.map(recipient => [recipient.recipientAccountId, recipient]));
          for (const item of items) {
            const recipient = currentRecipients.get(item.recipientAccountId);
            if (!recipient || recipient.recipientMode !== item.recipientMode
              || recipient.recipientContentPublicKeyFingerprint !== item.recipientContentPublicKeyFingerprint
              || recipient.recipientContentPublicKey !== preparedRecipients.get(item.recipientAccountId)?.recipientContentPublicKey
              || recipient.expectedStoredSourceVersion !== item.expectedStoredSourceVersion) return 'source_changed';
          }
          input.signal?.throwIfAborted();
          response = await input.upsert({ items });
        } catch (error) {
          if (!input.signal?.aborted && error instanceof TeamCredentialDirectMaterialHttpContractError) throw error;
          return input.signal?.aborted ? 'cancelled' : 'source_unavailable';
        }
        if (response.results.length !== items.length) throw new TeamCredentialDirectMaterialHttpContractError();
        let reason: ReconcileFailure | null = null;
        for (const [index, result] of response.results.entries()) {
          const item = items[index]!;
          if (result.recipientAccountId !== item.recipientAccountId || result.sourceMemberKey !== item.sourceMemberKey) {
            throw new TeamCredentialDirectMaterialHttpContractError();
          }
          if (result.status === 'stored') {
            if (result.sourceVersion !== item.sourceVersion) throw new TeamCredentialDirectMaterialHttpContractError();
            publishedSourceVersion = result.sourceVersion;
            prepared++;
          } else {
            reason ??= result.reason === 'source_changed' ? 'source_changed' : 'upload_failed';
          }
        }
        items = [];
        budget = createServerHttpRequestBodyItemBudgetV1({ items });
        return reason;
      };
      for (const recipient of page.recipients) {
        // A missing/stale census, not a whole-audience repair (child 06
        // L10D-R13): a tuple the Home reports current for the version this
        // snapshot would produce is already delivered, and re-sealing it would
        // only publish a Team change that restarts this reconciliation.
        if (recipient.storedTupleCurrent && page.publishedSourceVersion === sourceSnapshot.currentness.sourceVersion) {
          continue;
        }
        const result = prepareTeamCredentialDirectMaterial({
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
          homeServerIdentityId: page.homeServerIdentityId,
          teamId: page.teamId,
          resourceId: page.resourceId,
          recipientAccountId: recipient.recipientAccountId,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!result.ok) return await fail(result.reason);
        // The preparation page already owns the item-count limit. Respect
        // the HTTP body limit as well when credentials are large.
        let item = result.item;
        if (!budget.tryAdmit(item)) {
          const reason = await flush();
          if (reason) return await fail(reason);
          item = { ...item, expectedPublishedSourceVersion: publishedSourceVersion };
          if (!budget.tryAdmit(item)) return await fail('upload_failed');
        }
        items.push(item);
      }
      const reason = await flush();
      if (reason) return await fail(reason);
      cursor = page.nextCursor ?? undefined;
    } catch (error) {
      if (!input.signal?.aborted && error instanceof TeamCredentialDirectMaterialHttpContractError) throw error;
      return input.signal?.aborted
        ? { ok: false, reason: 'cancelled', prepared }
        : { ok: false, reason: 'source_unavailable', prepared };
    }
  } while (cursor);
  return { ok: true, prepared };
}
