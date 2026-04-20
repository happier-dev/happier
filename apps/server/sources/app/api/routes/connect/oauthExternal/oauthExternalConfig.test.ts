import { describe, expect, it } from 'vitest';

import {
  resolveWebAppOAuthReturnUrlFromEnv,
  resolveWebAppOAuthReturnUrlFromRequestHeaders,
} from './oauthExternalConfig';

describe('resolveWebAppOAuthReturnUrlFromEnv', () => {
  it('derives the web app base URL from the canonical public server URL when local UI is served and HAPPIER_WEBAPP_URL is unset', () => {
    expect(resolveWebAppOAuthReturnUrlFromEnv({
      HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/base/',
      HAPPIER_SERVER_UI_DIR: '/tmp/ui',
      HAPPIER_SERVER_UI_PREFIX: '/ui/',
    }, 'github')).toBe('https://stack.example.test/base/ui/oauth/github');
  });

  it('preserves the configured UI prefix for loopback header overrides', () => {
    expect(resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/ui',
      },
      providerId: 'github',
      headers: {
        origin: 'http://127.0.0.1:8081',
        referer: 'http://127.0.0.1:8081/ui/settings',
      },
    })).toBe('http://127.0.0.1:8081/ui/oauth/github');
  });

  it('preserves loopback base path segments from request headers before the UI prefix', () => {
    expect(resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/ui',
      },
      providerId: 'github',
      headers: {
        origin: 'http://127.0.0.1:8081',
        referer: 'http://127.0.0.1:8081/base/ui/settings',
      },
    })).toBe('http://127.0.0.1:8081/base/ui/oauth/github');
  });

  it('preserves the configured reverse-proxy base path for loopback origins without a referer path', () => {
    expect(resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/base/',
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/ui',
      },
      providerId: 'github',
      headers: {
        origin: 'http://127.0.0.1:8081',
      },
    })).toBe('http://127.0.0.1:8081/base/ui/oauth/github');
  });

  it('preserves the configured reverse-proxy base path when the UI is root-mounted', () => {
    expect(resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/base/',
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/',
      },
      providerId: 'github',
      headers: {
        origin: 'http://127.0.0.1:8081',
        referer: 'http://127.0.0.1:8081/base/settings',
      },
    })).toBe('http://127.0.0.1:8081/base/oauth/github');
  });

  it('preserves the configured reverse-proxy base path for root-mounted UI when only the loopback origin is available', () => {
    expect(resolveWebAppOAuthReturnUrlFromRequestHeaders({
      env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/base/',
        HAPPIER_SERVER_UI_DIR: '/tmp/ui',
        HAPPIER_SERVER_UI_PREFIX: '/',
      },
      providerId: 'github',
      headers: {
        origin: 'http://127.0.0.1:8081',
      },
    })).toBe('http://127.0.0.1:8081/base/oauth/github');
  });
});
