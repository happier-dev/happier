import { t } from '@/text';
import { randomUUID } from '@/platform/randomUUID';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { listPendingSessionRequests, type SessionPendingRequest } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resolveVoiceContextSessionFromState } from '@/voice/context/resolveVoiceContextSession';
import { getVoiceContextFormatterPrefs } from '@/voice/context/voiceContextPrefs';
import { summarizeAgentRequestForVoiceHuman } from '@/voice/context/contextFormatters';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type NativeVoicePermissionInput = Readonly<{
  canAccept(): boolean;
  captureResponse(): ((text: string) => Promise<void>) | null;
  dispose(): void;
}>;

type NativePermissionPrompt = { request: SessionPendingRequest; ready: boolean };

/** Input for a read-out native request; the existing permission Action owns settlement. */
export function createNativeVoicePermissionInput(params: Readonly<{
  address: SessionAddress;
  signal: AbortSignal;
  readOut: (text: string, listen: boolean, isCurrent: () => boolean, onReady: () => void) => Promise<void>;
  commitTranscript: (text: string, localId: string) => Promise<void>;
  onResponding: () => void;
}>): NativeVoicePermissionInput {
  const execute = createFrontDoorActionExecute();
  let disposed = false;
  let prompt: NativePermissionPrompt | null = null;
  let reading = false;
  const question = () => t('voice.readiness.permissionQuestion', { approve: t('common.yes'), deny: t('common.no') });
  const readPrompt = async (selected: NativePermissionPrompt, text: string, listen: boolean): Promise<void> => {
    reading = true;
    selected.ready = false;
    try {
      await params.readOut(text, listen,
        () => !disposed && !params.signal.aborted && prompt === selected,
        () => { selected.ready = listen; });
    } finally {
      reading = false;
      if (!disposed) observe();
    }
  };
  const observe = (): void => {
    if (disposed || params.signal.aborted) return;
    const state = storage.getState();
    const session = resolveVoiceContextSessionFromState(params.address, state);
    const requests = session
      ? listPendingSessionRequests(session, readStoredSessionMessagesForAddress(state, params.address)).filter(request => request.kind === 'permission')
      : [];
    if (prompt && requests.some(request => request.id === prompt?.request.id)) return;
    prompt = null;
    if (reading) return;
    const request = requests[0];
    if (!request) return;
    const prefs = getVoiceContextFormatterPrefs({ settings: state.settings, sessionAddress: params.address,
      sessionId: params.address.sessionId, isCurrentAttemptTarget: true });
    if (!prefs.voiceSharePermissionRequests) return;
    const selected = prompt = { request, ready: false };
    const summary = summarizeAgentRequestForVoiceHuman(request.kind, request.id, request.tool, request.arguments, prefs);
    const listen = prefs.voiceCanApproveRequests;
    fireAndForget(readPrompt(selected, `${summary} ${listen ? question() : t('voice.readiness.permissionTapRequired')}`, listen),
      { tag: 'voice.nativePermission.readOut' });
  };
  const unsubscribe = subscribeRegisteredStorageState(observe, {
    sessions: [params.address.sessionId], sessionMessages: [params.address.sessionId],
  });
  observe();
  return {
    canAccept: () => !disposed && !params.signal.aborted && prompt?.ready === true,
    captureResponse() {
      const selected = prompt;
      if (disposed || params.signal.aborted || !selected?.ready) return null;
      selected.ready = false;
      return async (text: string): Promise<void> => {
        if (disposed || params.signal.aborted || prompt !== selected) return;
        if (text.trim()) await params.commitTranscript(text, randomUUID());
        if (disposed || params.signal.aborted || prompt !== selected) return;
        const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/[.!?。！？]+$/u, '').trim();
        const answer = normalize(text);
        const decision = answer === normalize(t('common.yes')) || answer === 'yes'
          ? 'approved' : answer === normalize(t('common.no')) || answer === 'no' ? 'denied' : null;
        if (!decision) {
          await readPrompt(selected, question(), true);
          return;
        }
        params.onResponding();
        const result = await execute('session.permission.respond', {
          sessionId: params.address.sessionId, requestId: selected.request.id,
          ...(selected.request.turnId ? { turnId: selected.request.turnId } : {}), decision,
        }, { surface: 'voice', serverId: params.address.serverId, signal: params.signal });
        if (!result.ok && !disposed && !params.signal.aborted) {
          await readPrompt(selected, t('voice.readiness.permissionTapRequired'), false);
        }
      };
    },
    dispose() { disposed = true; prompt = null; unsubscribe?.(); },
  };
}
