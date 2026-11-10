function readStructuredEnvelope(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const envelope = meta?.happierStructuredInputV1;
    return envelope && typeof envelope === 'object' && !Array.isArray(envelope)
        ? envelope as Record<string, unknown>
        : {};
}

function mergeArrays(left: unknown, right: unknown): unknown[] | undefined {
    const out = [
        ...(Array.isArray(left) ? left : []),
        ...(Array.isArray(right) ? right : []),
    ];
    return out.length > 0 ? out : undefined;
}

/** Compose producer-owned raw metadata; ingress admission owns validation. */
export function mergeMessageMetaOverrides(
    left?: Record<string, unknown> | null,
    right?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
    if (!left && !right) return undefined;
    const merged: Record<string, unknown> = {
        ...(left ?? {}),
        ...(right ?? {}),
    };
    const leftEnvelope = readStructuredEnvelope(left);
    const rightEnvelope = readStructuredEnvelope(right);
    const mentions = mergeArrays(leftEnvelope.mentions, rightEnvelope.mentions);
    const vendorPluginMentions = mergeArrays(leftEnvelope.vendorPluginMentions, rightEnvelope.vendorPluginMentions);
    const skillMentions = mergeArrays(leftEnvelope.skillMentions, rightEnvelope.skillMentions);
    const composerAttachments = mergeArrays(leftEnvelope.composerAttachments, rightEnvelope.composerAttachments);
    const sessionAttachments = mergeArrays(leftEnvelope.sessionAttachments, rightEnvelope.sessionAttachments);
    const sessionDiscussionSelectionSourceV1 = rightEnvelope.sessionDiscussionSelectionSourceV1
        ?? leftEnvelope.sessionDiscussionSelectionSourceV1;
    const imageInputs = mergeArrays(
        [...(Array.isArray(leftEnvelope.imageInputs) ? leftEnvelope.imageInputs : []), ...(Array.isArray(leftEnvelope.attachments) ? leftEnvelope.attachments : [])],
        [...(Array.isArray(rightEnvelope.imageInputs) ? rightEnvelope.imageInputs : []), ...(Array.isArray(rightEnvelope.attachments) ? rightEnvelope.attachments : [])],
    );

    if (Object.keys(leftEnvelope).length > 0 || Object.keys(rightEnvelope).length > 0) {
        const envelope: Record<string, unknown> = {
            ...leftEnvelope,
            ...rightEnvelope,
            v: 1,
            ...(mentions ? { mentions } : {}),
            ...(vendorPluginMentions ? { vendorPluginMentions } : {}),
            ...(skillMentions ? { skillMentions } : {}),
            ...(imageInputs ? { imageInputs } : {}),
            ...(composerAttachments ? { composerAttachments } : {}),
            ...(sessionAttachments ? { sessionAttachments } : {}),
            ...(sessionDiscussionSelectionSourceV1 ? { sessionDiscussionSelectionSourceV1 } : {}),
        };
        delete envelope.attachments;
        merged.happierStructuredInputV1 = envelope;
    }

    return merged;
}
