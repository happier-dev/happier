import { describe, expect, it } from 'vitest';
import type { ManagedMachineFullV1 } from './managedMachineV1.js';
import {
  respondToManagedInstallation,
  type ManagedInstallationAnsweringClient,
} from './installationResponse.js';

const controller = { machineId: 'controller', installationId: 'installation' };
const launch = {
  provider: { pluginId: 'custom.compute', localId: 'native' },
  schemaVersion: 1,
  name: 'Guest',
  choices: {},
};
const resource = {
  contributionRef: launch.provider,
  schemaVersion: 1,
  value: { nativeId: 'guest' },
};
const signIn = {
  kind: 'auth.approveRemoteProvisioning' as const,
  message: 'Sign this managed machine into your Account?',
};
const admitted = {
  homeId: 'home',
  managedId: 'guest-row',
  operationId: 'acquire-operation',
};

function row(
  overrides: Partial<ManagedMachineFullV1> = {},
): ManagedMachineFullV1 {
  return {
    id: admitted.managedId,
    homeId: admitted.homeId,
    custodianAccountId: 'owner',
    enrollmentAccountId: 'member',
    controller,
    launch,
    allocation: 'bound',
    resource,
    creationState: 'active',
    desired: 'start',
    desiredWhen: 'now',
    intentRevision: 3,
    retention: { kind: 'until-delete' },
    wakeOnAcceptedMessage: false,
    ...overrides,
  };
}

/** The member daemon's answering client: its own sign-in, bound to the acquire its executor admitted. */
function memberDaemon(machine: ManagedMachineFullV1) {
  const delivered: unknown[] = [];
  const approvedPairings: unknown[] = [];
  const client: ManagedInstallationAnsweringClient = {
    accountId: 'member',
    homeId: 'home',
    accountAuthority: false,
    admittedAcquire: admitted,
    assertCurrent: () => {},
    readMachine: async () => ({ originalMachine: machine, machine }),
    readOperation: async () => {
      throw new Error(
        'A requester answer never reads the controller operation',
      );
    },
    invokeTask: async () => {
      throw new Error(
        'A requester answer never reaches the custodian task port',
      );
    },
    invokeInstallation: async (response) => {
      delivered.push(response);
      return response.delivery
        ? {
            ok: true,
            result: {
              publicKey: 'guest-key',
              homeServerIdentityId: 'home',
              pairing: {
                secretB64Url: 'pairing-secret',
                createdAtMs: Date.now() - 1,
                expiresAtMs: Date.now() + 60_000,
              },
              supportsTokenOnly: true,
              pairingRequirement: 'v3',
              enrollmentAccountId: 'member',
            },
          }
        : { ok: true, result: { ok: true } };
    },
    approvePairing: async (pairing) => {
      approvedPairings.push(pairing.enrollmentAccountId);
      return undefined;
    },
  };
  return { client, delivered, approvedPairings };
}

const answer = (
  overrides: Partial<typeof admitted> = {},
  prompt: Readonly<{ kind: string; message: string }> = signIn,
) => ({
  serverId: 'server',
  ...admitted,
  ...overrides,
  taskId: 'enrollment-task',
  purpose: 'approve' as const,
  prompt: prompt as typeof signIn,
  approved: true,
});
const context = {
  surface: 'agent',
  authority: 'account_automation',
  runtimeAccountId: 'member',
  serverId: 'server',
} as const;

describe('a requester daemon answering the guest sign-in of the acquire it admitted', () => {
  it('signs the guest into its own Account for exactly that admitted operation', async () => {
    const daemon = memberDaemon(row());
    expect(
      await respondToManagedInstallation(answer(), context, daemon.client),
    ).toEqual({ taskId: 'enrollment-task' });
    expect(daemon.approvedPairings).toEqual(['member']);
    expect(daemon.delivered).toEqual([
      expect.objectContaining({
        ...admitted,
        taskId: 'enrollment-task',
        expectedPromptKind: signIn.kind,
        delivery: { kind: 'terminalPairing' },
      }),
      expect.objectContaining({
        ...admitted,
        taskId: 'enrollment-task',
        expectedPromptKind: signIn.kind,
        answer: { approved: true },
      }),
    ]);
  });

  it.each([
    [
      'another operation on the same row',
      answer({ operationId: 'other-operation' }),
      row(),
    ],
    [
      'another row',
      answer({ managedId: 'other-row' }),
      row({ id: 'other-row' }),
    ],
    [
      'another question on its own operation',
      answer(
        {},
        { kind: 'daemon.replaceRemoteBackgroundServices', message: 'Replace?' },
      ),
      row(),
    ],
    [
      "a row enrolling another person's Account",
      answer(),
      row({ enrollmentAccountId: 'someone-else' }),
    ],
    [
      "the custodian's own sign-in, which its controller answers",
      answer(),
      row({ custodianAccountId: 'member' }),
    ],
  ])('refuses %s and sends nothing', async (_case, input, machine) => {
    const daemon = memberDaemon(machine);
    expect(
      await respondToManagedInstallation(input, context, daemon.client),
    ).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(daemon.delivered).toEqual([]);
    expect(daemon.approvedPairings).toEqual([]);
  });
});
