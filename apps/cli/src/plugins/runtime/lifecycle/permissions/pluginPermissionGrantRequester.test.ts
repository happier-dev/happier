import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PluginInstallReviewPrincipalDigestSchema,
  PluginPermissionSubjectV1Schema,
} from '@happier-dev/protocol';

import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import { createServerPluginPermissionGrantRequester } from './pluginPermissionGrantRequester';

vi.mock('axios');
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: vi.fn(),
}));

describe('server plugin permission grant requester', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(createDefaultPluginInstallationPublisherHeader).mockReset();
  });

  it('posts the exact host-derived request with account authentication and installation proof', async () => {
    const subject = PluginPermissionSubjectV1Schema.parse({
      kind: 'credential_access_disclosure',
      contribution: { pluginId: 'acme.voice', localId: 'speech' },
      credentialSlotId: 'api_key',
      purpose: 'voice.speech',
      accessDeclarationDigest: 'c'.repeat(64),
      selectedAuthorityDigest: 'd'.repeat(64),
      selectedRawAccessDigest: 'e'.repeat(64),
      installedGenerationId: 'generation-1',
      installReviewPrincipalDigest: PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64)),
    });
    const request = {
      pluginId: 'acme.voice',
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject,
      requester: { kind: 'plugin', pluginId: 'acme.voice' },
      reason: 'Voice provider raw credential access review',
    } as const;
    const output = {
      pendingRequest: {
        v: 1,
        id: 'request-1',
        accountId: 'account-1',
        ...request,
        authoritySource: {
          kind: 'machine_installation',
          machineId: 'machine-1',
          installationId: 'installation-1',
        },
        status: 'pending',
        createdAt: 1,
        updatedAt: 1,
      },
    } as const;
    vi.mocked(createDefaultPluginInstallationPublisherHeader).mockResolvedValue('publisher-proof');
    vi.mocked(axios.post).mockResolvedValue({ data: output });
    const signal = new AbortController().signal;
    const requester = createServerPluginPermissionGrantRequester({
      credentials: { token: 'account-token' } as never,
    });

    await expect(requester.request(request, { signal })).resolves.toEqual(output);
    expect(createDefaultPluginInstallationPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/plugins/permissions/grants/request',
      body: request,
    });
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/plugins\/permissions\/grants\/request$/u),
      request,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer account-token',
          'x-happier-plugin-installation-manifest-publisher': 'publisher-proof',
        }),
        signal,
      }),
    );
  });
});
