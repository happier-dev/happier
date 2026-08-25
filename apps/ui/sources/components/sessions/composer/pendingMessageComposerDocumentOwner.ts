import type { ComposerCapabilitiesV1, ComposerRefV1 } from '@happier-dev/protocol';

import {
    createEphemeralComposerDocumentOwner,
    type ComposerDraftDocument,
    type MutableComposerDocumentOwner,
} from './composerDocumentOwner';

const CAPABILITIES: ComposerCapabilitiesV1 = Object.freeze({
    text: true,
    references: true,
    attachments: true,
    submit: true,
});

export function createPendingMessageComposerDocumentOwner(input: Readonly<{
    ref: Extract<ComposerRefV1, { kind: 'pendingMessage' }>;
    initialDocument: ComposerDraftDocument;
    isCurrent: () => boolean;
}>): MutableComposerDocumentOwner {
    return createEphemeralComposerDocumentOwner({
        ref: input.ref,
        capabilities: CAPABILITIES,
        initialDocument: input.initialDocument,
        isCurrent: input.isCurrent,
    });
}
