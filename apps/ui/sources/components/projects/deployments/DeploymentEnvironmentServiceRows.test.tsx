// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptDetailV1,
  createDeploymentReceiptHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import {
  MachineServiceRowV1Schema,
  MachineServicesListResultV1Schema,
} from '@happier-dev/protocol';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createMachineReadBatchResponseFixture,
  createPlainMachineRowFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
  type HomeDomainAnswer,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/utils/web/reactDomCjs', async () =>
  (
    await import('@/dev/testkit/mocks/reactDomCjs')
  ).createReactDomCjsRendererMock(),
);
vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock(),
);
const routerMock = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => routerMock.module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);

// The Machine RPC transport is a system boundary: an Action placed on the Machine reaches its daemon through it.
const machineTransport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(machineTransport.rpc));

// Only the Home HTTP and Machine RPC boundaries are substituted: the Environment page, the Machine services Resource, the Action
// front door and the shared Run a command sheet run for real (L-A-1107, P1 §3 service row ⋯).
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentEnvironmentDetail } =
  await import('./DeploymentEnvironmentDetail');
const { createDeploymentActions } = await import('./deploymentActions');

const accountId = 'account-owner';
const serverIdentityId = 'srv_environment_service_rows';
const machineId = 'machine-a';
let serverId: string;
type Envelope = ReturnType<typeof ExternalActionRequestEnvelopeV1Schema.parse>;
type Request = Parameters<NonNullable<HomeDomainAnswer['select']>>[1];

function answerAction(
  actionId: string,
  read: (envelope: Envelope, request: Request) => unknown | Promise<unknown>,
) {
  const path = `/v1/actions/${actionId}`;
  homes.answer(serverId, `${path}/execution-authorization`, {
    select: (body) => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(
        (body as { envelope: unknown }).envelope,
      );
      return {
        body: {
          v: 1,
          token: 'service-rows-admission',
          binding: {
            serverIdentityId,
            accountId,
            authentication: { kind: 'account', tokenEpoch: 0 },
            actionId,
            requestId: envelope.requestId,
            target: { kind: 'machine', machineId },
            machineId,
            installationId: 'installation-a',
            custodianAccountId: accountId,
            accountEncryptionMode: 'plain',
            requestEnvelopeDigest:
              computeExternalActionRequestEnvelopeDigestV1(envelope),
          },
        },
      };
    },
  });
  homes.answer(serverId, path, {
    select: async (body, request) => {
      const authorized =
        ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(
        authorized.success ? authorized.data.envelope : body,
      );
      return {
        body: {
          v: 1,
          actionId,
          requestId: envelope.requestId,
          execution: { ok: true, result: await read(envelope, request) },
        },
      };
    },
  });
}

/** The daemon's Resource wire for one services snapshot; the production Resource store owns demand. */
function answerServices(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  const content = {
    contentType: 'application/json',
    bytesBase64: bytes.toString('base64'),
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
  answerAction('machines.services.list', (envelope, request) => {
    const continuation = envelope.resourceContinuation;
    if (!continuation) return value;
    if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)
      return { ok: true, resource: continuation.params.resource, ...content };
    if (
      continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN
    )
      return {
        ok: true,
        subscriptionId: continuation.params.subscriptionId,
        digest: content.digest,
      };
    if (
      continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE
    )
      return { ok: true, closed: true };
    return new Promise((resolve) => {
      const idle = () => resolve({ ok: true, status: 'idle' });
      request.signal?.addEventListener('abort', idle, { once: true });
      if (request.signal?.aborted) idle();
    });
  });
}

beforeEach(async () => {
  await homes.reset();
  await initializeRealAppRuntimeForTests();
  installHomeGovernanceBoundaries(homes);
  serverId = await homes.addHome({
    name: 'Service rows',
    serverUrl: 'https://service-rows.test',
    serverIdentityId,
    accountId,
    currentAccount: true,
    active: true,
  });
  const machine = {
    ...createPlainMachineRowFixture({ id: machineId, accountId }),
    installationId: 'installation-a',
  };
  homes.answer(serverId, 'POST /v1/machines/read-batch', {
    select: async (input) => ({
      body: await createMachineReadBatchResponseFixture(input, (id) =>
        id === machineId ? machine : null,
      ).json(),
    }),
  });
});
afterEach(async () => {
  const { Modal } = await import('@/modal');
  await act(async () => {
    Modal.hideAll();
  });
  await standardCleanup();
  await homes.reset();
});

