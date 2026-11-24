import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import {
  SessionSpawnNewActionResultV1Schema,
  projectSessionSpawnNewActionResultV1,
} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import {
  SpawnSessionControlErrorResponseSchema,
  projectSpawnSessionControlErrorResponse,
} from '@/session/shared/spawnSessionContract';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { prepareDaemonAgentIsolationIdentity } from '../spawn/prepareDaemonAgentIsolationIdentity';
import type {
  HostAgentIsolationLaunchContext,
  HostAgentIsolationLaunchSnapshot,
} from './agentIsolationLaunchPolicy';
import { createSessionAgentIsolationMemberPreparation } from './sessionPreparation';

// The daemon reads the Machine's isolation policy from its registered Machine
// client. Until registration settles the read is "unread" (metadata_unavailable),
// which must never be taken as "isolation off".
const machineId = 'machine-startup';
const home = 'canonical-home';
const unread: HostAgentIsolationLaunchSnapshot = {
  enabled: true,
  status: { kind: 'unavailable', code: 'metadata_unavailable' },
  workspaceRoots: [],
};
const isolationOff: HostAgentIsolationLaunchSnapshot = {
  enabled: false,
  status: { kind: 'disabled' },
  workspaceRoots: [],
};
const isolationOnNotSetUp: HostAgentIsolationLaunchSnapshot = {
  enabled: true,
  status: { kind: 'unavailable', code: 'provisioning_unavailable' },
  workspaceRoots: [],
};

/** A daemon whose Machine registration settles when the test says so. */
function startingMachine(
  initial: HostAgentIsolationLaunchSnapshot,
  settledPolicy: HostAgentIsolationLaunchSnapshot,
) {
  let settle!: () => void;
  const registered = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let current = initial;
  const counts = { reads: 0, awaits: 0 };
  const context: HostAgentIsolationLaunchContext = {
    read: () => {
      counts.reads += 1;
      return current;
    },
    awaitReadable: () => {
      counts.awaits += 1;
      return registered;
    },
  };
  return {
    context,
    counts,
    settle() {
      current = settledPolicy;
      settle();
    },
  };
}

const attribution = (accountId: string) => ({
  serverId: 'saved-home',
  machineId,
  installationId: 'installation',
  accountId,
});

function prepareFor(
  context: HostAgentIsolationLaunchContext,
  accountId: string,
) {
  return createSessionAgentIsolationMemberPreparation({
    machineId,
    custodianAccountId: 'owner',
    agentIsolation: context,
    resolveCurrentMachineExecutionOriginContext: async () => ({
      machineId,
      serverIdentityId: home,
    }),
  })(
    {
      bootstrap: {
        attribution: attribution(accountId),
        homeServerIdentityId: home,
        savedSecretOperationContext: {},
      },
    },
    new AbortController().signal,
  );
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

describe('Session isolation preparation during daemon startup', () => {
  it('starts the custodian Session once Machine registration settles on isolation off', async () => {
    const machine = startingMachine(unread, isolationOff);
    const outcome = settled(
      prepareFor(
        machine.context,
        'owner',
      )({ requesterWorkAttributionV1: attribution('owner') }),
    );
    await nextTurn();
    machine.settle();
    expect(await outcome).toEqual({ ok: true, value: undefined });
    expect(machine.counts.awaits).toBe(1);
  });

  it('refuses a cancelled start before registration as retryable "Machine not ready", through the Action result', async () => {
    const machine = startingMachine(unread, isolationOff);
    const request = new AbortController();
    const prepared = prepareDaemonAgentIsolationIdentity({
      hasAgentRuntime: true,
      signal: request.signal,
      requesterWorkAttributionV1: attribution('owner'),
      prepareAgentIsolationMember: prepareFor(machine.context, 'owner'),
    });
    await nextTurn();
    request.abort();
    const result = await prepared;
    if (result.ok)
      throw new Error('Expected the unread Machine policy to refuse');
    const response = SpawnSessionControlErrorResponseSchema.parse(
      projectSpawnSessionControlErrorResponse(result.result),
    );
    const action = SessionSpawnNewActionResultV1Schema.parse(
      projectSessionSpawnNewActionResultV1(
        projectSessionSpawnFailure({
          errorCode: response.errorCode!,
          errorMessage: response.error,
          errorDetail: response.errorDetail,
        }),
      ),
    );
    expect(action).toMatchObject({
      type: 'error',
      code: 'spawn_failed',
      retryable: true,
      launchError: {
        code: 'agent_isolation_unavailable',
        agentIsolationRefusal: {
          reason: 'metadata_unavailable',
          phase: 'native_execution_preparation',
        },
      },
    });
  });

  it('adds no wait and no extra read once the Machine policy is read', async () => {
    const machine = startingMachine(isolationOff, isolationOff);
    await expect(
      prepareFor(
        machine.context,
        'owner',
      )({ requesterWorkAttributionV1: attribution('owner') }),
    ).resolves.toBeUndefined();
    expect(machine.counts).toEqual({ reads: 1, awaits: 0 });
  });

  it('still refuses a guest when the settled policy requires isolation that is not set up', async () => {
    const machine = startingMachine(unread, isolationOnNotSetUp);
    const outcome = settled(
      prepareFor(
        machine.context,
        'guest',
      )({ requesterWorkAttributionV1: attribution('guest') }),
    );
    await nextTurn();
    machine.settle();
    const result = await outcome;
    expect(result.ok).toBe(false);
    const error = result.ok ? undefined : result.error;
    expect(error).toBeInstanceOf(PluginError);
    expect(error).toMatchObject({
      code: 'agent_isolation_unavailable',
      retryable: false,
      details: { reason: 'provisioning_unavailable' },
    });
  });
});
