import { t } from '@/text';
import { randomUUID } from '@/platform/randomUUID';
import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { listPendingSessionRequests, type SessionPendingRequest } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resolveSessionPermissionChoices, selectSessionPermissionChoiceForDecision } from '@/sync/ops/sessionPermissionChoices';
import { resolveVoiceContextSessionFromState } from '@/voice/context/resolveVoiceContextSession';
import { getVoiceContextFormatterPrefs } from '@/voice/context/voiceContextPrefs';
import { summarizeAgentRequestForVoiceHuman } from '@/voice/context/contextFormatters';
import { resolveVoiceSessionLabel } from '@/voice/context/resolveVoiceSessionLabel';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';

export type NativeVoicePermissionInput = Readonly<{
  canAccept(): boolean;
  beginTurn(): void;
  waitForPendingReadout(): Promise<boolean>;
  resumeReadout(): Promise<boolean>;
  captureResponse(): ((text: string) => Promise<void>) | null;
  waitForResponseSettlement(): Promise<'approved' | 'denied' | null>;
  dispose(): void;
}>;

type NativePermissionPrompt = { address: SessionAddress; request: SessionPendingRequest; ready: boolean; needsReadout: boolean };

function resolveSpokenPermissionDecision(text: string): 'approved' | 'denied' | null {
  const normalize = (value: string) => value.trim().toLocaleLowerCase()
    .replace(/[’‘]/gu, "'").replace(/[,.!?。！？]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const answer = normalize(text);
  if (answer === normalize(t('common.yes')) || /^(?:(?:yes|yeah|yep|okay|ok)(?: please)?(?: (?:allow|approve)(?: it| that)?| go ahead| do it)?|(?:please )?(?:allow|approve)(?: it| that)?|(?:please )?(?:go ahead|do it))(?: please)?$/u.test(answer)) return 'approved';
  if (answer === normalize(t('common.no')) || /^(?:(?:no|nope)(?: thanks| thank you)?(?: (?:deny|decline|reject)(?: it| that)?| (?:don't|do not)(?: (?:allow|approve|do)(?: it| that)?)?)?|(?:please )?(?:deny|decline|reject)(?: it| that)?|(?:please )?(?:don't|do not)(?: (?:allow|approve|do)(?: it| that)?)?)(?: please)?$/u.test(answer)) return 'denied';
  return null;
}

/** Input for a read-out native request; the existing permission Action owns settlement. */
export function createNativeVoicePermissionInput(params: Readonly<{
  controlSessionId: string;
  signal: AbortSignal;
  readOut: (text: string, listen: boolean, isCurrent: () => boolean, onReady: () => void) => Promise<void>;
  commitTranscript: (text: string, localId: string) => Promise<void>;
  onResponding: () => void;
  onResponseSettled: (result: Readonly<{ ok: true; decision: 'approved' | 'denied' }> | Readonly<{ ok: false; error: unknown }>) => Promise<void>;
}>): NativeVoicePermissionInput {
  const execute = createFrontDoorActionExecute();
  let disposed = false;
  let prompt: NativePermissionPrompt | null = null;
  let reading: Promise<void> | null = null;
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
  const readPrompt = (selected: NativePermissionPrompt, text: string, listen: boolean): Promise<void> => {
    selected.ready = false;
    selected.needsReadout = true;
    const presentation = params.readOut(text, listen,
      () => !disposed && !params.signal.aborted && prompt === selected,
      () => { selected.ready = listen; selected.needsReadout = false; }).finally(() => {
      if (reading === presentation) reading = null;
      if (!disposed) observe();
    });
    reading = presentation;
    return presentation;
  };
  const presentPrompt = async (selected: NativePermissionPrompt): Promise<void> => {
    const prefs = getVoiceContextFormatterPrefs({ settings: storage.getState().settings, sessionAddress: selected.address,
      sessionId: selected.address.sessionId, isCurrentAttemptTarget: true });
    const request = selected.request;
    const summary = summarizeAgentRequestForVoiceHuman(request.kind, request.id, request.tool, request.arguments, prefs,
      resolveVoiceSessionLabel(selected.address, prefs, { fallbackLabel: t('voice.readiness.requestingSession') }));
    await readPrompt(selected, `${summary} ${prefs.voiceCanApproveRequests ? question() : t('voice.readiness.permissionTapRequired')}`,
      true);
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
    const selected = prompt = { address, request, ready: false, needsReadout: true };
    fireAndForget(presentPrompt(selected),
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
    async waitForPendingReadout() {
      if (disposed || params.signal.aborted || !prompt) return false;
      // The request itself is the spoken acknowledgement. Keep its original
      // synthesis/playback and listening rearm ahead of the model's final reply.
      await reading;
      return true;
    },
    async resumeReadout() {
      if (disposed || params.signal.aborted) return false;
      if (reading) {
        await reading;
        return true;
      }
      if (!prompt?.needsReadout) return false;
      const prefs = getVoiceContextFormatterPrefs({ settings: storage.getState().settings, sessionAddress: prompt.address,
        sessionId: prompt.address.sessionId, isCurrentAttemptTarget: true });
      if (!prefs.voiceSharePermissionRequests) return false;
      // A genuine playback interruption can still leave the request unheard.
      // Re-present it at the turn's existing settlement.
      await presentPrompt(prompt);
      return true;
    },
    captureResponse() {
      const selected = prompt;
      if (disposed || params.signal.aborted || !selected?.ready) return null;
      selected.ready = false;
      return async (text: string): Promise<void> => {
        const decision = resolveSpokenPermissionDecision(text);
        try {
          if (disposed || params.signal.aborted || prompt !== selected) return;
          if (text.trim()) await params.commitTranscript(text, randomUUID());
          if (disposed || params.signal.aborted || prompt !== selected) return;
          const prefs = getVoiceContextFormatterPrefs({ settings: storage.getState().settings,
            sessionAddress: selected.address, sessionId: selected.address.sessionId, isCurrentAttemptTarget: true });
          if (!prefs.voiceCanApproveRequests || !decision) {
            await readPrompt(selected,
              prefs.voiceCanApproveRequests ? question() : t('voice.readiness.permissionTapRequired'), true);
            return;
          }
          const request = selected.request;
          const response = request.nativeChoices === undefined ? { decision }
            : selectSessionPermissionChoiceForDecision(resolveSessionPermissionChoices({
              toolName: request.tool, toolInput: request.arguments, nativeChoices: request.nativeChoices,
              nativeChoiceAvailability: request.nativeChoiceAvailability,
            }), decision)?.response;
          if (!response) {
            await readPrompt(selected, t('voice.readiness.permissionTapRequired'), true);
            return;
          }
          params.onResponding();
          const responding = execute('session.permission.respond', {
            sessionId: selected.address.sessionId, requestId: selected.request.id,
            ...(selected.request.turnId ? { turnId: selected.request.turnId } : {}), ...response,
          }, { surface: 'voice', serverId: selected.address.serverId, signal: params.signal });
          // The native turn can finish before the permission RPC acknowledges.
          // Report the Action's settled decision to the turn lifecycle owner.
          responseSettlement = responding.then(result => result.ok ? decision : null, () => null);
          requireActionSuccess(await responding);
        } catch (error) {
          if (!disposed && !params.signal.aborted) await params.onResponseSettled({ ok: false, error });
          return;
        }
        if (!disposed && !params.signal.aborted && decision) await params.onResponseSettled({ ok: true, decision });
      };
    },
    waitForResponseSettlement: () => responseSettlement,
    dispose,
  };
}
