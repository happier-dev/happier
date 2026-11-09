import * as React from 'react';

import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t, tLoose } from '@/text';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { useVoiceProviderRegistryRevision } from '@/voice/registry/useVoiceProviderRegistryRevision';
import { resolveVoiceServiceTitle } from '@/voice/registry/voiceProviderPresentation';
import { getVoiceSessionEndedAttempt, subscribeToVoiceSessionEndedAttempt } from '@/voice/session/voiceSessionStore';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

/**
 * Where a Voice conversation lives, for its session header: "Global Voice · OpenAI Realtime". The
 * service belongs to this conversation's binding, including the lifecycle's captured ended binding.
 * A Voice conversation's folder is private plumbing and never its subtitle.
 */
export function useVoiceConversationHeaderSubtitle(metadata: unknown, address?: SessionAddress | null): string | undefined {
  const isVoiceCarrier = isVoiceConversationCustodySessionMetadata(metadata);
  useVoiceProviderRegistryRevision(voiceProviderRegistry, isVoiceCarrier);
  const localize = useProjectedPluginLocalizedTextResolver();
  const accountScope = useActiveServerAccountScope();
  const readProviderId = React.useCallback(() => {
    if (!isVoiceCarrier || !address) return null;
    const ended = getVoiceSessionEndedAttempt();
    if (areServerAccountScopesEqual(ended?.accountScope, accountScope)
      && areSessionAddressesEqual(ended?.conversationSessionAddress, address)) return ended?.adapterId ?? null;
    const binding = voiceConversationBindingResolver.resolveByConversationSessionId({
      conversationSessionId: address.sessionId,
      sessionMetadata: metadata,
    });
    return areSessionAddressesEqual(binding?.conversationSessionAddress, address) ? binding?.adapterId ?? null : null;
  }, [accountScope, address?.serverId, address?.sessionId, isVoiceCarrier, metadata]);
  const providerId = React.useSyncExternalStore(isVoiceCarrier ? subscribeConversationProvider : subscribeNoop,
    readProviderId, readProviderId);
  if (!isVoiceCarrier) return undefined;
  const entry = providerId ? voiceProviderRegistry.get(providerId) : null;
  const where = t('voiceMoments.globalVoice');
  return entry ? `${where} · ${resolveVoiceServiceTitle(entry, tLoose, localize)}` : where;
}

function subscribeConversationProvider(listener: () => void): () => void {
  const unsubscribeBinding = voiceSessionBindingStore.subscribe(listener);
  const unsubscribeEnded = subscribeToVoiceSessionEndedAttempt(listener);
  return () => { unsubscribeBinding(); unsubscribeEnded(); };
}

function subscribeNoop(): () => void {
  return () => {};
}
