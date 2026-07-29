import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StartedPackedNovelConnectedAccountProvider =
  Readonly<{
    origin: string;
    requestCount: () => number;
    close: () => Promise<void>;
  }>;

export function classifyPackedNovelConnectedAccountProviderRequest(
  input: Readonly<{
    method: string | undefined;
    rawUrl: string;
  }>,
): 'accepted' | 'not-found' | 'malformed' {
  let requestUrl: URL;
  try {
    requestUrl = new URL(input.rawUrl, 'http://127.0.0.1');
    const decodedPathname = decodeURIComponent(requestUrl.pathname);
    return (
      input.method === 'GET'
      && decodedPathname === '/@happier-dev/plugin-sdk'
      && requestUrl.search === ''
    )
      ? 'accepted'
      : 'not-found';
  } catch {
    return 'malformed';
  }
}

export async function startPackedNovelConnectedAccountProvider():
Promise<StartedPackedNovelConnectedAccountProvider> {
  let requestCount = 0;
  const server = createServer((request, response) => {
    const classification =
      classifyPackedNovelConnectedAccountProviderRequest({
        method: request.method,
        rawUrl: request.url ?? '/',
      });
    if (classification === 'accepted') {
      requestCount += 1;
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        version: 'packed-novel-connected-account-fixture',
      }));
      return;
    }
    if (classification === 'malformed') {
      response.writeHead(400, {
        'cache-control': 'no-store',
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({
        error: 'malformed_request_path',
      }));
      return;
    }
    response.writeHead(404, {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error(
      'packed_novel_connected_account_provider_address_missing',
    );
  }
  let closed = false;
  return Object.freeze({
    origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
    requestCount: () => requestCount,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (
          error ? rejectClose(error) : resolveClose()
        ));
        server.closeAllConnections();
      });
    },
  });
}
