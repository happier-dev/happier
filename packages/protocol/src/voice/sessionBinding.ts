import { readSystemSessionMetadataFromMetadata } from '../sessions/control/contract.js';

export const HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE = 'happier_voice_binding_nonce' as const;
export const HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE = 'happier_voice_lease_id' as const;

export const VOICE_CONVERSATION_SYSTEM_SESSION_KEY = 'voice_conversation';
export const VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY = 'voice_conversation_retired';
/** Legacy hidden carrier marker retained by the existing Voice lookup owner. */
export const VOICE_CONVERSATION_LEGACY_SYSTEM_SESSION_KEY = 'voice_carrier';

export function isVoiceConversationSystemSessionMetadata(metadata: unknown): boolean {
  const systemSession = readSystemSessionMetadataFromMetadata({ metadata });
  const key = String(systemSession?.key ?? '').trim();
  return systemSession?.hidden === true && (
    key === VOICE_CONVERSATION_SYSTEM_SESSION_KEY
    || key === VOICE_CONVERSATION_LEGACY_SYSTEM_SESSION_KEY
  );
}
