import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createMachineRolesRuntime } from '../roles/machineRolesRuntime';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';

// Every Session start (Machine RPC, control route, workflow start, host Action ingress, CLI) reaches
// the session control runtime's spawn admission; the sessions role refusal lives there.
it('refuses every new Session typed while the sessions role is off, keeps Stop, and admits again once on', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-sessions-role-'));
  // Server boundary: the Machine's opened metadata.
  let metadata: Record<string, unknown> = { rolesV1: { active: ['memory'] } };
  let metadataVersion = 1;
  const roles = createMachineRolesRuntime({ initialStoredRoles: ['memory'], port: {
    read: async () => ({ status: 'ready' as const, metadata, metadataVersion }),
    compareAndSwap: async () => ({ status: 'conflict' as const, metadata, metadataVersion }),
  } });
  const fixture = await createRequesterSessionControlRuntimeFixture({
    happyHomeDir: join(directory, 'home'), activeServerDir: join(directory, 'home', 'servers', 'sessions-home'),
    serverId: 'sessions-home', serverHttpBaseUrl: 'https://sessions-home.invalid',
    machineId: 'machine-sessions', custodianAccountId: 'owner', credentials: { token: 'sessions-fixture', encryption: null },
    connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
    registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
    resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    startup: { machineRoles: roles },
  });
  const missingDirectory = join(directory, 'no-such-project');
  try {
    const { runtime } = fixture;
    const refused = { type: 'error', errorCode: RPC_ERROR_CODES.MACHINE_ROLE_INACTIVE };
    expect(await runtime.spawnSession({ directory: missingDirectory })).toMatchObject(refused);
    expect(await runtime.spawnSessionForInternalResume({ directory: missingDirectory, existingSessionId: 'session-old' }))
      .toMatchObject(refused);
    // Running Sessions finish: Stop is not a new Session.
    expect(await runtime.stopSession('session-unknown')).not.toMatchObject({ errorCode: RPC_ERROR_CODES.MACHINE_ROLE_INACTIVE });

    metadata = { rolesV1: { active: ['memory', 'sessions'] } };
    metadataVersion++;
    await roles.reload();
    expect(await runtime.spawnSession({ directory: missingDirectory }))
      .not.toMatchObject({ errorCode: RPC_ERROR_CODES.MACHINE_ROLE_INACTIVE });
  } finally {
    roles.stop();
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