function environment() {
  const base = createDeploymentEnvironmentDetailV1();
  const detail = {
    ...base,
    environment: createDeploymentEnvironmentHeaderV1({
      ...base.environment,
      serverId,
    }),
  };
  const servingId = detail.targetLinks.find(
    (row) => row.targetLink.id === detail.environment.runtimeTargetLinkId,
  )!.targetLink.activeDeploymentId!;
  const serving = createDeploymentReceiptDetailV1({
    deployment: createDeploymentReceiptHeaderV1({
      id: servingId,
      state: 'succeeded',
    }),
  });
  const transport: DeploymentReadTransportV1 = {
    listDomains: async () => ({
      ok: true,
      value: { items: [], nextCursor: null },
    }),
    listEnvironments: async () => ({
      ok: true,
      value: {
        items: [
          { environment: detail.environment, title: detail.content.name },
        ],
        nextCursor: null,
      },
    }),
    readEnvironment: async () => ({ ok: true, value: detail }),
    listHistory: async () => ({
      ok: true,
      value: { ok: true, items: [serving.deployment], nextCursor: null },
    }),
    readReceipt: async () => ({ ok: true, value: serving }),
  };
  const scope = { serverId, accountId, projectSourceId: 'source-app' };
  return {
    detail,
    serving,
    controller: createDeploymentReadControllerV1({ scope, transport }),
    scope,
  };
}

