import { BrowserActiveTargetV1Schema } from '@happier-dev/protocol/browser/events/activeTarget';
import type { ComputerControlStatusResponseV1 } from '@happier-dev/protocol/computer/v1';

import { classifyBrowserAgentActivity, type BrowserCopresence } from '@/sync/domains/browser/automation/copresence';

/**
 * Who is using the shared window, as the one co-presence capsule reads it, projected from the computer
 * owner's `control.status` (W7) and nothing else. The only local fact is `stopRequested`: the gap between
 * the person's press and the owner's answer.
 *
 * - stopping: the press is unanswered, or the owner still drains the interrupted action;
 * - unconfirmed: the owner holds human control but cannot confirm the agent's input was released
 *   (`uncertain`), so it is never shown as "You have control";
 * - human: the stop is confirmed;
 * - agent: the agent may act (idle included: a shared window is still the agent's to use, and Take
 *   control stays reachable before its first action).
 */
export function projectComputerCopresence(input: Readonly<{
    status: ComputerControlStatusResponseV1 | null;
    stopRequested: boolean;
}>): BrowserCopresence {
    const { status } = input;
    const controlEpoch = status?.controlEpoch ?? 0;
    if (input.stopRequested || status?.stopping) return { kind: 'stopping', controlEpoch };
    if (!status) return { kind: 'idle', controlEpoch };
    if (status.controller === 'human') {
        return status.uncertain
            ? { kind: 'unconfirmed', controlEpoch }
            : { kind: 'human', controlEpoch, interruptedCompletion: null };
    }
    const target = BrowserActiveTargetV1Schema.safeParse(status.activeTarget);
    return {
        kind: 'agent',
        activity: classifyBrowserAgentActivity(status.activity?.kind === 'capture' ? 'snapshot' : status.activity?.kind),
        target: target.success ? target.data : null,
        controlEpoch,
    };
}
