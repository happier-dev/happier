import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import { canResumeOrContinueSessionWithOptions } from '@/agents/runtime/resumeCapabilities';
import type { Session } from '@/sync/domains/state/storageTypes';
import { HappyError } from '@/utils/errors/errors';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export const SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE = 'SESSION_NOT_RESUMABLE';

export type SessionMessageSendEligibilityOptions = Readonly<{
    resumeCapabilityOptions?: ResumeCapabilityOptions;
}>;

export function canSendUserMessageToSession(
    session: Pick<Session, 'active' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView'>,
    options?: SessionMessageSendEligibilityOptions,
): boolean {
    if (session.active === true) {
        return true;
    }

    return canResumeOrContinueSessionWithOptions(
        readSessionOwnerMetadataView(session),
        options?.resumeCapabilityOptions,
    );
}

export function createSessionMessageSendNotResumableError(): HappyError {
    return new HappyError(
        'This inactive session cannot be resumed, so the message was not sent.',
        false,
        { kind: 'config', code: SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE },
    );
}

export function assertCanSendUserMessageToSession(
    session: Pick<Session, 'active' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView'>,
    options?: SessionMessageSendEligibilityOptions,
): void {
    if (!canSendUserMessageToSession(session, options)) {
        throw createSessionMessageSendNotResumableError();
    }
}
