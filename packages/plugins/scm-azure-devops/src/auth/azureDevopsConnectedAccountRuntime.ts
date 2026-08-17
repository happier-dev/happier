import { Buffer } from 'node:buffer';

import type {
  ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
  ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  ConnectedAccountManualCompletion as PluginConnectedAccountManualCompletion,
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { normalizeAzureDevOpsBaseUrl } from '../triage/origin.js';

type ConnectedAccountCredentialReader =
  Parameters<PluginConnectedAccountRuntime['status']>[0]['credentials'];

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
 * `sources/SCM.md` §6.1 specifies a health read against the configured REST base's connection
 * identity endpoint, which would supply the provider's own name for this principal. This runtime
 * performs no network read, so the deployment is the truthful value it can name; it is never a
 * claim about who the token belongs to. The host, the port and the organization or collection
 * segment are all part of that name — every Azure DevOps Services deployment shares one host, so a
 * host-only label would render every organization identically.
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

async function readHealth(
  credentials: ConnectedAccountCredentialReader,
): Promise<PluginConnectedAccountHealthResult> {
  const token = readStoredToken(await credentials.get(TOKEN_CREDENTIAL_KEY));
  if (token === null) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'azure_devops_credentials_unavailable',
        'The Azure DevOps personal access token is missing; reconnect the account.',
      ),
    };
  }
  return { status: 'connected', scopes: [] };
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
          await context.attemptCredentials.set(TOKEN_CREDENTIAL_KEY, token);
          return {
            status: 'connected' as const,
            ...(context.attempt.kind === 'reconnect'
              ? { accountId: context.attempt.account.accountId }
              : {}),
            displayName: readConfiguredDeploymentLabel(context.configuration.values),
            scopes: [],
          };
        },
      },
    },
  },
  async refresh(context) {
    return readHealth(context.credentials);
  },
  async revoke() {
    // A personal access token is revoked in Azure DevOps itself; claiming otherwise would tell a
    // user their token is dead while it still authorizes every other client that holds it.
    return { status: 'remoteUnsupported' as const };
  },
  async status(context) {
    return readHealth(context.credentials);
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
