import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';

import {
  GITLAB_CONFIGURATION_RECORD_V1,
  encodeGitlabConfiguration,
} from '../configuration.js';
import {
  GITLAB_CONNECTED_ACCOUNT_PURPOSE,
  GITLAB_PLUGIN_ID,
} from '../contribution.js';

/**
 * Test support for the GitLab Triage detail vertical.
 *
 * The stub sits at the genuine system boundary — the host HTTP service and the
 * generic Connected Accounts service — so the real client runs beneath every
 * test: origin pinning, redirect refusal, one materialization per invocation,
 * and the real failure classifier. Nothing inside `triage/` is stubbed.
 */

export const GITLAB_TEST_ORIGIN = 'https://gitlab.com';

export const GITLAB_TEST_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-account' }),
  accountId: 'account-under-test',
});

/** The project the fixtures are keyed to, in this source's own scope grammar. */
export const GITLAB_TEST_PROJECT_ID = 3;
export const GITLAB_TEST_COLLISION_SCOPE =
  `gitlab:${Buffer.from(GITLAB_TEST_ORIGIN, 'utf8').toString('base64url')}:${GITLAB_TEST_PROJECT_ID}`;

export type RecordedGitlabRequest = Readonly<{
  url: string;
  method: string;
  headers: Readonly<Record<string, string>>;
  /**
   * The decoded request document, present exactly when one was sent. A mutation
   * test that could not read what left the process could not tell a pinned
   * conditional write from an unpinned one.
   */
  body?: string;
  redirect: 'error' | 'follow' | 'manual';
}>;

export type StubGitlabResponse = Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}>;

/**
 * A request GitLab never answers.
 *
 * A real HTTP boundary neither returns nor throws for such a request until its signal aborts, and
 * that is exactly the condition an invocation deadline exists for. The stub reproduces it — and
 * rejects with the abort reason, as the platform does — so a deadline test exercises the real
 * signal composition rather than a mocked timeout.
 */
export const GITLAB_STUB_NEVER_ANSWERS = 'never-answers';

export type StubGitlabTransport = Readonly<{
  requests: readonly RecordedGitlabRequest[];
  context: PluginInvocationContext;
  materializeCount: () => number;
}>;

/**
 * Builds a plugin invocation context whose HTTP boundary answers from `respond`.
 * Anything the responder does not recognize fails the test loudly rather than
 * silently returning an empty page — an unstubbed route that quietly 404s is how
 * a green test ends up asserting nothing.
 */
export function createStubGitlabTransport(input: Readonly<{
  respond: (request: RecordedGitlabRequest) =>
    StubGitlabResponse | typeof GITLAB_STUB_NEVER_ANSWERS | undefined;
  signal?: AbortSignal;
}>): StubGitlabTransport {
  const requests: RecordedGitlabRequest[] = [];
  let materializeCount = 0;

  const connectedAccounts = {
    async listAccounts(): Promise<never> {
      throw new Error('No stubbed GitLab Connected Account listing for this test');
    },
    async materializeListedAccount(): Promise<Readonly<{
      kind: 'httpHeaders';
      headers: Readonly<Record<string, string>>;
    }>> {
      materializeCount += 1;
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
      const recorded: RecordedGitlabRequest = Object.freeze({
        url: request.url,
        method: request.method ?? 'GET',
        headers: Object.freeze({ ...(request.headers ?? {}) }),
        ...(request.body === undefined
          ? {}
          : { body: new TextDecoder().decode(request.body) }),
        redirect: request.redirect,
      });
      requests.push(recorded);
      const response = input.respond(recorded);
      if (response === undefined) {
        throw new Error(`No stubbed GitLab response for ${recorded.method} ${recorded.url}`);
      }
      if (response === GITLAB_STUB_NEVER_ANSWERS) {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (signal === undefined) return;
          if (signal.aborted) { reject(signal.reason); return; }
          signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
        });
      }
      return Object.freeze({
        status: response.status,
        finalUrl: recorded.url,
        headers: Object.freeze({ ...(response.headers ?? {}) }),
        body: new TextEncoder().encode(JSON.stringify(response.body ?? null)),
      });
    },
  };

  const context = {
    plugin: { id: GITLAB_PLUGIN_ID, version: '0.0.0' },
    contribution: {
      id: 'gitlab-forge',
      qualifiedId: `${GITLAB_PLUGIN_ID}/contributions/gitlab-forge`,
    },
    surface: 'background',
    caller: {
      kind: 'plugin',
      pluginId: 'happier.triage',
      contribution: { id: 'sources', qualifiedId: 'happier.triage/points/sources' },
    },
    signal: input.signal ?? new AbortController().signal,
    services: { connectedAccounts, http } as unknown as PluginInvocationContext['services'],
  } as unknown as PluginInvocationContext;

  return Object.freeze({
    requests,
    context,
    materializeCount: () => materializeCount,
  });
}

/** The configured GitLab.com deployment every detail test is invoked for. */
export function gitlabTestConfiguredInstance(
  overrides: Partial<TriageConfiguredSourceInstanceV1> = {},
): TriageConfiguredSourceInstanceV1 {
  return {
    v: 1,
    instance: {
      source: { pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-forge' },
      sourceInstanceId: '9d6f0b2a-3c41-4d7e-9a52-8c1f4b7d2e03',
    },
    binding: { purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE, account: GITLAB_TEST_ACCOUNT },
    localInstanceKey: GITLAB_TEST_ORIGIN,
    configuration: encodeGitlabConfiguration(GITLAB_CONFIGURATION_RECORD_V1),
    ...overrides,
  } as TriageConfiguredSourceInstanceV1;
}

/** A GitLab `Link` header advertising exactly one following page. */
export function gitlabNextLinkHeader(nextUrl: string): Readonly<Record<string, string>> {
  return Object.freeze({ link: `<${nextUrl}>; rel="next"` });
}
