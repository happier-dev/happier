import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PluginInstallReviewPrincipalDigestSchema,
  PluginPermissionSubjectV1Schema,
} from '@happier-dev/protocol';
import { createServerPluginPermissionGrantListReader } from './pluginPermissionGrantListReader';

vi.mock('axios');

describe('server plugin permission grant list reader', () => {
  beforeEach(() => vi.mocked(axios.post).mockReset());

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
    } as const;

    await expect(reader.list(query, { signal: controller.signal })).resolves.toEqual(output);
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/plugins\/permissions\/grants\/list$/u),
      query,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer account-token' }),
        signal: controller.signal,
      }),
    );
  });
});
