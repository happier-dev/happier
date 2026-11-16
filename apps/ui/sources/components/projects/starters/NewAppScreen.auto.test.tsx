import * as React from 'react';
import { act } from 'react-test-renderer';
import type { DeploySuggestionCatalogV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(
    {},
  ),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
// The UI transport adapter delegates into the real Action executor; only its host ports are fixtures (the
// suggestion owner's own test harness, suggestDeploySetup.test.ts).
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
    >()),
    createFrontDoorActionExecute: () => execute,
  }),
);

const { createActionExecutor } = await import('@happier-dev/protocol/actions');
const { createActionExecutorBoundaryFixture } =
  await import('@/dev/testkit/fixtures/actionExecutorBoundary');
const { createPlainPromptLibraryCatalogHomeFixture } =
  await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { waitForHomeGovernance } =
  await import('@/dev/testkit/harness/homeGovernanceHarness');
const { NewAppScreen } = await import('./NewAppScreen');

afterEach(() => standardCleanup());
beforeEach(() => {
  execute.mockReset();
});

const runner = {
  v: 1,
  modelSelection: {
    agentTargetKey: 'agent:happier.agent.claude/claude',
    providerConnectionId: null,
    modelId: 'default',
  },
};
const targets: DeploySuggestionCatalogV1['targets'] = [
  {
    id: 'own',
    title: 'A machine',
    targetClass: 'ownServer',
    availability: 'available',
    accepts: ['static'],
    needs: [],
  },
];
const recommendation = {
  source: { kind: 'starter', starterId: '["starter","website"]' },
  targetId: 'own',
  whatToBuild: 'A bakery landing page',
  stack: { framework: 'html', output: 'static' },
  data: { kind: 'none' },
  variables: [],
};
const terminal = (output: unknown) => ({
  run: {
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'call_1',
    intent: 'task',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    permissionMode: 'no_tools',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    status: 'succeeded',
    startedAtMs: 1,
    finishedAtMs: 2,
  },
  latestToolResult: output,
});

type Ports = Parameters<typeof createActionExecutorBoundaryFixture>[0];
/** The catalog's owners (starters, Machines, targets) as the Home reports them, plus the Agent and run boundary. */
function suggestionBoundary(overrides: Ports) {
  const executor = createActionExecutor(
    createActionExecutorBoundaryFixture({
      registryActionExecute: async ({ input }) => {
        const kind = (input as { kind: string }).kind;
        return {
          pages: [
            {
              sourceId: kind,
              status: { state: 'ok', fetchedAt: 1 },
              nextCursor: null,
              items:
                kind === 'starter'
                  ? [
                      {
                        sourceId: kind,
                        kind: 'starter',
                        itemId: 'website',
                        title: 'Static website',
                        starterDeploy: { framework: 'html', output: 'static' },
                      },
                    ]
                  : [],
            },
          ],
        };
      },
      connectedServiceAction: async () => ({
        accounts: [],
        pools: [],
        healthBasis: 'credentials',
        source: { completeness: 'complete', observedAtMs: 1 },
      }),
      machinesList: async () => ({
        items: [
          {
            machineId: 'devbox',
            label: 'devbox',
            active: true,
            homeDir: '/home/alice',
          },
        ],
      }),
      deploymentSuggestionTargets: async () => ({ targets, stores: [] }),
      machineSetupPlan: async () => ({ targets: [] }),
      agentsModelsList: async () => ({
        llmTaskRunner: {
          ok: true,
          source: 'auto',
          runner,
          title: 'Claude Haiku',
        },
      }),
      executionRunCheckProtocolV2: async () => ({
        ok: true,
        exactMachineId: 'devbox',
      }),
      executionRunStart: async () => ({
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
      }),
      ...overrides,
    }),
  );
  execute.mockImplementation(executor.execute);
}

async function openDescribe(name: string) {
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(
    `https://${name}.test`,
    {
      key: 'registry-sources',
      value: { v: 2, disabledSourceIds: [], sources: [] },
    },
    'updated',
    { handleRequest: async () => null },
  );
  const onClose = vi.fn();
  const screen = await renderScreen(<NewAppScreen onClose={onClose} />);
  await waitForHomeGovernance(() =>
    expect(screen.findByTestId('newApp.describeApp')).toBeTruthy(),
  );
  return { fixture, screen, onClose };
}

