import * as React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { readReducerSidechainMessages } from '@/sync/reducer/reducer';
import { useSessionMessagesReducerSnapshot } from '@/sync/domains/state/storage';

/**
 * One sidechain's messages, in the shape a transcript renders.
 *
 * The reducer holds a sidechain as flat records and projects them into `Message` in exactly one
 * place — `readReducerSidechainMessages`, beside the map and the converter. This hook is the React
 * read of that: nothing is parsed here, nothing is converted here, and no second message model
 * exists for the same records.
 *
 * Keyed on `reducerVersion`, not on the reducer state object, which is MUTATED IN PLACE for
 * streaming performance. A `useMemo` over the state alone can never recompute — the exact mistake
 * that once made the Agents pane's activity preview unrefreshable.
 *
 * It does not fetch. `SidechainTranscriptBody` mounts the one hydration owner; a second fetcher here
 * would be a second demand-load path for the same id.
 */
export function useSidechainTranscriptMessages(params: Readonly<{
    sessionId: string;
    sidechainId: string;
}>): Message[] {
    const { sessionId, sidechainId } = params;
    const { reducerState, reducerVersion } = useSessionMessagesReducerSnapshot(sessionId);

    return React.useMemo(
        () => readReducerSidechainMessages(reducerState, sidechainId),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reducerState is mutated in place; reducerVersion is its only change signal (D-4)
        [reducerState, reducerVersion, sidechainId],
    );
}
