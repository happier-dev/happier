import { GITHUB_TOKEN_CREDENTIAL_KEY as TOKEN_CREDENTIAL_KEY, materializeGithubCredential } from './credentialMaterialization.js';
import type {
  ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { resolveGhNativeToken } from '@happier-dev/plugin-sdk/exec';
import { PluginError } from '@happier-dev/plugin-sdk';

import { refreshGithubCopilotCredential } from './copilot.js';
import { confirmGithubIdentity, diagnostic, githubPortableAuthentication } from './authentication.js';

type GithubConnectedAccountReadContext = Parameters<PluginConnectedAccountRuntime['status']>[0];

async function readHealth(
  context: GithubConnectedAccountReadContext,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginConnectedAccountHealthResult> {
  const token = (await context.credentials.get(TOKEN_CREDENTIAL_KEY, options))?.trim() ?? '';
  if (!token) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'github_credentials_unavailable',
        'GitHub credentials are unavailable; reconnect the account.',
      ),
    };
  }
  const identity = await confirmGithubIdentity(token, context, options);
  if (identity.status === 'rejected') {
    return {
      status: 'reconnectRequired',
      diagnostic: identity.diagnostic,
    };
  }
  if (identity.status === 'unavailable') {
    return {
      status: 'unavailable',
      diagnostic: identity.diagnostic,
    };
  }
  if (identity.status !== 'confirmed') {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'github_identity_unavailable',
        'GitHub account identity could not be confirmed.',
      ),
    };
  }
  const credentialKind = await context.credentials.get('credentialKind', options);
  const storedExpiry = await context.credentials.get('expiresAtMs', options);
  const expiresAt = storedExpiry ? Number(storedExpiry) : undefined;
  return {
    status: 'connected',
    credentialKind: credentialKind === 'oauth' ? 'oauth' : 'token',
    ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt } : {}),
    providerIdentity: {
      accountId: identity.providerAccountId,
      ...(identity.email ? { email: identity.email } : {}),
    },
    displayName: identity.displayName,
    scopes: identity.scopes,
  };
}


const githubConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      ...githubPortableAuthentication.modes,
      'native-import': {
        kind: 'manual',
        async complete(input, context, options) {
          if (input.fields.source !== 'native') {
            return { status: 'rejected', diagnostic: diagnostic(
              'github_import_source_unsupported', 'The GitHub import source is unsupported.',
            ) };
          }
          const signal = options?.signal ?? context.signal;
          const native = await resolveGhNativeToken({ signal });
          if (!native.ok) {
            return { status: 'unavailable', diagnostic: diagnostic(
              'github_import_credentials_unavailable',
              'GitHub CLI credentials are unavailable. Install gh and sign in with gh auth login on this machine.',
            ) };
          }
          const identity = await confirmGithubIdentity(native.token, context, options);
          if (identity.status !== 'confirmed') return identity;
          await context.attemptCredentials.set(TOKEN_CREDENTIAL_KEY, native.token, options);
          return {
            status: 'connected',
            credentialKind: 'token',
            providerIdentity: {
              accountId: identity.providerAccountId,
              ...(identity.email ? { email: identity.email } : {}),
            },
            displayName: identity.displayName,
            scopes: identity.scopes,
          };
        },
      },
    },
  },
  async refresh(context, options) {
    return await refreshGithubCopilotCredential(context, options) ?? readHealth(context, options);
  },
  async revoke() {
    return { status: 'remoteUnsupported' };
  },
  async status(context, options) {
    return readHealth(context, options);
  },
  materialize: materializeGithubCredential,
  async materializeNative(request, context, options) {
    if (request.kind !== 'httpHeaders') throw new PluginError({
      code: 'plugin_connected_account_binding_out_of_scope',
      message: 'Native GitHub credentials require an authorized HTTPS header request',
    });
    if (!request.headerNames.includes('authorization')) return { kind: 'httpHeaders', headers: {} };
    const originHostname = new URL(request.origin).host;
    const hostname = originHostname === 'api.github.com' ? 'github.com' : originHostname;
    const native = await resolveGhNativeToken({
      hostname,
      signal: options?.signal ?? context.signal,
    });
    if (!native.ok) throw new PluginError({
      code: 'plugin_connected_account_native_unavailable',
      message: 'Sign in with gh CLI',
      remediation: { kind: 'openUrl', url: 'https://cli.github.com/manual/gh_auth_login' },
    });
    return { kind: 'httpHeaders', headers: { Authorization: `Bearer ${native.token}` } };
  },
};

export const githubConnectedAccountRuntime = Object.freeze(
  githubConnectedAccountRuntimeDefinition,
);
