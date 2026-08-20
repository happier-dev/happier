/**
 * The handed-over brief, read as the document it is rather than as one string.
 *
 * The seed the target Agent receives is a plain-text prompt with three named
 * containers in it — the framer's own structure, written so the target can tell
 * a RECORDING of the conversation from the live turn appended after it. Printed
 * verbatim into a card, that structure arrives as markup: `<session_context
 * session_id="…">` at column 0, a matching closer forty lines later, and every
 * replayed turn flattened to one line with its newlines written out as `\n`.
 *
 * That is hostile to read and it is not what the reader is being shown the card
 * for. So the card presents the structure AS structure: each container becomes a
 * labelled section carrying its own name, and the one-line encoding of each turn
 * is reversed back into the lines it was made from.
 *
 * The line this reader will not cross is inventing or discarding meaning:
 *
 * - Sections stay in document order, and text outside every container stays
 *   exactly where it was, so nothing is reordered or dropped.
 * - Only escapes with an EXACT inverse are decoded. The producer doubles every
 *   backslash before it writes a newline as `\n`, so that pair round-trips
 *   losslessly. The `\uXXXX` defangs it applies to reserved markers do not — a
 *   value that already contained the six characters `>` is indistinguishable
 *   from one that was defanged — so those are left exactly as the target saw them.
 * - A container this reader does not recognise, or a brief with no containers at
 *   all, degrades to one unlabelled section: the verbatim text, which is what the
 *   card showed before it could read any structure.
 *
 * @see packages/agents/src/sessions/replay/happierReplayPrompt.ts — the producer.
 */

/**
 * A container opener on a line of its own: `<name>` or `<name attr="…">`.
 *
 * Anchored to the whole line because that is the only place the producer emits
 * one. A tag inside a replayed turn is defanged rather than removed, and a turn
 * is always rendered behind its `User: ` / `Assistant: ` label, so no untrusted
 * line can match this and forge a section.
 */
const CONTAINER_OPEN_LINE = /^<([a-z][a-z0-9_]*)((?:\s[^<>]*)?)>$/;
const CONTAINER_CLOSE_LINE = /^<\/([a-z][a-z0-9_]*)>$/;

export type HandedOverBriefSectionV1 = Readonly<{
    /** The container's own name, or `null` for text that sat outside every container. */
    container: string | null;
    /** The container name as a heading, or `null` when there is no container to name. */
    label: string | null;
    /** The opener's attribute text, verbatim, when it carried any. */
    attributes: string | null;
    /** The section's text, with the producer's line encoding reversed. */
    body: string;
}>;

/**
 * Reverses the one-line encoding the producer applies to every replayed turn.
 *
 * Exact, because the producer escapes the escape first: `\` becomes `\\` before
 * any newline becomes `\n`, so a left-to-right scan that consumes both
 * characters of each pair cannot mistake content for an escape. Text that
 * genuinely contained the two characters `\n` arrived as `\\n` and comes back
 * out as `\n`, not as a line break.
 */
function decodeSeedLineEscapes(value: string): string {
    if (!value.includes('\\')) return value;
    let decoded = '';
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (character !== '\\' || index + 1 >= value.length) {
            decoded += character;
            continue;
        }
        const next = value[index + 1];
        if (next === 'n') {
            decoded += '\n';
            index += 1;
            continue;
        }
        if (next === '\\') {
            decoded += '\\';
            index += 1;
            continue;
        }
        decoded += character;
    }
    return decoded;
}

/**
 * The container's own name as a heading.
 *
 * Derived, never authored: the heading IS the tag the target read, only typeset.
 * That keeps the card honest about what it is showing, needs no translated copy
 * for a machine-generated identifier, and means a container renamed upstream
 * still labels itself correctly instead of drifting from a hardcoded string.
 */
function formatContainerLabel(container: string): string {
    const spaced = container.replaceAll('_', ' ').trim();
    return spaced.length === 0 ? container : `${spaced[0]!.toUpperCase()}${spaced.slice(1)}`;
}

function buildSection(
    container: string | null,
    attributes: string,
    lines: readonly string[],
): HandedOverBriefSectionV1 | null {
    const body = decodeSeedLineEscapes(lines.join('\n').replace(/^\n+|\n+$/g, ''));
    // A run of blank lines between two containers is layout, not content.
    if (container === null && body.trim().length === 0) return null;
    const trimmedAttributes = attributes.trim();
    return {
        container,
        label: container === null ? null : formatContainerLabel(container),
        attributes: trimmedAttributes.length === 0 ? null : trimmedAttributes,
        body,
    };
}

export function readHandedOverBriefSections(briefText: string): readonly HandedOverBriefSectionV1[] {
    const sections: HandedOverBriefSectionV1[] = [];
    let container: string | null = null;
    let attributes = '';
    let buffer: string[] = [];

    const flush = (): void => {
        const section = buildSection(container, attributes, buffer);
        if (section) sections.push(section);
        buffer = [];
    };

    for (const line of briefText.split('\n')) {
        if (container === null) {
            const open = CONTAINER_OPEN_LINE.exec(line);
            if (open) {
                flush();
                container = open[1]!;
                attributes = open[2] ?? '';
                continue;
            }
        } else {
            const close = CONTAINER_CLOSE_LINE.exec(line);
            // Only its OWN closer ends a container. A mismatched one is content:
            // closing on it would hand the rest of the recording a section
            // heading it never had.
            if (close && close[1] === container) {
                flush();
                container = null;
                attributes = '';
                continue;
            }
        }
        buffer.push(line);
    }
    // A container left open is still a section. The recording simply ended
    // inside it, and saying so is more truthful than dropping its body.
    flush();

    return sections;
}
