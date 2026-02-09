import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

import { findAvailableLoopbackPort, isLoopbackPortAvailable } from '@/cloud/loopbackPort';
import { generatePkceCodes } from '@/cloud/pkce';

export type OauthPkceCodes = {
  verifier: string;
  challenge: string;
};

export type LoopbackOauthAuthorizationContext = {
  authorizationUrl: string;
  redirectUri: string;
  callbackUrl: string;
  state: string;
  port: number;
};

export type StartLoopbackOauthPkceFlowOptions<TTokens> = {
  defaultPort: number;
  callbackPath: `/${string}`;
  buildAuthorizationUrl: (params: {
    port: number;
    state: string;
    challenge: string;
    redirectUri: string;
  }) => string;
  openAuthorizationUrl: (context: LoopbackOauthAuthorizationContext) => Promise<void>;
  exchangeCodeForTokens: (params: {
    code: string;
    verifier: string;
    state: string;
    port: number;
  }) => Promise<TTokens>;
  onSuccessResponse?: (params: { res: ServerResponse; tokens: TTokens }) => void;
  onCallbackErrorParam?: (params: { error: string; res: ServerResponse; port: number }) => void;
  onTokenExchangeErrorResponse?: (params: { error: unknown; res: ServerResponse }) => void;
  onPortResolved?: (params: { defaultPort: number; port: number; usedFallback: boolean }) => void;
  generateState?: () => string;
  generatePkce?: () => OauthPkceCodes;
  timeoutMs?: number;
  startupDelayMs?: number;
  isLoopbackPortAvailableFn?: (port: number) => Promise<boolean>;
  findAvailableLoopbackPortFn?: () => Promise<number>;
  createServerFn?: (
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ) => {
    listen: (port: number, host: string, callback: () => void) => void;
    once: (event: 'error', handler: (error: Error) => void) => void;
    close: (callback?: () => void) => void;
  };
};

function defaultGenerateState(): string {
  return randomBytes(32).toString('hex');
}

function renderDefaultSuccessHtml(): string {
  return [
    '<html>',
    '<body style="font-family: sans-serif; padding: 20px;">',
    '<h2>Authentication Successful</h2>',
    '<p>You can close this window and return to your terminal.</p>',
    '<script>setTimeout(() => window.close(), 3000);</script>',
    '</body>',
    '</html>',
  ].join('');
}

export async function startLoopbackOauthPkceFlow<TTokens>(
  opts: StartLoopbackOauthPkceFlowOptions<TTokens>,
): Promise<TTokens> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const startupDelayMs = opts.startupDelayMs ?? 100;
  const generateState = opts.generateState ?? defaultGenerateState;
  const generatePkce = opts.generatePkce ?? generatePkceCodes;
  const isLoopbackPortAvailableFn = opts.isLoopbackPortAvailableFn ?? isLoopbackPortAvailable;
  const findAvailableLoopbackPortFn = opts.findAvailableLoopbackPortFn ?? findAvailableLoopbackPort;
  const createServerFn = opts.createServerFn ?? createServer;

  const defaultPortAvailable = await isLoopbackPortAvailableFn(opts.defaultPort);
  const port = defaultPortAvailable ? opts.defaultPort : await findAvailableLoopbackPortFn();
  opts.onPortResolved?.({
    defaultPort: opts.defaultPort,
    port,
    usedFallback: !defaultPortAvailable,
  });

  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const redirectUri = `http://localhost:${port}${opts.callbackPath}`;
  const callbackUrl = `http://127.0.0.1:${port}${opts.callbackPath}`;
  const authorizationUrl = opts.buildAuthorizationUrl({
    port,
    state,
    challenge,
    redirectUri,
  });

  let resolveCallback!: (tokens: TTokens) => void;
  let rejectCallback!: (error: unknown) => void;
  const serverControl: { stop: (() => void) | null } = { stop: null };
  const callbackResultPromise = new Promise<TTokens>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  await new Promise<void>((resolveStart, rejectStart) => {
    let settled = false;
    const server = createServerFn(async (req, res) => {
      const requestUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (requestUrl.pathname !== opts.callbackPath) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const settle = (result: { ok: true; tokens: TTokens } | { ok: false; error: unknown }) => {
        const stop = serverControl.stop;
        if (stop) {
          stop();
        }
        try {
          server.close();
        } catch {
          // ignore
        }

        if (result.ok) resolveCallback(result.tokens);
        else rejectCallback(result.error);
      };

      const providerError = requestUrl.searchParams.get('error');
      if (providerError) {
        try {
          if (opts.onCallbackErrorParam) {
            opts.onCallbackErrorParam({ error: providerError, res, port });
          } else {
            res.writeHead(400);
            res.end(`Authentication error: ${providerError}`);
          }
          settle({ ok: false, error: new Error(`Authentication error: ${providerError}`) });
        } catch (error) {
          settle({ ok: false, error });
        }
        return;
      }

      const receivedState = requestUrl.searchParams.get('state');
      if (receivedState !== state) {
        res.writeHead(400);
        res.end('Invalid state parameter');
        settle({ ok: false, error: new Error('Invalid state parameter') });
        return;
      }

      const code = requestUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('No authorization code received');
        settle({ ok: false, error: new Error('No authorization code received') });
        return;
      }

      try {
        const tokens = await opts.exchangeCodeForTokens({
          code,
          verifier,
          state,
          port,
        });
        if (opts.onSuccessResponse) {
          opts.onSuccessResponse({ res, tokens });
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(renderDefaultSuccessHtml());
        }
        settle({ ok: true, tokens });
      } catch (error) {
        if (opts.onTokenExchangeErrorResponse) {
          opts.onTokenExchangeErrorResponse({ error, res });
        } else {
          res.writeHead(500);
          res.end('Token exchange failed');
        }
        settle({ ok: false, error });
      }
    });

    const settleStart = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        server.close();
      } catch {
        // ignore
      }
      rejectStart(error);
    };

    const timeoutHandle = setTimeout(() => {
      settleStart(new Error('Authentication timeout'));
    }, timeoutMs);
    serverControl.stop = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        server.close();
      } catch {
        // ignore
      }
    };

    server.once('error', (error) => {
      settleStart(error);
    });

    server.listen(port, '127.0.0.1', () => {
      resolveStart();
    });
  });

  if (startupDelayMs > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, startupDelayMs));
  }

  try {
    await opts.openAuthorizationUrl({
      authorizationUrl,
      redirectUri,
      callbackUrl,
      state,
      port,
    });
  } catch (error) {
    const stop = serverControl.stop;
    if (stop) {
      stop();
    }
    rejectCallback(error);
  }

  return await callbackResultPromise;
}
