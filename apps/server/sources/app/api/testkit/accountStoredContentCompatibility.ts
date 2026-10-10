import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    buildAccountStoredContentCompatibilitySocketAuthV1,
} from "@happier-dev/protocol";
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';

export const currentAccountStoredContentCompatibilityHeaders =
    buildAccountStoredContentCompatibilityHttpHeadersV1(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    );

export const currentAccountStoredContentCompatibilitySocketAuth =
    buildAccountStoredContentCompatibilitySocketAuthV1(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    );

/** Apply the real connect-time declaration parser to a Socket.IO boundary fixture. */
export function qualifyCurrentAccountStoredContentSocket(socket: { data?: Record<string, unknown> }): void {
    writeAccountStoredContentCompatibilityForSocket({ data: socket.data ??= {} },
        evaluateAccountStoredContentSocketCompatibility(currentAccountStoredContentCompatibilitySocketAuth));
}
