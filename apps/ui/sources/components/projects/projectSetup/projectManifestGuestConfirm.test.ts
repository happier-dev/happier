import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import tweetnacl from 'tweetnacl';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { createPlainMachineRowFixture, createPlainSharedMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);

// Owner ruling 2026-11-23 ~15:10Z: on a Machine whose owner turned isolation off, a Use guest's own
// Project work is admitted; one confirmation by the guest is enough. Replaced: Home HTTP, and below the receiving executor the daemon's definition writer (the real
// placement and pinning run in the CLI's apiMachine.projectDefinitionOwnWork test). Real: the
// Project file client, the UI front door and default executor, the mounted confirmation and its
// press, the UI Account transport with the guest's sealed requester context, and the receiving
// executor's policy, confirmation admission, review builder and digest comparison.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { ModalProvider } = await import('@/modal');
const { getActiveServerSnapshot } =
  await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } =
  await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { createFrontDoorActionExecute } =
  await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { createProjectManifestActionClient } =
  await import('./projectManifestActionClient');

const homeId = 'srv_guest_definition';
const actionId = 'projects.manifest.update';
const bytes =
  '{"version":1,"scripts":{"check":{"execution":"portable","source":{"kind":"command","command":"true"}}}}';
let serverId = 'home';

beforeEach(async () => {
  await homes.reset();
  serverId = await homes.addHome({
    name: 'Guest Home',
    serverUrl: 'https://guest-definition.test',
    serverIdentityId: homeId,
    accountId: 'guest',
    currentAccount: true,
  });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
});
afterEach(async () => {
  standardCleanup();
  await homes.reset();
});

function installOwnerMachine(custodian: 'owner' | 'guest' = 'owner') {
  const installation = tweetnacl.sign.keyPair.fromSeed(
    new Uint8Array(32).fill(9),
  );
  // The guest holds Use on a Machine another person (the owner) holds, or holds its own Machine.
  const machine = {
    ...(custodian === 'owner'
      ? createPlainSharedMachineRowFixture({ id: 'owner-machine', custodianAccountId: 'owner', role: 'use' })
      : createPlainMachineRowFixture({ id: 'owner-machine', accountId: 'guest' })),
    installationId: 'owner-installation',
    installationPublicKey: encodeBase64(installation.publicKey),
  };
  homes.answer(serverId, '/v1/machines', { body: [machine] });
  homes.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine } });
  homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, {
    select: (body) => {
      const issued =
        ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return {
        body: ExternalActionExecutionAuthorizationV1Schema.parse({
          v: 1,
          token: 'guest-home-root',
          binding: {
            accountId: 'guest',
            authentication: { kind: 'account', tokenEpoch: 0 },
            serverIdentityId: homeId,
            machineId: machine.id,
            installationId: machine.installationId,
            custodianAccountId: custodian,
            accountEncryptionMode: 'plain',
            actionId,
            requestId: issued.envelope.requestId,
            target: issued.envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(
              issued.envelope,
            ),
          },
        }),
      };
    },
  });

  const writes: unknown[] = [];
  // The receiving daemon has no presenter; with this policy it asks for a review before the write.
  const daemon = createActionExecutor({
    readActionsSettings: () =>
      normalizeActionsSettingsV1({
        v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
      }),
    projectDefinitionAction: async ({ input }) => {
      writes.push(input);
      return {
        status: 'saved',
        basis: { kind: 'present', hash: 'b'.repeat(64) },
        document: readProjectManifestDocument(bytes),
      };
    },
    approvalsCreate: async () => {
      throw new Error(
        'a person’s own press never creates a self-approval Artifact',
      );
    },
  });
  const received: Array<{
    confirmation?: { reviewDigest?: string };
    result: { ok: boolean; errorCode?: string; reviewDigest?: string };
  }> = [];
  homes.answer(serverId, `/v1/actions/${actionId}`, {
    select: async (body) => {
      const relayed =
        ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const opened = openExternalActionRequesterAccountContextV1({
        authorization: relayed.executionAuthorization,
        purpose: { kind: 'external_action' },
        machineId: machine.id,
        installationId: machine.installationId,
        serverIdentityId: homeId,
        installationPrivateKey: installation.secretKey,
        includeInvocation: true,
      });
      if (!opened) throw new Error('missing requester context');
      // Without a carried invocation the daemon keeps Home's root for the guest's Account app press.
      const invocation = opened.invocation ?? {
        surface: 'ui' as const,
        authority: 'present_user' as const,
        caller: { kind: 'host' as const },
      };
      const confirmation = invocation.presentUserConfirmation;
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(
        relayed.envelope,
      );
      const execution = await daemon.execute(actionId, envelope.input, {
        surface: invocation.surface,
        authority: invocation.authority,
        actionCaller: invocation.caller,
        serverId: homeId,
        runtimeAccountId: 'guest',
        actionRequestId: envelope.requestId,
        externalActionTarget: envelope.target,
        ...(confirmation ? { presentUserConfirmation: confirmation } : {}),
      });
      const details = execution.ok
        ? undefined
        : (execution.details as { reviewDigest?: string } | undefined);
      received.push({
        confirmation,
        result: execution.ok
          ? { ok: true }
          : {
              ok: false,
              errorCode: execution.errorCode,
              ...(details?.reviewDigest
                ? { reviewDigest: details.reviewDigest }
                : {}),
            },
      });
      return {
        body: {
          v: 1,
          actionId,
          requestId: envelope.requestId,
          execution: execution.ok
            ? { ok: true, result: execution.result }
            : {
                ok: false,
                errorCode: execution.errorCode,
                error: execution.error,
                ...(execution.details ? { details: execution.details } : {}),
              },
        },
      };
    },
  });
  return { machine, writes, received };
}

