import { t } from '@/text';
import { randomUUID } from '@/platform/randomUUID';
import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { listPendingSessionRequests, type SessionPendingRequest } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resolveVoiceContextSessionFromState } from '@/voice/context/resolveVoiceContextSession';
import { getVoiceContextFormatterPrefs } from '@/voice/context/voiceContextPrefs';
import { summarizeAgentRequestForVoiceHuman } from '@/voice/context/contextFormatters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';

export type NativeVoicePermissionInput = Readonly<{
  canAccept(): boolean;
  beginTurn(): void;
  captureResponse(): ((text: string) => Promise<void>) | null;
  waitForResponseSettlement(): Promise<'approved' | 'denied' | null>;
  dispose(): void;
}>;

type NativePermissionPrompt = { address: SessionAddress; request: SessionPendingRequest; ready: boolean };

/** Input for a read-out native request; the existing permission Action owns settlement. */
export function createNativeVoicePermissionInput(params: Readonly<{
  controlSessionId: string;
  signal: AbortSignal;
  readOut: (text: string, listen: boolean, isCurrent: () => boolean, onReady: () => void) => Promise<void>;
  commitTranscript: (text: string, localId: string) => Promise<void>;
  onResponding: () => void;
  onResponseSettled: (failure: unknown | null) => Promise<void>;
}>): NativeVoicePermissionInput {
  const execute = createFrontDoorActionExecute();
  let disposed = false;
  let prompt: NativePermissionPrompt | null = null;
  let reading = false;
  let responseSettlement: Promise<'approved' | 'denied' | null> = Promise.resolve(null);
  const readAddresses = (): readonly SessionAddress[] => {
    const binding = voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: params.controlSessionId });
    if (binding?.transcriptMode !== 'native_session') return [];
    return [binding.conversationSessionAddress,
      ...(binding.targetSessionAddress && !areSessionAddressesEqual(binding.conversationSessionAddress, binding.targetSessionAddress)
        ? [binding.targetSessionAddress] : [])];
  };
  let addresses = readAddresses();
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
    const requests = addresses.flatMap(address => {
      const session = resolveVoiceContextSessionFromState(address, state);
      return session ? listPendingSessionRequests(session, readStoredSessionMessagesForAddress(state, address))
        .filter(request => request.kind === 'permission').map(request => ({ address, request })) : [];
    });
    const currentPrompt = prompt;
    if (currentPrompt && requests.some(({ address, request }) => request.id === currentPrompt.request.id
      && areSessionAddressesEqual(address, currentPrompt.address))) return;
    prompt = null;
    if (reading) return;
    const entry = requests[0];
    if (!entry) return;
    const { address, request } = entry;
    const prefs = getVoiceContextFormatterPrefs({ settings: state.settings, sessionAddress: address,
      sessionId: address.sessionId, isCurrentAttemptTarget: true });
    if (!prefs.voiceSharePermissionRequests) return;
    const selected = prompt = { address, request, ready: false };
    const summary = summarizeAgentRequestForVoiceHuman(request.kind, request.id, request.tool, request.arguments, prefs);
    const listen = prefs.voiceCanApproveRequests;
    fireAndForget(readPrompt(selected, `${summary} ${listen ? question() : t('voice.readiness.permissionTapRequired')}`, listen),
      { tag: 'voice.nativePermission.readOut' });
  };
  const subscribeRequests = () => subscribeRegisteredStorageState(observe, {
    sessions: addresses.map(address => address.sessionId),
    sessionMessages: addresses.map(address => address.sessionId),
  });
  let unsubscribeRequests = subscribeRequests();
  const unsubscribeBinding = voiceSessionBindingStore.subscribe(() => {
    const next = readAddresses();
    if (next.length === addresses.length && next.every((address, index) => areSessionAddressesEqual(address, addresses[index]))) return;
    addresses = next;
    unsubscribeRequests?.();
    unsubscribeRequests = subscribeRequests();
    observe();
  });
  const dispose = () => {
    disposed = true;
    prompt = null;
    unsubscribeRequests?.();
    unsubscribeBinding();
    params.signal.removeEventListener('abort', dispose);
  };
  params.signal.addEventListener('abort', dispose, { once: true });
  observe();
  return {
    canAccept: () => !disposed && !params.signal.aborted && prompt?.ready === true,
    beginTurn: () => { responseSettlement = Promise.resolve(null); },
    captureResponse() {
      const selected = prompt;
      if (disposed || params.signal.aborted || !selected?.ready) return null;
      selected.ready = false;
      return async (text: string): Promise<void> => {
        try {
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
          const responding = execute('session.permission.respond', {
            sessionId: selected.address.sessionId, requestId: selected.request.id,
            ...(selected.request.turnId ? { turnId: selected.request.turnId } : {}), decision,
          }, { surface: 'voice', serverId: selected.address.serverId, signal: params.signal });
          // The native turn can finish before the permission RPC acknowledges.
          // Report the Action's settled decision to the turn lifecycle owner.
          responseSettlement = responding.then(result => result.ok ? decision : null, () => null);
          requireActionSuccess(await responding);
        } catch (error) {
          if (!disposed && !params.signal.aborted) await params.onResponseSettled(error);
          return;
        }
        if (!disposed && !params.signal.aborted) await params.onResponseSettled(null);
      };
    },
    waitForResponseSettlement: () => responseSettlement,
    dispose,
  };
}
