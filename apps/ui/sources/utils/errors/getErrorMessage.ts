import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { t } from '@/text';

export function getErrorMessage(err: unknown): string {
    if (err === null || err === undefined) return '';

    if (typeof err === 'string') return err;

    if (err instanceof Error) {
        const rpcErrorCode = (err as any).rpcErrorCode;
        if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
            return t('errors.daemonUnavailableBody');
        }
        // Error.message is often the most user-meaningful; fall back to String(err) for empty messages.
        return err.message || String(err);
    }

    if (typeof err === 'object') {
        const rpcErrorCode = (err as any).rpcErrorCode;
        if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
            return t('errors.daemonUnavailableBody');
        }
        const maybeMessage = (err as any).message;
        if (typeof maybeMessage === 'string') return maybeMessage;
    }

    return String(err);
}
