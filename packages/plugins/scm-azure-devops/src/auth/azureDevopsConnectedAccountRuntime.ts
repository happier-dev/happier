import { Buffer } from 'node:buffer';

import type {
  ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
  ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  ConnectedAccountManualCompletion as PluginConnectedAccountManualCompletion,
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { createAzureDevOpsApiClient } from '../triage/client.js';
import { decodeAzureConnectionData } from '../triage/decode.js';
import { normalizeAzureDevOpsBaseUrl } from '../triage/origin.js';
import type { AzureDevOpsOrigin } from '../triage/types.js';

type ConnectedAccountReadContext = Parameters<PluginConnectedAccountRuntime['status']>[0];

/** The one declared authentication mode: an explicitly configured deployment plus a PAT. */
export const AZURE_DEVOPS_MANUAL_MODE_ID = 'manual';
/**
 * The non-secret configured deployment field the host normalizes, admits and republishes.
 *
 * It is a service *base*, not an origin: an Azure DevOps deployment always lives beneath an
 * organization (Services) or collection (Server) path segment, and the host publishes that base
 * beside the bare origin it governs network access by.
 */
export const AZURE_DEVOPS_BASE_CONFIGURATION_FIELD = 'base';
const TOKEN_CREDENTIAL_KEY = 'token';
const EMPTY_HTTP_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

/**
 * Azure DevOps authenticates a personal access token as HTTP Basic with an empty username.
 *
 * The username half is deliberately empty rather than a display name: Azure documents the PAT as
 * the password of an unnamed principal, and putting an account name there makes the header depend
 * on a mutable value that has nothing to do with the credential.
 */
export function encodeAzureDevOpsPatAuthorization(token: string): string {
  return `Basic ${Buffer.from(`:${token}`, 'utf8').toString('base64')}`;
}

/**
 * The deployment this account was configured for, used as its display name.
 *
 * Identity validation proves who owns the credential, while this label identifies where the
 * account connects. The host, the port and the organization or collection segment are all part of
 * that name — every Azure DevOps Services deployment shares one host, so a host-only label would
 * render every organization identically.
 */
function readConfiguredDeploymentLabel(values: Readonly<Record<string, unknown>>): string {
  const configured = values[AZURE_DEVOPS_BASE_CONFIGURATION_FIELD];
  if (typeof configured !== 'string') return 'Azure DevOps';
  const normalized = normalizeAzureDevOpsBaseUrl(configured);
  if (!normalized.ok) return 'Azure DevOps';
  const { baseUrl, forgeHostId, requestOrigin } = normalized.origin;
  return `${forgeHostId}${baseUrl.slice(requestOrigin.length)}`;
}

function readStoredToken(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed.length === 0 ? null : trimmed;
}

type AzureDevOpsIdentityConfirmation =
  | Readonly<{
    status: 'confirmed';
    accountId: string;
  }>
  | Readonly<{
    status: 'rejected' | 'unavailable';
    diagnostic: ReturnType<typeof diagnostic>;
  }>;

async function confirmAzureDevOpsIdentity(
  input: Readonly<{ token: string; origin: AzureDevOpsOrigin }>,
  context: Pick<PluginConnectedAccountAuthenticationContext, 'services' | 'signal'>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<AzureDevOpsIdentityConfirmation> {
  const signal = options?.signal ?? context.signal;
  const client = createAzureDevOpsApiClient({
    origin: input.origin,
    authorization: {
      headers: { Authorization: encodeAzureDevOpsPatAuthorization(input.token) },
    },
    transport: async (request) => {
      const response = await context.services.http.request({
        url: request.url,
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined
          ? {}
          : { body: new TextEncoder().encode(request.body) }),
        // Azure can intercept an invalid PAT with a sign-in redirect. Following it would forward
        // the attempted credential outside the deployment the user configured.
        redirect: 'error',
      }, { signal: request.signal });
      return {
        status: response.status,
        headers: response.headers,
        bodyText: new TextDecoder().decode(response.body),
      };
    },
    now: () => Date.now(),
  });
  const response = await client.request({ route: { resource: 'connectionData' }, signal });
  if (!response.ok) {
    const failure = response.failure;
    if (failure.class === 'unauthorized') {
      return {
        status: 'rejected',
        diagnostic: diagnostic(
          'azure_devops_manual_credentials_invalid',
          'Azure DevOps rejected this personal access token.',
        ),
      };
    }
    if (failure.class === 'forbidden') {
      return {
        status: 'rejected',
        diagnostic: diagnostic(
          'azure_devops_manual_credentials_insufficient',
          'This Azure DevOps personal access token cannot read the configured deployment.',
        ),
      };
    }
    if (failure.class === 'restVersionUnsupported') {
      return {
        status: 'rejected',
        diagnostic: diagnostic(
          'azure_devops_rest_version_unsupported',
          'This Azure DevOps Server cannot serve the REST 7.1 contract required by this integration.',
        ),
      };
    }
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'azure_devops_identity_unavailable',
        'Azure DevOps could not confirm this connection.',
      ),
    };
  }

  const connection = decodeAzureConnectionData(response.body);
  if (connection === null) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'azure_devops_identity_invalid',
        'Azure DevOps returned an invalid authenticated identity.',
      ),
    };
  }
  return {
    status: 'confirmed',
    accountId: connection.authenticatedUserId,
  };
}

