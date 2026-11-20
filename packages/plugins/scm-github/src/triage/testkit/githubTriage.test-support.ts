import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginInvocationContext, PluginReference } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef, ConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';

import {
  createGithubListedAccountApiClient,
  type GithubApiMediaClientV1,
} from '../../observations/githubApiClient.js';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_FIXTURE_OTHER_REPOSITORY,
  GITHUB_FIXTURE_OTHER_REPOSITORY_ID,
  GITHUB_REPOSITORY_RESPONSE,
} from '../__fixtures__/githubResponses.js';

/**
 * Test support for the GitHub Triage vertical.
 *
 * The mock sits at the genuine system boundary — the host HTTP service and the generic
 * Connected Accounts service — so the real API client runs beneath every test: origin
 * pinning, reserved-header stripping, one materialization per invocation, and the real
 * rate-limit classifier. Nothing in `triage/` is stubbed.
 */

export const GITHUB_TEST_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'account-under-test',
});

export type RecordedGithubRequest = Readonly<{
  url: string;
  method: string;
  headers: Readonly<Record<string, string>>;
  redirect: 'error' | 'follow' | 'manual';
  /**
   * The exact bytes the boundary received. A write test asserts the body GitHub
   * would actually be sent — the whole point of the delta/precondition rules is
   * WHAT is transmitted, and a test that only checks the URL and verb proves none
   * of it.
   */
  body?: Uint8Array;
}>;

/** Decodes a recorded write body for assertion. */
export function readRecordedJsonBody(request: RecordedGithubRequest): unknown {
  if (request.body === undefined) return undefined;
  return JSON.parse(new TextDecoder().decode(request.body)) as unknown;
}

export type StubHttpResponse = Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  /** Raw body, when the test needs a non-JSON payload. */
  rawBody?: Uint8Array;
}>;

/** Synthetic GitHub GraphQL boundary shape; production traversal/projectors stay real. */
/**
 * GitHub's `StatusCheckRollupContextConnection` counts for the same contexts a node
 * page would list: a Check Run counts under its conclusion once completed and under
 * its status before that; a commit status counts under its state.
 */
export function githubChecksRollupCounts(nodes: readonly unknown[]): Readonly<{
  checkRunCountsByState: readonly Readonly<{ state: string; count: number }>[];
  statusContextCountsByState: readonly Readonly<{ state: string; count: number }>[];
}> {
  const runs = new Map<string, number>();
  const statuses = new Map<string, number>();
  for (const raw of nodes) {
    const node = raw as Readonly<Record<string, unknown>>;
    if (node.__typename === 'CheckRun') {
      const state = String(node.status) === 'COMPLETED' ? String(node.conclusion ?? 'COMPLETED') : String(node.status);
      runs.set(state, (runs.get(state) ?? 0) + 1);
    } else if (node.__typename === 'StatusContext') {
      statuses.set(String(node.state), (statuses.get(String(node.state)) ?? 0) + 1);
    }
  }
  const list = (counts: Map<string, number>) => [...counts].map(([state, count]) => ({ state, count }));
  return { checkRunCountsByState: list(runs), statusContextCountsByState: list(statuses) };
}

export function githubChecksBatchResponse(request: RecordedGithubRequest, input: Readonly<{
  nodes?: readonly unknown[];
  errors?: readonly unknown[];
  pullRequest?: unknown;
  reviewDecision?: string;
}> = {}): StubHttpResponse {
  // The test HTTP boundary carries the exact GraphQL variables production serialized,
  // and answers the connection shape the query selected: node pages or state counts.
  const { query, variables } = readRecordedJsonBody(request) as { query: string; variables: Record<string, unknown> };
  const counts = query.includes('checkRunCountsByState');
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(variables).filter(key => key.startsWith('owner'))) {
    const index = key.slice('owner'.length);
    data[`row${index}`] = {
      databaseId: Number(variables[`name${index}`] === GITHUB_FIXTURE_OTHER_REPOSITORY
        ? GITHUB_FIXTURE_OTHER_REPOSITORY_ID : GITHUB_FIXTURE_REPOSITORY_ID),
      ...(variables[`number${index}`] === undefined ? {} : { pullRequest: input.pullRequest === undefined ? {
        ...(input.reviewDecision === undefined ? {} : { reviewDecision: input.reviewDecision }),
        headRefOid: 'a'.repeat(40), commits: { nodes: [{ commit: {
          oid: 'a'.repeat(40), statusCheckRollup: { contexts: counts ? githubChecksRollupCounts(input.nodes ?? []) : {
            nodes: input.nodes ?? [], pageInfo: { hasNextPage: false, endCursor: null },
          } },
        } }] },
      } : input.pullRequest }),
    };
  }
  return { status: 200, body: { data, ...(input.errors === undefined ? {} : { errors: input.errors }) } };
}

