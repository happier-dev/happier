import * as React from 'react';

import {
    readHappierStructuredInputV1FromMeta,
    type ComposerAttachmentInputV1,
} from '@happier-dev/protocol';

export type TranscriptComposerAttachment = Readonly<{
    instanceId: string;
    typeLabel: string;
    label: string;
    description: string | null;
    icon: string | null;
    tone: string | null;
}>;

const NO_COMPOSER_ATTACHMENTS: readonly TranscriptComposerAttachment[] = Object.freeze([]);

/**
 * The transcript only retains immutable, author-supplied presentation facts for
 * composer attachments. It neither resolves the attachment value nor invokes
 * plugin UI after admission.
 */
function projectTranscriptComposerAttachment(
    attachment: ComposerAttachmentInputV1,
): TranscriptComposerAttachment {
    return Object.freeze({
        instanceId: attachment.instanceId,
        typeLabel: attachment.presentation.typeLabel,
        label: attachment.presentation.label,
        description: attachment.presentation.description ?? null,
        icon: attachment.presentation.icon ?? null,
        tone: attachment.presentation.tone ?? null,
    });
}

export function resolveMessageComposerAttachments(meta: unknown): readonly TranscriptComposerAttachment[] {
    const attachments = readHappierStructuredInputV1FromMeta(meta)?.composerAttachments ?? [];
    return attachments.length === 0
        ? NO_COMPOSER_ATTACHMENTS
        : Object.freeze(attachments.map(projectTranscriptComposerAttachment));
}

export function useMessageComposerAttachments(meta: unknown): readonly TranscriptComposerAttachment[] {
    return React.useMemo(() => resolveMessageComposerAttachments(meta), [meta]);
}
