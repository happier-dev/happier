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
// Where a new repository would go on each forge is a Machine RPC (the SCM describe boundary); none answers by default.
vi.mock('@/sync/ops/scm/machineScm', () => ({
  machineScmHostingRepositoryDescribePublishTargets: vi.fn(async () => ({ success: false, error: 'Machine unavailable' })),
}));
// The UI transport adapter delegates into the real Action executor; only its host ports are fixtures (the
// suggestion owner's own test harness, suggestDeploySetup.test.ts).
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
    >()),
    // Reviewed creates (Use this setup) go through `confirmed`, bound the way the real front door binds them.
    createFrontDoorActionExecute: () => Object.assign(execute, {
      confirmed: async (actionId: string, input: unknown, context: object) => {
        const { bindPresentUserActionConfirmationV1 } = await import('@happier-dev/protocol/actions/executor/approvalReview');
        return execute(actionId, input, bindPresentUserActionConfirmationV1(actionId as never, input,
          { ...context, runtimeAccountId: 'alice', actionRequestId: 'reviewed-create' } as never));
      },
    }),
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
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
/** A field select's menu (ValueFieldSelect renders one DropdownMenu carrying its testID, items and onSelect). */
const menu = (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) =>
  screen.findAllByType(DropdownMenu).find((node) => node.props.testID === testID);
const { Item } = await import('@/components/ui/lists/Item');
/** The row itself (its testID also lands on inner hosts, which carry no subtitle). */
const row = (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) =>
  screen.findAllByType(Item).find((node) => node.props.testID === testID);

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

