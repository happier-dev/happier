import * as React from 'react';
import { buildSessionMessageRouteId, type Message, type TranscriptOlderPageLoadResult } from '@happier-dev/session-core/messages';
import type { ReducerState } from '@happier-dev/session-core/reducer';
import { isSessionActionConfirmationRequest } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { TranscriptJumpResult, TranscriptJumpTarget } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import type { ToolCallsGroupExpansionRequest } from '@/components/sessions/transcript/rowHost/useTranscriptToolCallsExpansionState';
import { expandTranscriptToolCallGroupsForMessage } from '@/components/sessions/transcript/rowHost/useTranscriptToolCallsExpansionState';
import { resolvePermissionToolCallLocations } from '@/utils/sessions/permissions/resolvePermissionToolCallLocations';
import { markPendingNavigationTranscriptReady, usePendingNavigationLanding } from '@/activity/source/pendingNavigationRuntime';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { useSessionScreenIsFocused } from '@/components/sessions/shell/useSessionScreenIsFocused';

export type TranscriptPendingNavigationLandingInput = Readonly<{
    address: SessionAddress | null;
    isLoaded: boolean;
    focused: boolean;
    hasOlder: boolean;
    loadOlder: (() => Promise<TranscriptOlderPageLoadResult>) | null;
    messagesById: Readonly<Record<string, Message>>;
    reducerState?: ReducerState | null;
    items: readonly ChatTranscriptListItem[];
    setToolCallsGroupExpanded(request: ToolCallsGroupExpansionRequest): void;
    waitForVisualUpdate(): Promise<void>;
    jumpToTarget(target: TranscriptJumpTarget, options: Readonly<{ signal: AbortSignal; preferTargetWindow: boolean }>): Promise<TranscriptJumpResult>;
}>;

type TranscriptPendingNavigationLandingProps = Omit<TranscriptPendingNavigationLandingInput, 'reducerState' | 'messagesById' | 'focused'> & Readonly<{
    messagesById?: TranscriptPendingNavigationLandingInput['messagesById'];
}>;

/** Lands only on the focused Session screen; it reads that focus here, so its list does not render for it. */
export function TranscriptPendingNavigationLanding(input: TranscriptPendingNavigationLandingProps): React.ReactElement | null {
    const landing = usePendingNavigationLanding(input.address);
    const focused = useSessionScreenIsFocused();
    return landing?.state === 'pending' && focused
        ? React.createElement(ActiveTranscriptPendingNavigationLanding, { input: { ...input, focused } }) : null;
}

function ActiveTranscriptPendingNavigationLanding(props: Readonly<{ input: TranscriptPendingNavigationLandingProps & Readonly<{ focused: boolean }> }>): null {
    const source = useSessionTranscriptSource();
    const reducerState = source.useReducerState();
    // Ordinary list hosts omit message detail to keep subscriptions row-local.
    // Only an active landing reads it; fork hosts retain their composed corpus.
    const messagesById = source.useMessagesById();
    useTranscriptPendingNavigationLanding({ ...props.input, messagesById: props.input.messagesById ?? messagesById, reducerState });
    return null;
}

function resolveRouteId(input: TranscriptPendingNavigationLandingInput, messageId: string, message: Message | null | undefined) {
    return buildSessionMessageRouteId({ messageId, messagesById: message ? { [messageId]: message } : input.messagesById,
        reducerState: input.reducerState });
}

function resolveLocation(input: TranscriptPendingNavigationLandingInput, requestId: string) {
    return resolvePermissionToolCallLocations({ permissionIds: [requestId],
        messageIdsOldestFirst: Object.keys(input.messagesById), messagesById: input.messagesById,
        resolveRouteMessageId: (id, message) => resolveRouteId(input, id, message),
    }).get(requestId);
}

/** Reveal only after the Session has hydrated; the prompt owns focus while it loads. */
export function useTranscriptPendingNavigationLanding(input: TranscriptPendingNavigationLandingInput): void {
    const landing = usePendingNavigationLanding(input.address);
    const location = React.useMemo(() => landing?.state === 'pending' && !isSessionActionConfirmationRequest({ source: landing.requestSource })
        ? resolveLocation(input, landing.requestId) : null, [input.messagesById, input.reducerState, landing]);
    const routeMessageId = location?.kind === 'nested' ? location.parentMessageId : location?.messageId;
    const frame = React.useRef(input);
    frame.current = input;
    React.useEffect(() => {
        if (!input.focused || !input.isLoaded || !landing || landing.state !== 'pending'
            || landing.focusTarget !== 'prompt' || isSessionActionConfirmationRequest({ source: landing.requestSource })) return;
        const controller = new AbortController();
        const reveal = async () => {
            let current = frame.current;
            let targetId = routeMessageId;
            let hasOlder = current.hasOlder;
            while (!targetId && hasOlder && current.loadOlder) {
                const page = await current.loadOlder();
                if (controller.signal.aborted || (page.status !== 'loaded' && page.status !== 'no_more')) return;
                await frame.current.waitForVisualUpdate();
                if (controller.signal.aborted) return;
                current = frame.current;
                const found = resolveLocation(current, landing.requestId);
                targetId = found?.kind === 'nested' ? found.parentMessageId : found?.messageId;
                hasOlder = page.hasMore;
            }
            if (!targetId) return;
            const message = Object.values(current.messagesById).find(candidate => resolveRouteId(current, candidate.id, candidate) === targetId);
            if (!message) return;
            expandTranscriptToolCallGroupsForMessage(message.id, current.items, current.setToolCallsGroupExpanded);
            await current.waitForVisualUpdate();
            if (controller.signal.aborted) return;
            const result = await frame.current.jumpToTarget({ kind: 'route-message-id', routeMessageId: targetId,
                seqHint: message.seq ?? null }, { signal: controller.signal, preferTargetWindow: true });
            if (controller.signal.aborted || (result.status !== 'scrolled' && result.status !== 'window-rendered')) return;
            markPendingNavigationTranscriptReady(landing);
        };
        fireAndForget(reveal(), { tag: 'Next.pendingRequestReveal' });
        return () => controller.abort();
    }, [input.focused, input.isLoaded, landing, routeMessageId]);
}