const calls = (actionId: string) =>
  execute.mock.calls.filter((row) => row[0] === actionId);

it('Describe your app replaces the Ask-an-agent door: one run on a ready Machine, then cards; a starter card continues to the review (journey-deploy F1/F4)', async () => {
  suggestionBoundary({
    executionRunWait: async () => ({
      ok: true,
      status: 'succeeded',
      result: terminal({ recommendations: [recommendation] }),
    }),
  });
  const { fixture, screen } = await openDescribe('auto-describe');
  try {
    expect(
      screen.findByTestId('newApp.askAgent'),
      'the free-form agent door is gone',
    ).toBeNull();
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    expect(
      screen.findByTestId('newApp.auto.suggest')?.props.disabled,
      'nothing to suggest from yet',
    ).toBe(true);
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'A small landing page for my bakery'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('newApp.auto.recommendations')).toBeTruthy(),
    );
    expect(calls('execution.run.start')).toHaveLength(1);
    expect(calls('deployments.suggestions.check')).toHaveLength(1);
    expect(
      screen.findByTestId('newApp.auto.useSetup')?.props.disabled,
      'the recommended card starts chosen',
    ).toBe(false);
    await screen.pressByTestIdAsync('newApp.auto.useSetup');
    // The starter continues in the existing review: the chosen starter and the person's words, nothing created yet.
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('newApp.nameField')).toBeTruthy(),
    );
    expect(screen.findByTestId('newApp.description')?.props.value).toBe(
      'A small landing page for my bakery',
    );
    expect(calls('projects.starters.create')).toHaveLength(0);
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('Stop ends the accepted run once and returns to the description, kept (journey-deploy F1 Stop)', async () => {
  let release: (() => void) | null = null;
  let stops = 0;
  suggestionBoundary({
    executionRunWait: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            ok: true,
            status: 'succeeded',
            result: terminal({ recommendations: [recommendation] }),
          });
      }),
    executionRunStop: async () => {
      stops++;
      release?.();
      return { ok: true };
    },
  });
  const { fixture, screen } = await openDescribe('auto-stop');
  try {
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'A booking page'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('newApp.auto.runsOn')).toBeTruthy(),
    );
    expect(
      screen.findByTestId('newApp.auto.description')?.props.editable,
      'the words are read-only while it runs',
    ).toBe(false);
    await screen.pressByTestIdAsync('newApp.auto.stop');
    await waitForHomeGovernance(() => expect(stops).toBe(1));
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('newApp.auto.describe')).toBeTruthy(),
    );
    expect(screen.findByTestId('newApp.auto.description')?.props.value).toBe(
      'A booking page',
    );
    expect(
      calls('deployments.suggestions.check'),
      'nothing is checked after Stop',
    ).toHaveLength(0);
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('says why no agent can suggest, per Machine, starting no run; Choose a starter myself returns to the source step (journey-deploy F3)', async () => {
  suggestionBoundary({
    agentsModelsList: async () => ({
      llmTaskRunner: {
        ok: false,
        errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE',
        reason: 'no_ready_agent',
        unavailableAgents: [
          {
            agentTargetKey: runner.modelSelection.agentTargetKey,
            reason: 'sign_in_required',
          },
        ],
      },
    }),
  });
  const { fixture, screen } = await openDescribe('auto-no-agent');
  try {
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'An invoice app'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('newApp.auto.noAgent.devbox.action'),
      ).toBeTruthy(),
    );
    expect(calls('execution.run.start')).toHaveLength(0);
    await screen.pressByTestIdAsync('newApp.auto.chooseStarter');
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('newApp.describeApp')).toBeTruthy(),
    );
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('when every suggestion is dropped it says it couldn’t suggest, and Try again runs once more (journey-deploy F3)', async () => {
  suggestionBoundary({
    executionRunWait: async () => ({
      ok: true,
      status: 'succeeded',
      result: terminal({
        recommendations: [{ ...recommendation, targetId: 'invented' }],
      }),
    }),
  });
  const { fixture, screen } = await openDescribe('auto-nothing');
  try {
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'Something'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('newApp.auto.nothing')).toBeTruthy(),
    );
    await screen.pressByTestIdAsync('newApp.auto.tryAgain');
    await waitForHomeGovernance(() =>
      expect(calls('execution.run.start')).toHaveLength(2),
    );
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});
