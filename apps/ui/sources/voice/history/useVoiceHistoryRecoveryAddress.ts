import * as React from 'react';

import { collectActivitySourceSessionAddresses } from '@/activity/source/activitySourceSessionAddresses';
import { useActivityAttentionSummarySource } from '@/activity/source/useActivityAttentionSource';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
    getVoiceSessionEndedAttempt,
    getVoiceSessionPresentedBinding,
    subscribeToVoiceSessionEndedAttempt,
    subscribeToVoiceSessionSnapshot,
} from '@/voice/session/voiceSessionStore';

import { readVoiceHistoryPendingRecovery } from './useVoiceHistoryPendingRecovery';

/**
 * History's existing recovery entry visits retained custody, never execution reuse.
 * Prefer this client's exact conversation; after cold hydration, Activity owns
 * discovery (including retired carriers and both Home/root scopes). Clearing the
 * presented block exposes the next retained recovery without replaying anything.
 */
export function useVoiceHistoryRecoveryAddress(): SessionAddress | null {
    const source = useActivityAttentionSummarySource();
    const accountScope = useActiveServerAccountScope();
    const binding = React.useSyncExternalStore(subscribeToVoiceSessionSnapshot,
        getVoiceSessionPresentedBinding, getVoiceSessionPresentedBinding);
    const ended = React.useSyncExternalStore(subscribeToVoiceSessionEndedAttempt,
        getVoiceSessionEndedAttempt, getVoiceSessionEndedAttempt);
    return React.useMemo(() => {
        const preferred = ended
            ? areServerAccountScopesEqual(ended.accountScope, accountScope) ? ended.conversationSessionAddress : null
            : binding?.conversationSessionAddress ?? null;
        const needsRecovery = (address: SessionAddress) => {
            const session = source.sessionsById[address.sessionId];
            return session && areServerProfileIdentifiersEquivalent(session.serverId ?? source.activeServerId, address.serverId)
                && readVoiceHistoryPendingRecovery(address, session) !== null;
        };
        if (preferred && needsRecovery(preferred)) return preferred;
        for (const address of collectActivitySourceSessionAddresses(source, true)) {
            if (needsRecovery(address)) return address;
        }
        return null;
    }, [accountScope, binding, ended, source]);
}
