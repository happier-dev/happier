import { describe, expect, it, vi } from 'vitest';

import { createCodexCloudAuthenticator } from './createCodexCloudAuthenticator';
import type { CodexCloudAuthenticatorDeps } from './createCodexCloudAuthenticator';

describe('createCodexCloudAuthenticator', () => {
  it('uses device auth when opts.device is true', async () => {
    const deviceSpy = vi.fn(async (_params: Parameters<CodexCloudAuthenticatorDeps['authenticateDevice']>[0]) => ({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'it',
      account_id: 'acct',
    }));
    const pkceSpy = vi.fn(async (_params: Parameters<CodexCloudAuthenticatorDeps['authenticatePkce']>[0]) => ({
      access_token: 'at2',
      refresh_token: 'rt2',
      id_token: 'it2',
      account_id: 'acct2',
    }));

    const authenticateCodex = createCodexCloudAuthenticator({
      now: () => 123,
      authenticateDevice: deviceSpy,
      authenticatePkce: pkceSpy,
    });

    const res = await authenticateCodex({ device: true });
    expect(res.access_token).toBe('at');
    expect(deviceSpy).toHaveBeenCalledTimes(1);
    expect(pkceSpy).toHaveBeenCalledTimes(0);
  });

  it('uses paste auth when opts.paste is true', async () => {
    const deviceSpy = vi.fn(async (_params: Parameters<CodexCloudAuthenticatorDeps['authenticateDevice']>[0]) => ({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'it',
      account_id: 'acct',
    }));
    const pkceSpy = vi.fn(async (_params: Parameters<CodexCloudAuthenticatorDeps['authenticatePkce']>[0]) => ({
      access_token: 'at2',
      refresh_token: 'rt2',
      id_token: 'it2',
      account_id: 'acct2',
    }));

    const authenticateCodex = createCodexCloudAuthenticator({
      now: () => 123,
      authenticateDevice: deviceSpy,
      authenticatePkce: pkceSpy,
    });

    const res = await authenticateCodex({ paste: true });
    expect(res.access_token).toBe('at2');
    expect(pkceSpy).toHaveBeenCalledWith(expect.objectContaining({ mode: 'paste' }));
    expect(deviceSpy).toHaveBeenCalledTimes(0);
  });

  it('defaults to loopback auth when no mode flags are set', async () => {
    const deviceSpy = vi.fn(async (_params: Parameters<CodexCloudAuthenticatorDeps['authenticateDevice']>[0]) => ({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'it',
      account_id: 'acct',
    }));
    const pkceSpy = vi.fn(async (_params: Parameters<CodexCloudAuthenticatorDeps['authenticatePkce']>[0]) => ({
      access_token: 'at2',
      refresh_token: 'rt2',
      id_token: 'it2',
      account_id: 'acct2',
    }));

    const authenticateCodex = createCodexCloudAuthenticator({
      now: () => 123,
      authenticateDevice: deviceSpy,
      authenticatePkce: pkceSpy,
    });

    await authenticateCodex({});
    expect(pkceSpy).toHaveBeenCalledWith(expect.objectContaining({ mode: 'loopback' }));
  });

  it('does not force device auth when opts.noOpen is true', async () => {
    const deviceSpy = vi.fn(async (_params: Parameters<CodexCloudAuthenticatorDeps['authenticateDevice']>[0]) => ({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'it',
      account_id: 'acct',
    }));
    const pkceSpy = vi.fn(async (_params: Parameters<CodexCloudAuthenticatorDeps['authenticatePkce']>[0]) => ({
      access_token: 'at2',
      refresh_token: 'rt2',
      id_token: 'it2',
      account_id: 'acct2',
    }));

    const authenticateCodex = createCodexCloudAuthenticator({
      now: () => 123,
      authenticateDevice: deviceSpy,
      authenticatePkce: pkceSpy,
    });

    await authenticateCodex({ noOpen: true });
    expect(pkceSpy.mock.calls[0]?.[0]).toMatchObject({ mode: 'loopback', opts: { noOpen: true } });
    expect(deviceSpy).toHaveBeenCalledTimes(0);
  });

  it('rejects setting both paste and device auth modes', async () => {
    const deviceSpy = vi.fn(async (_params: Parameters<CodexCloudAuthenticatorDeps['authenticateDevice']>[0]) => ({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'it',
      account_id: 'acct',
    }));
    const pkceSpy = vi.fn(async (_params: Parameters<CodexCloudAuthenticatorDeps['authenticatePkce']>[0]) => ({
      access_token: 'at2',
      refresh_token: 'rt2',
      id_token: 'it2',
      account_id: 'acct2',
    }));

    const authenticateCodex = createCodexCloudAuthenticator({
      now: () => 123,
      authenticateDevice: deviceSpy,
      authenticatePkce: pkceSpy,
    });

    await expect(authenticateCodex({ paste: true, device: true })).rejects.toThrow(/paste/i);
    expect(deviceSpy).toHaveBeenCalledTimes(0);
    expect(pkceSpy).toHaveBeenCalledTimes(0);
  });
});
