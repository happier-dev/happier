import * as React from 'react';
import sodium from 'libsodium-wrappers';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
  type ExternalActionRequestEnvelopeV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

import type { LibsodiumKeyPair } from '@/encryption/libsodium.lib';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import {
  createMachineReadBatchResponseFixture,
  createPlainMachineRowFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import { t } from '@/text';

// The log viewport's recycler depends on native layout; render its rows deterministically at that boundary.
vi.mock('@legendapp/list/react-native', async () =>
    (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock({ renderItems: true }));

// Only the authenticated Home HTTP boundary is substituted. The sheet, its hook, the Action front door, the executor's
// Machine-owned admission routing and the requester sealing stay real; the daemon's reply is the boundary answer.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { ServiceCommandSheet } = await import('./ServiceCommandSheet');

const actionId = 'machines.services.exec';
const actionPath = `/v1/actions/${actionId}`;
const target = {
  kind: 'current' as const,
  serviceId: 'web',
  expectedGeneration: 'gen-7',
};
let serverId: string;
let installationKey: LibsodiumKeyPair;

type Received = Readonly<{
  envelope: ExternalActionRequestEnvelopeV1;
  confirmedActionId: string | null;
}>;

beforeEach(async () => {
  await sodium.ready;
  installationKey = sodium.crypto_sign_seed_keypair(
    new Uint8Array(32).fill(23),
  );
  await homes.reset();
  await initializeRealAppRuntimeForTests();
  installHomeGovernanceBoundaries(homes);
  serverId = await homes.addHome({
    name: 'Service command',
    serverUrl: 'https://service-command.test',
    serverIdentityId: 'srv_service_command',
    accountId: 'account',
    currentAccount: true,
    active: true,
  });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const { restoreConnectionToActiveServer } =
    await import('@/sync/runtime/orchestration/connectionManager');
  const credentials = await TokenStorage.getCredentialsForServerUrl(
    'https://service-command.test',
    { serverId },
  );
  if (!credentials)
    throw new Error('Service command Home credentials unavailable');
  await restoreConnectionToActiveServer(credentials);
});
afterEach(async () => {
  await homes.reset();
  standardCleanup();
});

/** The Machine daemon's side of the boundary: it receives each exec and answers with `reply`. */
function answerExec(
  reply: (envelope: ExternalActionRequestEnvelopeV1) => unknown,
): Received[] {
  const received: Received[] = [];
  const row = {
    ...createPlainMachineRowFixture({ id: 'machine', accountId: 'account' }),
    installationId: 'installation',
    installationPublicKey: encodeBase64(installationKey.publicKey, 'base64'),
  };
  homes.answer(serverId, 'POST /v1/machines/read-batch', {
    select: async (body) => ({
      body: await createMachineReadBatchResponseFixture(body, () => row).json(),
    }),
  });
  const authorize = (
    envelope: ExternalActionRequestEnvelopeV1,
    authentication: unknown,
  ) => ({
    v: 1,
    token: 'service-command-proof',
    binding: {
      serverIdentityId: 'srv_service_command',
      accountId: 'account',
      authentication,
      actionId,
      requestId: envelope.requestId,
      target: { kind: 'machine', machineId: 'machine' },
      machineId: 'machine',
      installationId: 'installation',
      custodianAccountId: 'account',
      accountEncryptionMode: 'plain',
      requestEnvelopeDigest:
        computeExternalActionRequestEnvelopeDigestV1(envelope),
    },
  });
  homes.answer(serverId, `${actionPath}/execution-authorization`, {
    select: (body) => {
      const request = body as { envelope: unknown; authentication?: unknown };
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(
        request.envelope,
      );
      return { body: authorize(envelope, { kind: 'account', tokenEpoch: 0 }) };
    },
  });
  homes.answer(serverId, actionPath, {
    select: (body) => {
      const request =
        ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const requester = request.executionAuthorization
        ? openExternalActionRequesterAccountContextV1({
            authorization: request.executionAuthorization,
            purpose: { kind: 'external_action' },
            machineId: 'machine',
            installationId: 'installation',
            serverIdentityId: 'srv_service_command',
            installationPrivateKey: installationKey.privateKey,
            includeInvocation: true,
          })
        : null;
      // A plain Account sends the readable V1 envelope.
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
      received.push({
        envelope,
        confirmedActionId:
          requester?.invocation?.presentUserConfirmation?.actionId ?? null,
      });
      return {
        body: {
          v: 1,
          actionId,
          requestId: envelope.requestId,
          execution: { ok: true, result: reply(envelope) },
        },
      };
    },
  });
  return received;
}

const render = () =>
  renderScreen(
    <ServiceCommandSheet
      serverId={serverId}
      machineId="machine"
      machineName="shop-prod"
      serviceName="web"
      place="shop · Production"
      target={target}
    />,
  );

it("hands the typed words and the person's press to the Machine once, then shows the redacted output and exit code", async () => {
  let output = {
    exitCode: 0,
    stdout: 'Prisma schema loaded\nDatabase schema is up to date!\n',
    stderr: '',
  };
  const received = answerExec(() => output);
  const screen = await render();
  try {
    screen.changeTextByTestId(
      'service-command.input',
      'pnpm prisma migrate status',
    );
    await vi.waitFor(() =>
      expect(
        screen.findHostByTestId('service-command.run')!.props.accessibilityState
          ?.disabled,
      ).toBe(false),
    );
    await screen.pressByTestIdAsync('service-command.run');
    await vi.waitFor(() =>
      expect(screen.findHostByTestId('service-command.lines')).not.toBeNull(),
    );
    expect(received).toHaveLength(1);
    expect(received[0]!.envelope.input).toMatchObject({
      serverId,
      machineId: 'machine',
      mode: 'exec',
      target,
      argv: ['pnpm', 'prisma', 'migrate', 'status'],
    });
    // The person's press is the approval: the daemon receives it as a present-user confirmation of this Action.
    expect(received[0]!.confirmedActionId).toBe(actionId);
    expect(screen.getTextContent()).toContain('Database schema is up to date!');
    expect(screen.getTextContent()).toContain(
      t('machineServices.command.redacted'),
    );
    // Run again sends exactly one more exec and replaces the output with the new run's.
    output = { exitCode: 1, stdout: '', stderr: 'Drift detected\n' };
    await screen.pressByTestIdAsync('service-command.run');
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain('Drift detected'),
    );
    expect(received).toHaveLength(2);
  } finally {
    await screen.unmount();
  }
});

it('refuses shell syntax at the field and says how to run it, without sending anything', async () => {
  const received = answerExec(() => ({ exitCode: 0, stdout: '', stderr: '' }));
  const screen = await render();
  try {
    screen.changeTextByTestId(
      'service-command.input',
      'cat /var/log/app.log | tail',
    );
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain(
        t('machineServices.command.shellSyntax'),
      ),
    );
    expect(
      screen.findHostByTestId('service-command.run')!.props.accessibilityState
        ?.disabled,
    ).toBe(true);
    await screen.pressByTestIdAsync('service-command.run');
    expect(received).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});

it('never reads a dispatched command with no exit as finished', async () => {
  answerExec(() => ({ kind: 'outcome_unknown' }));
  const screen = await render();
  try {
    screen.changeTextByTestId('service-command.input', 'pnpm db:seed');
    await vi.waitFor(() =>
      expect(
        screen.findHostByTestId('service-command.run')!.props.accessibilityState
          ?.disabled,
      ).toBe(false),
    );
    await screen.pressByTestIdAsync('service-command.run');
    await vi.waitFor(() =>
      expect(screen.findHostByTestId('service-command.unknown')).not.toBeNull(),
    );
    expect(screen.findHostByTestId('service-command.lines')).toBeNull();
  } finally {
    await screen.unmount();
  }
});
