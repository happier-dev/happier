import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PROVIDER_UI_E2E_MODEL_ID } from './uiE2eProviderSettings';

export type StartedProviderUiE2eEndpoint = Readonly<{
  baseUrl: string;
  stop: () => Promise<void>;
}>;

function writeJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function startProviderUiE2eEndpoint(): Promise<StartedProviderUiE2eEndpoint> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/v1/models') {
      writeJson(response, 200, {
        models: [{
          key: PROVIDER_UI_E2E_MODEL_ID,
          display_name: 'Provider E2E Model',
          type: 'llm',
          loaded_instances: [{ id: 'provider-e2e-loaded-instance' }],
        }],
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      writeJson(response, 200, {
        object: 'list',
        data: [{ id: PROVIDER_UI_E2E_MODEL_ID, name: 'Provider E2E Model' }],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/models/load') {
      request.resume();
      writeJson(response, 200, { status: 'loaded', model: PROVIDER_UI_E2E_MODEL_ID });
      return;
    }
    writeJson(response, 404, { error: 'not_found' });
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close(server);
    throw new Error('Provider UI E2E endpoint did not expose a TCP address');
  }
  const port = (address as AddressInfo).port;
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => close(server),
  });
}
