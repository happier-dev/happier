/**
 * A turn that can carry two texts: `text` is what was sent to the Agent, and
 * `displayText` is what the reader saw when the two differ.
 *
 * Structural rather than tied to one message type, because the same pair
 * travels as a committed transcript `Message`, as a queued `PendingMessage`,
 * and as the edit request built from one.
 */
export type MessageDisplayTextSource = Readonly<{
    text?: string | null;
    displayText?: string | null;
}>;

/**
 * The text a turn actually SHOWED, for the paths that put a past turn back in
 * front of the user.
 *
 * The sender expands review comments, an attachments block, a subagent or
 * participant route, or an automation template into `text` and keeps the typed
 * sentence in `displayText`. Restoring `text` therefore hands the reader
 * scaffolding they never saw and makes it their new draft. Every restore,
 * preview and edit path answers this question the same way, so it is answered
 * once here rather than at each call site.
 *
 * Rendering is a different question with more inputs — streaming state,
 * structured-only blocks, the pre-`displayText` attachments block — and keeps
 * its own owner in the transcript.
 */
export function readMessageDisplayText(source: MessageDisplayTextSource): string {
    if (typeof source.displayText === 'string') return source.displayText;
    return typeof source.text === 'string' ? source.text : '';
}
