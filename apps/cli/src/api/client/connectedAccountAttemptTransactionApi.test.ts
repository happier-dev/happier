import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectedAccountAttemptTransactionApiError,
  createConnectedAccountAttemptTransactionApi,
} from './connectedAccountAttemptTransactionApi';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('./serverHttpBaseUrl', () => ({
  resolveServerHttpBaseUrl: () => 'https://server.example',
}));
vi.mock('./connectedServicesServerApiTimeout', () => ({
  resolveConnectedServicesServerApiTimeoutMs: () => 1_000,
}));

describe('Connected Account attempt transaction API', () => {
  beforeEach(() => {
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.patch).mockReset();
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.delete).mockReset();
  });

  it('uses the exact account-authenticated create/read/CAS/delete route', async () => {
    const api = createConnectedAccountAttemptTransactionApi({
      token: 'account-token',
    });
    const record = {
      revision: 1,
      content: { t: 'encrypted' as const, c: 'opaque-ciphertext' },
      expiresAtMs: 123_456,
    };
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: record,
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: record,
    });
    vi.mocked(axios.patch).mockResolvedValue({
      status: 200,
      data: {
        ...record,
        revision: 2,
        content: { t: 'encrypted' as const, c: 'opaque-replacement' },
      },
    });
    vi.mocked(axios.delete).mockResolvedValue({
      status: 200,
      data: { status: 'deleted' },
    });

    await expect(api.create({
      kind: 'oauth',
      attemptId: 'attempt-1',
      content: record.content,
      expiresAtMs: record.expiresAtMs,
    })).resolves.toEqual(record);
    await expect(api.read({
      kind: 'oauth',
      attemptId: 'attempt-1',
    })).resolves.toEqual(record);
    await expect(api.replace({
      kind: 'oauth',
      attemptId: 'attempt-1',
      expectedRevision: 1,
      content: { t: 'encrypted', c: 'opaque-replacement' },
      expiresAtMs: record.expiresAtMs,
    })).resolves.toEqual({
      ...record,
      revision: 2,
      content: { t: 'encrypted', c: 'opaque-replacement' },
    });
    await expect(api.delete({
      kind: 'oauth',
      attemptId: 'attempt-1',
      expectedRevision: 2,
    })).resolves.toBeUndefined();

    const expectedUrl =
      'https://server.example/v2/connect/connected-account-attempt-transactions/oauth/attempt-1';
    expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toBe(expectedUrl);
    expect(vi.mocked(axios.get).mock.calls[0]?.[0]).toBe(expectedUrl);
    expect(vi.mocked(axios.patch).mock.calls[0]?.[0]).toBe(expectedUrl);
    expect(vi.mocked(axios.delete).mock.calls[0]?.[0]).toBe(expectedUrl);
    for (const options of [
      vi.mocked(axios.post).mock.calls[0]?.[2],
      vi.mocked(axios.get).mock.calls[0]?.[1],
      vi.mocked(axios.patch).mock.calls[0]?.[2],
      vi.mocked(axios.delete).mock.calls[0]?.[1],
    ]) {
      expect(options).toMatchObject({
        headers: { Authorization: 'Bearer account-token' },
        timeout: 1_000,
      });
    }
  });

  it('returns null only for reads and preserves typed CAS conflicts', async () => {
    const api = createConnectedAccountAttemptTransactionApi({
      token: 'account-token',
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 404,
      data: {
        error: 'connected_account_attempt_transaction_not_found',
      },
    });
    vi.mocked(axios.patch).mockResolvedValue({
      status: 409,
      data: {
        error: 'connected_account_attempt_transaction_conflict',
      },
    });

    await expect(api.read({
      kind: 'device',
      attemptId: 'attempt-2',
    })).resolves.toBeNull();
    await expect(api.replace({
      kind: 'device',
      attemptId: 'attempt-2',
      expectedRevision: 1,
      content: { t: 'encrypted', c: 'opaque' },
      expiresAtMs: 123_456,
    })).rejects.toMatchObject({
      name: ConnectedAccountAttemptTransactionApiError.name,
      code: 'connected_account_attempt_transaction_conflict',
    });
  });

  it('accepts an exact absent record as successful terminal cleanup and still rejects a conflict', async () => {
    const api = createConnectedAccountAttemptTransactionApi({
      token: 'account-token',
    });
    vi.mocked(axios.delete).mockResolvedValueOnce({
      status: 404,
      data: { error: 'connected_account_attempt_transaction_not_found' },
    });

    await expect(api.delete({
      kind: 'oauth',
      attemptId: 'attempt-4',
      expectedRevision: 3,
    })).resolves.toBeUndefined();

    vi.mocked(axios.delete).mockResolvedValueOnce({
      status: 409,
      data: { error: 'connected_account_attempt_transaction_conflict' },
    });
    await expect(api.delete({
      kind: 'oauth',
      attemptId: 'attempt-4',
      expectedRevision: 3,
    })).rejects.toMatchObject({
      code: 'connected_account_attempt_transaction_conflict',
    });

    vi.mocked(axios.delete).mockResolvedValueOnce({
      status: 404,
      data: { error: 'connected_account_attempt_transaction_conflict' },
    });
    await expect(api.delete({
      kind: 'oauth',
      attemptId: 'attempt-4',
      expectedRevision: 3,
    })).rejects.toMatchObject({
      code: 'connected_account_attempt_transaction_contract_invalid',
    });
  });

  it('rejects malformed server records before exposing them to persistence', async () => {
    const api = createConnectedAccountAttemptTransactionApi({
      token: 'account-token',
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        revision: 0,
        content: { t: 'encrypted', c: '' },
        expiresAtMs: 'not-a-number',
      },
    });

    await expect(api.read({
      kind: 'oauth',
      attemptId: 'attempt-3',
    })).rejects.toThrow();
  });

  it('rejects a server record whose content is neither a plain nor an encrypted envelope', async () => {
    const api = createConnectedAccountAttemptTransactionApi({
      token: 'account-token',
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        revision: 1,
        // The retired side contract shipped a bare opaque string here. The canonical
        // envelope is explicit about which representation it carries.
        content: 'opaque-ciphertext',
        expiresAtMs: 123_456,
      },
    });

    await expect(api.read({
      kind: 'oauth',
      attemptId: 'attempt-5',
    })).rejects.toThrow();
  });
});