/** One exact-account materialization request the boundary actually received. */
export type RecordedMaterialization = Readonly<{
  purpose: string;
  account: ConnectedAccountRef;
  materialization: Readonly<Record<string, unknown>>;
}>;

/** The bounded metadata listing the generic Connected Accounts owner answers with. */
export type StubConnectedAccountListing = Readonly<{
  status: 'complete' | 'truncated';
  accounts: readonly Readonly<{
    account: ConnectedAccountRef;
    displayName: string;
    state: 'connected' | 'expired' | 'reconnectRequired' | 'unavailable';
    connectedAccountOrigins: readonly string[];
    connectedAccountBases: readonly string[];
  }>[];
}>;

export type StubGithubTransport = Readonly<{
  requests: readonly RecordedGithubRequest[];
  context: PluginInvocationContext;
  materializeCount: () => number;
  materializations: readonly RecordedMaterialization[];
  listRequests: readonly Readonly<{ purpose: string; limit?: number }>[];
  /** Every purpose whose binding was re-asked after a refused listing. */
  bindingReads: readonly string[];
}>;

export function jsonBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Builds a plugin invocation context whose HTTP boundary answers from `respond`.
 * Anything the responder does not recognize fails the test loudly rather than
 * silently returning an empty page.
 */
export function createStubGithubTransport(input: Readonly<{
  /**
   * A responder may answer later. A synchronous answer settles on the same
   * microtask, which makes every request look serial no matter how the caller
   * issued them — so a test that has to tell "one after another" from "in one
   * batch" holds its answers open until it has seen who is waiting.
   */
  respond: (
    request: RecordedGithubRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => StubHttpResponse | Promise<StubHttpResponse> | undefined;
  signal?: AbortSignal;
  /** Present only for discovery tests; absent leaves the listing unimplemented. */
  listing?: StubConnectedAccountListing | (() => never);
  /**
   * The host's answer to `getBinding`. `null` is a purpose with no selected
   * account — the state in which the host also refuses to list it. Defaults to a
   * bound summary so a test that only stubs a listing still describes a
   * configured Account.
   */
  binding?: Readonly<{ purpose: string; account?: ConnectedAccountRef }> | null;
  /** Generic custody boundary override; native credentials never enter the listed-account path. */
  nativeMaterialization?: ConnectedAccountMaterialization | (() => never);
  /** Optional host Action boundary used by operations that coordinate through a canonical host owner. */
  executeAction?: (action: PluginReference, actionInput: unknown) => unknown | Promise<unknown>;
}>): StubGithubTransport {
  const requests: RecordedGithubRequest[] = [];
  const materializations: RecordedMaterialization[] = [];
  const listRequests: Array<Readonly<{ purpose: string; limit?: number }>> = [];
  const bindingReads: string[] = [];
  let materializeCount = 0;
  const materializeAccount = (request: RecordedMaterialization) => {
    materializeCount += 1;
    materializations.push(Object.freeze({ ...request, materialization: Object.freeze({ ...request.materialization }) }));
    return Object.freeze({ kind: 'httpHeaders' as const,
      headers: Object.freeze({ Authorization: 'Bearer test-only-placeholder' }) });
  };

  const connectedAccounts = {
    async materialize(purpose: string, materialization: Readonly<Record<string, unknown>>,
      options?: Readonly<{ expectedAccount?: ConnectedAccountRef }>): Promise<ConnectedAccountMaterialization> {
      const materialized = input.nativeMaterialization;
      if (options?.expectedAccount && materialized === undefined)
        return materializeAccount({ purpose, materialization, account: options.expectedAccount });
      if (materialized === undefined) {
        throw Object.assign(new Error('Sign in with gh CLI'), { code: 'plugin_connected_account_native_unavailable' });
      }
      return typeof materialized === 'function' ? materialized() : materialized;
    },
    async listAccounts(
      request: Readonly<{ purpose: string; limit?: number }>,
    ): Promise<StubConnectedAccountListing> {
      listRequests.push(Object.freeze({ ...request }));
      const listing = input.listing;
      if (listing === undefined) {
        throw new Error('No stubbed Connected Account listing for this test');
      }
      return typeof listing === 'function' ? listing() : listing;
    },
    async getBinding(purpose: string, options?: Readonly<{ signal?: AbortSignal }>) {
      options?.signal?.throwIfAborted();
      bindingReads.push(purpose);
      return input.binding === null ? null : Object.freeze({
        purpose,
        account: input.binding?.account ?? GITHUB_TEST_ACCOUNT,
        service: (input.binding?.account ?? GITHUB_TEST_ACCOUNT).service,
        target: { kind: 'account' as const, displayName: 'GitHub fixture' },
      });
    },
    async materializeListedAccount(
      request: Readonly<{
        purpose: string;
        account: ConnectedAccountRef;
        materialization: Readonly<Record<string, unknown>>;
      }>,
    ): Promise<Readonly<{
      kind: 'httpHeaders';
      headers: Readonly<Record<string, string>>;
    }>> {
      return materializeAccount(request);
    },
  };

  const http = {
    async request(
      request: Readonly<{
        url: string;
        method?: string;
        headers?: Readonly<Record<string, string>>;
        body?: Uint8Array;
        redirect: 'error' | 'follow' | 'manual';
      }>,
      options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<Readonly<{
      status: number;
      finalUrl: string;
      headers: Readonly<Record<string, string>>;
      body: Uint8Array;
    }>> {
      const recorded: RecordedGithubRequest = Object.freeze({
        url: request.url,
        method: request.method ?? 'GET',
        headers: Object.freeze({ ...(request.headers ?? {}) }),
        redirect: request.redirect,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      requests.push(recorded);
      const answered = await new Promise<StubHttpResponse | undefined>((resolve, reject) => {
        const signal = options?.signal;
        const onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(input.respond(recorded, options)).then(resolve, reject).finally(() => {
          signal?.removeEventListener('abort', onAbort);
        });
      });
      const pathname = new URL(recorded.url).pathname;
      const response = answered ?? (
        recorded.method === 'GET'
        && pathname === `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`
          ? { status: 200, body: GITHUB_REPOSITORY_RESPONSE }
          // Pinned comparison metadata is a genuine HTTP boundary; individual tests
          // override this response to exercise divergence and provider failures.
          : recorded.method === 'GET' && pathname.startsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/compare/`)
            ? { status: 200, body: { base_commit: { sha: pathname.split('/').at(-1)?.split('...')[0] }, merge_base_commit: { sha: 'c'.repeat(40) } } }
          : undefined
      );
      if (response === undefined) {
        throw new Error(`No stubbed GitHub response for ${recorded.method} ${recorded.url}`);
      }
      return Object.freeze({
        status: response.status,
        finalUrl: recorded.url,
        headers: Object.freeze({ ...(response.headers ?? {}) }),
        body: response.rawBody ?? jsonBody(response.body ?? {}),
      });
    },
  };

  const context = {
    plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
    contribution: {
      id: 'triage-source',
      qualifiedId: `${GITHUB_PLUGIN_ID}/contributions/triage-source`,
    },
    surface: 'background',
    caller: {
      kind: 'plugin',
      pluginId: 'happier.triage',
      contribution: { id: 'sources', qualifiedId: 'happier.triage/points/sources' },
    },
    signal: input.signal ?? new AbortController().signal,
    services: {
      connectedAccounts,
      http: createPluginHttpFixture({ request: http.request }),
      actions: {
        execute: async (action: PluginReference, actionInput: unknown) => {
          if (input.executeAction === undefined) {
            const id = typeof action === 'string' ? action : `${action.pluginId}/${action.localId}`;
            throw new Error(`No stubbed host Action for ${id}`);
          }
          return await input.executeAction(action, actionInput);
        },
      },
    } as unknown as PluginInvocationContext['services'],
  } as unknown as PluginInvocationContext;

  return Object.freeze({
    requests,
    context,
    materializeCount: () => materializeCount,
    materializations,
    listRequests,
    bindingReads,
  });
}

export async function createTestGithubApiClient(
  transport: StubGithubTransport,
): Promise<GithubApiMediaClientV1> {
  return createGithubListedAccountApiClient(transport.context, GITHUB_TEST_ACCOUNT);
}

/** A monotonic injected clock; no adapter under test may reach for `Date.now()`. */
export function fixedClock(startMs: number): () => number {
  return () => startMs;
}
