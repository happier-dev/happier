import type { VoiceSessionStatus } from './types';

/**
 * The canonical "the microphone is genuinely capturing" fact.
 *
 * Two owners need it and they must never disagree: the Voice surface model,
 * which announces microphone state and labels the transport, and the energy
 * clock, whose respiration gate claims a live microphone with *motion*
 * (§2.4a). A surface saying "microphone inactive" beside a planet breathing as
 * if it were open is a split brain the user can see, so the predicate lives in
 * one place rather than being re-derived at each site.
 *
 * `connected` is deliberately not enough on its own. The runtime machine has a
 * distinct `acquiring_mic` state between `connected` and `listening`
 * (`VoiceConversationRuntimeMachine.ts`), and the session status stays
 * `connected` throughout it. The open capture source — the level store's input
 * writer, which opens the instant the microphone starts producing — is what
 * separates "the attempt exists" from "the microphone is on".
 */
export function resolveVoiceMicCaptureActive(inputs: Readonly<{
  status: VoiceSessionStatus;
  /** The level store's input channel has an open writer. */
  inputSourceActive: boolean;
}>): boolean {
  return inputs.status === 'connected' && inputs.inputSourceActive;
}
