import * as React from 'react';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useSessionChatReveal } from '@/components/sessions/panes/useSessionChatReveal';
import { createServerRequestForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { GalleryMediaItem } from './galleryModel';
import { resolveGalleryChatJump, type GalleryChatJump } from './showGalleryItemInChat';

export function useShowGalleryItemInChat(address: SessionAddress, lifetime: ServerAccountScopeLifetime | null) {
    const navigate = useNavigateToSession();
    const { sessionId, serverId } = address;
    // The chat comes forward before the transcript jumps: a phone switches to it (lab pr974 SM1jp), and a
    // Details drawer covering it closes, through the one reveal owner the review handoff uses too.
    const revealChat = useSessionChatReveal(useDestinationPaneScopeId(createSessionPaneScopeId(sessionId, serverId)));
    return React.useCallback(async (item: Pick<GalleryMediaItem, 'messageLocalId'>, signal?: AbortSignal): Promise<GalleryChatJump> => {
        if (!item.messageLocalId) return { ok: false, code: 'no_message' };
        if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(serverId, lifetime.scope.serverId)) {
            return { ok: false, code: 'cancelled' };
        }
        const { scope } = lifetime;
        const retired = new Error('Gallery transcript lookup retired');
        try {
            const result = await runWithServerAccountScopeRequestGuard({ scope, isCurrent: lifetime.isCurrent, signal,
                staleError: () => retired }, async guard => {
                guard.check();
                const loaded = areServerAccountScopesEqual(getActiveServerAccountScope(), scope)
                    ? readRegisteredStorageState()?.sessionMessages[sessionId]?.messagesById : undefined;
                const request = createServerRequestForServerAccountScope({ scope, activeRequest: async () => {
                    throw new Error('Expected captured Account authority for the gallery transcript lookup');
                } });
                const jump = await resolveGalleryChatJump({ sessionId, serverId, item, loadedMessages: Object.values(loaded ?? {}),
                    request, signal: guard.signal });
                guard.check();
                return jump;
            });
            if (!lifetime.isCurrent() || signal?.aborted) return { ok: false, code: 'cancelled' };
            if (result.ok) {
                revealChat();
                await navigate(sessionId, { serverId, query: result.query });
            }
            return result;
        } catch (error) {
            return { ok: false, code: error === retired || signal?.aborted || !lifetime.isCurrent() ? 'cancelled' : 'read_failed' };
        }
    }, [lifetime, navigate, revealChat, serverId, sessionId]);
}
