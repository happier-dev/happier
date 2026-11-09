import * as React from 'react';

import { readHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/sessions/userMessageRpc';
import type { ComposerAttachmentInputV1 } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import type { MessageStructuredReferences } from '../references/messageStructuredReferences';

export type TranscriptComposerAttachment = Readonly<{
    instanceId: string;
    typeLabel: string;
    label: string;
    description: string | null;
    icon: string | null;
    tone: string | null;
    source?: SessionMessageRefV1;
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
        ...(attachment.presentation.source ? { source: attachment.presentation.source } : {}),
    });
}

export function resolveMessageComposerAttachments(meta: unknown, inline?: MessageStructuredReferences['inline']): readonly TranscriptComposerAttachment[] {
    const placed = new Set(Array.from(inline?.values() ?? []).flatMap(reference => reference.attachmentId ? [reference.attachmentId] : []));
    const attachments = readHappierStructuredInputV1FromMeta(meta)?.composerAttachments ?? [];
    const unplaced = attachments.filter(attachment => !placed.has(attachment.instanceId));
    return unplaced.length === 0
        ? NO_COMPOSER_ATTACHMENTS
        : Object.freeze(unplaced.map(projectTranscriptComposerAttachment));
}

export function useMessageComposerAttachments(meta: unknown, inline?: MessageStructuredReferences['inline']): readonly TranscriptComposerAttachment[] {
    return React.useMemo(() => resolveMessageComposerAttachments(meta, inline), [meta, inline]);
}