async function readHealth(
  context: ConnectedAccountReadContext,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginConnectedAccountHealthResult> {
  const token = readStoredToken(await context.credentials.get(TOKEN_CREDENTIAL_KEY, options));
  if (token === null) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'azure_devops_credentials_unavailable',
        'The Azure DevOps personal access token is missing; reconnect the account.',
      ),
    };
  }
  const configured = context.configuration.values[AZURE_DEVOPS_BASE_CONFIGURATION_FIELD];
  const normalized = typeof configured === 'string'
    ? normalizeAzureDevOpsBaseUrl(configured)
    : { ok: false as const };
  if (!normalized.ok) {
    return {
      status: 'reconnectRequired',
      diagnostic: diagnostic(
        'azure_devops_base_invalid',
        'This Azure DevOps connection has no usable organization or collection URL.',
      ),
    };
  }
  const identity = await confirmAzureDevOpsIdentity(
    { token, origin: normalized.origin },
    context,
    options,
  );
  if (identity.status === 'rejected') {
    return { status: 'reconnectRequired', diagnostic: identity.diagnostic };
  }
  if (identity.status === 'unavailable') {
    return { status: 'unavailable', diagnostic: identity.diagnostic };
  }
  return {
    status: 'connected',
    displayName: readConfiguredDeploymentLabel(context.configuration.values),
    scopes: [],
  };
}

/**
 * A credential is materialized only for a bare network origin.
 *
 * The host already admits the request origin against this account's own configured origins, so
 * this check is the source-side half of the same rule rather than a second route table: it refuses
 * anything that is not an exact credential-free HTTPS origin. A configured *base* is deliberately
 * refused here — the base is what a source routes by, while authorization is governed by the
 * origin alone, and accepting a path here would let the two facts drift apart.
 */
function isAdmissibleAzureDevOpsOrigin(origin: string): boolean {
  const normalized = normalizeAzureDevOpsBaseUrl(origin);
  return normalized.ok && normalized.origin.requestOrigin === origin;
}

const azureDevopsConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      [AZURE_DEVOPS_MANUAL_MODE_ID]: {
        kind: 'manual',
        async complete(
          input: PluginConnectedAccountManualCompletion,
          context: PluginConnectedAccountAuthenticationContext,
          options,
        ) {
          const token = readStoredToken(input.fields[TOKEN_CREDENTIAL_KEY]);
          if (token === null) {
            return {
              status: 'rejected' as const,
              diagnostic: diagnostic(
                'azure_devops_manual_credentials_invalid',
                'Azure DevOps requires a personal access token.',
              ),
            };
          }
          const configured = context.configuration.values[AZURE_DEVOPS_BASE_CONFIGURATION_FIELD];
          const normalized = typeof configured === 'string'
            ? normalizeAzureDevOpsBaseUrl(configured)
            : { ok: false as const };
          if (!normalized.ok) {
            return {
              status: 'rejected' as const,
              diagnostic: diagnostic(
                'azure_devops_base_invalid',
                'Azure DevOps requires a usable organization or collection URL.',
              ),
            };
          }
          const identity = await confirmAzureDevOpsIdentity(
            { token, origin: normalized.origin },
            context,
            options,
          );
          if (identity.status !== 'confirmed') return identity;
          await context.attemptCredentials.set(TOKEN_CREDENTIAL_KEY, token, options);
          return {
            status: 'connected' as const,
            ...(context.attempt.kind === 'reconnect'
              ? { accountId: context.attempt.account.accountId }
              : {}),
            displayName: readConfiguredDeploymentLabel(context.configuration.values),
            providerIdentity: { accountId: identity.accountId },
            scopes: [],
          };
        },
      },
    },
  },
  async refresh(context, options) {
    return readHealth(context, options);
  },
  async revoke() {
    // A personal access token is revoked in Azure DevOps itself; claiming otherwise would tell a
    // user their token is dead while it still authorizes every other client that holds it.
    return { status: 'remoteUnsupported' as const };
  },
  async status(context, options) {
    return readHealth(context, options);
  },
  async materialize(request, context) {
    if (request.kind !== 'httpHeaders') {
      throw new Error('Azure DevOps connected accounts support HTTP-header materialization only');
    }
    if (!isAdmissibleAzureDevOpsOrigin(request.origin)) {
      throw new Error('Azure DevOps connected accounts cannot materialize credentials for this origin');
    }
    if (!request.headerNames.some((name) => name.toLowerCase() === 'authorization')) {
      return { kind: 'httpHeaders' as const, headers: EMPTY_HTTP_HEADERS };
    }
    const token = readStoredToken(await context.credentials.get(TOKEN_CREDENTIAL_KEY));
    if (token === null) {
      throw new Error('Azure DevOps connected-account credentials are unavailable');
    }
    return {
      kind: 'httpHeaders' as const,
      headers: { Authorization: encodeAzureDevOpsPatAuthorization(token) },
    };
  },
};

export const azureDevopsConnectedAccountRuntime = Object.freeze(
  azureDevopsConnectedAccountRuntimeDefinition,
);
