import type { ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import { buildMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { INLINE_REFERENCE_ATTACHMENT_SCHEME_V1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';

/** Only exact, typed occurrences belong to a tray item; lookalike text stays text. */
export function planComposerAttachmentReferenceRemoval(
    snapshot: Pick<ComposerSnapshotV1, 'text' | 'references'>,
    attachmentIds: readonly string[],
): Array<{ kind: 'text.replaceRange'; range: { start: number; end: number }; text: string }> {
    const refs = new Set(attachmentIds.map((id) => buildMentionRefV1(INLINE_REFERENCE_ATTACHMENT_SCHEME_V1, id)));
    return snapshot.references.flatMap((reference) => (
        refs.has(reference.ref)
        && snapshot.text.slice(reference.start, reference.end) === reference.token
            ? [{ kind: 'text.replaceRange' as const, range: { start: reference.start, end: reference.end }, text: '' }]
            : []
    ));
}
