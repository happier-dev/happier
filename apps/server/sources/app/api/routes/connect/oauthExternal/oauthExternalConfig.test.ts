import { describe, expect, it } from 'vitest';

import { resolveWebAppOAuthReturnUrlFromEnv, resolveWebAppOAuthReturnUrlFromRequestHeaders } from './oauthExternalConfig';

describe('resolveWebAppOAuthReturnUrlFromEnv', () => {
  it('allows the bundled Tauri return URL by default through the shared redirect validator', () => {
    expect(resolveWebAppOAuthReturnUrlFromEnv({
      HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: 'tauri://localhost/oauth',
    }, 'okta')).toBe('tauri://localhost/oauth/okta');
  });

  it.each([
    'tauri://evil.example.test/oauth',
    'tauri://sub.localhost/oauth',
    'tauri://localhost:8080/oauth',
    'tauri://user:pass@localhost/oauth',
  ])('does not trust a different Tauri authority by default: %s', (returnBase) => {
    expect(resolveWebAppOAuthReturnUrlFromEnv({
      HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: returnBase,
      HAPPIER_WEBAPP_URL: 'https://app.example.test',
    }, 'okta')).toBe('https://app.example.test/oauth/okta');
  });
  it('uses the preferred hosted client when no web app URL is configured', () => {
    expect(resolveWebAppOAuthReturnUrlFromEnv({}, 'github'))
      .toBe('https://cloud.happier.dev/oauth/github');
  });

  it('derives the web app base URL from the canonical public server URL when local UI is served and HAPPIER_WEBAPP_URL is unset', () => {
    expect(resolveWebAppOAuthReturnUrlFromEnv({
      HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/base/',
      HAPPIER_SERVER_UI_DIR: '/tmp/ui',
      HAPPIER_SERVER_UI_PREFIX: '/ui/',
    }, 'github')).toBe('https://stack.example.test/base/ui/oauth/github');
  });
});

describe('resolveWebAppOAuthReturnUrlFromRequestHeaders', () => {
  it('preserves the UI base path when the loopback referer is nested under a reverse-proxy base', () => {
    const resolved = resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/ui',
      },
      providerId: 'github',
      headers: {
        referer: 'http://127.0.0.1:8081/base/ui/settings',
      },
    });
    expect(resolved).toBe('http://127.0.0.1:8081/base/ui/oauth/github');
  });

  it('uses the configured UI prefix for loopback origins without a referer path', () => {
    const resolved = resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/ui',
      },
      providerId: 'github',
      headers: {
        origin: 'http://localhost:8081',
      },
    });
    expect(resolved).toBe('http://localhost:8081/ui/oauth/github');
  });

  it('preserves the configured reverse-proxy base path for loopback origins without a referer path', () => {
    const resolved = resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/base/',
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/ui',
      },
      providerId: 'github',
      headers: {
        origin: 'http://127.0.0.1:8081',
      },
    });
    expect(resolved).toBe('http://127.0.0.1:8081/base/ui/oauth/github');
  });

  it('preserves the configured reverse-proxy base path when the UI is root-mounted', () => {
    const resolved = resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/base/',
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/',
      },
      providerId: 'github',
      headers: {
        referer: 'http://127.0.0.1:8081/base/settings',
      },
    });
    expect(resolved).toBe('http://127.0.0.1:8081/base/oauth/github');
  });

  it('preserves the configured reverse-proxy base path for root-mounted UI when only the loopback origin is available', () => {
    const resolved = resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/base/',
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/',
      },
      providerId: 'github',
      headers: {
        origin: 'http://127.0.0.1:8081',
      },
    });
    expect(resolved).toBe('http://127.0.0.1:8081/base/oauth/github');
  });

  it('returns into the Tauri desktop webview origin when its scheme is an allowed return scheme', () => {
    const resolved = resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test',
        HAPPIER_WEBAPP_URL: 'https://stack.example.test',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: 'happier,tauri',
      },
      providerId: 'okta',
      headers: {
        origin: 'tauri://localhost',
      },
    });
    expect(resolved).toBe('tauri://localhost/oauth/okta');
  });

  it('returns the Tauri desktop webview to its root oauth route regardless of the relay UI prefix', () => {
    const resolved = resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/base/',
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/ui',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: 'tauri',
      },
      providerId: 'okta',
      headers: {
        origin: 'tauri://localhost',
      },
    });
    expect(resolved).toBe('tauri://localhost/oauth/okta');
  });

  it.each([undefined, '', 'happier'])('returns to the bundled Tauri origin without scheme opt-in (%s)', (allowedSchemes) => {
    const resolved = resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_WEBAPP_URL: 'https://stack.example.test',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: allowedSchemes,
      },
      providerId: 'okta',
      headers: {
        origin: 'tauri://localhost',
      },
    });
    expect(resolved).toBe('tauri://localhost/oauth/okta');
  });

  it('ignores a non-loopback host on the Tauri scheme', () => {
    const resolved = resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: 'tauri',
      },
      providerId: 'okta',
      headers: {
        origin: 'tauri://evil.example.test',
      },
    });
    expect(resolved).toBeNull();
  });

  it.each(['http:', 'https:'])('returns the Windows desktop webview on %s to its bundle root instead of the relay UI prefix', (protocol) => {
    expect(resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/base/',
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/ui',
      },
      providerId: 'okta',
      headers: { origin: `${protocol}//tauri.localhost` },
    })).toBe(`${protocol}//tauri.localhost/oauth/okta`);
  });
});
