import { vi } from 'vitest';
import {
  createPluginHttpFixture,
  createPluginTestkit,
} from '@happier-dev/plugin-sdk/testing';
import type {
  ConnectedAccountAuthenticationContext,
  ConnectedAccountCredentialStore,
  ConnectedAccountMutationContext,
  ConnectedAccountReadContext,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from './index.js';

// Constructed vectors from Vercel's OIDC discovery and documented REST schemas
// (read 2026-11-18), not tenant captures:
// https://vercel.com/.well-known/openid-configuration
// https://vercel.com/docs/sign-in-with-vercel
export const service = {
  pluginId: 'happier.machine.vercel',
  localId: 'vercel-account',
};
export const callbackUrl =
  'https://cloud.happier.dev/oauth/connected-account/callback';
export const clientId = 'cl_public_client';
export const teamId = 'team_example';
export function credentials(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  const store: ConnectedAccountCredentialStore = {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value, options) {
      options?.signal?.throwIfAborted();
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
  return { values, store };
}

type Route = { status: number; body?: unknown } | Error;

export async function createVercelOAuthFixture(
  options: {
    attempt?: 'connect' | 'reconnect';
    values?: Record<string, string>;
    publicClient?: boolean;
    publicClientScopes?: string[];
    teams?: readonly { id: string; name: string }[];
    retained?: Record<string, string>;
  } = {},
) {
  const kit = await createPluginTestkit({
    manifest: entry.manifest,
    module: entry,
  });

  const runtime = kit.registration(
    'connectedAccountDescriptors',
    service.localId,
  );
  if (!runtime) throw new Error('Missing activated Vercel runtime');
  const mode = runtime.authentication.modes['oauth'];
  if (!mode || mode.kind !== 'oauthAuthorizationCode')
    throw new Error('Missing Vercel OAuth mode');
  const teams = options.teams ?? [{ id: teamId, name: 'Example team' }];
  const routes = new Map<string, Route>([
    [
      '/login/oauth/token',
      {
        status: 200,
        body: {
          token_type: 'Bearer',
          access_token: 'access-private',
          refresh_token: 'refresh-private',
          expires_in: 3600,
          scope: 'openid email profile offline_access',
        },
      },
    ],
    [
      '/login/oauth/userinfo',
      {
        status: 200,
        body: {
          sub: 'user_subject',
          email: 'person@example.com',
          preferred_username: 'person',
        },
      },
    ],
    ['/login/oauth/token/revoke', { status: 200 }],
    ['/v2/teams', { status: 200, body: { teams, pagination: { next: null } } }],
    ['/v10/projects', { status: 200, body: { projects: [], pagination: { next: null } } }],
  ]);
  for (const team of teams)
    routes.set(`/v2/teams/${team.id}`, {
      status: 200,
      body: { id: team.id, name: team.name, slug: team.id },
    });
  const requests: HttpRequest[] = [];
  const request = vi.fn(async (input: HttpRequest) => {
    requests.push(input);
    const route = routes.get(new URL(input.url).pathname);
    if (route instanceof Error) throw route;
    const status = route?.status ?? 404;
    return {
      status,
      finalUrl: input.url,
      headers: {},
      body:
        route?.body === undefined
          ? new Uint8Array()
          : new TextEncoder().encode(JSON.stringify(route.body)),
    };
  });
  const getPublicOAuthClient = vi.fn(async () =>
    options.publicClient === false
      ? null
      : { clientId, scopes: options.publicClientScopes ?? ['openid', 'email', 'profile', 'offline_access'] },
  );
  const values: Record<string, string> = { ...options.values };
  const attempt =
    options.attempt === 'reconnect'
      ? {
          kind: 'reconnect' as const,
          attemptId: 'attempt-1',
          account: { service, accountId: 'host-account' },
        }
      : { kind: 'connect' as const, attemptId: 'attempt-1' };
  const configuration = {
    target: {
      kind: 'attempt' as const,
      attemptId: 'attempt-1',
      service,
      modeId: 'oauth',
    },
    revision: 'configuration-1',
    values,
    async getSecret() {
      return null;
    },
    getPublicOAuthClient,
  };
  const staged = credentials();
  const retained = credentials(options.retained);
  const stagedConfigurations: unknown[] = [];
  const controller = new AbortController();
  const services = {
    http: createPluginHttpFixture({ request }),
  } as ConnectedAccountAuthenticationContext['services'];
  const common = {
    plugin: { id: service.pluginId, version: entry.manifest.version },
    contribution: {
      id: service.localId,
      qualifiedId: `${service.pluginId}/${service.localId}`,
    },
    surface: 'background' as const,
    invokedAtMs: Date.now(),
    services,
    signal: controller.signal,
  };
  const authentication: ConnectedAccountAuthenticationContext = {
    ...common,
    service,
    attempt,
    configuration,
    attemptCredentials: staged.store,
    async stageAccountConfiguration(input) {
      stagedConfigurations.push(input);
      Object.assign(values, input.values);
    },
  };
  const account = { service, accountId: 'host-account' };
  const readConfiguration = {
    ...configuration,
    target: { kind: 'account' as const, account, modeId: 'oauth' },
  };
  const read: ConnectedAccountReadContext = {
    ...common,
    account,
    configuration: readConfiguration,
    credentials: retained.store,
  };
  const mutation: ConnectedAccountMutationContext = {
    ...read,
    stagedCredentials: staged.store,
    operation: {
      operationId: 'refresh-1',
      configurationRevision: 'configuration-1',
    },
  };
  return {
    kit,
    runtime,
    mode,
    authentication,
    read,
    mutation,
    staged,
    retained,
    requests,
    routes,
    values,
    stagedConfigurations,
    getPublicOAuthClient,
    request,
  };
}

export const pkce = { method: 'S256' as const, challenge: 'challenge-value' };
export const completion = {
  code: 'code-private',
  callbackUrl,
  state: 'attempt-1.nonce',
  pkceVerifier: 'verifier-private',
};
export const projectId = 'prj_example';
export const projects = {
  status: 200,
  body: { projects: [{ id: projectId, name: 'Example site', accountId: teamId }, { id: 'prj_docs', name: 'Docs', accountId: teamId }], pagination: { next: null } },
};
