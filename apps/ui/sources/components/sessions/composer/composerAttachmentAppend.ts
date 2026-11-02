import type { ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import { buildMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { INLINE_REFERENCE_ATTACHMENT_SCHEME_V1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { planComposerReferenceInsertion } from './composerReferenceInsertion';

/** Upload drafts live outside the portable document; their references belong to it. */
export type ComposerAttachmentInsertionItem = Readonly<{ draft: AttachmentDraft; note?: string }> | Readonly<{ text: string }>;

/** Append-only placement shared by existing and not-yet-created Session drafts. */
export function planComposerAttachmentAppend(input: Readonly<{
    snapshot: Pick<ComposerSnapshotV1, 'text' | 'references'>;
    items: readonly ComposerAttachmentInsertionItem[];
}>): Pick<ComposerSnapshotV1, 'text' | 'references'> {
    let text = input.snapshot.text;
    const references = [...input.snapshot.references];
    if (input.items.length > 0 && text.length > 0) text += '\n\n';
    for (const [index, item] of input.items.entries()) {
        if ('text' in item) {
            text += item.text;
            if (item.text && index < input.items.length - 1) text += '\n\n';
            continue;
        }
        const { draft } = item;
        const [edit, insertion] = planComposerReferenceInsertion({
            snapshot: { text, references, selection: { start: text.length, end: text.length } },
            at: { kind: 'caret' }, reference: { kind: INLINE_REFERENCE_ATTACHMENT_SCHEME_V1,
                ref: buildMentionRefV1(INLINE_REFERENCE_ATTACHMENT_SCHEME_V1, draft.id),
                label: draft.source.kind === 'web' ? draft.source.file.name : draft.source.name },
        });
        // The selected range is the end of this document, so no existing range is rebased.
        text += edit.text;
        references.push(insertion.reference);
        if (item.note) text += item.note + (index < input.items.length - 1 ? '\n\n' : '');
    }
    return { text, references };
}
