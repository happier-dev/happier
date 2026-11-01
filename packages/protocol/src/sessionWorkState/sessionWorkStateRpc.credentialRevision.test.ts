import { describe, expect, it } from 'vitest';

import { SessionConnectedServiceAuthApplyGenerationResponseV1Schema } from './sessionWorkStateRpc.js';

describe('selected-account application proof', () => {
  it.each([null, 'csr_aaaaaaaaaaaaaaaaaaaaaa'])(
    'keeps the released revisioned proof shape for credential revision %s', (credentialRevision) => {
      expect(SessionConnectedServiceAuthApplyGenerationResponseV1Schema.safeParse({
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        verification: {
          providerAccountId: 'account-b',
          proofStrength: 'exact',
          generationApplication: {
            serviceId: 'openai-codex', groupId: 'team', profileId: 'backup', generation: 2,
            credentialRevision, credentialFingerprint: 'sha256:current-token',
          },
        },
      }).success).toBe(credentialRevision !== null);
    },
  );
});
