import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';

import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { waitFor } from '../../src/testkit/timing';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';

import { io as socketIo } from 'socket.io-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesInvokeRequest, CapabilitiesInvokeResponse } from '@happier-dev/protocol/capabilities';

const run = createRunDirs({ runLabel: 'core' });

async function registerRpcMethod(sock: any, method: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeoutMs = 15_000;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out registering RPC method: ${method}`));
    }, timeoutMs);

    const onRegistered = (data: any) => {
      if (data?.method !== method) return;
      cleanup();
      resolve();
    };

    const onError = (data: any) => {
      cleanup();
      reject(new Error(`rpc-register error: ${typeof data?.error === 'string' ? data.error : 'unknown'}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      sock.off(SOCKET_RPC_EVENTS.REGISTERED, onRegistered);
      sock.off(SOCKET_RPC_EVENTS.ERROR, onError);
    };

    sock.on(SOCKET_RPC_EVENTS.REGISTERED, onRegistered);
    sock.on(SOCKET_RPC_EVENTS.ERROR, onError);
    sock.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
  });
}

describe('core e2e: capabilities.invoke(cli.* probeModels) machine RPC transport', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('routes a capabilities.invoke request to a machine-scoped socket and returns the encrypted result', async () => {
    const testDir = run.testDir('capabilities-invoke-probe-models-transport');
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });

    const auth = await createTestAuth(server.baseUrl);
    const secret = Uint8Array.from(randomBytes(32));
    const machineId = randomUUID();

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();

    const machineSock = socketIo(server.baseUrl, {
      path: '/v1/updates',
      transports: ['websocket'],
      reconnection: false,
      auth: { token: auth.token, clientType: 'machine-scoped', machineId },
    });

    const rpcMethod = `${machineId}:${RPC_METHODS.CAPABILITIES_INVOKE}`;

    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });
      await waitFor(() => machineSock.connected, { timeoutMs: 20_000 });

      machineSock.on(SOCKET_RPC_EVENTS.REQUEST, async (data: any, callback: (response: string) => void) => {
        try {
          if (data?.method !== rpcMethod) {
            callback(encryptLegacyBase64({ error: 'method-not-found' }, secret));
            return;
          }

          const decrypted = decryptLegacyBase64(String(data?.params ?? ''), secret) as CapabilitiesInvokeRequest | null;
          if (!decrypted) {
            callback(encryptLegacyBase64({ error: 'bad-params' }, secret));
            return;
          }

          const response: CapabilitiesInvokeResponse = {
            ok: true,
            result: {
              provider: 'opencode',
              source: 'dynamic',
              supportsFreeform: false,
              availableModels: [
                { id: 'default', name: 'Default' },
                { id: 'model-a', name: 'Model A' },
                { id: 'model-b', name: 'Model B' },
              ],
            },
          };

          callback(encryptLegacyBase64(response, secret));
        } catch (e: any) {
          callback(encryptLegacyBase64({ error: String(e?.message ?? e) }, secret));
        }
      });

      await registerRpcMethod(machineSock, rpcMethod);

      const request: CapabilitiesInvokeRequest = {
        id: 'cli.opencode',
        method: 'probeModels',
        params: { timeoutMs: 10_000 },
      };
      const paramsCiphertext = encryptLegacyBase64(request, secret);
      const rpc = await ui.rpcCall<any>(rpcMethod, paramsCiphertext);
      expect(rpc && typeof rpc === 'object' ? rpc.ok : false).toBe(true);

      const decrypted = decryptLegacyBase64(String(rpc.result ?? ''), secret) as CapabilitiesInvokeResponse | null;
      expect(decrypted && typeof decrypted === 'object' ? (decrypted as any).ok : false).toBe(true);

      const okRes = decrypted as Extract<CapabilitiesInvokeResponse, { ok: true }>;
      const result: any = okRes.result;
      expect(result?.provider).toBe('opencode');
      expect(result?.source).toBe('dynamic');
      expect(Array.isArray(result?.availableModels)).toBe(true);
      expect(result.availableModels[0]?.id).toBe('default');
      expect(result.availableModels.some((m: any) => m?.id === 'model-a' && m?.name === 'Model A')).toBe(true);
      expect(result.availableModels.some((m: any) => m?.id === 'model-b' && m?.name === 'Model B')).toBe(true);
    } finally {
      try {
        machineSock.close();
      } catch {
        // ignore
      }
      ui.close();
    }
  }, 120_000);
});

