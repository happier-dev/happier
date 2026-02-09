import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { startLoopbackOauthPkceFlow } from './loopbackOauthPkce';

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

class FakeLoopbackServer {
  private handler: RequestHandler | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  public closed = false;

  attach(handler: RequestHandler): this {
    this.handler = handler;
    return this;
  }

  once(event: 'error', handler: (error: Error) => void): void {
    if (event === 'error') {
      this.errorHandler = handler;
    }
  }

  listen(_port: number, _host: string, callback: () => void): void {
    callback();
  }

  close(callback?: () => void): void {
    this.closed = true;
    callback?.();
  }

  async dispatch(url: string): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    if (!this.handler) throw new Error('handler not attached');

    let statusCode = 200;
    let headers: Record<string, string> = {};
    let body = '';

    const req = { url } as IncomingMessage;
    const res = {
      writeHead(code: number, nextHeaders?: Record<string, string>) {
        statusCode = code;
        headers = nextHeaders ?? {};
        return this;
      },
      end(chunk?: string) {
        if (typeof chunk === 'string') body += chunk;
      },
    } as unknown as ServerResponse;

    await this.handler(req, res);
    return { statusCode, headers, body };
  }

  emitError(error: Error): void {
    this.errorHandler?.(error);
  }
}

describe('startLoopbackOauthPkceFlow', () => {
  it('completes the callback flow and returns exchanged tokens', async () => {
    const fakeServer = new FakeLoopbackServer();
    const exchangeCodeForTokens = vi.fn(async () => ({ accessToken: 'token-1' }));

    const tokens = await startLoopbackOauthPkceFlow({
      defaultPort: 54545,
      callbackPath: '/callback',
      startupDelayMs: 0,
      timeoutMs: 5_000,
      generateState: () => 'state-1',
      generatePkce: () => ({ verifier: 'verifier-1', challenge: 'challenge-1' }),
      isLoopbackPortAvailableFn: async () => true,
      findAvailableLoopbackPortFn: async () => 40001,
      createServerFn: (handler) => fakeServer.attach(handler),
      buildAuthorizationUrl: ({ redirectUri, state, challenge }) =>
        `https://example.com/oauth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&challenge=${challenge}`,
      openAuthorizationUrl: async () => {
        await fakeServer.dispatch('/callback?code=auth-code-1&state=state-1');
      },
      exchangeCodeForTokens,
      onSuccessResponse: ({ res }) => {
        res.writeHead(204);
        res.end();
      },
    });

    expect(tokens).toEqual({ accessToken: 'token-1' });
    expect(exchangeCodeForTokens).toHaveBeenCalledWith({
      code: 'auth-code-1',
      verifier: 'verifier-1',
      state: 'state-1',
      port: 54545,
    });
    expect(fakeServer.closed).toBe(true);
  });

  it('falls back to an available port when the default loopback port is occupied', async () => {
    const fakeServer = new FakeLoopbackServer();
    const exchangeCodeForTokens = vi.fn(async () => ({ ok: true }));

    await startLoopbackOauthPkceFlow({
      defaultPort: 54545,
      callbackPath: '/callback',
      startupDelayMs: 0,
      timeoutMs: 5_000,
      generateState: () => 'state-2',
      generatePkce: () => ({ verifier: 'verifier-2', challenge: 'challenge-2' }),
      isLoopbackPortAvailableFn: async () => false,
      findAvailableLoopbackPortFn: async () => 40123,
      createServerFn: (handler) => fakeServer.attach(handler),
      buildAuthorizationUrl: ({ redirectUri }) => `https://example.com/oauth?redirect_uri=${encodeURIComponent(redirectUri)}`,
      openAuthorizationUrl: async ({ port }) => {
        expect(port).toBe(40123);
        await fakeServer.dispatch('/callback?code=auth-code-2&state=state-2');
      },
      exchangeCodeForTokens,
    });

    expect(exchangeCodeForTokens).toHaveBeenCalledWith({
      code: 'auth-code-2',
      verifier: 'verifier-2',
      state: 'state-2',
      port: 40123,
    });
  });

  it('lets providers handle callback error parameters', async () => {
    const fakeServer = new FakeLoopbackServer();
    const exchangeCodeForTokens = vi.fn();

    await expect(
      startLoopbackOauthPkceFlow({
        defaultPort: 54545,
        callbackPath: '/oauth2callback',
        startupDelayMs: 0,
        timeoutMs: 5_000,
        generateState: () => 'state-3',
        generatePkce: () => ({ verifier: 'verifier-3', challenge: 'challenge-3' }),
        isLoopbackPortAvailableFn: async () => true,
        findAvailableLoopbackPortFn: async () => 40123,
        createServerFn: (handler) => fakeServer.attach(handler),
        buildAuthorizationUrl: ({ redirectUri }) => `https://example.com/oauth?redirect_uri=${encodeURIComponent(redirectUri)}`,
        openAuthorizationUrl: async () => {
          await fakeServer.dispatch('/oauth2callback?error=access_denied&state=state-3');
        },
        exchangeCodeForTokens,
        onCallbackErrorParam: ({ error, res }) => {
          res.writeHead(302, { Location: 'https://example.com/error' });
          res.end();
          throw new Error(`Authentication error: ${error}`);
        },
      }),
    ).rejects.toThrow('Authentication error: access_denied');

    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(fakeServer.closed).toBe(true);
  });
});
