import { describe, expect, it } from 'vitest';

import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { decryptSessionMessageLegacy, isAcpSidechainMessage } from '../../src/testkit/providers/assertions';

describe('isAcpSidechainMessage', () => {
  it('recognizes serialized JSON transcript wrappers that contain sidechain ACP messages', () => {
    const wrapped = {
      __happierSerializedJsonValueV1: true,
      type: 'json',
      value: {
        role: 'agent',
        content: {
          type: 'acp',
          provider: 'opencode',
          data: {
            type: 'message',
            message: 'SUBTASK_OK',
            sidechainId: 'call_task_1',
          },
        },
        meta: {
          importedFrom: 'acp-sidechain',
          sidechainId: 'call_task_1',
        },
      },
    };

    expect(isAcpSidechainMessage(wrapped, 'call_task_1')).toBe(true);
  });

  it('returns normalized decrypted messages so scenario assertions can read importedFrom metadata', () => {
    const secret = new Uint8Array(32).fill(7);
    const wrapped = {
      __happierSerializedJsonValueV1: true,
      type: 'json',
      value: {
        role: 'agent',
        content: {
          type: 'acp',
          provider: 'opencode',
          data: {
            type: 'message',
            message: 'SUBTASK_OK',
            sidechainId: 'call_task_1',
          },
        },
        meta: {
          importedFrom: 'acp-sidechain',
          sidechainId: 'call_task_1',
        },
      },
    };

    const decrypted = decryptSessionMessageLegacy(
      {
        id: 'row-1',
        content: { t: 'encrypted', c: encryptLegacyBase64(wrapped, secret) },
      } as any,
      secret,
    );

    expect(decrypted).toMatchObject({
      meta: {
        importedFrom: 'acp-sidechain',
        sidechainId: 'call_task_1',
      },
    });
    expect(isAcpSidechainMessage(decrypted as any, 'call_task_1')).toBe(true);
  });
});