describe('Environment service row ⋯ (P1 §3)', () => {
  it('restarts the exact serving service through deployments.restart, and opens Run a command on its running container', async () => {
    const { detail, serving, controller, scope } = environment();
    const service =
      serving.content.ownServer?.approvedInputBasis.services[0] ??
      serving.content.images[0]!.service;
    const instance = 'instance-a';
    const row = MachineServiceRowV1Schema.parse({
      serviceId: `${instance}/${service}`,
      name: service,
      authority: 'project',
      lifecyclePurpose: 'deployment',
      generation: 'generation-7',
      state: 'running',
      environmentId: detail.environment.id,
      deployment: {
        deploymentId: serving.deployment.id,
        installationId: 'installation-a',
        service: {
          kind: 'deployment',
          machineId,
          environmentId: detail.environment.id,
          environmentInstanceId: instance,
          composeService: service,
          serviceId: `${instance}/${service}`,
        },
      },
      capabilities: {
        start: true,
        stop: true,
        restart: true,
        logs: true,
        accounting: false,
      },
    });
    answerServices(
      MachineServicesListResultV1Schema.parse({
        kind: 'snapshot',
        services: [row],
      }),
    );
    // The Action owner reads the Environment's current record before it admits the restart.
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
      ok: true, environment: { ...detail.environment, serverId: serverIdentityId }, targetLinks: detail.targetLinks.map(row => row.targetLink),
    } });
    const restarts: unknown[] = [];
    answerAction('deployments.restart', (envelope) => {
      restarts.push(envelope.input);
      return { kind: 'accepted', operation: { operationId: 'restart-1' } };
    });
    const lifetime = {
      scope,
      isCurrent: () => true,
      onRetire: () => ({ dispose() {} }),
    };
    const { ModalProvider } = await import('@/modal');
    const screen = await renderScreen(
      <ModalProvider><DeploymentEnvironmentDetail
        controller={controller}
        environmentId={detail.environment.id}
        demand={{ mounted: true, visible: true, focused: true }}
        accountId={accountId}
        serverId={serverId}
        phone={false}
        deploy={null}
        review={{ pendingId: null, request: () => {}, open: () => {} }}
        onOpenReceipt={() => {}}
        lifetime={lifetime}
        restart={createDeploymentActions(lifetime, 'source-app').restart}
      /></ModalProvider>,
    );
    const menu = `project-deployments.environment.services.${service}.menu`;
    try {
      await waitForHomeGovernance(() =>
        expect(screen.findByTestId(menu)).not.toBeNull(),
      );
      await screen.pressByTestIdAsync(menu);
      await waitForHomeGovernance(() =>
        expect(
          screen.findByTestId(
            `project-deployments.environment.services.${service}.restart`,
          ),
        ).not.toBeNull(),
      );
      await screen.pressByTestIdAsync(
        `project-deployments.environment.services.${service}.restart`,
      );
      const restartCalls = () => [...restarts, ...machineTransport.rpc.mock.calls.map(([call]) => call)
        .filter(call => JSON.stringify(call).includes('deployments.restart'))];
      await waitForHomeGovernance(() => expect(restartCalls(), screen.getTextContent()).toHaveLength(1));
      // The exact serving generation and its admitted identity reach the boundary; no source operands.
      const sent = JSON.stringify(restartCalls()[0]);
      for (const operand of [detail.environment.id, serving.deployment.id, String(detail.environment.runtimeTargetLinkId),
        machineId, 'installation-a', row.deployment!.service.serviceId, 'generation-7']) expect(sent).toContain(operand);

      await screen.pressByTestIdAsync(menu);
      await waitForHomeGovernance(() =>
        expect(
          screen.findByTestId(
            `project-deployments.environment.services.${service}.command`,
          ),
        ).not.toBeNull(),
      );
      await screen.pressByTestIdAsync(
        `project-deployments.environment.services.${service}.command`,
      );
      // The shared sheet, at the generation the row shows: one press runs machines.services.exec there.
      await waitForHomeGovernance(() =>
        expect(screen.findByTestId('service-command.input')).not.toBeNull(),
      );
      expect(restartCalls()).toHaveLength(1);
    } finally {
      await act(async () => {
        controller.retire();
      });
    }
  });

  it('opens the Logs companion on the row\'s service, and Build shows the serving receipt\'s own steps (P11)', async () => {
    const { detail, serving, controller, scope } = environment();
    const service = serving.content.ownServer?.approvedInputBasis.services[0] ?? serving.content.images[0]!.service;
    const instance = 'instance-a';
    answerServices(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [MachineServiceRowV1Schema.parse({
      serviceId: `${instance}/${service}`, name: service, authority: 'project', lifecyclePurpose: 'deployment',
      generation: 'generation-7', state: 'running', environmentId: detail.environment.id,
      deployment: { deploymentId: serving.deployment.id, installationId: 'installation-a', service: { kind: 'deployment', machineId,
        environmentId: detail.environment.id, environmentInstanceId: instance, composeService: service, serviceId: `${instance}/${service}` } },
      capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false },
    })] }));
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const { ModalProvider } = await import('@/modal');
    const screen = await renderScreen(<ModalProvider><DeploymentEnvironmentDetail controller={controller}
      environmentId={detail.environment.id} demand={{ mounted: true, visible: true, focused: true }} accountId={accountId}
      serverId={serverId} phone={false} deploy={null} review={{ pendingId: null, request: () => {}, open: () => {} }}
      onOpenReceipt={() => {}} lifetime={lifetime} /></ModalProvider>);
    const menu = `project-deployments.environment.services.${service}.menu`;
    try {
      // Nothing reads or renders logs until the companion is open.
      expect(screen.findByTestId('environment-logs.runtime')).toBeNull();
      await waitForHomeGovernance(() => expect(screen.findByTestId(menu)).not.toBeNull());
      await screen.pressByTestIdAsync(menu);
      await waitForHomeGovernance(() => expect(screen.findByTestId(`project-deployments.environment.services.${service}.logs`)).not.toBeNull());
      await screen.pressByTestIdAsync(`project-deployments.environment.services.${service}.logs`);
      // The row's service opens on Runtime.
      await waitForHomeGovernance(() => expect(screen.findByTestId('environment-logs.runtime')).not.toBeNull());
      await screen.pressByTestIdAsync('environment-logs.view:build');
      await waitForHomeGovernance(() => expect(screen.findByTestId('environment-logs.build')).not.toBeNull());
    } finally { await act(async () => { controller.retire(); }); }
  });
});
