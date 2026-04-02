import { sanitizeEndpointErrorMessage } from './sanitizeEndpointErrorMessage';

export function resolveSocketErrorClassification(
    error: unknown,
): Readonly<{
    message: string;
    statusCode: number | null;
    kind: 'auth' | 'unknown';
    retryable: boolean;
}> {
    const rawMessage = error instanceof Error ? error.message : String(error);
    let message = sanitizeEndpointErrorMessage(rawMessage) ?? rawMessage;
    if (message.trim().toLowerCase() === 'xhr poll error') {
        message = 'Connection error';
    }
    const data = error && typeof error === 'object' ? (error as any).data : null;
    const candidateStatusCode = data && typeof data === 'object'
        ? (typeof (data as any).statusCode === 'number'
            ? (data as any).statusCode
            : typeof (data as any).status === 'number'
              ? (data as any).status
              : null)
        : null;
    const statusCode = typeof candidateStatusCode === 'number' ? candidateStatusCode : null;
    const kind: 'auth' | 'unknown' = statusCode === 401 || statusCode === 403 ? 'auth' : 'unknown';
    return {
        message,
        statusCode,
        kind,
        retryable: kind !== 'auth',
    };
}
