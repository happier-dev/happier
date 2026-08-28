import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/daemon/connectedServices/catalogHooks', () => ({
  getConnectedServiceStateSharingDescriptor: async () => ({
    authIsolation: {
      secretEntries: [
        '.credentials.json',
        '.happier-claude-connected-service-home.json',
      ],
    },
  }),
}));

import { createConnectedServiceRuntimeAuthNativeHome } from './createRuntimeAuthNativeHome';

describe('createConnectedServiceRuntimeAuthNativeHome', () => {
  it('keeps native credential paths and private writes in the host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-native-home-'));
    const nativeHome = await createConnectedServiceRuntimeAuthNativeHome({
      agentId: 'claude',
      root,
    });
    expect(nativeHome).not.toBeNull();

    const credentialBytes = new TextEncoder().encode('{"credential":"opaque"}\n');
    await nativeHome!.replaceFiles({ '.credentials.json': credentialBytes });

    await expect(readFile(join(root, '.credentials.json'))).resolves.toEqual(
      Buffer.from(credentialBytes),
    );
    if (process.platform !== 'win32') {
      expect((await stat(join(root, '.credentials.json'))).mode & 0o777).toBe(0o600);
    }
    await expect(nativeHome!.readFiles(['.credentials.json'])).resolves.toEqual({
      '.credentials.json': credentialBytes,
    });
  });

  it('rejects reads and writes outside the declared credential file set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-native-home-'));
    const nativeHome = await createConnectedServiceRuntimeAuthNativeHome({
      agentId: 'claude',
      root,
    });

    await expect(nativeHome!.readFiles(['../ambient-secret'])).rejects.toThrow(
      'connected_service_native_home_credential_file_undeclared',
    );
    await expect(nativeHome!.replaceFiles({
      '../ambient-secret': new Uint8Array([1]),
    })).rejects.toThrow('connected_service_native_home_credential_file_undeclared');
  });
});
