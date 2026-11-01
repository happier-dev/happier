import type { VoiceHistoryActionId } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import type { PublicActionInputById } from '@happier-dev/protocol/actions/actionSpecs';
import { isVoiceHistoryOperationSupersededError, VoiceHistoryOperationSupersededError, type VoiceHistoryConsumer, type VoiceHistoryExportArtifact } from './voiceHistoryConsumer';
import { VoiceConversationActionInputSchemas } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { readVoiceConversationHistory } from './voiceConversationHistory';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { fetchSessionListQueryPageForHome } from '@/sync/domains/session/listing/sessionListQueryRuntime';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

export async function executeVoiceConversationHistoryListAction(input: unknown, isCurrent: () => boolean,
  invocation?: Readonly<{ scope: ServerAccountScope; lifetime?: ServerAccountScopeLifetime; signal?: AbortSignal }>) {
  const value = VoiceConversationActionInputSchemas['ui.voice_global.conversations.list'].parse(input);
  const unavailable = (code: string) => ({ ok: false as const, errorCode: code, error: code });
  if (!isCurrent()) return unavailable('voice_action_account_changed');
  const serverId = invocation?.scope.serverId ?? getActiveServerSnapshot().serverId;
  const address = value.conversationSessionAddress;
  if (address) {
    if (!areServerProfileIdentifiersEquivalent(address.serverId, serverId)
      || !areServerProfileIdentifiersEquivalent(serverId, getActiveServerSnapshot().serverId)) return unavailable('voice_conversation_home_not_mounted');
    await sync.ensureSessionVisibleForMessageRoute(address.sessionId, { serverId: address.serverId, hydrateMessages: false });
    if (!isCurrent()) return unavailable('voice_action_account_changed');
    if (!isVoiceConversationCustodySessionMetadata(readVoiceSessionOwnerMetadataFromState(storage.getState(), address))
      || !readVoiceConversationHistory(storage.getState(), { serverId }).conversations.some(row => row.address.sessionId === address.sessionId)) {
      return unavailable('session_unavailable');
    }
    await sync.fetchPendingMessages(address.sessionId, storage.getState().profileScope ?? undefined);
    if (!isCurrent()) return unavailable('voice_action_account_changed');
    const result = readVoiceConversationHistory(storage.getState(), { serverId });
    return { ...result, conversations: result.conversations.filter(row => row.address.sessionId === address.sessionId) };
  }
  // This Action borrows the Session-list page reader, without another retained cursor or body loader.
  const abort = new AbortController();
  const retired = invocation?.lifetime?.onRetire(() => abort.abort());
  const merged = mergeAbortSignals([abort.signal, invocation?.signal]);
  const signal = merged.signal;
  try {
    const page = async (path: string, cursor: string | null | undefined) => cursor === null ? null
      : fetchSessionListQueryPageForHome(serverId, { source: { kind: 'ordinary', path,
        allowV1Fallback: path === '/v2/sessions' }, membership: 'rowOnly', cursor, signal });
    const [active, archived] = await Promise.all([
      page('/v2/sessions', value.cursor?.active), page('/v2/sessions/archived', value.cursor?.archived),
    ]);
    if (!isCurrent() || signal.aborted || active?.current === false || archived?.current === false) return unavailable('voice_action_account_changed');
    const nextCursor = active?.hasNext || archived?.hasNext ? {
      active: active?.hasNext ? active.nextCursor : null,
      archived: archived?.hasNext ? archived.nextCursor : null,
    } : null;
    return { ...readVoiceConversationHistory(storage.getState(), { serverId,
      coverageComplete: nextCursor === null && !active?.metadataUpgradeRequiredCount && !archived?.metadataUpgradeRequiredCount }), nextCursor };
  } finally {
    abort.abort();
    merged.dispose();
    retired?.dispose();
  }
}

/** Private delivery ports shared by the mounted page and the answering client's Action host. */
export type VoiceHistoryActionPorts = Readonly<{
  consumer: VoiceHistoryConsumer;
  saveExportArtifact: (artifact: VoiceHistoryExportArtifact) => Promise<void>;
}>;

type VoiceHistoryActionRequest = { [Id in VoiceHistoryActionId]: Readonly<{ actionId: Id; input: PublicActionInputById[Id] }> }[VoiceHistoryActionId];

/** Input has already passed the Protocol executor's exact Action schema. */
export async function executeVoiceHistoryAction(request: VoiceHistoryActionRequest,
  ports: VoiceHistoryActionPorts, isCurrent: () => boolean) {
  const assertCurrent = () => { if (!isCurrent()) throw new VoiceHistoryOperationSupersededError(); };
  try {
    assertCurrent();
    switch (request.actionId) {
      case 'ui.voice_global.history.search': {
        const value = request.input;
        const result = await ports.consumer.search(value.query, value.refresh);
        assertCurrent();
        return result;
      }
      case 'ui.voice_global.history.load_older': {
        const value = request.input;
        await ports.consumer.search();
        assertCurrent();
        const result = await ports.consumer.loadOlder(value.query);
        assertCurrent();
        return result;
      }
      case 'ui.voice_global.history.export': {
        const value = request.input;
        await ports.consumer.search();
        assertCurrent();
        const artifact = await ports.consumer.exportHistory(value);
        assertCurrent();
        await ports.saveExportArtifact(artifact);
        assertCurrent();
        return { fileName: artifact.fileName, mimeType: artifact.mimeType, rowCount: artifact.rowCount, range: artifact.range };
      }
      case 'ui.voice_global.history.clear': {
        const result = await ports.consumer.clear();
        assertCurrent();
        return result;
      }
    }
  } catch (error) {
    // Preserve the consumer's typed retirement reason across the Action result
    // boundary so every caller can present the existing Account recovery state.
    if (isVoiceHistoryOperationSupersededError(error)) return {
      ok: false as const,
      errorCode: 'voice_history_operation_superseded',
      error: 'voice_history_operation_superseded',
    };
    throw error;
  }
}
