import type { ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginError } from '@happier-dev/plugin-sdk';
import { GITHUB_TOKEN_CREDENTIAL_KEY, isGithubCopilotCompatibleToken } from './tokenKinds.js';
import { githubPortableAuthentication } from './authentication.js';

export { GITHUB_TOKEN_CREDENTIAL_KEY } from './tokenKinds.js';
const GITHUB_HTTP_ORIGINS = new Set(['https://api.github.com', 'https://github.com']);
const EMPTY_HTTP_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

function isAllowedGithubOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && GITHUB_HTTP_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

/** Stored credentials use the host's existing mode-aware custody in either realm. */
export const materializeGithubCredential: NonNullable<ConnectedAccountPortableRuntime['materialize']> = async (request, context, options) => {
  if (request.kind === 'environment') {
    const key = request.keys[0];
    if (request.keys.length !== 1 || (key !== 'COPILOT_GITHUB_TOKEN' && key !== 'GH_TOKEN')) {
      throw new PluginError({ code: 'github_copilot_environment_unsupported', message: 'GitHub supports only its declared CLI and Copilot token environment destinations.' });
    }
    const token = (await context.credentials.get(GITHUB_TOKEN_CREDENTIAL_KEY, options))?.trim() ?? '';
    if (key === 'GH_TOKEN' && !token) {
      throw new PluginError({ code: 'credential_unavailable', message: 'GitHub connected-account credentials are unavailable.' });
    }
    if (key === 'COPILOT_GITHUB_TOKEN' && !isGithubCopilotCompatibleToken(token)) {
      throw new PluginError({ code: 'github_copilot_token_unsupported', message: 'Select a supported fine-grained, OAuth, or GitHub App user token for Copilot.' });
    }
    return { kind: 'environment', env: { [key]: token } };
  }
  if (request.kind !== 'httpHeaders') {
    throw new Error('GitHub connected accounts support HTTP headers and their declared environment destinations');
  }
  if (!isAllowedGithubOrigin(request.origin)) {
    throw new Error('GitHub connected accounts cannot materialize credentials for this origin');
  }
  if (!request.headerNames.some(name => name.toLowerCase() === 'authorization')) {
    return { kind: 'httpHeaders', headers: EMPTY_HTTP_HEADERS };
  }
  const token = (await context.credentials.get(GITHUB_TOKEN_CREDENTIAL_KEY, options))?.trim() ?? '';
  if (!token) throw new Error('GitHub connected-account credentials are unavailable');
  return { kind: 'httpHeaders', headers: { Authorization: `Bearer ${token}` } };
};

/** Portable sign-in and materialization share existing host credential custody. */
export const githubAccountCredentialRuntime = {
  authentication: githubPortableAuthentication,
  materialize: materializeGithubCredential,
} satisfies ConnectedAccountPortableRuntime;
