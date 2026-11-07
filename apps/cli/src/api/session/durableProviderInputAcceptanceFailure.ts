import { readHttpStatus } from '@/api/client/httpStatusError';

/** A refused read must settle as its transport failure, not wait for evidence. */
export function readDurableProviderInputAcceptanceFailure(error: unknown): 'unknown' {
    const status = readHttpStatus(error);
    if (status !== null && status >= 400 && status < 500) throw error;
    // Unavailable acceptance evidence never proves provider refusal.
    return 'unknown';
}
