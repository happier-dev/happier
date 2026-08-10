import * as React from 'react';
import {
    MENTION_KIND_V1,
    readHappierStructuredInputV1FromMeta,
    readMentionRefOpaqueForKindV1,
    readStructuredInputMentionSourcesV1,
} from '@happier-dev/protocol';

import { extractWorkspaceFileMentions } from '@/components/sessions/linkedFiles/extractWorkspaceFileMentions';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';

/**
 * The one projection behind the transcript's structured-references row (D-6). Both
 * `MessageView` branches — the user bubble and the agent block — consume it, so the two
 * previously duplicated scans became one owner with one contract.
 *
 * Two sources feed it, and the difference between them is a product invariant, not an
 * implementation detail:
 *
 * - **Sessions come only from the envelope (INV-5).** A message whose text merely contains a
 *   lookalike token is plain text. Scanning for them would let any agent output that mentions
 *   `@session:...` render a navigable link the user never authored.
 * - **Files additionally keep the text scan, permanently (D-5).** A pre-envelope message and a
 *   post-envelope message with zero mentions are indistinguishable, so there is no point at
 *   which the scan can be retired. It also still covers a path the user typed by hand rather
 *   than picking. The envelope is what covers what the scan cannot parse — a quoted token like
 *   `@"my file.ts"` (`extractWorkspaceFileMentions` requires `/^[A-Za-z0-9._/-]+\/?$/`).
 *
 * A well-formed reference of an unknown kind is skipped here and left untouched in the
 * envelope (INV-4): it is never reinterpreted as a file or a session.
 */

export type TranscriptFileReference = Readonly<{
    kind: 'file';
    path: string;
}>;

export type TranscriptSessionReference = Readonly<{
    kind: 'session';
    sessionId: string;
    /** Advisory display text captured when the reference was composed; never identity. */
    label: string | null;
}>;

export type TranscriptStructuredReference = TranscriptFileReference | TranscriptSessionReference;

const NO_REFERENCES: readonly TranscriptStructuredReference[] = Object.freeze([]);

/**
 * D-26: a reference repeated at several composer positions is one row. Identity is
 * `{kind, ref}`, expressed here on the decoded payload so an envelope file reference and the
 * same path found by the text scan collapse to a single chip.
 */
function referenceIdentity(reference: TranscriptStructuredReference): string {
    return reference.kind === 'file'
        ? `file\u0000${reference.path}`
        : `session\u0000${reference.sessionId}`;
}

export function resolveMessageStructuredReferences(
    input: Readonly<{ meta: unknown; text: string }>,
): readonly TranscriptStructuredReference[] {
    const envelope = readHappierStructuredInputV1FromMeta(input.meta);
    // D-4 precedence lives at one owner: with `mentions` present the legacy per-kind arrays
    // and meta-root aliases are ignored entirely.
    const { mentions } = readStructuredInputMentionSourcesV1(envelope);

    const references: TranscriptStructuredReference[] = [];
    const seen = new Set<string>();
    const add = (reference: TranscriptStructuredReference): void => {
        const identity = referenceIdentity(reference);
        if (seen.has(identity)) return;
        seen.add(identity);
        references.push(reference);
    };

    for (const mention of mentions) {
        // The kind decides first, and `readMentionRefOpaqueForKindV1` then requires the ref's
        // scheme to match that kind. A reference whose kind this build does not know — or whose
        // ref disagrees with its kind — produces no row instead of falling through to a known
        // kind (INV-4).
        if (mention.kind === MENTION_KIND_V1.session) {
            const sessionId = readMentionRefOpaqueForKindV1(MENTION_KIND_V1.session, mention.ref);
            if (sessionId !== null) add({ kind: 'session', sessionId, label: mention.label ?? null });
            continue;
        }
        if (mention.kind === MENTION_KIND_V1.file) {
            const path = readMentionRefOpaqueForKindV1(MENTION_KIND_V1.file, mention.ref);
            if (path !== null && isSafeWorkspaceRelativePath(path)) add({ kind: 'file', path });
        }
    }

    for (const path of extractWorkspaceFileMentions(input.text)) {
        add({ kind: 'file', path });
    }

    return references.length === 0 ? NO_REFERENCES : references;
}

/**
 * `enabled: false` is the streaming case: the agent block renders plain text while a turn is
 * still arriving, and a half-arrived path must not flash a chip.
 */
export function useMessageStructuredReferences(
    input: Readonly<{ meta: unknown; text: string; enabled?: boolean }>,
): readonly TranscriptStructuredReference[] {
    const enabled = input.enabled !== false;
    const meta = input.meta;
    const text = input.text;
    return React.useMemo(
        () => (enabled ? resolveMessageStructuredReferences({ meta, text }) : NO_REFERENCES),
        [enabled, meta, text],
    );
}
