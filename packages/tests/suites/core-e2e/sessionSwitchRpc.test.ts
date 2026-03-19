import { describe, expect, it, vi } from 'vitest';

import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { requestSessionSwitchRpc } from '../../src/testkit/sessionSwitchRpc';

describe('requestSessionSwitchRpc', () => {
  it('accepts serialized-json boolean results from encrypted RPC responses', async () => {
    const secret = new Uint8Array(32).fill(7);
    const rpcCall = vi.fn().mockResolvedValue({
      ok: true,
      result: encryptLegacyBase64(
        { __happierSerializedJsonValueV1: true, type: 'json', value: true },
        secret,
      ),
    });

    const switched = await requestSessionSwitchRpc({
      ui: { rpcCall } as never,
      sessionId: 'sess-1',
      to: 'remote',
      secret,
      timeoutMs: 50,
    });

    expect(switched).toBe(true);
    expect(rpcCall).toHaveBeenCalledWith(
      'sess-1:switch',
      expect.any(String),
    );
  });
});
