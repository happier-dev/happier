import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';

vi.mock('@/daemon/connectedServices/catalogHooks', () => ({
  getConnectedServicesMaterializer: vi.fn(async () => async (params: {
    selectionsByServiceId?: ReadonlyMap<string, unknown>;
    recordsByServiceId: ReadonlyMap<string, unknown>;
  }) => ({
    env: {
      SELECTION_COUNT: String(params.selectionsByServiceId?.size ?? 0),
      RECORD_COUNT: String(params.recordsByServiceId.size),
    },
    cleanupOnFailure: null,
    cleanupOnExit: null,
  })),
}));

describe('materializeConnectedServicesForSpawn selections', () => {
  it('passes resolved connected-service selections through the provider materializer', async () => {
    const { materializeConnectedServicesForSpawn } = await import('./materializeConnectedServicesForSpawn');
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-1',
      activeServerDir: '/tmp/server',
      baseDir: '/tmp/base',
      recordsByServiceId: new Map([['openai-codex', record]]),
      selectionsByServiceId: new Map([
        ['openai-codex', {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          activeProfileId: 'work',
          fallbackProfileId: 'work',
          generation: 3,
          record,
          policy: { v: 1 },
        }],
      ]),
    });

    expect(result?.env).toMatchObject({
      RECORD_COUNT: '1',
      SELECTION_COUNT: '1',
    });
    expect(readConnectedServiceChildSelectionsFromEnv(result?.env ?? {})?.get('openai-codex')).toMatchObject({
      kind: 'group',
      groupId: 'codex-main',
      activeProfileId: 'work',
      generation: 3,
    });
  });
});
