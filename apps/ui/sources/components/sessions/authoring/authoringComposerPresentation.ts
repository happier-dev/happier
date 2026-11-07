import type { ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';

import { projectComposerDocumentSnapshot } from '@/components/sessions/composer/composerSnapshotProjection';
import type { MutableComposerDocumentOwner } from '@/components/sessions/composer/composerDocumentOwner';
import {
    registerComposerPresentationTarget,
    notifyComposerPresentationTargetChanged,
    type ComposerPresentationAttachmentComposition,
    type ComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import type { AuthoringComposerSelection } from './authoringComposerCustody';

/** One registration for the document's lifetime; mounted inputs supply only current presentation. */
export function createAuthoringComposerPresentation(input: Readonly<{
    owner: MutableComposerDocumentOwner;
    isCurrent: () => boolean;
    readScope: () => ServerAccountScope | null;
    readSelection: () => AuthoringComposerSelection | null;
    synchronizeDocument: () => void;
    readAttachmentComposition: () => ComposerPresentationAttachmentComposition | null;
    focus: () => void;
    editable: () => boolean;
    presented: () => boolean;
}>): Readonly<{
    mount(presentation: ComposerPresentationTarget): () => void;
    dispose(): void;
}> {
    let mounted: ComposerPresentationTarget | null = null;
    let layout: ComposerSnapshotV1['layout'] = 'wrap';
    const readOwner = () => {
        if (mounted === null) input.synchronizeDocument();
        return input.owner;
    };
    const target: ComposerPresentationTarget = {
        isCurrent: input.isCurrent,
        readScope: input.readScope,
        isPresented: () => mounted?.isPresented?.() ?? input.presented(),
        readRevision: () => readOwner().read().revision,
        replace: (text, expectedRevision) => {
            const owner = readOwner();
            if (owner.read().revision !== expectedRevision) return owner.read().revision;
            return owner.replaceDocument({ ...owner.read().document, text });
        },
        readSnapshot: () => {
            if (mounted?.readSnapshot) return mounted.readSnapshot();
            const owner = readOwner();
            const selection = input.readSelection();
            return projectComposerDocumentSnapshot({ owner,
                attachmentCatalog: { entriesById: input.readAttachmentComposition()?.composerAttachmentsById },
                presentation: { layout, focused: false, editable: input.editable(), submittable: false,
                    submitting: false, running: false, ...(selection === null ? {} : { selection }) },
            });
        },
        readAttachmentComposition: () => mounted !== null
            ? mounted.readAttachmentComposition?.() ?? null : input.readAttachmentComposition(),
        commitDocument: ({ expectedRevision, mutation }) => readOwner().apply(expectedRevision, mutation),
        commitDocumentEmitsChange: true,
        ...(input.owner.capabilities.attachments ? { createAttachmentInstanceId: randomUUID } : {}),
        focusComposer: () => {
            if (mounted?.focusComposer) return mounted.focusComposer();
            if (!input.editable()) return false;
            input.focus();
            return true;
        },
        setComposerDecorations: update => mounted?.setComposerDecorations?.(update),
        acquireComposerInputLock: lease => mounted?.acquireComposerInputLock?.(lease) ?? (() => {}),
    };
    let unregister: (() => void) | null = null;
    return {
        mount(presentation: ComposerPresentationTarget): () => void {
            mounted = presentation;
            if (unregister === null) unregister = registerComposerPresentationTarget(input.owner.ref, target);
            else notifyComposerPresentationTargetChanged(input.owner.ref);
            return () => {
                if (mounted !== presentation) return;
                layout = presentation.readSnapshot?.().layout ?? layout;
                mounted = null;
                notifyComposerPresentationTargetChanged(input.owner.ref);
            };
        },
        dispose: () => { unregister?.(); unregister = null; },
    };
}