async function saveProjectFile(machineId: string) {
  const client = createProjectManifestActionClient({
    expectedAccountId: 'guest',
    execute: createFrontDoorActionExecute(createDefaultActionExecutor()),
    workspace: {
      serverId: homeId,
      workspaceId: 'guest-ref',
      machineId,
      rootPath: '/guest/project',
    },
  });
  return client.update({ expectedBasis: { kind: 'absent' }, bytes });
}

describe("a Use guest's own Project file on another person's Machine", () => {
  it('saves with one confirmation by the guest: the press reaches the Machine carrying that confirmation', async () => {
    const { machine, writes, received } = installOwnerMachine();
    const screen = await renderScreen(React.createElement(ModalProvider));
    try {
      let saving!: ReturnType<typeof saveProjectFile>;
      act(() => {
        saving = saveProjectFile(machine.id);
      });
      saving.catch(() => {});
      await vi.waitFor(() => expect(screen.getTextContent()).toContain('Update project file'), { timeout: 10_000 });
      await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 10_000 });
      // The Machine admits the guest's one confirmation; it does not ask for its own review again.
      expect(received[0], JSON.stringify(received)).toMatchObject({ confirmation: expect.any(Object), result: { ok: true } });
      expect(await saving).toMatchObject({ status: 'saved' });
      expect(received).toHaveLength(1);
      expect(writes).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the Machine owner's own confirmed save on that one confirmation", async () => {
    const { machine, writes, received } = installOwnerMachine('guest');
    const screen = await renderScreen(React.createElement(ModalProvider));
    try {
      let saving!: ReturnType<typeof saveProjectFile>;
      act(() => {
        saving = saveProjectFile(machine.id);
      });
      saving.catch(() => {});
      await vi.waitFor(() => expect(screen.getTextContent()).toContain('Update project file'), { timeout: 10_000 });
      await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
      expect(await saving).toMatchObject({ status: 'saved' });
      expect(received).toEqual([expect.objectContaining({ confirmation: expect.any(Object), result: { ok: true } })]);
      expect(writes).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it('writes nothing and reaches no Machine when the guest declines', async () => {
    const { machine, writes, received } = installOwnerMachine();
    const screen = await renderScreen(React.createElement(ModalProvider));
    try {
      let saving!: ReturnType<typeof saveProjectFile>;
      act(() => {
        saving = saveProjectFile(machine.id);
      });
      saving.catch(() => {});
      await vi.waitFor(() => expect(screen.getTextContent()).toContain('Update project file'), { timeout: 10_000 });
      await screen.pressByTestIdAsync('actions.confirmation-review.decision-reject');
      await expect(saving).rejects.toMatchObject({ code: 'approval_canceled' });
      expect(received).toEqual([]);
      expect(writes).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });
});
