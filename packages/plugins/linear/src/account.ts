import type { ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ConnectedAccountRuntime, ConnectedAccountHealthResult } from '@happier-dev/plugin-sdk/connected-accounts';
import { LINEAR_ORIGIN, LINEAR_PERSONAL_KEY } from './contracts.js';
import { LinearRequestError, requestLinearGraphql, record } from './api.js';

const EMPTY_HEADERS: Readonly<Record<string, string>> = Object.freeze({});
type AccountContext = Parameters<ConnectedAccountRuntime['status']>[0];
const unavailable = { code: 'linear/verificationUnavailable', severity: 'error' as const, message: 'Linear could not confirm this connection. Try again when it is reachable.' };
const rejected = { code: 'linear/credentialRejected', severity: 'error' as const, message: 'Linear rejected this personal API key. Check its access and try again.' };

async function verify(authorization: string, context: { services: Pick<AccountContext['services'], 'http'>; signal: AbortSignal }) {
  const result = await requestLinearGraphql({ context, authorization, operationName: 'LinearAccount',
    query: 'query LinearAccount { viewer { id name } }' });
  const viewer = record(result.viewer);
  if (typeof viewer.id !== 'string' || typeof viewer.name !== 'string') throw new Error('linear/accountInvalid');
  return { id: viewer.id, name: viewer.name };
}

async function health(context: AccountContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
  const key = (await context.credentials.get(LINEAR_PERSONAL_KEY, options))?.trim();
  if (!key) return { status: 'reconnectRequired', diagnostic: rejected };
  const signal = options?.signal ?? context.signal;
  try {
    const viewer = await verify(key, { services: context.services, signal });
    return { status: 'connected', displayName: viewer.name };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof LinearRequestError && error.failure.class === 'authentication') return { status: 'reconnectRequired', diagnostic: rejected };
    return { status: 'unavailable', diagnostic: unavailable };
  }
}

const materializeLinearCredentials: NonNullable<ConnectedAccountPortableRuntime['materialize']> = async (request, context, options) => {
    if (request.kind !== 'httpHeaders' || request.origin !== LINEAR_ORIGIN) throw new Error('linear/materializationUnsupported');
    if (!request.headerNames.some((header) => header.toLowerCase() === 'authorization')) return { kind: 'httpHeaders', headers: EMPTY_HEADERS };
    const key = (await context.credentials.get(LINEAR_PERSONAL_KEY, options))?.trim();
    if (!key) throw new Error('linear/credentialsUnavailable');
    // Personal API keys are the Authorization value itself, without Bearer.
    // https://linear.app/developers/graphql#authentication
    return { kind: 'httpHeaders', headers: { authorization: key } };
  };

export const linearConnectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { [LINEAR_PERSONAL_KEY]: {
    kind: 'manual',
    async complete(input, context, options) {
      const key = input.fields[LINEAR_PERSONAL_KEY]?.trim();
      if (!key) return { status: 'rejected', diagnostic: rejected };
      const signal = options?.signal ?? context.signal;
      try {
        const viewer = await verify(key, { services: context.services, signal });
        await context.attemptCredentials.set(LINEAR_PERSONAL_KEY, key, { signal });
        return { status: 'connected', accountId: viewer.id, displayName: viewer.name, scopes: [] };
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof LinearRequestError && error.failure.class === 'authentication') return { status: 'rejected', diagnostic: rejected };
        return { status: 'unavailable', diagnostic: unavailable };
      }
    },
  } } },
  status: health,
  refresh: health,
  async revoke() { return { status: 'remoteUnsupported' }; },
  materialize: materializeLinearCredentials,
};

export const linearPortableAccountRuntime: ConnectedAccountPortableRuntime = {
    authentication: linearConnectedAccountRuntime.authentication,
    materialize: materializeLinearCredentials,
};
