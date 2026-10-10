import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { compareTranscriptMessagesOldestFirst, type Message } from "@happier-dev/session-core/messages";
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';

const DEMO_SESSION_ID = 'demo-messages-session';

type DemoMessagesInput = Parameters<typeof createReadOnlySessionTranscriptSource>[0];
type DemoMessagesOptions = Pick<DemoMessagesInput, 'interaction' | 'actions'> & Partial<Pick<DemoMessagesInput, 'metadata'>>;

export function useDemoMessages(messages: readonly Message[], options?: DemoMessagesOptions) {
    const orderedMessages = useMemo(() => [...messages].sort(compareTranscriptMessagesOldestFirst), [messages]);
    const snapshot = useMemo(() => ({
        messages: orderedMessages,
        // These rows are already materialized, so no normalization/reducer
        // provenance exists. Route lookup uses the dataset's message identities.
        reducerState: null,
        metadata: options?.metadata ?? null,
        agentState: null,
    }), [orderedMessages, options?.metadata]);
    // Demo rows are already materialized, including tool children; keep them intact.
    const [source] = useState(() => createReadOnlySessionTranscriptSource({
        sessionId: DEMO_SESSION_ID,
        ...snapshot,
        ...options,
    }));
    const publishedSnapshot = useRef(snapshot);
    useLayoutEffect(() => {
        if (publishedSnapshot.current === snapshot) return;
        publishedSnapshot.current = snapshot;
        source.update(snapshot);
    }, [snapshot, source]);

    return source;
}
