import { createConnectedAccountAttemptTransactionApi as createPortableTransactionApi } from '@happier-dev/cli-common/connectedAccounts';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';
import { resolveConnectedServicesServerApiTimeoutMs } from './connectedServicesServerApiTimeout';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export type {
  ConnectedAccountAttemptTransactionKind,
  ConnectedAccountAttemptTransactionScope,
  PendingConnectedAccountAttemptTransaction,
  ConnectedAccountAttemptTransactionRecord,
  ConnectedAccountAttemptTransactionStoreApi,
  ConnectedAccountAttemptTransactionApiErrorCode,
} from '@happier-dev/cli-common/connectedAccounts';
export { ConnectedAccountAttemptTransactionApiError } from '@happier-dev/cli-common/connectedAccounts';

export function createConnectedAccountAttemptTransactionApi(params: Readonly<{ token: string }>) {
  return createPortableTransactionApi({
    token: params.token,
    baseUrl: resolveServerHttpBaseUrl(),
    headers: buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    timeoutMs: resolveConnectedServicesServerApiTimeoutMs(),
    http: {
      async request(input) {
        const options = {
          headers: input.headers,
          timeout: input.timeoutMs,
          maxRedirects: 0,
          validateStatus: (status: number) => status === 200 || status === 404 || status === 409,
        };
        const body: unknown = input.body === undefined ? undefined : JSON.parse(new TextDecoder().decode(input.body));
        const response = input.method === 'POST'
          ? await axios.post(input.url, body, options)
          : input.method === 'PATCH'
            ? await axios.patch(input.url, body, options)
            : input.method === 'DELETE'
              ? await axios.delete(input.url, { ...options, data: body })
              : await axios.get(input.url, options);
        return { status: response.status, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(response.data)) };
      },
    },
  });
}
