import { randomBytes } from 'node:crypto';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import { decryptLegacyBase64, encryptLegacyBase64 } from '../messageCrypto';
import type { SocketCollector } from '../socketClient';
import { unwrapSerializedJsonValue } from '../unwrapSerializedJsonValue';
import { dispatchRuntimeActionE2E } from './runtimeActionE2E';

describe('dispatchRuntimeActionE2E', () => {
  it('dispatches action input through the production execution-run action RPC envelope', async () => {
    const secret = randomBytes(32);
    const calls: Array<{ method: string; request: unknown }> = [];
    const ui = {
      async rpcCall(method: string, params: string) {
        calls.push({
          method,
          request: unwrapSerializedJsonValue(decryptLegacyBase64(params, secret)),
        });

        return {
          ok: true,
          result: encryptLegacyBase64(
            {
              ok: true,
              result: {
                producer: 'real',
                frameCount: 2,
              },
            },
            secret,
          ),
        };
      },
    } as unknown as SocketCollector;

    const response = await dispatchRuntimeActionE2E(
      {
        ui,
        sessionId: 'session-live-qa',
        runId: 'run-live-qa',
        secret,
      },
      'localServices.inventory.list',
      { machineId: 'machine-live-qa' },
    );

    expect(calls).toEqual([
      {
        method: `session-live-qa:${SESSION_RPC_METHODS.EXECUTION_RUN_ACTION}`,
        request: {
          runId: 'run-live-qa',
          actionId: 'localServices.inventory.list',
          input: {
            machineId: 'machine-live-qa',
          },
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      result: {
        producer: 'real',
        frameCount: 2,
      },
    });
  });
});
