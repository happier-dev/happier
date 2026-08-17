import type { Message } from '../../messages/messageTypes';

export function agentTextLooksLikeExecutionRunSignal(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) return false;
    return (
        (
            normalized.includes('execution run')
            || normalized.includes('run has been started')
            || normalized.includes('run started')
            || /\brun_[0-9a-z-]{8,}\b/i.test(text)
        )
        && (
            normalized.includes('started')
            || normalized.includes('running')
            || normalized.includes('delegate')
            || normalized.includes('execution run')
        )
    );
}

/**
 * The `happier` meta-envelope kinds a user turn can carry that NAME a member of the roster.
 *
 * A teammate can enter the roster without any tool call ever mentioning it: launching one and
 * addressing one both write a `happier` envelope onto the user's own message, and
 * `deriveAgentTeamHintFromSubagentMessages` / `…FromParticipantMessages` read exactly those two
 * kinds to recover the team and its members.
 *
 * Keeping the list explicit rather than "any envelope" is deliberate: this projection exists to be
 * narrow, and a user turn that says nothing about agents must not join it.
 */
const SUBAGENT_SOURCE_USER_MESSAGE_ENVELOPE_KINDS: ReadonlySet<string> = new Set([
    'subagent_launch.v1',
    'participant_message.v1',
]);

function readHappierEnvelopeKind(meta: unknown): string | null {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const happier = (meta as Record<string, unknown>).happier;
    if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return null;
    const kind = (happier as Record<string, unknown>).kind;
    return typeof kind === 'string' && kind.length > 0 ? kind : null;
}

/**
 * Whether this message can contribute to the session's agent roster.
 *
 * The projection this feeds is what every count-shaped surface derives its roster from, so a source
 * the roster derivation genuinely reads and this predicate does not keep is a silent undercount —
 * not a missing optimisation. That was live for user turns: the pane derived its roster from the
 * whole transcript and the header derived it from this projection, so a Claude teammate known only
 * from a launch envelope appeared in one and not the other.
 */
export function shouldIncludeSubagentSourceMessage(message: Message): boolean {
    if (message.kind === 'tool-call') return true;
    if (message.kind === 'user-text') {
        const kind = readHappierEnvelopeKind((message as { meta?: unknown }).meta);
        return kind !== null && SUBAGENT_SOURCE_USER_MESSAGE_ENVELOPE_KINDS.has(kind);
    }
    if (message.kind !== 'agent-text') return false;
    const text = typeof (message as { text?: unknown }).text === 'string'
        ? String((message as { text?: unknown }).text)
        : '';
    return agentTextLooksLikeExecutionRunSignal(text);
}
