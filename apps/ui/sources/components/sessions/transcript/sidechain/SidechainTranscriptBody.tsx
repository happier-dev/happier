import * as React from 'react';

import { ChainTranscriptList } from '@/components/sessions/transcript/ChainTranscriptList';
import {
    SidechainHydrationInlineStatus,
    shouldShowSidechainHydrationInlineStatus,
} from '@/components/tools/shell/views/SidechainHydrationInlineStatus';
import { useEnsureSidechainsLoaded } from '@/hooks/session/useEnsureSidechainsLoaded';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

/**
 * ONE sidechain transcript body: hydrate it, say honestly when it is empty, render it.
 *
 * Extracted from `ToolFullView`, which was the only surface that could show a sidechain because it
 * was the only one holding the tool message that owns one. An imported workflow-agent sidecar has no
 * owning tool message, so the details host that finally shows it had two options: reproduce this
 * logic, or consume it. A second sidechain transcript renderer is precisely the split-brain the
 * agent-activity program has spent its waves removing, so this is the shared one and there is no
 * other.
 *
 * What it owns, and why each piece has to travel with the list rather than be restated per host:
 *
 * - **hydration**, through `useEnsureSidechainsLoaded` — the ONE demand-load owner, asked by id, so
 *   a sidechain with no tool call is fetchable at all. Mounting this body is what fetches; nothing
 *   about a sidechain is loaded to draw a row that has not been opened;
 * - **the dataset key**, which is what makes `ChainTranscriptList` treat a different transcript as a
 *   different dataset instead of paginating the previous one's tail;
 * - **the in-flight answer**. `ChainTranscriptList` spins on an empty list unless it is told the
 *   load already resolved, and a legitimately empty sidechain must stop rather than spin forever;
 * - **the inline status**, which is the only honest thing to draw while there is nothing to draw.
 *
 * What it deliberately does NOT own: layout and chrome. Each host frames it — the tool full view
 * inside its content wrapper, the details tab inside the pane — because a body that also declared
 * its frame would force one host's padding on the other.
 */

export type SidechainTranscriptBodyProps = Readonly<{
    sessionId: string;
    /**
     * The sidechain to hydrate and render, or `null` for a transcript that has messages but no
     * sidechain of its own (a tool call whose children arrived inline).
     */
    sidechainId: string | null;
    /**
     * Dataset identity when there is no `sidechainId`. The owning message id, for the tool view.
     * Two transcripts sharing a dataset key would page into each other.
     */
    datasetIdentityFallback?: string;
    messages: Message[];
    metadata: Metadata | null;
    interaction: TranscriptInteraction;
    forcePermissionPromptsInTranscript?: boolean;
    jumpToMessageId?: string | null;
    /** Rendered above the transcript, BELOW the hydration status. */
    header?: React.ReactNode;
    footer?: React.ReactNode;
    messageWrapperTestIdPrefix?: string;
    hydrationStatusTestID: string;
}>;

export function SidechainTranscriptBody(props: SidechainTranscriptBodyProps): React.ReactElement {
    const {
        datasetIdentityFallback,
        footer,
        forcePermissionPromptsInTranscript = false,
        header,
        hydrationStatusTestID,
        interaction,
        jumpToMessageId,
        messageWrapperTestIdPrefix,
        messages,
        metadata,
        sessionId,
        sidechainId,
    } = props;

    const normalizedSessionId = sessionId.trim();
    const normalizedSidechainId = sidechainId && sidechainId.trim().length > 0 ? sidechainId.trim() : null;

    // One id, because one transcript is on screen. The array identity changes only when the id
    // does, so the hook's request signature is stable across every streamed commit.
    const sidechainIds = React.useMemo(() => [normalizedSidechainId], [normalizedSidechainId]);
    const hydration = useEnsureSidechainsLoaded({
        enabled: normalizedSessionId.length > 0 && normalizedSidechainId !== null,
        sessionId: normalizedSessionId,
        sidechainIds,
    });

    const datasetIdentity = normalizedSidechainId ?? datasetIdentityFallback ?? '';
    const datasetKey = React.useMemo(
        () => JSON.stringify([normalizedSessionId, datasetIdentity]),
        [datasetIdentity, normalizedSessionId],
    );

    const status = normalizedSidechainId
        ? hydration.bySidechainId[normalizedSidechainId]?.status ?? hydration.status
        : hydration.status;

    // Claimed only while a fetch is genuinely in flight. A loaded-but-empty sidechain (or a terminal
    // error / not_ready) must not spin forever in the list footer; the inline status above already
    // states error and unavailable.
    const isInitialLoadInFlight = status === 'loading' || status === 'in_flight' || status === 'retrying';
    const showHydrationStatus = shouldShowSidechainHydrationInlineStatus({
        messageCount: messages.length,
        sidechainId: normalizedSidechainId,
        status,
    });

    const loadOlder = React.useCallback(async () => {
        if (!normalizedSessionId || !normalizedSidechainId) {
            return { loaded: 0, hasMore: false, status: 'not_ready' as const };
        }
        return sync.loadOlderSidechainMessages(normalizedSessionId, normalizedSidechainId);
    }, [normalizedSessionId, normalizedSidechainId]);

    const composedHeader = (
        <>
            {showHydrationStatus ? (
                <SidechainHydrationInlineStatus testID={hydrationStatusTestID} status={status} />
            ) : null}
            {header}
        </>
    );

    return (
        <ChainTranscriptList
            key={datasetKey}
            sessionId={normalizedSessionId}
            datasetKey={datasetKey}
            messages={messages}
            metadata={metadata}
            interaction={interaction}
            forcePermissionPromptsInTranscript={forcePermissionPromptsInTranscript}
            isInitialLoadInFlight={isInitialLoadInFlight}
            {...(normalizedSidechainId ? { loadOlder } : null)}
            jumpToMessageId={jumpToMessageId ?? null}
            header={composedHeader}
            {...(footer ? { footer } : null)}
            {...(messageWrapperTestIdPrefix ? { messageWrapperTestIdPrefix } : null)}
        />
    );
}
