import * as React from 'react';
import { useHomeSetupDismissals } from '@/components/hub/layout/useHomeSetupDismissals';
import type { SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { storage } from '@/sync/domains/state/storage';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { deriveVoiceSetupFacts, type VoiceSetupFacts, type VoiceSetupInput } from './voiceSetupFacts';

export const VOICE_SETUP_STEP_ID = 'setup:voice';
type SetupRendererFacts = Readonly<{ facts: VoiceSetupFacts; dismiss: () => void }>;

/** Whether the person dismissed "Set up voice" (Home's "Get set up" dismissal; Customize brings it back). */
export function useVoiceSetupDismissed(): boolean {
    return useHomeSetupDismissals().hidden.has(VOICE_SETUP_STEP_ID);
}

/** Home and settings share facts and dismissal; the surface supplies its real tile and steps panel. */
export function useVoiceSetupItem(input: Omit<VoiceSetupInput, 'messages'> & Readonly<{
    conversationSessionAddress: SessionAddress | null;
    renderTile?: (controls: Parameters<SetupBlockItem['renderTile']>[0] & SetupRendererFacts) => React.ReactNode;
    renderPanel?: (controls: Readonly<{ close: () => void }> & SetupRendererFacts) => React.ReactNode;
}>) {
    const address = input.conversationSessionAddress;
    // Only the bound conversation's slice can trigger this consumer. Reading has no hydration/RPC effects.
    const slice = storage((state) => address ? state.sessionMessages[address.sessionId] : undefined);
    const session = storage((state) => address ? state.sessions[address.sessionId] : undefined);
    const messages = React.useMemo(() => readStoredSessionMessagesForAddress({
        sessions: address && session ? { [address.sessionId]: session } : {},
        sessionMessages: address && slice ? { [address.sessionId]: slice } : {},
    }, address), [address?.serverId, address?.sessionId, session, slice]);
    const facts = React.useMemo(() => deriveVoiceSetupFacts({
        providerId: input.providerId, readiness: input.readiness, microphonePermission: input.microphonePermission, messages,
    }), [input.providerId, input.readiness, input.microphonePermission, messages]);
    const dismissals = useHomeSetupDismissals();
    const dismiss = React.useCallback(() => dismissals.dismiss(VOICE_SETUP_STEP_ID), [dismissals.dismiss]);
    const hidden = dismissals.hidden.has(VOICE_SETUP_STEP_ID);
    const item = React.useMemo((): SetupBlockItem | null => hidden || !input.renderTile ? null : {
        id: VOICE_SETUP_STEP_ID,
        renderTile: (controls) => input.renderTile!({ ...controls, facts, dismiss }),
        ...(input.renderPanel ? { renderPanel: (controls: Readonly<{ close: () => void }>) => input.renderPanel!({ ...controls, facts, dismiss }) } : {}),
    }, [hidden, input.renderTile, input.renderPanel, facts, dismiss]);
    return React.useMemo(() => ({ facts, hidden, dismiss, item }), [facts, hidden, dismiss, item]);
}
