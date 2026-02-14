import type { TracedMessage } from '../reducerTracer';
import type { ReducerState } from '../reducer';
import { cancelRunningTools } from '../helpers/cancelRunningApprovedTools';

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

            if (msg.content.type === 'task-lifecycle') {
                if (msg.content.event === 'turn_aborted' || msg.content.event === 'task_complete') {
                    cancelRunningTools({
                        state,
                        changed,
                        completedAt: msg.createdAt,
                        reason: 'Request interrupted',
                        preferredToolId: msg.content.id ?? null,
                    });
                }
                continue;
            }

            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                role: 'agent',
                createdAt: msg.createdAt,
                event: msg.content,
                tool: null,
                text: null,
                meta: msg.meta,
            });
            changed.add(mid);
        }
    }
}
