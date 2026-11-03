import { localVoiceRuntimeController } from '@/voice/local/localVoiceRuntimeController';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import {
  getVoiceConversationRuntimeSnapshot,
  useVoiceConversationRuntimeStore,
} from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import type {
  VoiceAdapterController,
  VoiceAdapterContextChannel,
  VoiceAdapterId,
  VoiceAdapterSurfaceCapabilities,
  VoiceAdapterTranscriptMode,
  VoiceSessionSnapshot,
} from '@/voice/session/types';

/**
 * Capability flags that distinguish the two public local adapters. Both share
 * the same lifecycle (toggle/stop/interrupt/mute/snapshot via the local runtime
 * controller); they differ only by which optional capabilities they expose.
 */
export type LocalVoiceAdapterCapabilities = Readonly<{
  /** Forward agent context updates into the local agent buffer (off = no-op). */
  contextUpdates: boolean;
  /** Expose the typed text-turn entrypoint (off = omitted from the controller). */
  textTurns: boolean;
  /**
   * Provider-owned transcript-mode decision for binding resolution. When
   * omitted, the adapter exposes no hidden voice conversation session
   * (e.g. `local_direct`).
   */
  resolveBindingTranscriptMode?: (settings: unknown) => VoiceAdapterTranscriptMode | null;
  resolveSurfaceCapabilities?: (voiceSettings: unknown) => VoiceAdapterSurfaceCapabilities | null;
  resolveContextChannel?: (voiceSettings: unknown) => VoiceAdapterContextChannel | null;
  /** Provider-owned local context port, carried only into this adapter's attempts. */
  currentUiContext?: VoiceCurrentUiToolPort;
}>;

/**
 * Single internal factory backing both public local voice adapters
 * (`local_direct` and `local_conversation`). `local_direct` is a strict subset
 * of `local_conversation`, expressed purely through capability flags — there is
 * no behavioral fork between the two beyond the flagged capabilities. The two
 * public provider ids are preserved (no settings migration).
 */
export function createLocalVoiceAdapter(
  id: VoiceAdapterId,
  capabilities: LocalVoiceAdapterCapabilities,
): VoiceAdapterController {
  const getSnapshot = (): VoiceSessionSnapshot =>
    deriveLocalVoiceSessionSnapshot(id, 'local', getVoiceConversationRuntimeSnapshot());

  const start = async (opts: Parameters<VoiceAdapterController['start']>[0]) => {
    void opts.initialContext;
    await localVoiceRuntimeController.toggleTurn(
      opts.sessionId,
      capabilities.currentUiContext,
      opts.requestedTargetSessionAddress,
      opts.conversationSelection,
      opts.onConversationSelection,
    );
  };

  // Retained only for the adapter's legacy direct-control seam. Product Start
  // enters through `start`, where the qualified target is required.
  const toggle = async (opts: Readonly<{ sessionId: string }>) => {
    await localVoiceRuntimeController.toggleTurn(opts.sessionId, capabilities.currentUiContext);
  };

  const stop = async (opts: Parameters<VoiceAdapterController['stop']>[0]) => {
    await localVoiceRuntimeController.stopSession(opts.reason, opts.signal);
  };

  const interrupt = async (opts: Readonly<{ sessionId: string }>) => {
    await localVoiceRuntimeController.abortTurn(opts.sessionId);
  };

  const bargeIn = async (opts: Readonly<{ sessionId: string }>) => {
    await localVoiceRuntimeController.toggleTurn(opts.sessionId, capabilities.currentUiContext);
  };

  const setMuted = async (opts: Readonly<{ sessionId: string; muted: boolean }>) => {
    await localVoiceRuntimeController.setMuted(opts.sessionId, opts.muted);
  };

  const sendContextUpdate = capabilities.contextUpdates
    ? (opts: Readonly<{ sessionId: string; update: string }>) => {
        localVoiceRuntimeController.appendAgentContextUpdate(opts.sessionId, opts.update);
      }
    : () => {};

  const sendTextTurn = capabilities.textTurns
    ? async (opts: Parameters<NonNullable<VoiceAdapterController['sendTextTurn']>>[0]) => {
        await localVoiceRuntimeController.sendAgentTextTurn({
          controlSessionId: opts.controlSessionId,
          text: opts.text,
          durableDispatch: {
            localId: opts.localId,
            deliveryCommand: opts.deliveryCommand,
          },
          onAccepted: opts.onAccepted,
        });
      }
    : undefined;

  return {
    id,
    engineKind: 'local',
    start,
    stop,
    toggle,
    interrupt,
    commitInput: async ({ sessionId }) => await localVoiceRuntimeController.commitInput(sessionId),
    bargeIn,
    setMuted,
    sendContextUpdate,
    ...(sendTextTurn ? { sendTextTurn } : {}),
    getSnapshot,
    subscribe: (listener) => useVoiceConversationRuntimeStore.subscribe(() => listener()),
    ...(capabilities.resolveBindingTranscriptMode
      ? { resolveBindingTranscriptMode: capabilities.resolveBindingTranscriptMode }
      : {}),
    ...(capabilities.resolveSurfaceCapabilities
      ? { resolveSurfaceCapabilities: capabilities.resolveSurfaceCapabilities }
      : {}),
    ...(capabilities.resolveContextChannel
      ? { resolveContextChannel: capabilities.resolveContextChannel }
      : {}),
  };
}
