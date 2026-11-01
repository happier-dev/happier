import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveBoxPublicKeyFromSeed, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { ApiClient } from './api';
import { encodeBase64, encrypt } from './encryption';

vi.mock('@/configuration', () => ({ configuration: {
  apiServerUrl: 'https://plain-machines.example.test', serverUrl: 'https://plain-machines.example.test',
} }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), infoFile: vi.fn() } }));

describe('plain machine registration', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(['tokenOnly', 'dataKey'] as const)('registers and reads plain Machine content for %s account credentials', async (credentialMode) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
      features: { encryption: { plaintextMachine: { enabled: true } } },
      capabilities: { encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' } },
    }) })));
    const metadata = { host: 'plain', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/tmp/happy', happyLibDir: '/tmp/lib' };
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } } : { status: 404 });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, data: unknown) => {
      const body = data as { metadata: string; dataEncryptionKey: string };
      expect(body.metadata).toBe(encodePlainMachineStoredContent(metadata));
      expect(body.dataEncryptionKey).toBe(MACHINE_PLAIN_DATA_KEY_MARKER);
      return { data: { machine: { id: 'machine', metadata: body.metadata, dataEncryptionKey: body.dataEncryptionKey,
        metadataVersion: 1, daemonState: null, daemonStateVersion: 0 } } };
    });
    const machineKey = new Uint8Array(32).fill(7);
    const api = await ApiClient.create({ token: 'token', encryption: credentialMode === 'dataKey'
      ? { type: 'dataKey', machineKey, publicKey: deriveBoxPublicKeyFromSeed(machineKey) }
      : null });
    await expect(api.getOrCreateMachine({ machineId: 'machine', metadata }))
      .resolves.toMatchObject({ encryptionVariant: 'plain', encryptionKey: null, metadata });
    expect(post).toHaveBeenCalledOnce();
  });

  it('preserves complete historical documents when converting encrypted machine content', async () => {
    const secret = new Uint8Array(32).fill(7);
    const metadata = { host: 'historical', platform: 'linux', happyCliVersion: 'old', homeDir: '/old', happyHomeDir: '/old/.happy', happyLibDir: '/old/lib', retainedExtension: { important: true } };
    const daemonState = { retainedState: ['old', 'state'] };
    const raw = { id: 'historical', dataEncryptionKey: null,
      metadata: encodeBase64(encrypt(secret, 'legacy', metadata)), metadataVersion: 5,
      daemonState: encodeBase64(encrypt(secret, 'legacy', daemonState)), daemonStateVersion: 9 };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
      features: { encryption: { plaintextMachine: { enabled: true } } },
      capabilities: { encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' } },
    }) })));
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } } : { status: 200, data: { machine: raw } });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, data: unknown) => {
      if (String(url).endsWith('/content-key/transition')) {
        expect(data).toMatchObject({
          expected: { dataEncryptionKey: null, metadataVersion: 5, daemonStateVersion: 9 },
          next: { dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            metadata: encodePlainMachineStoredContent(metadata), daemonState: encodePlainMachineStoredContent(daemonState) },
        });
        return { data: { kind: 'committed', machine: { ...raw, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
          metadata: encodePlainMachineStoredContent(metadata), daemonState: encodePlainMachineStoredContent(daemonState) } } };
      }
      return { data: { machine: { ...raw, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent(metadata), daemonState: encodePlainMachineStoredContent(daemonState) } } };
    });
    const api = await ApiClient.create({ token: 'token', encryption: { type: 'legacy', secret } });
    const machine = await api.getOrCreateMachine({ machineId: 'historical', metadata });
    expect(machine.metadata).toEqual(metadata);
    expect(machine.daemonState).toEqual(daemonState);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('does not register over encrypted history when its key cannot open the old documents', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
      features: { encryption: { plaintextMachine: { enabled: true } } },
      capabilities: { encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' } },
    }) })));
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } } : { status: 200, data: { machine: {
      id: 'locked', dataEncryptionKey: null, metadata: encodeBase64(encrypt(new Uint8Array(32).fill(8), 'legacy', { host: 'locked' })),
      metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
    } } });
    const post = vi.spyOn(axios, 'post');
    const api = await ApiClient.create({ token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } });
    await expect(api.getOrCreateMachine({ machineId: 'locked', metadata: { host: 'new', platform: 'linux', happyCliVersion: 'test', homeDir: '/new', happyHomeDir: '/new/.happy', happyLibDir: '/new/lib' } }))
      .rejects.toMatchObject({ code: 'MACHINE_CONTENT_KEY_UNAVAILABLE' });
    expect(post).not.toHaveBeenCalled();
  });

  it('does not register a plain marker when the account still requires encryption', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
      features: { encryption: { plaintextMachine: { enabled: true } } },
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'e2ee' } },
    }) })));
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'e2ee', updatedAt: 1 } }
      : { status: 200, data: { machine: { id: 'wrong-mode', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent({ host: 'untrusted' }), metadataVersion: 1, daemonState: null, daemonStateVersion: 0 } } });
    const post = vi.spyOn(axios, 'post');
    const api = await ApiClient.create({ token: 'token', encryption: null });
    await expect(api.getOrCreateMachine({ machineId: 'wrong-mode', metadata: { host: 'new', platform: 'linux', happyCliVersion: 'test', homeDir: '/new', happyHomeDir: '/new/.happy', happyLibDir: '/new/lib' } }))
      .rejects.toMatchObject({ rpcErrorCode: 'MACHINE_RPC_ENCRYPTION_ERROR', reason: 'target_key_unavailable' });
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects a registration response that downgrades an encrypted account to plain content', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'e2ee', updatedAt: 1 } }
      : { status: 404 });
    const metadata = { host: 'new', platform: 'linux', happyCliVersion: 'test', homeDir: '/new', happyHomeDir: '/new/.happy', happyLibDir: '/new/lib' };
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { machine: { id: 'downgraded', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: encodePlainMachineStoredContent(metadata), metadataVersion: 1, daemonState: null, daemonStateVersion: 0 } } });
    const api = await ApiClient.create({ token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(4) } });
    await expect(api.getOrCreateMachine({ machineId: 'downgraded', metadata }))
      .rejects.toMatchObject({ rpcErrorCode: 'MACHINE_RPC_ENCRYPTION_ERROR', reason: 'target_key_unavailable' });
  });
});
