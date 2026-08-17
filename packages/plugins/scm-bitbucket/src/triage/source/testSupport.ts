import type {
  ConnectedAccountsService,
  ConnectedAccountListedState,
  QualifiedConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

import type { BitbucketSourceRuntime } from './authorization.js';

/**
 * Boundary doubles for the two genuine system boundaries these tests cross: provider HTTP and the
 * host-owned Connected Accounts service. Everything below them — request construction, pagination,
 * decoding, identity, mapping, evidence, and token codecs — runs for real.
 */
export type StubReply = Readonly<{
  status?: number;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
}>;

export type StubRequest = Readonly<{ url: string; headers: Readonly<Record<string, string>> }>;

export function createHttpStub(
  route: (url: string) => StubReply | undefined,
): Readonly<{ http: HttpService; requests: StubRequest[] }> {
  const requests: StubRequest[] = [];
  const http = {
    async request(input: Parameters<HttpService['request']>[0]) {
      requests.push({ url: input.url, headers: { ...input.headers } });
      const reply = route(input.url) ?? { status: 404, body: { error: { message: 'not routed' } } };
      return {
        status: reply.status ?? 200,
        finalUrl: input.url,
        headers: reply.headers ?? {},
        body: new TextEncoder().encode(
          reply.body === undefined ? '' : JSON.stringify(reply.body),
        ),
      };
    },
  } as unknown as HttpService;
  return { http, requests };
}

export const TEST_SERVICE_REF = Object.freeze({
  pluginId: 'happier.scm.forge.bitbucket',
  localId: 'bitbucket-account',
});

export function accountRef(accountId: string): QualifiedConnectedAccountRef {
  return { service: TEST_SERVICE_REF, accountId } as QualifiedConnectedAccountRef;
}

export type StubAccount = Readonly<{
  accountId: string;
  state?: ConnectedAccountListedState;
  materializationError?: unknown;
}>;

export function createConnectedAccountsStub(
  input: Readonly<{
    accounts: readonly StubAccount[];
    status?: 'complete' | 'truncated';
    listError?: unknown;
  }>,
): Readonly<{ connectedAccounts: ConnectedAccountsService; materializations: string[] }> {
  const materializations: string[] = [];
  const connectedAccounts = {
    async listAccounts() {
      if (input.listError !== undefined) throw input.listError;
      return {
        status: input.status ?? 'complete',
        accounts: input.accounts.map((account) => ({
          account: accountRef(account.accountId),
          displayName: account.accountId,
          state: account.state ?? 'connected',
          connectedAccountOrigins: [],
          connectedAccountBases: [],
        })),
      };
    },
    async materializeListedAccount(request: Readonly<{ account: QualifiedConnectedAccountRef }>) {
      const account = input.accounts.find(
        (candidate) => candidate.accountId === request.account.accountId,
      );
      if (account?.materializationError !== undefined) throw account.materializationError;
      materializations.push(request.account.accountId);
      return {
        kind: 'httpHeaders' as const,
        headers: { Authorization: `Basic test-${request.account.accountId}` },
      };
    },
  } as unknown as ConnectedAccountsService;
  return { connectedAccounts, materializations };
}

export function createRuntime(
  connectedAccounts: ConnectedAccountsService,
  http: HttpService,
): BitbucketSourceRuntime {
  return { connectedAccounts, http, now: () => 1_760_000_000_000 };
}

/**
 * The host invocation context a bound Action receives.
 *
 * It carries only the two boundary doubles and a signal, because that is all a
 * source Action may reach. Everything below it — admission, route construction,
 * pagination, projection and the published result schema — runs for real.
 */
export function createInvocationContext(
  connectedAccounts: ConnectedAccountsService,
  http: HttpService,
  signal: AbortSignal = new AbortController().signal,
): PluginInvocationContext {
  return {
    plugin: { id: TEST_SERVICE_REF.pluginId, version: '0.0.0' },
    contribution: {
      id: 'bitbucket-cloud',
      qualifiedId: `${TEST_SERVICE_REF.pluginId}/contributions/bitbucket-cloud`,
    },
    surface: 'background',
    caller: {
      kind: 'plugin',
      pluginId: 'happier.triage',
      contribution: { id: 'sources', qualifiedId: 'happier.triage/points/sources' },
    },
    signal,
    services: { connectedAccounts, http } as unknown as PluginInvocationContext['services'],
  } as unknown as PluginInvocationContext;
}
