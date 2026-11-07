import { randomUUID } from '@/platform/randomUUID';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { SessionPendingEditResultV1 } from '@happier-dev/protocol/actions/actionSpecs';
import type { SessionPendingMessageComposerAdmissionPrepareResponseV1 } from '@happier-dev/protocol/sessions/userMessageRpc';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { acceptPendingMessageComposerAdmission, abandonPendingMessageComposerAdmission, preparePendingMessageComposerAdmission } from '@/sync/ops/pendingMessageComposerAdmission';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

/** All ingress shares the existing prepare, Pending content writer and custody settlement owners. */
export function createUiPendingEditAction(account: LazyActionAccountContext, editorCurrent?: () => boolean): NonNullable<ActionExecutorDeps['sessionPendingEdit']> {
  return async ({ input, context }) => withActionAccountRequestSignal(account, context.signal, async signal => {
    const sourceComposerRef = { kind: 'pendingMessage', sessionId: input.sessionId, localId: input.localId } as const;
    const current = () => !signal?.aborted && account.accountLifetime.isCurrent() && editorCurrent?.() !== false;
    const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    account.assertCurrent();
    if (!current()) return failure('pending_message_edit_stale');
    const state = storage.getState();
    const session = state.sessions[input.sessionId];
    // Focus is not mutation authority: the existing writer fences the exact
    // Pending projection against this captured Account, including another Home.
    if (!session || session.serverId !== account.serverId) return failure('pending_message_not_loaded');
    const replacementLocalId = input.replacementLocalId
      // Mounted Composer already owns retry-stable rotation; semantic callers have no prepared candidate.
      ?? (!editorCurrent && (input.structuredInput.composerAttachments?.length ?? 0) > 0 ? randomUUID() : undefined);
    const localId = replacementLocalId ?? input.localId;
    const options = { serverId: account.serverId, accountLifetime: account.accountLifetime };
    let prepared: Extract<SessionPendingMessageComposerAdmissionPrepareResponseV1, { ok: true }> | undefined;
    let accepted = false;
    let abandoned = false;
    const abandon = async () => {
      if (abandoned || !prepared?.sessionMediaCleanup || !account.accountLifetime.isCurrent()) return;
      await abandonPendingMessageComposerAdmission(input.sessionId, {
        sessionId: input.sessionId, localId, structuredInput: prepared.structuredInput,
        stagedMediaHandles: prepared.stagedMediaHandles,
        ...(prepared.stagedMediaReleaseIntents ? { stagedMediaReleaseIntents: prepared.stagedMediaReleaseIntents } : {}),
        sessionMediaCleanup: prepared.sessionMediaCleanup,
      }, options);
      abandoned = true;
    };
    try {
      const preparation = await preparePendingMessageComposerAdmission(input.sessionId, {
        localId, text: input.text, structuredInput: input.structuredInput, sourceComposerRef,
      }, { ...options, signal });
      if (!preparation.ok) return failure(preparation.errorCode);
      prepared = preparation;
      if (!current()) { await abandon(); return failure('pending_message_edit_stale'); }
      const admission = await sync.updatePendingMessage(input.sessionId, input.localId, prepared.text, prepared.structuredInput, {
        ...options, session,
        ...(replacementLocalId ? { replacementLocalId } : {}),
        preparedComposerAdmission: prepared,
      });
      if (!admission) throw new Error('Pending Composer PATCH accepted without its canonical admission fact');
      accepted = true;
      let settlement: SessionPendingEditResultV1['settlement'] = 'complete';
      try {
        // A durable PATCH stays accepted when its presentation or Account retires.
        if (account.accountLifetime.isCurrent()) await acceptPendingMessageComposerAdmission(input.sessionId, admission, options);
      } catch { settlement = 'failed'; }
      return { status: 'accepted', localId: admission.localId, structuredInput: admission.structuredInput, settlement } satisfies SessionPendingEditResultV1;
    } catch (error) {
      if (!accepted) await abandon().catch(() => undefined);
      throw error;
    }
  });
}
