import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';

import {
  createGithubListedAccountApiClient,
  type GithubApiClientV1,
} from '../../observations/githubApiClient.js';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
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
  binding?: Readonly<{ purpose: string }> | null;
  /** Optional host Action boundary used by operations that coordinate through a canonical host owner. */
  executeAction?: (actionId: string, actionInput: unknown) => unknown | Promise<unknown>;
}>): StubGithubTransport {
  const requests: RecordedGithubRequest[] = [];
  const materializations: RecordedMaterialization[] = [];
  const listRequests: Array<Readonly<{ purpose: string; limit?: number }>> = [];
  const bindingReads: string[] = [];
  let materializeCount = 0;

  const connectedAccounts = {
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
    async getBinding(purpose: string): Promise<Readonly<{ purpose: string }> | null> {
      bindingReads.push(purpose);
      return input.binding === undefined ? Object.freeze({ purpose }) : input.binding;
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
      materializeCount += 1;
      materializations.push(Object.freeze({
        purpose: request.purpose,
        account: request.account,
        materialization: Object.freeze({ ...request.materialization }),
      }));
      return Object.freeze({
        kind: 'httpHeaders',
        headers: Object.freeze({ Authorization: 'Bearer test-only-placeholder' }),
      });
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
        Promise.resolve(input.respond(recorded)).then(resolve, reject).finally(() => {
          signal?.removeEventListener('abort', onAbort);
        });
      });
      const pathname = new URL(recorded.url).pathname;
      const response = answered ?? (
        recorded.method === 'GET'
        && pathname === `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`
          ? { status: 200, body: GITHUB_REPOSITORY_RESPONSE }
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
      http,
      actions: {
        execute: async (actionId: string, actionInput: unknown) => {
          if (input.executeAction === undefined) {
            throw new Error(`No stubbed host Action for ${actionId}`);
          }
          return await input.executeAction(actionId, actionInput);
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
): Promise<GithubApiClientV1> {
  return createGithubListedAccountApiClient(transport.context, GITHUB_TEST_ACCOUNT);
}

/** A monotonic injected clock; no adapter under test may reach for `Date.now()`. */
export function fixedClock(startMs: number): () => number {
  return () => startMs;
}
