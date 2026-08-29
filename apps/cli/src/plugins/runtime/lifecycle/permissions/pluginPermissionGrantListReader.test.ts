import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PluginInstallReviewPrincipalDigestSchema,
  PluginPermissionSubjectV1Schema,
} from '@happier-dev/protocol';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import { createServerPluginPermissionGrantListReader } from './pluginPermissionGrantListReader';

vi.mock('axios');
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: vi.fn(),
}));

describe('server plugin permission grant list reader', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(createDefaultPluginInstallationPublisherHeader).mockReset();
  });

  it('posts the exact canonical query with account authentication and parses the response', async () => {
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
    const output = {
      grants: [{
        v: 1,
        id: 'grant-1',
        accountId: 'account-1',
        pluginId: 'acme.voice',
        capability: 'credentials.materialize.raw',
        targetScope: { kind: 'account' },
        subject,
        authoritySource: { kind: 'bundled' },
        status: 'active',
        grantedByUserId: 'user-1',
        grantedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
      pendingRequests: [],
    } as const;
    vi.mocked(axios.post).mockResolvedValue({ data: output });
    const controller = new AbortController();
    const reader = createServerPluginPermissionGrantListReader({
      credentials: { token: 'account-token' } as never,
    });
    const query = {
      pluginId: 'acme.voice',
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject,
      includeRevoked: false,
      includeResolvedRequests: false,
      limit: 200,
      caller: {
        pluginId: 'acme.voice',
        machineId: 'machine-1',
        materializationId: 'materialization-1',
      },
    } as const;
    vi.mocked(createDefaultPluginInstallationPublisherHeader).mockResolvedValue('publisher-proof');

    await expect(reader.list(query, { signal: controller.signal })).resolves.toEqual(output);
    expect(createDefaultPluginInstallationPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/plugins/permissions/grants/list',
      body: query,
    });
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/plugins\/permissions\/grants\/list$/u),
      query,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer account-token',
          'x-happier-plugin-installation-manifest-publisher': 'publisher-proof',
        }),
        signal: controller.signal,
      }),
    );
  });

  it('does not send caller provenance when the matching publisher proof is unavailable', async () => {
    const reader = createServerPluginPermissionGrantListReader({
      credentials: { token: 'account-token' } as never,
    });

    await expect(reader.list({
      pluginId: 'acme.voice',
      caller: {
        pluginId: 'acme.voice',
        machineId: 'machine-1',
        materializationId: 'materialization-1',
      },
      includeRevoked: false,
      includeResolvedRequests: false,
      limit: 50,
    })).rejects.toThrow('plugin_permission_grant_publisher_proof_unavailable');
    expect(axios.post).not.toHaveBeenCalled();
  });
});
