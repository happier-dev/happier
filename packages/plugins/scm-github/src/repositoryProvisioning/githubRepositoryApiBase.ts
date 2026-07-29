import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/experimental/scm';

import { createGithubRepositoryCommandFailedError } from './githubRepositoryErrors.js';

const GITHUB_DOT_COM_HOST = 'github.com';

export function resolveGithubRepositoryHost(provider: ScmHostingProviderRef): string {
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isGithubDotComRepositoryProvider(provider: ScmHostingProviderRef): boolean {
  return resolveGithubRepositoryHost(provider) === GITHUB_DOT_COM_HOST;
}

export function resolveGithubRepositoryApiBaseUrl(provider: ScmHostingProviderRef): string {
  let parsed: URL;
  try {
    parsed = new URL(provider.baseUrl);
  } catch {
    throw createGithubRepositoryCommandFailedError('GitHub provider base URL is invalid');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname.replace(/\/+$/, '') !== ''
    || parsed.search
    || parsed.hash
  ) {
    throw createGithubRepositoryCommandFailedError('GitHub provider base URL is invalid');
  }
  const origin = parsed.origin;
  return parsed.hostname.toLowerCase() === GITHUB_DOT_COM_HOST
    ? 'https://api.github.com'
    : `${origin}/api/v3`;
}
