import { getErrorMessage } from '@/utils/errors/getErrorMessage';

export function formatVoiceTestFailureMessage(baseMessage: string, err: unknown): string {
    const details = getErrorMessage(err).trim();
    return details ? `${baseMessage}\n\n${details}` : baseMessage;
}

