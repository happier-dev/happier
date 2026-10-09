import { describe, expect, it } from 'vitest';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';

describe('spawn requester admission currentness', () => {
  it('refuses expired requester admission before resolving Account or Agent inputs', async () => {
    expect(await prepareExecuteSpawnSessionRequest({
      request: { options: { directory: '/repo',
        requesterWorkAttributionV1: { serverId: 'home', accountId: 'alice', machineId: 'machine', installationId: 'installation' },
        verifyRequesterMachineAdmissionCurrent: async () => false,
      }, credentials: { token: 'owner-token', encryption: null } },
      validateEnvVarRecordStrict,
    })).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE });
  });
});
