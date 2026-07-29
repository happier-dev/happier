import { describe, expect, it } from 'vitest';

import {
  CONNECTED_SERVICE_PENDING_AUTH_GROUP_GENERATIONS_METADATA_KEY,
  readConnectedServiceProviderAdoptedAuthGroupGenerationsFromMetadata,
} from './pendingGenerationMetadata';

describe('connected-service generation metadata compatibility', () => {
  it('ignores historical shared application receipts while retaining exact adopted-generation facts', () => {
    const providerAdoptedTarget = {
      serviceId: 'openai-codex' as const,
      groupId: 'team',
      profileId: 'work',
      generation: 2,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      proof: {
        status: 'verified' as const,
        source: 'codex_app_server',
        sharedAuthSurfaceId: 'codex',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    };
    const metadata = {
      [CONNECTED_SERVICE_PENDING_AUTH_GROUP_GENERATIONS_METADATA_KEY]: {
        v: 1,
        entries: [{
          kind: 'shared_application_receipt',
          epochKey: {
            serviceId: 'openai-codex',
            groupId: 'team',
            profileId: 'work',
            generation: 2,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            applicationOwnerId: 'codex',
          },
          providerAdoptedTarget,
          recordedAtMs: 6,
        }, {
          kind: 'provider_adopted_generation',
          providerAdoptedTarget,
          proofStrength: 'exact',
          updatedAtMs: 7,
        }],
      },
    };

    expect(readConnectedServiceProviderAdoptedAuthGroupGenerationsFromMetadata(metadata)).toEqual([{
      kind: 'provider_adopted_generation',
      providerAdoptedTarget,
      proofStrength: 'exact',
      updatedAtMs: 7,
    }]);
  });
});
