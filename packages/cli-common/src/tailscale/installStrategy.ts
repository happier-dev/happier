const DEFAULT_TAILSCALE_STABLE_MANIFEST_URL = 'https://pkgs.tailscale.com/stable/';

const DEFAULT_DOCS_URLS = {
  darwin: 'https://tailscale.com/download/mac',
  linux: 'https://tailscale.com/docs/install/linux',
  win32: 'https://tailscale.com/download/windows',
} as const;

const INSTALL_MODE_ENV_KEY = 'HAPPIER_TAILSCALE_INSTALL_MODE';
const MANIFEST_URL_ENV_KEY = 'HAPPIER_TAILSCALE_INSTALL_MANIFEST_URL';
const DOCS_URL_ENV_KEYS = {
  darwin: 'HAPPIER_TAILSCALE_INSTALL_DOCS_URL_DARWIN',
  linux: 'HAPPIER_TAILSCALE_INSTALL_DOCS_URL_LINUX',
  win32: 'HAPPIER_TAILSCALE_INSTALL_DOCS_URL_WIN32',
} as const;

export type TailscaleInstallStrategy =
  | Readonly<{
      kind: 'downloadAndLaunch';
      platform: 'darwin' | 'win32';
      docsUrl: string;
      manifestUrl: string;
      waitForCliTimeoutMs: number;
      pollIntervalMs: number;
      postInstallAppLaunch: string | null;
    }>
  | Readonly<{
      kind: 'manual';
      platform: NodeJS.Platform;
      docsUrl: string;
    }>;

export function resolveTailscaleInstallStrategy(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): TailscaleInstallStrategy {
  if (readInstallModeOverride(env) === 'manual') {
    return {
      kind: 'manual',
      platform,
      docsUrl: resolveDocsUrl(platform, env),
    };
  }

  if (platform === 'darwin') {
    return {
      kind: 'downloadAndLaunch',
      platform,
      docsUrl: resolveDocsUrl(platform, env),
      manifestUrl: readUrlEnv(env, MANIFEST_URL_ENV_KEY) ?? DEFAULT_TAILSCALE_STABLE_MANIFEST_URL,
      waitForCliTimeoutMs: 180_000,
      pollIntervalMs: 1_000,
      postInstallAppLaunch: 'Tailscale',
    };
  }

  if (platform === 'win32') {
    return {
      kind: 'downloadAndLaunch',
      platform,
      docsUrl: resolveDocsUrl(platform, env),
      manifestUrl: readUrlEnv(env, MANIFEST_URL_ENV_KEY) ?? DEFAULT_TAILSCALE_STABLE_MANIFEST_URL,
      waitForCliTimeoutMs: 180_000,
      pollIntervalMs: 1_000,
      postInstallAppLaunch: null,
    };
  }

  return {
    kind: 'manual',
    platform,
    docsUrl: resolveDocsUrl(platform, env),
  };
}

export function extractTailscaleInstallerDownloadUrl(params: Readonly<{
  manifestText: string;
  manifestUrl: string;
  platform: NodeJS.Platform;
}>): string | null {
  const hrefs = extractHrefTargets(params.manifestText);
  const matcher = selectInstallerMatcher(params.platform);
  if (!matcher) {
    return null;
  }

  for (const href of hrefs) {
    if (!matcher(href)) {
      continue;
    }
    try {
      return new URL(href, params.manifestUrl).toString();
    } catch {
      continue;
    }
  }

  return null;
}

function readInstallModeOverride(env: NodeJS.ProcessEnv): 'manual' | null {
  const raw = String(env[INSTALL_MODE_ENV_KEY] ?? '').trim().toLowerCase();
  return raw === 'manual' ? 'manual' : null;
}

function resolveDocsUrl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') {
    return readUrlEnv(env, DOCS_URL_ENV_KEYS.darwin) ?? DEFAULT_DOCS_URLS.darwin;
  }
  if (platform === 'win32') {
    return readUrlEnv(env, DOCS_URL_ENV_KEYS.win32) ?? DEFAULT_DOCS_URLS.win32;
  }
  return readUrlEnv(env, DOCS_URL_ENV_KEYS.linux) ?? DEFAULT_DOCS_URLS.linux;
}

function readUrlEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = String(env[key] ?? '').trim();
  if (!value) {
    return null;
  }
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function extractHrefTargets(text: string): readonly string[] {
  const matches = Array.from(
    String(text ?? '').matchAll(/href=(?:"([^"]+)"|'([^']+)')/gi),
    (match) => match[1] ?? match[2] ?? '',
  );
  return matches
    .map((value) => value.trim())
    .filter(Boolean);
}

function selectInstallerMatcher(
  platform: NodeJS.Platform,
): ((href: string) => boolean) | null {
  if (platform === 'darwin') {
    return (href) => /tailscale-[^"'/?#\s]+-macos\.pkg$/i.test(href);
  }
  if (platform === 'win32') {
    return (href) => /tailscale-setup-(?!full-)[^"'/?#\s]+\.exe$/i.test(href);
  }
  return null;
}
