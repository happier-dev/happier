import type { ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

export const GITHUB_TOKEN_CREDENTIAL_KEY = 'token';
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
  if (request.kind !== 'httpHeaders') {
    throw new Error('GitHub connected accounts support HTTP-header materialization only');
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

/** Authentication/import stays with its native role; established use needs no Machine. */
export const githubAccountCredentialRuntime = {
  authentication: { modes: {} },
  materialize: materializeGithubCredential,
} satisfies ConnectedAccountPortableRuntime;
