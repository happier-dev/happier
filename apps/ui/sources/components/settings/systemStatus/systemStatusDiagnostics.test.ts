import { describe, expect, it } from 'vitest';

import { sanitizeActiveServerSnapshotForDiagnostics } from './systemStatusDiagnostics';

describe('system status diagnostics projection', () => {
  it('sanitizes every active-server URL', () => {
    const projected = sanitizeActiveServerSnapshotForDiagnostics({
      generation: 1,
      serverId: 'home-stable-id',
      serverUrl: 'https://server-user:server-secret@legacy.example.test/path?token=server-token#server-fragment',
      activeShareableServerUrl: 'https://share-user:share-secret@share.example.test/path?token=share-token#share-fragment',
      activeShareableServerUrlValidatedAgainstServerUrl: 'https://validated-user:validated-secret@validated.example.test/path?token=validated-token#validated-fragment',
      activeLocalRelayUrl: 'http://relay-user:relay-secret@127.0.0.1:43122/path?token=relay-token#relay-fragment',
      runtimeOrigin: 'http://runtime-user:runtime-secret@127.0.0.1:43123/path?token=runtime-token#runtime-fragment',
      carrier: 'iroh',
    });

    expect(projected).toEqual({
      generation: 1,
      serverId: 'home-stable-id',
      serverUrl: 'https://legacy.example.test/path',
      activeShareableServerUrl: 'https://share.example.test/path',
      activeShareableServerUrlValidatedAgainstServerUrl: 'https://validated.example.test/path',
      activeLocalRelayUrl: 'http://127.0.0.1:43122/path',
      runtimeOrigin: 'http://127.0.0.1:43123/path',
      carrier: 'iroh',
    });
    const serialized = JSON.stringify(projected);
    for (const secret of [
      'server-secret',
      'server-token',
      'share-secret',
      'share-token',
      'validated-secret',
      'validated-token',
      'relay-secret',
      'relay-token',
      'runtime-secret',
      'runtime-token',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
