import type { AttachmentDraft } from './attachmentDraftModel';

type RecoverableFollowUpPayloadLike = Readonly<{
    draftText?: string;
    displayText?: string | null;
    metaOverrides?: Record<string, unknown> | null;
    profileId?: string | null;
    attachmentDrafts?: readonly AttachmentDraft[] | null;
}>;

type RecoverableFollowUpErrorLike = Error & {
    recoverableFollowUpPayload?: RecoverableFollowUpPayloadLike;
};

export function attachRecoverableAttachmentDrafts(
    error: unknown,
    payload: Readonly<{
        draftText: string;
        displayText?: string | null;
        metaOverrides?: Record<string, unknown> | null;
        profileId?: string | null;
        attachmentDrafts: readonly AttachmentDraft[];
    }>,
): unknown {
    if (!(error instanceof Error)) {
        return error;
    }

    const decoratedError = error as RecoverableFollowUpErrorLike;
    const existingPayload = decoratedError.recoverableFollowUpPayload ?? {};
    decoratedError.recoverableFollowUpPayload = {
        draftText: typeof existingPayload.draftText === 'string' && existingPayload.draftText.trim().length > 0
            ? existingPayload.draftText
            : payload.draftText,
        displayText: existingPayload.displayText ?? payload.displayText,
        metaOverrides: existingPayload.metaOverrides ?? payload.metaOverrides,
        profileId: existingPayload.profileId ?? payload.profileId,
        attachmentDrafts: payload.attachmentDrafts,
    };
    return decoratedError;
}

export function readRecoverableAttachmentDrafts(error: unknown): readonly AttachmentDraft[] | null {
    if (!(error instanceof Error)) {
        return null;
    }

    const payload = (error as RecoverableFollowUpErrorLike).recoverableFollowUpPayload;
    return Array.isArray(payload?.attachmentDrafts) ? payload.attachmentDrafts : null;
}
