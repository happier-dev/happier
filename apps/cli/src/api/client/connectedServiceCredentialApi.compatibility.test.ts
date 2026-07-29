import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios');
vi.mock('./serverHttpBaseUrl', () => ({
  resolveServerHttpBaseUrl: () => 'https://server.example',
}));
vi.mock('./serverEndpointFailureLog', () => ({
  logServerEndpointFailure: vi.fn(),
}));

import { ConnectedServiceCredentialHttpClient } from './connectedServiceCredentialApi';

describe('connected-service credential exact 0.2.1 response boundary', () => {
  beforeEach(() => {
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.delete).mockReset();
    vi.mocked(axios.isAxiosError).mockReset();
  });

  it('accepts the released no-revision response only as legacy_unfenced', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'ciphertext' },
        metadata: { kind: 'token' },
      },
    });

    const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
    await expect(api.getConnectedServiceCredentialSealed({
      serviceId: 'github',
      profileId: 'work',
    })).resolves.toEqual({
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
      sealed: { format: 'account_scoped_v1', ciphertext: 'ciphertext' },
      metadata: { kind: 'token' },
    });
  });

  it.each([
    {
      storageMode: 'plain' as const,
      cleanupGroupReferences: true,
      expectedUrl:
        'https://server.example/v3/connect/github/profiles/work/credential'
        + '?cleanupGroupReferences=true'
        + '&expectedCredentialRevision=csr_0123456789ABCDEFGHJKMNPQRS',
    },
    {
      storageMode: 'e2ee' as const,
      cleanupGroupReferences: false,
      expectedUrl:
        'https://server.example/v2/connect/github/profiles/work/credential'
        + '?expectedCredentialRevision=csr_0123456789ABCDEFGHJKMNPQRS',
    },
  ])(
    'deletes a revisioned $storageMode credential through its guarded route',
    async ({
      storageMode,
      cleanupGroupReferences,
      expectedUrl,
    }) => {
      vi.mocked(axios.delete).mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
      await expect(api.deleteConnectedServiceCredentialRevisioned({
        storageMode,
        serviceId: 'github',
        profileId: 'work',
        expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        cleanupGroupReferences,
      })).resolves.toBeUndefined();

      expect(axios.delete).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer token',
          },
        }),
      );
    },
  );

  it('preserves a revision conflict as a control conflict', async () => {
    vi.mocked(axios.isAxiosError).mockReturnValue(true);
    vi.mocked(axios.delete).mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'connect_credential_revision_conflict' },
      },
    });

    const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
    await expect(api.deleteConnectedServiceCredentialRevisioned({
      storageMode: 'plain',
      serviceId: 'github',
      profileId: 'work',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      cleanupGroupReferences: false,
    })).rejects.toMatchObject({
      code: 'connect_credential_revision_conflict',
      controlStatus: 'conflict',
    });
  });
});
