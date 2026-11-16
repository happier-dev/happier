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
    // The own server builds from a GitHub checkout (U5 source facts); without them starters can't pair with it.
    sources: { gitIntegration: ['github'], upload: false },
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
      deploymentSuggestionForges: async () => [{ providerKind: 'github', title: 'GitHub' }],
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

it('a refused Stop keeps the run on screen with the refusal and Retry; it never claims it stopped (journey-deploy F1 Stop)', async () => {
  let release: (() => void) | null = null;
  let refuse = true;
  let stops = 0;
  suggestionBoundary({
    // Like the real transport, the wait ends when its caller's signal aborts (Stop asked); the Run itself goes on.
    executionRunWait: (_sessionId, _args, opts) =>
      new Promise((resolve, reject) => {
        release = () => resolve({ ok: true, status: 'succeeded', result: terminal({ recommendations: [recommendation] }) });
        const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }),
    executionRunStop: async () => {
      stops++;
      if (refuse) return { ok: false, errorCode: 'stop_refused', error: 'Stop refused' };
      release?.();
      return { ok: true };
    },
  });
  const { fixture, screen } = await openDescribe('auto-stop-refused');
  try {
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'A booking page'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    await waitForHomeGovernance(() => expect(calls('execution.run.start')).toHaveLength(1));
    await screen.pressByTestIdAsync('newApp.auto.stop');
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.auto.stopRefused')).toBeTruthy());
    expect(stops).toBe(1);
    expect(screen.findByTestId('newApp.auto.describe'), 'a refused Stop is not a stop').toBeNull();
    expect(screen.findByTestId('newApp.auto.working')).toBeTruthy();
    refuse = false;
    await screen.pressByTestIdAsync('newApp.auto.stopRefused.retry');
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.auto.describe')).toBeTruthy());
    expect(stops).toBe(2);
    expect(screen.findByTestId('newApp.auto.description')?.props.value).toBe('A booking page');
    expect(calls('deployments.suggestions.check'), 'nothing is checked after Stop').toHaveLength(0);
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('a catalog-app card continues in this dialog on Where for that app, not in the Store (journey-deploy F4 pure deploy)', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const summary = { sourceId: 'app', kind: 'app', itemId: 'plausible', title: 'Plausible', version: digest };
  const reads: unknown[] = [];
  suggestionBoundary({
    registryActionExecute: async ({ actionId, input }) => {
      if (actionId === 'registries.items.read') {
        reads.push(input);
        return { item: { summary, fetchedAt: 1, payload: { kind: 'app', state: 'ready', ref: { kind: 'content', digest },
          app: { schemaVersion: 1, title: 'Plausible', compose: { document: 'services:\n  web:\n    image: plausible/analytics\n', profiles: [], services: ['web'] },
            variables: [], generatedSecrets: [], domains: [], volumes: [] } } } };
      }
      const kind = (input as { kind: string }).kind;
      return { pages: [{ sourceId: kind, status: { state: 'ok', fetchedAt: 1 }, nextCursor: null, items: kind === 'app' ? [summary] : [] }] };
    },
    // An own server runs Compose and containers, so the stored catalog app fits it.
    deploymentSuggestionTargets: async () => ({ targets: [{ ...targets[0]!, accepts: ['static', 'compose', 'container'] }], stores: [] }),
    executionRunWait: async () => ({ ok: true, status: 'succeeded', result: terminal({ recommendations: [{
      source: { kind: 'catalogApp', appId: '["app","plausible"]' }, targetId: 'own', whatToBuild: 'Self-hosted analytics',
      stack: { framework: 'compose', output: 'container' }, data: { kind: 'none' }, variables: [] }] }) }),
  });
  const { fixture, screen, onClose } = await openDescribe('auto-catalog-where');
  try {
    routerMock.spies.push.mockClear();
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'A self-hosted analytics dashboard'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.auto.useSetup')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('newApp.auto.useSetup');
    await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.draft')).toBeTruthy());
    expect(reads).toContainEqual(expect.objectContaining({ kind: 'app', sourceId: 'app', itemId: 'plausible' }));
    expect(onClose, 'the dialog stays: Where runs inside it').not.toHaveBeenCalled();
    expect(routerMock.spies.push, 'no detour through the Store listing').not.toHaveBeenCalled();
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('a catalog app picked by hand takes the same path as a suggested one: Where inside this dialog, never the Store listing (journey-deploy catWhere, D3)', async () => {
  const digest = `sha256:${'b'.repeat(64)}`;
  const summary = { sourceId: 'app', kind: 'app', itemId: 'activepieces', title: 'Activepieces', version: digest };
  const reads: unknown[] = [];
  suggestionBoundary({
    registryActionExecute: async ({ actionId, input }) => {
      if (actionId === 'registries.items.read') {
        reads.push(input);
        return { item: { summary, fetchedAt: 1, payload: { kind: 'app', state: 'ready', ref: { kind: 'content', digest },
          app: { schemaVersion: 1, title: 'Activepieces', compose: { document: 'services:\n  web:\n    image: activepieces/activepieces\n', profiles: [], services: ['web'] },
            variables: [], generatedSecrets: [], domains: [], volumes: [] } } } };
      }
      const kind = (input as { kind: string }).kind;
      return { pages: [{ sourceId: kind, status: { state: 'ok', fetchedAt: 1 }, nextCursor: null, items: kind === 'app' ? [summary] : [] }] };
    },
  });
  const { fixture, screen, onClose } = await openDescribe('manual-catalog-where');
  try {
    routerMock.spies.push.mockClear();
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.catalog.activepieces')).toBeTruthy());
    await screen.pressByTestIdAsync('newApp.catalog.activepieces');
    await screen.pressByTestIdAsync('newApp.continue');
    await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.draft')).toBeTruthy());
    expect(reads).toContainEqual(expect.objectContaining({ kind: 'app', sourceId: 'app', itemId: 'activepieces' }));
    expect(onClose, 'the dialog stays: Where runs inside it').not.toHaveBeenCalled();
    expect(routerMock.spies.push, 'no detour through the Store listing').not.toHaveBeenCalled();
    // The Source row names the catalog app it deploys, never a placeholder (journey-deploy catWhere).
    const { FieldValue } = await import('@/components/ui/lists/FieldRow');
    const sourceValues = screen.findAllByType(FieldValue).map((node) => [node.props.value, node.props.note]);
    expect(sourceValues).toContainEqual(['Activepieces', expect.any(String)]);
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
