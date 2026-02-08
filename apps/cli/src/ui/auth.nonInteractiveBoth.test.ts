import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import tweetnacl from 'tweetnacl';

import {
  captureConsoleLogAndMuteStdout,
  createEnvKeyScope,
  setStdioTtyForTest,
} from '@/ui/testHelpers/authNonInteractiveGlobals.testHelper';

type AxiosRequestResponse = { state: 'requested' };
type AxiosClaimResponse = { state: 'authorized'; token: string; response: string };
type AxiosStatusResponse = { status: 'authorized' };
type AxiosResponse<T> = { data: T };

type AxiosLike = {
  post: (url: string, body?: unknown) => Promise<AxiosResponse<AxiosRequestResponse | AxiosClaimResponse | unknown>>;
  get: (url: string) => Promise<AxiosResponse<AxiosStatusResponse | unknown>>;
};

let capturedPublicKeyBase64: string | null = null;

function encryptLegacyBundleForRecipientPublicKey(recipientPublicKeyBase64: string): string {
  const recipientPublicKey = new Uint8Array(Buffer.from(recipientPublicKeyBase64, 'base64'));
  const payload = new Uint8Array(32).fill(7);

  const ephemeralKeyPair = tweetnacl.box.keyPair();
  const nonce = new Uint8Array(24).fill(9);
  const encrypted = tweetnacl.box(payload, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);

  const bundle = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
  bundle.set(ephemeralKeyPair.publicKey, 0);
  bundle.set(nonce, ephemeralKeyPair.publicKey.length);
  bundle.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);

  return Buffer.from(bundle).toString('base64');
}

vi.mock('axios', async () => {
  const axios: AxiosLike = {
    post: vi.fn(async (url: string, body?: unknown) => {
      if (url.endsWith('/v1/auth/request')) {
        const publicKey = (body as { publicKey?: unknown } | undefined)?.publicKey;
        capturedPublicKeyBase64 = typeof publicKey === 'string' ? publicKey : '';
        return { data: { state: 'requested' } };
      }
      if (url.endsWith('/v1/auth/request/claim')) {
        const claimBody = body as { publicKey?: unknown } | undefined;
        const publicKey = typeof claimBody?.publicKey === 'string' ? claimBody.publicKey : capturedPublicKeyBase64 ?? '';
        return {
          data: {
            state: 'authorized',
            token: 'tok',
            response: encryptLegacyBundleForRecipientPublicKey(publicKey),
          },
        };
      }
      throw new Error(`Unexpected axios.post URL: ${url}`);
    }),
    get: vi.fn(async (url: string) => {
      if (url.endsWith('/v1/auth/request/status')) {
        return { data: { status: 'authorized' } };
      }
      throw new Error(`Unexpected axios.get URL: ${url}`);
    }),
  };
  return { default: axios };
});

describe.sequential('doAuth (non-interactive)', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_NO_BROWSER_OPEN',
    'HAPPIER_AUTH_POLL_INTERVAL_MS',
    'HAPPIER_AUTH_METHOD',
  ] as const;

  it('prints both web + mobile instructions when method is not specified', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-cli-auth-noninteractive-'));
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'https://server.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: undefined,
      });

      vi.resetModules();
      const { doAuth } = await import('./auth');

      const creds = await doAuth();
      expect(creds?.token).toBe('tok');

      const out = output.logs.join('\n');
      expect(out.toLowerCase()).toContain('terminal is connected to: https://server.example.test');
      expect(out).toContain('Web app URL: https://webapp.example.test');
      expect(out.toLowerCase()).toContain('recommended: use the mobile app first');
      expect(out.toLowerCase()).toContain('already have a happier account on another device');
      expect(out).toContain('Option A');
      expect(out).toContain('webapp.example.test/terminal/connect#key=');
      expect(out).toContain('Option B');
      expect(out).toContain('happier://terminal?');
    } finally {
      output.restore();
      restoreTty();
      envScope.restore();
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('fails fast with a clear message when claim response token/response are invalid', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-cli-auth-noninteractive-invalid-claim-'));
    const envScope = createEnvKeyScope(envKeys);
    const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    const output = captureConsoleLogAndMuteStdout();

    const axiosModule = await import('axios');
    const axiosDefault = axiosModule.default as AxiosLike;
    const originalPost = axiosDefault.post;

    try {
      axiosDefault.post = vi.fn(async (url: string, body?: unknown) => {
        if (url.endsWith('/v1/auth/request')) {
          const publicKey = (body as { publicKey?: unknown } | undefined)?.publicKey;
          capturedPublicKeyBase64 = typeof publicKey === 'string' ? publicKey : '';
          return { data: { state: 'requested' } };
        }
        if (url.endsWith('/v1/auth/request/claim')) {
          return {
            data: {
              state: 'authorized',
              token: 123,
              response: null,
            },
          };
        }
        throw new Error(`Unexpected axios.post URL: ${url}`);
      }) as AxiosLike['post'];

      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'https://server.example.test',
        HAPPIER_WEBAPP_URL: 'https://webapp.example.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_AUTH_METHOD: undefined,
      });

      vi.resetModules();
      const { doAuth } = await import('./auth');
      const creds = await doAuth();

      expect(creds).toBeNull();
      expect(output.logs.join('\n')).toContain('Unexpected response from server. Please try again.');
    } finally {
      axiosDefault.post = originalPost;
      output.restore();
      restoreTty();
      envScope.restore();
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});
