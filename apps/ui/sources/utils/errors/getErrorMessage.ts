import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import { t } from '@/text';

export function getErrorMessage(err: unknown): string {
    if (err === null || err === undefined) return '';

    if (typeof err === 'string') return err;

    if (isRpcMethodNotAvailableError(err)) {
        return t('errors.daemonUnavailableBody');
    }

    if (err instanceof Error) {
        // Error.message is often the most user-meaningful; fall back to String(err) for empty messages.
        return err.message || String(err);
    }

    if (typeof err === 'object') {
        const maybeMessage = (err as { message?: unknown }).message;
        if (typeof maybeMessage === 'string') return maybeMessage;
    }

    return String(err);
}
