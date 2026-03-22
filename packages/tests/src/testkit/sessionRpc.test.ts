import { describe, expect, it } from 'vitest';

import { encryptLegacyBase64 } from './messageCrypto';
import { callLegacyEncryptedSessionRpc } from './sessionRpc';

describe('callLegacyEncryptedSessionRpc', () => {
  it('preserves decrypted application error envelopes instead of reporting them as timeouts', async () => {
    const secret = new Uint8Array(32).fill(7);
    const ui = {
      rpcCall: async () => ({
        ok: true,
        result: encryptLegacyBase64(
          { ok: false, error: 'Invalid params', errorCode: 'execution_run_invalid_action_input' },
          secret,
        ),
      }),
    } as any;

    await expect(
      callLegacyEncryptedSessionRpc({
        ui,
        sessionId: 'sess_1',
        method: 'execution.run.stream.start',
        req: { runId: 'run_1', message: 'hello' },
        secret,
        schema: { safeParse: () => ({ success: false }) },
        timeoutMs: 250,
      }),
    ).rejects.toMatchObject({
      message: 'RPC returned application error (execution_run_invalid_action_input): Invalid params',
    });
  });
});
