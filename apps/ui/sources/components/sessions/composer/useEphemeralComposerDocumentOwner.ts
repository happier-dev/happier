import type { ComposerCapabilitiesV1, ComposerRefV1 } from '@happier-dev/protocol';
import * as React from 'react';

import {
    createEphemeralComposerDocumentOwner,
    sameComposerDocumentRef,
    type ComposerDraftDocument,
    type MutableComposerDocumentOwner,
} from './composerDocumentOwner';

/**
 * React lifetime adapter for participant and automation composers. It keeps
 * semantic revision ownership in the document owner while React owns only the
 * render subscription and the current callback closures.
 */
export function useEphemeralComposerDocumentOwner(input: Readonly<{
    ref: ComposerRefV1;
    capabilities: ComposerCapabilitiesV1;
    initialDocument?: ComposerDraftDocument;
    isCurrent?: () => boolean;
    onDocumentChange?: (document: ComposerDraftDocument) => void;
}>): MutableComposerDocumentOwner {
    const latestInputRef = React.useRef(input);
    latestInputRef.current = input;
    const stateRef = React.useRef<Readonly<{
        ref: ComposerRefV1;
        owner: MutableComposerDocumentOwner;
    }> | null>(null);
    if (!stateRef.current || !sameComposerDocumentRef(stateRef.current.ref, input.ref)) {
        const owner = createEphemeralComposerDocumentOwner({
            ref: input.ref,
            capabilities: input.capabilities,
            ...(input.initialDocument ? { initialDocument: input.initialDocument } : {}),
            isCurrent: () => latestInputRef.current.isCurrent?.() ?? true,
            onDocumentChange: (document) => latestInputRef.current.onDocumentChange?.(document),
        });
        stateRef.current = { ref: input.ref, owner };
    }
    const owner = stateRef.current.owner;
    React.useSyncExternalStore(owner.observe, () => owner.read().revision, () => owner.read().revision);
    return owner;
}
