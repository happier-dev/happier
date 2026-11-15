export type FirstPartyReleaseArtifactSource = Readonly<{
  kind: 'github-release';
  githubRepo?: string;
  githubToken?: string;
  userAgent?: string;
}>;

export function resolveFirstPartyReleaseArtifactSource(params: Readonly<{
  artifactSource?: FirstPartyReleaseArtifactSource;
  githubRepo?: string;
  githubToken?: string;
  userAgent?: string;
}>): Readonly<{
  githubRepo: string;
  githubToken: string;
  userAgent: string;
  apiBaseUrl?: string;
}> {
  const env: Readonly<Record<string, string | undefined>> = typeof process === 'undefined' ? {} : process.env;
  const source = params.artifactSource?.kind === 'github-release' ? params.artifactSource : null;
  const override = env.HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL;
  let apiBaseUrl: string | undefined;
  if (override !== undefined) {
    if (env.NODE_ENV !== 'development') {
      throw new Error('[first-party-release] Release-source override requires development mode');
    }
    let url: URL;
    try {
      url = new URL(override);
    } catch {
      throw new Error('[first-party-release] Release-source override must be an HTTP(S) loopback origin');
    }
    if (!['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('[first-party-release] Release-source override must be an HTTP(S) loopback origin');
    }
    apiBaseUrl = url.origin;
  }
  return {
    apiBaseUrl,
    githubRepo: normalizeFirstPartyReleaseValue(
      source?.githubRepo
        ?? params.githubRepo
        ?? env.HAPPIER_FIRST_PARTY_RELEASE_REPO
        ?? env.HAPPIER_GITHUB_REPO
        ?? 'happier-dev/happier',
      'happier-dev/happier',
    ),
    // A local QA mirror must never receive credentials intended for GitHub.
    githubToken: apiBaseUrl ? '' : normalizeFirstPartyReleaseValue(
      source?.githubToken
        ?? params.githubToken
        ?? env.HAPPIER_FIRST_PARTY_RELEASE_TOKEN
        ?? env.HAPPIER_GITHUB_TOKEN
        ?? env.GITHUB_TOKEN
        ?? env.GH_TOKEN
        ?? '',
      '',
    ),
    userAgent: normalizeFirstPartyReleaseValue(
      source?.userAgent
        ?? params.userAgent
        ?? env.HAPPIER_FIRST_PARTY_RELEASE_USER_AGENT
        ?? 'happier-first-party-runtime',
      'happier-first-party-runtime',
    ),
  };
}

function normalizeFirstPartyReleaseValue(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}
