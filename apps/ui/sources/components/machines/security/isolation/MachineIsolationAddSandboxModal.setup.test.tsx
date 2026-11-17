import * as React from 'react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import {
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import {
  MachineSetupPlanInputV1Schema,
  MachineSetupPlanResultV1Schema,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineProvisionersListResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createManagedControllerMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import {
  clearPluginAccountAvailabilityProjection,
  replacePluginAccountAvailabilityProjection,
} from '@/sync/domains/plugins/availability/projection';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

// test-policy-boundary: Metro's lazy module loader is substituted; the actual Action executor stays real.
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
      >();
    const { createFrontDoorActionExecuteForVitest } =
      await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return {
      ...original,
      createFrontDoorActionExecute:
        createFrontDoorActionExecuteForVitest(original),
    };
  },
);
installApprovalCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } =
  await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(async () => {
  await harness.reset();
  resetScopedHomeActionExecutorsForTests();
});
afterEach(async () => {
  standardCleanup();
  await harness.reset();
});

const SETUP_SOURCES = [
  {
    kind: 'direct',
    setup: {
      items: [
        {
          kind: 'softwareRecipe',
          selection: {
            ref: {
              pluginId: 'fixture.recipes',
              recipeId: 'engine',
              revision: '1',
            },
            inputs: {},
          },
        },
      ],
    },
  },
] as const;

