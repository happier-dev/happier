import type { TracedMessage } from "../reducerTracer.js";
import type { ReducerState } from "../reducer.js";
import { setThinkingMergeCursor } from "../helpers/mergeCursors.js";
import { normalizeTranscriptSeq } from "../../messages/transcriptOrdering.js";

export function runModeSwitchEventsPhase(params: Readonly<{
    state: ReducerState;
    nonSidechainMessages: TracedMessage[];
    changed: Set<string>;
    allocateId: () => string;
}>): void {
    const { state, nonSidechainMessages, changed, allocateId } = params;

    //
    // Phase 5: Process mode-switch messages
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'event') {
            if (state.messageIds.has(msg.id)) {
                continue;
            }
            state.messageIds.set(msg.id, msg.id);

            if (msg.content.type === 'task-lifecycle'
                && !(msg.content.event === 'turn_cancelled' && msg.content.cause === 'user')) {
                continue;
            }

            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                seq: normalizeTranscriptSeq(msg.seq),
                localId: msg.localId ?? null,
                role: 'agent',
                createdAt: msg.createdAt,
                event: msg.content,
                tool: null,
                text: null,
                meta: msg.meta,
            });
            setThinkingMergeCursor(state, null, 'event-message');
            changed.add(mid);
        }
    }
}
