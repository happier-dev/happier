import { createConnectedAccountAttemptTransactionApi, createConnectedAccountAttemptTransactionAdapters, generatePkceCodes } from '@happier-dev/cli-common/connectedAccounts';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { digest } from '@/platform/digest';
import { createUiConnectedAccountContent } from './connectedAccountContent';

/** The existing transaction API over the invocation's captured Home transport. */
export function createUiConnectedAccountAttemptTransactionApi(account: LazyActionAccountContext, signal?: AbortSignal) {
    return createConnectedAccountAttemptTransactionApi({
        token: account.credentials.token,
        baseUrl: account.endpointUrl,
        http: {
            request: (input, options) => withActionAccountRequestSignal(account, options?.signal ?? signal, async ownedSignal => {
                // The shared API builds Home URLs; the captured Account transport owns
                // the actual address (which may be a local or Iroh carrier).
                const url = new URL(input.url);
                const response = await account.request(url.pathname + url.search, {
                    method: input.method,
                    headers: input.headers,
                    ...(input.body ? { body: new Uint8Array(input.body) } : {}),
                    redirect: input.redirect,
                    signal: ownedSignal,
                }, { includeAuth: false, retry: 'none' });
                const body = new Uint8Array(await response.arrayBuffer());
                return { status: response.status, finalUrl: response.url || input.url,
                    headers: Object.fromEntries(response.headers.entries()), body };
            }),
        },
    });
}

/** Browser/native crypto adapt the same durable PKCE/device transaction policy. */
export function createUiConnectedAccountAttemptTransactions(account: LazyActionAccountContext, signal?: AbortSignal) {
    const content = createUiConnectedAccountContent(account);
    const api = createUiConnectedAccountAttemptTransactionApi(account, signal);
    return { api, transactions: createConnectedAccountAttemptTransactionAdapters({
        api,
        randomBytes: getRandomBytes,
        generatePkceCodes: () => generatePkceCodes({ randomBytes: getRandomBytes, sha256: bytes => digest('SHA-256', bytes) }),
        seal: async payload => content.seal('attempt', await content.resolveAccountMode('fresh-authority'), payload),
        open: async record => {
            const opened = content.open('attempt', await content.resolveAccountMode(), record.content);
            if (opened === null) throw new Error('connected_account_attempt_transaction_unreadable');
            return opened;
        },
    }) };
}
