import { afterEach, expect, it, vi } from 'vitest';
import { CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1 } from '@happier-dev/protocol/connect/oauthAuthorizationResponse';
import { MCP_OAUTH_CALLBACK_URL_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';
import {
  captureConnectedAccountOAuthCallbackUrl,
  readCapturedConnectedAccountOAuthCallbackUrl,
  releaseCapturedConnectedAccountOAuthCallbackUrl,
} from './connectedAccountOAuthCallbackUrl';

afterEach(() => {
  vi.unstubAllGlobals();
  releaseCapturedConnectedAccountOAuthCallbackUrl(CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1);
  releaseCapturedConnectedAccountOAuthCallbackUrl(MCP_OAUTH_CALLBACK_URL_V1);
});

it('leaves native startup alone when its window has no browser location/history', () => {
  vi.stubGlobal('window', {});
  expect(() => captureConnectedAccountOAuthCallbackUrl()).not.toThrow();
});

function browserAt(href: string) {
  const browser = {
    location: new URL(href),
    history: {
      state: { id: 'existing-entry' },
      replaceState(_data: unknown, _unused: string, path: string | URL | null | undefined) {
        browser.location = new URL(String(path), browser.location);
      },
    },
  };
  return browser;
}

it('leaves the distinct Home sign-in callback and its query with their auth owner', () => {
  const href = 'https://self-hosted.example/oauth/github?flow=auth&code=x&state=home-state';
  const browser = browserAt(href);
  captureConnectedAccountOAuthCallbackUrl(browser);
  expect(browser.location.href).toBe(href);
  expect(readCapturedConnectedAccountOAuthCallbackUrl(CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1)).toBeUndefined();
});

it('keeps capture repeatable until the matching mounted callback takes custody', () => {
  const browser = browserAt('https://self-hosted.example/oauth/mcp/callback/?code=x&state=attempt.nonce');
  captureConnectedAccountOAuthCallbackUrl(browser);
  const original = `${MCP_OAUTH_CALLBACK_URL_V1}?code=x&state=attempt.nonce`;
  expect(browser.location.search).toBe('');
  expect(readCapturedConnectedAccountOAuthCallbackUrl(CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1)).toBeUndefined();
  releaseCapturedConnectedAccountOAuthCallbackUrl(CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1);
  expect(readCapturedConnectedAccountOAuthCallbackUrl(MCP_OAUTH_CALLBACK_URL_V1)).toBe(original);
  expect(readCapturedConnectedAccountOAuthCallbackUrl(MCP_OAUTH_CALLBACK_URL_V1)).toBe(original);
  releaseCapturedConnectedAccountOAuthCallbackUrl(MCP_OAUTH_CALLBACK_URL_V1);
  expect(readCapturedConnectedAccountOAuthCallbackUrl(MCP_OAUTH_CALLBACK_URL_V1)).toBeUndefined();
});
