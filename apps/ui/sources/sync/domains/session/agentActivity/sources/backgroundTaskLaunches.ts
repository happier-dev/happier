import { readBashBackgroundTaskId } from '@/components/tools/normalization/parse/backgroundTask';
import type { Message } from '@/sync/domains/messages/messageTypes';

/**
 * The join between a durable background-task record and the transcript card that launched it.
 *
 * A background command is a headless process, not an agent: it has no transcript and no sidechain
 * of its own, and its real output already lives on the originating `Bash` card. So the one thing a
 * detail view owes a reader — "where do I actually see what this printed?" — is a pointer to that
 * card, and this module is how it is found.
 *
 * **The join key is attested, not guessed.** Claude's `Bash` tool result carries `backgroundTaskId`
 * when the command was backgrounded (`BashOutput` in the SDK's `ToolOutputSchemas`), and the CLI
 * forwards the provider result verbatim. That id is the same `task_id` the provider task lifecycle
 * uses and therefore the same id the record is keyed by. Nothing here matches on command text or on
 * timing: a heuristic join would silently point a reader at somebody else's command.
 *
 * Reading that key out of a tool result is owned by `readBashBackgroundTaskId`, which the `Bash`
 * card uses for the same fact. Keeping a private copy here cost the JSON-encoded transcript
 * envelope — the ordinary Claude shape — and would have dropped every real deep link.
 */

export type BackgroundTaskLaunch = Readonly<{
    /** The transcript message holding the `Bash` tool call. */
    messageId: string;
    /** Transcript sequence, when the message has one. The deep link needs it; absence is honest. */
    seq: number | null;
    /** Provider tool-use id of the launching call. */
    toolCallId: string | null;
}>;

const EMPTY_LAUNCHES: ReadonlyMap<string, BackgroundTaskLaunch> = new Map();

function readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Index the transcript's backgrounded `Bash` launches by provider task id.
 *
 * Reads the subagent-source projection the roster already subscribes to, so no surface pays for a
 * second transcript subscription (R-11).
 */
export function readBackgroundTaskLaunches(
    messages: readonly Message[],
): ReadonlyMap<string, BackgroundTaskLaunch> {
    let launches: Map<string, BackgroundTaskLaunch> | null = null;

    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        const tool = message.tool;
        // The id on the RESULT is the attestation, and the only one. `BashInput.run_in_background`
        // is a request the provider may decline, so gating on it would drop a genuinely detached
        // command whose input flag never arrived — and would add nothing, because no other tool
        // result carries this key.
        const taskId = readBashBackgroundTaskId(tool?.result);
        if (!taskId) continue;
        if (launches === null) launches = new Map();
        // First writer wins: a resumed transcript can replay the same launch, and the earliest
        // occurrence is the one a reader scrolling back would recognise.
        if (launches.has(taskId)) continue;
        launches.set(taskId, {
            messageId: message.id,
            seq: typeof message.seq === 'number' && Number.isFinite(message.seq)
                ? Math.trunc(message.seq)
                : null,
            toolCallId: readTrimmedString(tool?.id),
        });
    }

    return launches ?? EMPTY_LAUNCHES;
}