it('sets a kind up through Machine Setup: Continue plans its prerequisite sources for review and Install applies them', async () => {
  onTestFinished(installBundledPluginUiDeclarationsForTests([]));
  onTestFinished(clearPluginAccountAvailabilityProjection);
  const serverId = await harness.addHome({
    name: 'Build',
    serverUrl: 'https://sandbox-setup.example.test',
    serverIdentityId: 'srv_sandbox_setup',
    accountId: 'owner',
    currentAccount: true,
  });
  replacePluginAccountAvailabilityProjection({
    scope: {
      serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId,
      accountId: 'owner',
    },
    snapshot: {
      availabilityCursor: 1,
      inventoryComplete: true,
      materializations: [],
      snapshots: [],
      intentReads: [],
    },
  });
  const controller = { machineId: 'devbox', installationId: 'installation' };
  const machine = createManagedControllerMachineFixture({
    id: controller.machineId,
    installationId: controller.installationId,
    activeAt: Date.now(),
    kind: 'persistent',
    // Your own Machine: only Manage may plan its setup.
    isShared: false,
  });
  await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
    { ...machine, metadata: { ...machine.metadata!, platform: 'linux' } },
  ]);
  const descriptor = {
    id: 'engine',
    title: 'Engine',
    icon: 'server',
    resourceKind: 'Container',
    schemaVersion: 1,
    launchSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    resourceSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    platforms: ['linux'],
    prerequisites: [],
    billing: { location: 'local', stoppedBilling: 'not-billed' },
    retention: { supportedIntents: ['start', 'stop', 'delete'] },
    sessionPlacement: { kind: 'controller-local' },
    actions: {
      check: 'check',
      options: 'options',
      acquire: 'acquire',
      bootstrap: 'bootstrap',
      inspect: 'inspect',
      power: 'power',
      destroy: 'destroy',
    },
  };
  const list = MachineProvisionersListResultV1Schema.parse({
    controller,
    provisioners: [
      {
        contribution: { pluginId: 'sandbox.kinds', localId: 'engine' },
        occurrenceId: 'occurrence-engine',
        credentialPurposes: [],
        acquireExecutionTarget: 'daemon',
        descriptor,
      },
    ],
  });
  await answerExternalActionAccountForHome(harness, serverId, {
    ...controller,
    actionId: 'machines.provisioners.list',
    tokenEpoch: 0,
    requesterInvocation: 'optional',
    execute: async () => list,
    failure: () => null,
  });
  await answerExternalActionAccountForHome(harness, serverId, {
    ...controller,
    actionId: 'machines.provisioners.check',
    tokenEpoch: 0,
    requesterInvocation: 'optional',
    execute: async (input) => {
      ManagedMachineActionInputSchemasV1['machines.provisioners.check'].parse(
        input,
      );
      // The native check names its prerequisite's installer and the Setup sources that install it.
      return {
        available: false,
        prerequisites: [
          {
            requirement: { kind: 'systemTool', id: 'engine' },
            status: 'unavailable',
            repairAction: {
              action: { pluginId: 'sandbox.kinds', localId: 'install' },
              input: {},
            },
            setupSources: SETUP_SOURCES,
          },
        ],
      };
    },
    failure: () => null,
  });
  const planned: unknown[] = [];
  const applied: unknown[] = [];
  // The Machine's Apply is its own external Action; the host executor is the boundary, so only its input is recorded.
  await answerExternalActionAccountForHome(harness, serverId, {
    ...controller,
    actionId: 'machines.setup.apply',
    tokenEpoch: 0,
    requesterInvocation: 'optional',
    execute: async (input) => {
      applied.push(input);
      return { ok: false, errorCode: 'unavailable', error: 'unavailable' };
    },
    failure: (result) => (result && typeof result === 'object' && 'ok' in result && result.ok === false
      ? (result as { ok: false; errorCode: string; error: string }) : null),
  });
  harness.answer(serverId, '/v1/actions/machines.setup.plan', {
    select: (body) => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
      const request = MachineSetupPlanInputV1Schema.parse(envelope.input);
      planned.push(request.sources);
      const result = MachineSetupPlanResultV1Schema.parse({
        desiredRevision: 0,
        // The Machine's current setup has its own direct source; the prerequisite's recipe joins it in the effects plan.
        sources: request.sources ?? [{ kind: 'direct', setup: {} }],
        exclusions: [],
        support: [],
        ...(request.mode === 'effects' ? { recipePlans: [] } : {}),
      });
      return {
        body: ExternalActionResponseEnvelopeV1Schema.parse({
          v: 1,
          actionId: 'machines.setup.plan',
          requestId: envelope.requestId,
          execution: { ok: true, result },
        }),
      };
    },
  });
  const { MachineIsolationAddSandboxModal } =
    await import('./MachineIsolationAddSandboxModal');
  const setChrome = vi.fn();
  const screen = await renderScreen(
    <ListPresentationProvider value="page">
      <MachineIsolationAddSandboxModal
        onClose={() => {}}
        setChrome={setChrome}
        serverId={serverId}
        controller={controller}
        machineName="devbox"
        onAdded={() => {}}
      />
    </ListPresentationProvider>,
  );
  try {
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-isolation-add.kind:sandbox.kinds/engine'),
      ).not.toBeNull(),
    );
    await screen.pressByTestIdAsync(
      'machine-isolation-add.kind:sandbox.kinds/engine',
    );
    const footer = await renderScreen(setChrome.mock.calls.at(-1)![0].footer);
    try {
      await footer.pressByTestIdAsync('machine-isolation-add.continue');
      // The Set up step plans exactly the sources the readiness owner gave, and shows the reviewed plan.
      await waitForHomeGovernance(() => {
        expect(
          planned.some((sources) =>
            JSON.stringify(sources ?? null).includes(JSON.stringify(SETUP_SOURCES[0].setup.items[0].selection.ref)),
          ),
          JSON.stringify({ planned, step: screen.getTextContent().slice(0, 500) }),
        ).toBe(true);
        expect(
          screen.findByTestId('machine-isolation-add.setup-plan'),
        ).not.toBeNull();
      });
      await footer.update(setChrome.mock.calls.at(-1)![0].footer);
      await waitForHomeGovernance(async () => {
        await footer.update(setChrome.mock.calls.at(-1)![0].footer);
        expect(
          footer.findByTestId('machine-isolation-add.install')?.props.disabled,
        ).not.toBe(true);
      });
      await footer.pressByTestIdAsync('machine-isolation-add.install');
      await waitForHomeGovernance(() =>
        expect(
          applied.length,
        ).toBeGreaterThan(0),
      );
    } finally {
      await footer.unmount();
    }
  } finally {
    await screen.unmount();
  }
});