it('a Machine whose name is still loading is never titled with the placeholder in What’s missing', async () => {
  suggestionBoundary({
    // The Home's inventory: a second Machine is offline and its name hasn't hydrated, so its label is the owner's placeholder.
    machinesList: async () => ({
      items: [
        { machineId: 'devbox', label: 'devbox', active: false, named: true, presence: 'offline' },
        { machineId: 'loading', label: 'Loading…', named: false, presence: 'offline' },
      ],
    }),
  });
  const { fixture, screen } = await openDescribe('auto-name-pending');
  try {
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'An invoice app'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    await waitForHomeGovernance(() => expect(row(screen, 'newApp.auto.noAgent.loading')).toBeTruthy());
    expect(row(screen, 'newApp.auto.noAgent.devbox')?.props.title).toBe('devbox');
    expect(row(screen, 'newApp.auto.noAgent.loading')?.props.title).not.toBe('Loading…');
    expect(typeof row(screen, 'newApp.auto.noAgent.loading')?.props.title).not.toBe('string');
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('a failed suggestion says so and keeps the owner’s code under Details, never a bare guess at the cause', async () => {
  suggestionBoundary({ deploymentSuggestionTargets: async () => { throw new Error('targets unavailable'); } });
  const { fixture, screen } = await openDescribe('auto-failed');
  try {
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'A bakery page'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const failed = () => screen.findAllByType(SurfaceStateCard).find((node) => node.props.testID === 'newApp.auto.failed');
    await waitForHomeGovernance(() => expect(failed()).toBeTruthy());
    expect(failed()!.props.kind).toBe('error');
    expect(typeof failed()!.props.diagnosticCode, 'the typed code a person can hand to support').toBe('string');
    expect(failed()!.props.diagnosticCode.length).toBeGreaterThan(0);
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


it('a questions round asks in the step: the footer waits for an answer, then one more run brings the cards (journey-deploy F2)', async () => {
  const questions = { kind: 'questions', questions: [{ id: 'purpose', type: 'text', prompt: 'What should visitors do?', required: true }] };
  let round = 0;
  suggestionBoundary({ executionRunWait: async () => {
    round++;
    return { ok: true, status: 'succeeded', result: terminal(round === 1 ? { recommendations: [], questions } : { recommendations: [recommendation] }) };
  } });
  const { fixture, screen } = await openDescribe('auto-questions');
  try {
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'A bakery page'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    await waitForHomeGovernance(() => expect(screen.findByTestId('app-shell-question-purpose-text')).toBeTruthy());
    expect(screen.findByTestId('newApp.auto.questions'), 'the questions sit in the step, not a stacked dialog').toBeTruthy();
    expect(screen.findByTestId('app-shell-question-submit'), 'the dialog footer owns the answer action').toBeNull();
    expect(screen.findByTestId('newApp.auto.suggestAgain')?.props.disabled, 'nothing to send until it is answered').toBe(true);
    execute.mockClear();
    await act(async () => screen.changeTextByTestId('app-shell-question-purpose-text', 'Order bread'));
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.auto.suggestAgain')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('newApp.auto.suggestAgain');
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.auto.recommendations')).toBeTruthy());
    expect(calls('execution.run.start')).toHaveLength(1);
    expect(calls('deployments.suggestions.catalog')).toHaveLength(0);
    expect(calls('execution.run.start')[0]![1]).toMatchObject({ intentInput: { input: { answers: { purpose: { kind: 'text', value: 'Order bread' } } } } });
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('Adjust changes one fact through the validator and asks again with a note, from the same snapshot (journey-deploy autoAdjust)', async () => {
  suggestionBoundary({ deploymentSuggestionTargets: async () => ({ targets, stores: [{ id: 'db', engine: 'postgres' }] }),
    executionRunWait: async () => ({ ok: true, status: 'succeeded', result: terminal({ recommendations: [recommendation] }) }) });
  const { fixture, screen } = await openDescribe('auto-adjust');
  try {
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'A bakery page'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.auto.adjust')).toBeTruthy());
    await screen.pressByTestIdAsync('newApp.auto.adjust');
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.auto.adjust.data.trigger')).toBeTruthy());
    execute.mockClear();
    await act(async () => { menu(screen, 'newApp.auto.adjust.data')!.props.onSelect('store:db'); });
    expect(execute, 'an adjustment is checked locally, no I/O').not.toHaveBeenCalled();
    expect(menu(screen, 'newApp.auto.adjust.data')?.props.selectedId).toBe('store:db');
    await act(async () => screen.changeTextByTestId('newApp.auto.adjust.note', 'Keep it free'));
    await screen.pressByTestIdAsync('newApp.auto.suggestAgain');
    await waitForHomeGovernance(() => expect(calls('execution.run.start')).toHaveLength(1));
    expect(calls('deployments.suggestions.catalog')).toHaveLength(0);
    expect(calls('execution.run.start')[0]![1]).toMatchObject({ intentInput: { input: { note: 'Keep it free' } } });
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('F2: canonical answers and adjustment notes each start one checked run with zero catalog reads; connect refresh reads once', async () => {
  const { useNewAppAutoSuggestions } = await import('./auto/useNewAppAutoSuggestions');
  const questions = { kind: 'questions', questions: [{ id: 'purpose', type: 'text', prompt: 'What should visitors do?', required: true }] };
  let round = 0;
  let releaseNote!: () => void;
  const noteGate = new Promise<void>(resolve => { releaseNote = resolve; });
  suggestionBoundary({ deploymentSuggestionTargets: async () => ({ targets, stores: [{ id: 'db', engine: 'postgres' }] }),
    executionRunWait: async () => {
      round++;
      if (round === 3) await noteGate;
      return { ok: true, status: 'succeeded', result: terminal(round === 1
        ? { recommendations: [], questions } : { recommendations: [recommendation] }) };
    } });
  const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://auto-u2-followup.test',
    { key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [] } }, 'updated', { handleRequest: async () => null });
  const { TransientQuestionForm } = await import('@/components/appShell/plugins/TransientQuestionForm');
  let current!: ReturnType<typeof useNewAppAutoSuggestions>;
  function Harness() {
    current = useNewAppAutoSuggestions({ serverId: fixture.home.id, active: true });
    return current.questions ? <TransientQuestionForm questions={current.questions.questions}
      onAnswer={current.answerQuestions} onCancel={current.backToDescription} /> : null;
  }
  const screen = await renderScreen(<Harness />);
  try {
    await act(async () => current.setDescription('  Bakery\n'));
    await act(async () => current.suggest());
    await waitForHomeGovernance(() => expect(current.questions).toEqual(questions));
    const answers = { purpose: { kind: 'text' as const, value: 'Order bread' } };
    execute.mockClear();
    await act(async () => screen.changeTextByTestId('app-shell-question-purpose-text', 'Order bread'));
    await screen.pressByTestIdAsync('app-shell-question-submit');
    await waitForHomeGovernance(() => expect(current.chosen).toBeTruthy());
    expect(calls('deployments.suggestions.catalog')).toHaveLength(0);
    expect(calls('execution.run.start')).toHaveLength(1);
    expect(calls('deployments.suggestions.check')).toHaveLength(1);
    expect(calls('execution.run.start')[0]![1]).toMatchObject({ intentInput: { input: { description: '  Bakery\n', answers } } });
    execute.mockClear();
    let adjusted = false;
    await act(async () => { adjusted = current.adjustChosen({ data: { kind: 'store', storeId: 'db', engine: 'postgres' } }); });
    expect(adjusted).toBe(true);
    expect(current.chosen!.recommendation.data).toEqual({ kind: 'store', storeId: 'db', engine: 'postgres' });
    await act(async () => { adjusted = current.adjustChosen({ targetId: 'invented' }); });
    expect(adjusted).toBe(false);
    expect(current.chosen!.recommendation.targetId).toBe('own');
    expect(execute).not.toHaveBeenCalled();
    const snapshot = current.chosen!.catalog;
    execute.mockClear();
    await act(async () => current.suggestAgain('Keep it free'));
    await waitForHomeGovernance(() => expect(calls('execution.run.start')).toHaveLength(1));
    expect(current.view.kind).toBe('working');
    expect(current.chosen!.recommendation.data).toEqual({ kind: 'store', storeId: 'db', engine: 'postgres' });
    await act(async () => releaseNote());
    await waitForHomeGovernance(() => expect(current.view.kind).toBe('recommendations'));
    expect(calls('deployments.suggestions.catalog')).toHaveLength(0);
    expect(calls('execution.run.start')).toHaveLength(1);
    expect(calls('deployments.suggestions.check')).toHaveLength(1);
    expect(calls('execution.run.start')[0]![1]).toMatchObject({ intentInput: { input: { catalog: snapshot, answers, note: 'Keep it free' } } });
    execute.mockClear();
    await act(async () => current.refreshSuggestions());
    await waitForHomeGovernance(() => expect(current.chosen).toBeTruthy());
    expect(calls('deployments.suggestions.catalog')).toHaveLength(1);
    expect(calls('execution.run.start')).toHaveLength(1);
    expect(calls('deployments.suggestions.check')).toHaveLength(1);
  } finally { await screen.unmount(); await fixture.dispose(); }
});

it('F5: Code lives on offers only forges that pair with the target, describes each once on open, and a choice reads and writes nothing', async () => {
  const pairing: DeploySuggestionCatalogV1['targets'] = [{ ...targets[0]!, sources: { gitIntegration: ['github', 'bitbucket'], upload: false } }];
  suggestionBoundary({
    deploymentSuggestionTargets: async () => ({ targets: pairing, stores: [] }),
    // GitLab can create a repository but this target can't deploy from it, so it is never offered.
    deploymentSuggestionForges: async () => [{ providerKind: 'github', title: 'GitHub' },
      { providerKind: 'bitbucket', title: 'Bitbucket' }, { providerKind: 'gitlab', title: 'GitLab' }],
    executionRunWait: async () => ({ ok: true, status: 'succeeded', result: terminal({ recommendations: [recommendation] }) }),
  });
  const { storage } = await import('@/sync/domains/state/storageStore');
  const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
  const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
  const { machineScmHostingRepositoryDescribePublishTargets: describeTargets } = await import('@/sync/ops/scm/machineScm');
  const { ScmHostingRepositoryDescribePublishTargetsResponseSchema } = await import('@happier-dev/protocol/scm');
  vi.mocked(describeTargets).mockImplementation(async (_machineId, request) => {
    const kind = (request as { providerKind: string }).providerKind;
    const title = kind === 'github' ? 'GitHub' : 'Bitbucket';
    return ScmHostingRepositoryDescribePublishTargetsResponseSchema.parse({
      success: true, defaultRepositoryName: 'bakery', auth: { state: 'authenticated', profileKind: 'connected_account' },
      targets: [{ provider: { id: `happier.scm.forge.${kind}/${kind}`, kind, displayName: title, baseUrl: `https://${kind}.example.test`,
        urlSafety: { allowedSchemes: ['https:'] } }, owner: `${kind}-team`, ownerKind: 'org', label: `${kind}-team`, isDefault: true,
        supportedVisibilities: ['private'], supportedRemoteUrlKinds: ['https'] }],
    });
  });
  const { fixture, screen } = await openDescribe('auto-forge');
  try {
    const scope = storage.getState().settingsScope;
    if (!scope) throw new Error('Expected admitted Home Account');
    await publishMachineInventoryForTest(scope, [createMachineFixture({ activeAt: Date.now() })]);
    await screen.pressByTestIdAsync('newApp.describeApp');
    await screen.pressByTestIdAsync('newApp.continue');
    await act(async () => screen.changeTextByTestId('newApp.auto.description', 'A bakery page'));
    await screen.pressByTestIdAsync('newApp.auto.suggest');
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.auto.useSetup')?.props.disabled).toBe(false));
    vi.mocked(describeTargets).mockClear();
    await screen.pressByTestIdAsync('newApp.auto.useSetup');
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.forge')).toBeTruthy());
    await waitForHomeGovernance(() => expect(vi.mocked(describeTargets)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(describeTargets).mock.calls.map((row) => (row[1] as { providerKind: string }).providerKind).sort())
      .toEqual(['bitbucket', 'github']);
    expect(menu(screen, 'newApp.forge')?.props.items.map((item: { id: string }) => item.id)).toEqual(['github', 'bitbucket']);
    expect(menu(screen, 'newApp.forge')?.props.selectedId, 'GitHub is the default').toBe('github');
    await waitForHomeGovernance(() => expect(row(screen, 'newApp.repository')?.props.subtitle).toContain('github-team/'));
    execute.mockClear();
    await act(async () => { menu(screen, 'newApp.forge')!.props.onSelect('bitbucket'); });
    expect(menu(screen, 'newApp.forge')?.props.selectedId).toBe('bitbucket');
    expect(row(screen, 'newApp.repository')?.props.subtitle).toContain('bitbucket-team/');
    expect(vi.mocked(describeTargets), 'a choice reads nothing more').toHaveBeenCalledTimes(2);
    expect(execute, 'and writes nothing until Create').not.toHaveBeenCalled();
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});

it('a Session suggestion without the person\u2019s words opens with the description empty, and the build brief starts with the words they type (decision 5)', async () => {
  suggestionBoundary({ registryActionExecute: async () => ({ pages: [] }) });
  const { storage } = await import('@/sync/domains/state/storageStore');
  const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
  const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
  const { machineScmHostingRepositoryDescribePublishTargets: describeTargets } = await import('@/sync/ops/scm/machineScm');
  const { ScmHostingRepositoryDescribePublishTargetsResponseSchema } = await import('@happier-dev/protocol/scm');
  vi.mocked(describeTargets).mockImplementation(async () => ScmHostingRepositoryDescribePublishTargetsResponseSchema.parse({
    success: true, defaultRepositoryName: 'bakery', auth: { state: 'authenticated', profileKind: 'connected_account' },
    targets: [{ provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.example.test',
      urlSafety: { allowedSchemes: ['https:'] } }, owner: 'alice', ownerKind: 'user', label: 'alice', isDefault: true,
      supportedVisibilities: ['private'], supportedRemoteUrlKinds: ['https'] }],
  }));
  const catalog: DeploySuggestionCatalogV1 = {
    starters: [{ id: '["starter","website"]', title: 'Static website', sourceId: 'starter', itemId: 'website',
      deploy: { framework: 'html', output: 'static' } }],
    apps: [], targets, machines: [], stores: [], forges: [{ providerKind: 'github', title: 'GitHub' }],
  };
  const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://auto-session-host.test',
    { key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [] } }, 'updated', { handleRequest: async () => null });
  const scope = storage.getState().settingsScope;
  if (!scope) throw new Error('Expected admitted Home Account');
  await publishMachineInventoryForTest(scope, [createMachineFixture({ activeAt: Date.now() })]);
  // What a Session host hands over when the agent's check call carried no description: the card, and no words.
  const screen = await renderScreen(<NewAppScreen onClose={vi.fn()}
    suggestion={{ description: '', recommendation: recommendation as never, catalog }} />);
  try {
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.auto.useSetup')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('newApp.auto.useSetup');
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.nameField')).toBeTruthy());
    expect(screen.findByTestId('newApp.description')?.props.value, 'never the model\u2019s whatToBuild').toBe('');
    await act(async () => screen.changeTextByTestId('newApp.nameField', 'Bakery'));
    await waitForHomeGovernance(() => expect(row(screen, 'newApp.repository')?.props.subtitle).toContain('alice/'));
    expect(screen.findByTestId('newApp.create')?.props.disabled, 'Create asks for the person\u2019s words first').toBe(true);
    await act(async () => screen.changeTextByTestId('newApp.description', '  A page for my bakery\n'));
    await waitForHomeGovernance(() => expect(screen.findByTestId('newApp.create')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('newApp.create');
    await waitForHomeGovernance(() => expect(calls('projects.starters.create')).toHaveLength(1));
    const brief = (calls('projects.starters.create')[0]![1] as { description: string }).description;
    expect(brief.startsWith('  A page for my bakery\n\n'), brief).toBe(true);
    await screen.unmount();
  } finally {
    await standardCleanup();
    await fixture.dispose();
  }
});
