import { describe, expect, it } from 'vitest';

import { encryptLegacyBase64 } from './messageCrypto';
import { callLegacyEncryptedSessionRpc } from './sessionRpc';

describe('callLegacyEncryptedSessionRpc', () => {
  it('does not double-prefix fully scoped session methods', async () => {
    const secret = new Uint8Array(32).fill(8);
    const methods: string[] = [];
    const ui = {
      rpcCall: async (method: string) => {
        methods.push(method);
        return {
          ok: true,
          result: encryptLegacyBase64({ ok: true }, secret),
        };
      },
    } as any;

    await expect(
      callLegacyEncryptedSessionRpc({
        ui,
        sessionId: 'sess_1',
        method: 'sess_1:permission',
        req: { id: 'perm_1', approved: true },
        secret,
        schema: { safeParse: (input) => ({ success: true, data: input as { ok: boolean } }) },
        timeoutMs: 250,
      }),
    ).resolves.toEqual({ ok: true });

    expect(methods).toEqual(['sess_1:permission']);
  });

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

  it('uses canonical errorMessage text from decrypted application error envelopes', async () => {
    const secret = new Uint8Array(32).fill(9);
    const ui = {
      rpcCall: async () => ({
        ok: true,
        result: encryptLegacyBase64(
          {
            ok: false,
            errorCode: 'invalid_parameters',
            errorMessage: 'Rollback target is not available in the active conversation',
          },
          secret,
        ),
      }),
    } as any;

    await expect(
      callLegacyEncryptedSessionRpc({
        ui,
        sessionId: 'sess_2',
        method: 'execution.run.rollback',
        req: { turnId: 'turn_1' },
        secret,
        schema: { safeParse: () => ({ success: false }) },
        timeoutMs: 250,
      }),
    ).rejects.toMatchObject({
      message:
        'RPC returned application error (invalid_parameters): Rollback target is not available in the active conversation',
    });
  });
});
