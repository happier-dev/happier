import type {
    ComposerAttachmentViewV1,
    ComposerInputLockSnapshotV1,
    ComposerSnapshotV1,
} from '@happier-dev/protocol';

import type { ComposerAttachmentAvailabilityCatalog } from './composerScopeAdapters';
import {
    composerAttachmentDraftToView,
    composerReferencesFromStructuredMentions,
} from './composerScopeAdapters';
import type { ComposerDocumentOwner } from './composerDocumentOwner';

export type ComposerSnapshotPresentationState = Readonly<{
    layout: ComposerSnapshotV1['layout'];
    focused: boolean;
    editable: boolean;
    submittable: boolean;
    submitting: boolean;
    running: boolean;
    inputLock?: ComposerInputLockSnapshotV1;
    selection?: NonNullable<ComposerSnapshotV1['selection']>;
}>;

/**
 * Projects one semantic owner document into the public presentation snapshot.
 * Focus, layout, locks, availability, and execution state remain read-only
 * presentation inputs and can never flow back into persisted draft bytes.
 */
export function projectComposerDocumentSnapshot(input: Readonly<{
    owner: ComposerDocumentOwner;
    presentation: ComposerSnapshotPresentationState;
    attachmentCatalog: ComposerAttachmentAvailabilityCatalog;
}>): ComposerSnapshotV1 {
    const { document, revision } = input.owner.read();
    const attachments: readonly ComposerAttachmentViewV1[] = document.composerAttachments.map((attachment) => (
        composerAttachmentDraftToView(attachment, input.attachmentCatalog)
    ));
    return {
        revision,
        ref: input.owner.ref,
        text: document.text,
        ...(input.presentation.selection ? { selection: input.presentation.selection } : {}),
        references: [...composerReferencesFromStructuredMentions({
            text: document.text,
            mentions: document.structuredInputMentions,
        })],
        attachments: [...attachments],
        layout: input.presentation.layout,
        capabilities: input.owner.capabilities,
        state: {
            focused: input.presentation.focused,
            editable: input.presentation.editable,
            submittable: input.presentation.submittable,
            submitting: input.presentation.submitting,
            running: input.presentation.running,
            ...(input.presentation.inputLock ? { inputLock: input.presentation.inputLock } : {}),
        },
    };
}
