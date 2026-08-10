import {
    HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
    MENTION_BOUNDS,
    MENTION_KIND_V1,
    readMentionRefOpaqueForKindV1,
    sanitizeMentionRefsV1,
} from '@happier-dev/protocol';

/**
 * The universal `<happier_session_reference>` projection (D-21).
 *
 * A session reference reaches the provider ONLY as this text block, appended to the provider
 * prompt string at the one prompt-finalization owner — never to the stored message text and
 * never to `displayText`, and with no provider-native structured item. That makes "a session
 * reference is not double-presented" a contract rather than an inference: there is exactly one
 * shape, produced in exactly one place, on send and on steer alike.
 *
 * It carries no transcript content. The agent reads what it needs through the Happier session
 * tools; embedding a snapshot here would be stale by construction and unbounded in size.
 */

const OPEN_TAG = '<happier_session_reference>';
const CLOSE_TAG = '</happier_session_reference>';

const HEADER = 'The user referenced other Happier session(s) in this message. Use them only if the request calls for it.';

const FOOTER = [
    'Happier session tools may be available to you (for example: read a session\'s transcript or status, or send it a message).',
    'No transcript content is included here — read it with a tool if you need it.',
    'If a tool call fails, or no such tool is available, say so to the user instead of guessing or working around it.',
].join(' ');

type SessionReferenceEntry =
    | Readonly<{ status: 'resolved'; sessionId: string; label: string | null }>
    | Readonly<{ status: 'unreadable' }>;

function readSessionReferenceEntries(meta: unknown): readonly SessionReferenceEntry[] {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [];
    const envelope = (meta as Record<string, unknown>)[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1];
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return [];

    const entries: SessionReferenceEntry[] = [];
    const seen = new Set<string>();
    let sawUnreadable = false;
    for (const mention of sanitizeMentionRefsV1((envelope as Record<string, unknown>).mentions)) {
        if (mention.kind !== MENTION_KIND_V1.session) continue;
        // D-26: provider context is deduplicated by `{kind, ref}` and ordered by first
        // occurrence, even though every textual occurrence stays in `mentions[]`.
        if (seen.has(mention.ref)) continue;
        seen.add(mention.ref);

        const sessionId = readMentionRefOpaqueForKindV1(MENTION_KIND_V1.session, mention.ref);
        if (!sessionId) {
            // An unreadable reference is stated, never repaired: inventing an id here would
            // send the agent at some other user's session.
            if (!sawUnreadable) {
                sawUnreadable = true;
                entries.push({ status: 'unreadable' });
            }
            continue;
        }
        entries.push({
            status: 'resolved',
            sessionId,
            label: typeof mention.label === 'string' && mention.label.trim().length > 0
                ? mention.label.trim()
                : null,
        });
    }
    return entries;
}

function formatEntry(entry: SessionReferenceEntry): string {
    if (entry.status === 'unreadable') {
        return '- a session reference in this message could not be read; no session id is available for it, and none must be guessed';
    }
    const label = entry.label
        ? ` (shown to the user as "${entry.label}" when the reference was inserted; the title may have changed since, and is never the identity)`
        : '';
    return `- session id: ${entry.sessionId}${label}`;
}

/**
 * Returns the block, or `null` when the message carries no session reference.
 *
 * The block is bounded by `MENTION_BOUNDS.maxReferenceBlockChars`. Entries are dropped from the
 * end rather than the text being cut mid-way, and the drop is stated, so the agent never reads
 * a truncated session id as a whole one.
 */
export function buildSessionReferenceBlockV1(meta: unknown): string | null {
    const entries = readSessionReferenceEntries(meta);
    if (entries.length === 0) return null;

    const overhead = `${OPEN_TAG}\n${HEADER}\n\n${FOOTER}\n${CLOSE_TAG}`.length;
    const lines: string[] = [];
    let used = overhead;
    let omitted = 0;
    for (const entry of entries) {
        const line = formatEntry(entry);
        if (used + line.length + 1 > MENTION_BOUNDS.maxReferenceBlockChars) {
            omitted += 1;
            continue;
        }
        lines.push(line);
        used += line.length + 1;
    }
    if (omitted > 0) {
        lines.push(`- ${omitted} further reference(s) omitted to stay within the reference budget`);
    }

    return [OPEN_TAG, HEADER, ...lines, '', FOOTER, CLOSE_TAG].join('\n');
}
