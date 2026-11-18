import React from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { teamCredentialDisplayNameFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';

import type {
  AgentExecutionTargetV1} from '@happier-dev/protocol/agents/executionTargetV1';
import type {
  PluginProjectedAgentConnectedAccountPurposeV2,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { resolveHappierMinimumInteractiveTargetSize } from '@happier-dev/plugin-ui/environment';

/**
 * The shared authoring controls are controlled and inert: values in, one
 * `onChangeField` out. These cases pin the three things a second authoring
 * surface historically got wrong — silently dropping a field it cannot offer,
 * smuggling a submit action into an authoring row, and writing a remembered
 * preference as a side effect of choosing a value.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const keyboardHandlerRegistrations: Array<Record<string, unknown>> = [];
let account:
  | Awaited<
      ReturnType<
        (typeof import('@/dev/testkit/harness/serverAccountConnectionHarness'))['restoreServerAccountForTest']
      >
    >
  | undefined;

installAgentInputCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeNativeMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock(
      { platformOS: 'ios' },
      {
        View: (
          props: Record<string, unknown> & { children?: React.ReactNode },
        ) => React.createElement('View', props, props.children),
        Text: (
          props: Record<string, unknown> & { children?: React.ReactNode },
        ) => React.createElement('Text', props, props.children),
        Pressable: (
          props: Record<string, unknown> & { children?: React.ReactNode },
        ) => React.createElement('Pressable', props, props.children),
        ScrollView: (
          props: Record<string, unknown> & { children?: React.ReactNode },
        ) => React.createElement('ScrollView', props, props.children),
        useWindowDimensions: () => ({ width: 900, height: 700 }),
        Dimensions: {
          get: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }),
        },
      },
    );
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
  },
});

// The overlay shell is substituted while the authoring controls remain real.
// The capabilities chip's Action-backed preview is covered by
// useSessionCapabilitiesPopover.test.ts through its Home/transport harness.
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
}));
vi.mock(
  '@/components/sessions/agentInput/components/AgentInputContentPopover',
  () => ({
    AgentInputContentPopover: (props: { open: boolean; content: unknown }) =>
      props.open
        ? React.createElement(
            'AgentInputContentPopoverStub',
            null,
            typeof props.content === 'function'
              ? (props.content as (args: unknown) => React.ReactNode)({
                  requestClose: () => {},
                  maxHeight: 400,
                })
              : (props.content as React.ReactNode),
          )
        : null,
  }),
);
// The Connected Services selection panel is the same kind of heavy boundary as
// the MCP one. Its props — the supported services, the current bindings, the
// Team resources it may offer and the setter it calls — are the behaviour under
// test, so they are captured rather than re-rendered.
const connectedServicesContentProps = vi.hoisted(() => ({
  value: null as any,
}));
// The Home's Team credential catalog is a transport-backed snapshot boundary.
// Which resources reach the selection panel — and the currentness filter that
// decides it — stay real.
const teamCredentialCatalog = vi.hoisted(() => ({
  resources: [] as Array<Record<string, unknown>>,
  resourceStatusByKey: new Map(),
  teamNameById: {} as Record<string, string>,
}));
vi.mock('@/hooks/teams/useHomeTeamCredentialModelCatalog', () => ({
  useHomeTeamCredentialModelCatalog: () => ({
    resources: teamCredentialCatalog.resources,
    resourceStatusByKey: teamCredentialCatalog.resourceStatusByKey,
    teamNameById: teamCredentialCatalog.teamNameById,
    homeNameByTeamId: {},
    current: true,
    condition: null,
  }),
}));
vi.mock(
  '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent',
  () => ({
    NewSessionConnectedServicesSelectionContent: (
      props: Record<string, unknown>,
    ) => {
      connectedServicesContentProps.value = props;
      return React.createElement(
        'NewSessionConnectedServicesSelectionContentStub',
        {
          testID: 'connected-services-content-stub',
        },
      );
    },
  }),
);
vi.mock('@/keyboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/keyboard')>();
  return {
    ...actual,
    useKeyboardShortcutHandlers: (handlers: Record<string, unknown>) => {
      keyboardHandlerRegistrations.push(handlers ?? {});
    },
  };
});

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);

const CLAUDE_TARGET: AgentExecutionTargetV1 = {
  kind: 'agent',
  identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

function baseValues(): WorkflowSessionAuthoringSelection {
  return { agentTarget: CLAUDE_TARGET };
}

function directCapableClaude(supportsDirectTranscriptStorage = true) {
  return {
    id: 'agent:happier.agent.claude/claude',
    label: 'Claude Code',
    target: CLAUDE_TARGET,
    agentId: 'claude',
    supportsDirectTranscriptStorage,
  };
}

/** The Agent's own Connected Account declaration, as the catalog projects it. */
const GITHUB_DECLARATION = {
  service: { pluginId: 'happier.connect.github', localId: 'github' },
  purpose: 'auth',
} satisfies PluginProjectedAgentConnectedAccountPurposeV2;

function claudeWithGithubDeclaration() {
  return { ...directCapableClaude(), connectedAccounts: [GITHUB_DECLARATION] };
}

/** A second declared service, so "untouched by this edit" is observable. */
const LINEAR_DECLARATION = {
  service: { pluginId: 'happier.connect.linear', localId: 'linear' },
  // Purpose ids are unique within one consumer contribution
  // (`ConnectedAccountPurposeDeclarationsV1Schema`).
  purpose: 'linear-auth',
} satisfies PluginProjectedAgentConnectedAccountPurposeV2;

const GITHUB_SERVICE_KEY = 'happier.connect.github/github';
const LINEAR_SERVICE_KEY = 'happier.connect.linear/linear';

function claudeWithTwoDeclarations() {
  return {
    ...directCapableClaude(),
    connectedAccounts: [GITHUB_DECLARATION, LINEAR_DECLARATION],
  };
}

/** This Account's qualified purpose defaults, projected as session bindings. */
const ACCOUNT_DEFAULT_AUTH_BINDINGS = {
  [GITHUB_SERVICE_KEY]: {
    source: 'connected',
    selection: 'profile',
    profileId: 'gh-work',
  },
  [LINEAR_SERVICE_KEY]: {
    source: 'connected',
    selection: 'profile',
    profileId: 'lin-work',
  },
} as const;

async function seedAccountDefaultConnectedServiceAuth(): Promise<string> {
  const { restoreServerAccountForTest } =
    await import('@/dev/testkit/harness/serverAccountConnectionHarness');
  const { createHomeHubArtifactHttpBoundary } =
    await import('@/dev/testkit/harness/homeHubArtifactHttpBoundary');
  const { buildServerFeaturesResponse } =
    await import('@/hooks/server/serverFeaturesTestUtils');
  const { createPlainProjectAccountRowListFixture } =
    await import('@/dev/testkit/fixtures/projectAccountRows');
  const features = buildServerFeaturesResponse();
  features.capabilities.connectedServices.qualifiedAccounts = {
    protocolVersion: 4,
  };
  const consumer = CLAUDE_TARGET.identity;
  const value = {
    v: 1,
    bindings: [
      {
        purpose: { consumer, purpose: 'auth' },
        target: {
          kind: 'account',
          account: {
            service: GITHUB_DECLARATION.service,
            accountId: 'gh-work',
          },
        },
      },
      {
        purpose: { consumer, purpose: 'linear-auth' },
        target: {
          kind: 'account',
          account: {
            service: LINEAR_DECLARATION.service,
            accountId: 'lin-work',
          },
        },
      },
    ],
  };
  const http = createHomeHubArtifactHttpBoundary('authoring-controls');
  account = await restoreServerAccountForTest({
    serverUrl: 'https://authoring-controls.test',
    accountId: 'authoring-controls',
    request: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/features') return Response.json(features);
      if (path === '/v1/account/project-rows/list')
        return Response.json(createPlainProjectAccountRowListFixture());
      if (path === '/v1/account/entity-rows/connected-accounts/purposes')
        return Response.json({
          status: 'present',
          revision: 1,
          content: { t: 'plain', v: { key: 'purposes', value } },
        });
      return http.request(url, init);
    },
  });
  return account.home.id;
}

/** Opens the chip's panel and returns the bindings it was handed. */
async function readPanelBindings(
  screen: Awaited<ReturnType<typeof renderControls>>['screen'],
): Promise<Record<string, unknown>> {
  await act(async () => {
    screen.pressByTestId('new-session-connected-services-auth-chip');
  });
  return connectedServicesContentProps.value?.bindingsByServiceId as Record<
    string,
    unknown
  >;
}

async function renderControls(
  overrides: Partial<
    React.ComponentProps<
      (typeof import('./SessionAuthoringControls'))['SessionAuthoringControls']
    >
  > = {},
) {
  const { SessionAuthoringControls } =
    await import('./SessionAuthoringControls');
  const onChangeField = vi.fn();
  const screen = await renderScreen(
    <SessionAuthoringControls
      fields={['permissionMode']}
      values={baseValues()}
      onChangeField={onChangeField}
      {...overrides}
    />,
  );
  return { screen, onChangeField };
}

/** Invokes the option a reader would tap inside the opened picker. */
function selectOption(
  screen: Awaited<ReturnType<typeof renderControls>>['screen'],
  optionId: string,
) {
  const popover = screen.root
    .findAllByType(AgentInputChipPickerPopover)
    .find((node) => node.props.open);
  if (!popover) throw new Error('no open picker');
  const option = popover.props.options.find(
    (entry: { id: string }) => entry.id === optionId,
  );
  if (!option || option.disabled)
    throw new Error(`option ${optionId} is not selectable`);
  popover.props.onSelect(optionId);
}

// Collect the real UI graph before behavior deadlines, as in the adjacent composer suites.
const { AgentInputChipPickerPopover } =
  await import('@/components/sessions/agentInput/components/AgentInputChipPickerPopover');
await import('./SessionAuthoringControls');

describe('SessionAuthoringControls', () => {
  it('lets an engine group supply the field title while retaining the accessible engine trigger', async () => {
    const { screen } = await renderControls({ presentation: 'fields', fields: ['agentTarget', 'modelSelection'],
      onChangeFields: () => {}, engineFieldTitle: null, values: baseValues() });
    expect(screen.findByTestId('session-authoring-control-agentTarget-row')).toBeNull();
    expect(screen.findByTestId('session-authoring-control-agentTarget')?.props.accessibilityLabel).toBeTruthy();
    await screen.unmount();
  });
  it('leads the engine chip with the Session list agent mark, read on the picker Machine', async () => {
    // One Session-agent-mark owner: Agents whose artwork only a Machine contributes (Muse) keep their mark here too.
    const { SessionAgentCatalogIdentityIcon } = await import('@/components/sessions/presentation/SessionAgentCatalogIdentityIcon');
    const { screen } = await renderControls({ presentation: 'chips', fields: ['agentTarget', 'modelSelection'],
      onChangeFields: () => {}, values: baseValues(),
      facts: { agentTargets: [directCapableClaude()], agentPickerContext: { machineId: 'machine-a', serverId: null, directory: '/p' } } });
    expect(screen.findByType(SessionAgentCatalogIdentityIcon)?.props).toMatchObject({ agentId: 'claude', machineId: 'machine-a' });
    await screen.unmount();
  });
  it('leaves an unset Profile out of the fields form and retains an authored Profile', async () => {
    const facts = { profilesEnabled: true, profiles: [{ id: 'available-profile', label: 'Release' }] };
    const { screen } = await renderControls({ presentation: 'fields', fields: ['profileId'], values: baseValues(), facts });
    expect(screen.findAllByTestId('session-authoring-control-profileId-row')).toHaveLength(0);
    const { SessionAuthoringControls } = await import('./SessionAuthoringControls');
    await screen.update(<SessionAuthoringControls presentation="fields" fields={['profileId']}
      values={{ ...baseValues(), profileId: 'retained-profile' }} facts={facts} onChangeField={() => {}} />);
    expect(screen.findAllByTestId('session-authoring-control-profileId-row').length).toBeGreaterThan(0);
    await screen.unmount();
  });
  it('uses the same honest empty engine summary in chips and fields', async () => {
    const { useSessionAuthoringEngineSummary, SessionAuthoringControls } =
      await import('./SessionAuthoringControls');
    const summaries: string[] = [];
    function Host({ presentation }: { presentation: 'chips' | 'fields' }) {
      summaries.push(useSessionAuthoringEngineSummary({ values: {} }));
      return (
        <SessionAuthoringControls
          fields={['agentTarget', 'modelSelection']}
          values={{}}
          presentation={presentation}
          onChangeField={() => {}}
          onChangeFields={() => {}}
        />
      );
    }
    const screen = await renderScreen(<Host presentation="chips" />);
    expect(summaries.at(-1)).toBe('agentInput.agent.unselected');
    expect(screen.getTextContent()).toContain(summaries.at(-1));
    await screen.update(<Host presentation="fields" />);
    expect(summaries.at(-1)).toBe('agentInput.agent.unselected');
    expect(screen.getTextContent()).toContain(summaries.at(-1));
    await screen.unmount();
  });
  beforeEach(() => {
    connectedServicesContentProps.value = null;
  });
  afterEach(async () => {
    await account?.dispose();
    account = undefined;
  });

  it('names the input that supplies the participant instead of an unchosen Agent', async () => {
    const { useSessionAuthoringEngineSummary } =
      await import('./SessionAuthoringControls');
    let summary = '';
    function Host() {
      summary = useSessionAuthoringEngineSummary({
        values: {},
        engine: { kind: 'input', name: 'participant_1' },
      });
      return null;
    }
    const screen = await renderScreen(<Host />);
    expect(summary).not.toBe('agentInput.agent.unselected');
    expect(summary).toBe('workflows.page.blocks.fromInput');
    await screen.unmount();
  });

  it("names the agent alone while it uses the CLI's own model (DESIGN-13 card footer)", async () => {
    const { useSessionAuthoringEngineSummary } =
      await import('./SessionAuthoringControls');
    let summary = '';
    function Host() {
      summary = useSessionAuthoringEngineSummary({ values: baseValues() });
      return null;
    }
    const screen = await renderScreen(<Host />);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).not.toContain('agentInput.model.useCliSettings');
    expect(summary).not.toContain(' · ');
    await screen.unmount();
  });

  it('shows a field it cannot offer as explicitly unavailable', async () => {
    // MCP selection belongs to another owner. Without that owner's control
    // the field must still be visible as unavailable — a missing chip reads
    // as "this step has no MCP setting", which is a different claim.
    const { screen } = await renderControls({
      fields: ['capabilitySelection', 'approvalProfileId'],
    });

    expect(
      screen.findByTestId(
        'session-authoring-control-capabilitySelection-unavailable',
      ),
    ).toBeTruthy();
    // Approval profiles have their own selectable control, even without an Agent.
    expect(screen.findByTestId('session-authoring-control-approvalProfileId')).toBeTruthy();
    await screen.unmount();
  });

  it('leaves out of a settings form a row this Agent or target can never offer, and keeps the ones that say what to do', async () => {
    // A Windows-only field on a Linux target, or a field the Agent has no options for, is not a
    // decision this step has; an "Unavailable" row for it is noise (Step options, DESIGN-ACCEPT-3).
    const { screen } = await renderControls({
      presentation: 'fields',
      fields: ['windowsTerminalWindowName', 'windowsRemoteSessionConsole', 'capabilitySelection', 'approvalProfileId', 'profileId'],
      values: { ...baseValues(), profileId: 'retained-profile' },
      facts: { targetIsWindows: false, profilesEnabled: false, profiles: [] },
    });
    expect(screen.findByTestId('session-authoring-control-windowsTerminalWindowName-row')).toBeNull();
    expect(screen.findByTestId('session-authoring-control-windowsRemoteSessionConsole-row')).toBeNull();
    // A control this host never supplies is not a decision this form has (owner 2026-11-06).
    expect(screen.findByTestId('session-authoring-control-capabilitySelection-row')).toBeNull();
    expect(screen.findByTestId('session-authoring-control-approvalProfileId-row')).toBeNull();
    expect(screen.findByTestId('session-authoring-control-profileId-unavailable')).toBeTruthy();
    await screen.unmount();
  });

  it('says why the Profile choice is unavailable and what to do about it', async () => {
    // A bare "Unavailable" left the reader guessing whether profiles were off or simply missing.
    const off = await renderControls({
      fields: ['profileId'],
      facts: { profilesEnabled: false, profiles: [] },
    });
    expect(
      off.screen.findByTestId('session-authoring-control-profileId-unavailable')
        ?.props.children,
    ).toBe('newSession.profileUnavailableTurnedOff');
    await off.screen.unmount();

    const none = await renderControls({
      fields: ['profileId'],
      facts: { profilesEnabled: true, profiles: [] },
    });
    expect(
      none.screen.findByTestId(
        'session-authoring-control-profileId-unavailable',
      )?.props.children,
    ).toBe('newSession.profileUnavailableNoneYet');
    await none.screen.unmount();

    const failed = await renderControls({
      fields: ['profileId'],
      facts: { profilesEnabled: true, profiles: [], profilesUnavailableReason: 'scope-retired' },
    });
    expect(failed.screen.findByTestId('session-authoring-control-profileId-unavailable')?.props.children)
      .toBe('common.unavailable');
    await failed.screen.unmount();

    // A profile read that has not answered yet is not "none yet": it reads as loading.
    const loading = await renderControls({
      fields: ['profileId'],
      facts: { profilesEnabled: true, profiles: [], profilesLoading: true },
    });
    expect(
      loading.screen.findByTestId(
        'session-authoring-control-profileId-unavailable',
      )?.props.children,
    ).toBe('common.loading');
    await loading.screen.unmount();
  });

  it('exposes no submit affordance and registers no composer send command', async () => {
    keyboardHandlerRegistrations.length = 0;
    const { screen } = await renderControls({
      fields: ['permissionMode', 'transcriptStorage'],
      facts: { agentTargets: [directCapableClaude()] },
    });

    const submitLike = screen.root.findAll(
      (node) =>
        typeof node.props?.testID === 'string' &&
        /send|submit/i.test(node.props.testID),
      { deep: true },
    );
    expect(submitLike).toHaveLength(0);

    const registeredCommandIds = keyboardHandlerRegistrations.flatMap(
      (handlers) => Object.keys(handlers),
    );
    expect(registeredCommandIds).not.toContain('composer.sendImmediate');

    await screen.unmount();
  });

  it('presents one field model as chips or as labelled field rows, and marks a changed field', async () => {
    const chips = await renderControls({
      fields: ['permissionMode', 'transcriptStorage'],
      facts: { agentTargets: [directCapableClaude()] },
      overriddenFields: new Set(['permissionMode']),
      overriddenAccessibilityHint: 'Changed for this step',
    });
    const permissionChip = chips.screen.root.find(
      (node) =>
        node.props?.testID === 'session-authoring-control-permissionMode' &&
        typeof node.props?.onPress === 'function',
    );
    // Changed-here is a state of the chip trigger itself, not a second control.
    expect(permissionChip.props.accessibilityHint).toBe(
      'Changed for this step',
    );
    const storageChip = chips.screen.root.findAll(
      (node) =>
        node.props?.testID === 'session-authoring-control-transcriptStorage' &&
        typeof node.props?.onPress === 'function',
    );
    for (const node of storageChip)
      expect(node.props.accessibilityHint).toBeUndefined();
    await chips.screen.unmount();

    const fields = await renderControls({
      fields: ['permissionMode'],
      presentation: 'fields',
    });
    const row = fields.screen.findByTestId(
      'session-authoring-control-permissionMode-row',
    );
    expect(row).not.toBeNull();
    // The row names the field; its trigger opens the very same picker and reports the same value.
    expect(fields.screen.getTextContent()).toContain(
      'settingsSession.permissions.title',
    );
    await act(async () => {
      fields.screen.pressByTestId('session-authoring-control-permissionMode');
    });
    await act(async () => {
      selectOption(fields.screen, 'yolo');
    });
    expect(fields.onChangeField).toHaveBeenCalledWith('permissionMode', 'yolo');
    await fields.screen.unmount();
  });

  // Round 1116b step options: a changed chip's own picker is the way back to the inherited value.
  it('leads a changed chip’s picker with the way back to the inherited value, and only a changed one', async () => {
    const onResetField = vi.fn();
    const chips = await renderControls({
      fields: ['permissionMode', 'transcriptStorage'],
      facts: { agentTargets: [directCapableClaude()] },
      overriddenFields: new Set(['permissionMode']),
      resetOverride: { label: 'Use workflow’s', onResetField },
    });
    const openPicker = () => chips.screen.findAllByType(AgentInputChipPickerPopover).find((node) => node.props.open);
    await act(async () => { chips.screen.pressByTestId('session-authoring-control-transcriptStorage'); });
    expect(openPicker()?.props.options.some((option: { label: string }) => option.label === 'Use workflow’s')).toBe(false);
    await act(async () => { openPicker()?.props.onRequestClose(); });
    await act(async () => { chips.screen.pressByTestId('session-authoring-control-permissionMode'); });
    expect(openPicker()?.props.options[0]?.label).toBe('Use workflow’s');
    await act(async () => { selectOption(chips.screen, openPicker()!.props.options[0].id); });
    expect(onResetField).toHaveBeenCalledWith('permissionMode');
    expect(chips.onChangeField).not.toHaveBeenCalled();
    await chips.screen.unmount();
  });

  it('returns a changed Windows window name to inheritance rather than an explicit blank', async () => {
    const { SessionAuthoringControls } = await import('./SessionAuthoringControls');
    const { createWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowEditorDraft');
    const { resolveEffectiveWorkflowStepExecution, listWorkflowStepOverriddenFields } = await import('@/sync/domains/workflows/workflowAuthoring');
    const { setWorkflowDefaultField, setWorkflowStepExecutionField } = await import('@happier-dev/protocol/workflows/workflowDefinitionEditV1');
    const initial = createWorkflowEditorDraft({ draftId: 'window-name-reset',
      defaults: { windowsTerminalWindowName: 'Workflow window' },
      blocks: [{ kind: 'step', id: 'check', document: { text: 'Check', references: [], attachments: [] },
        input: [], result: { kind: 'text' }, execution: { windowsTerminalWindowName: 'Step window' } }] });
    let current = initial;
    let changeDefault = (_name: string) => {};
    function Field() {
      const [draft, setDraft] = React.useState(initial);
      current = draft;
      changeDefault = (name) => setDraft(value => setWorkflowDefaultField(value, 'windowsTerminalWindowName', name));
      const step = draft.blocks[0];
      if (step?.kind !== 'step') throw new Error('Expected the authored step');
      return <SessionAuthoringControls fields={['windowsTerminalWindowName']}
        values={resolveEffectiveWorkflowStepExecution(draft, step)} facts={{ targetIsWindows: true }}
        overriddenFields={new Set(listWorkflowStepOverriddenFields(step))}
        onChangeField={(field, value) => setDraft(draft => setWorkflowStepExecutionField(draft, step.id, field, value))}
        resetOverride={{ label: 'Use workflow’s',
          onResetField: (field) => setDraft(draft => setWorkflowStepExecutionField(draft, step.id, field, undefined)) }} />;
    }
    const screen = await renderScreen(<Field />);
    const inputId = 'session-authoring-control-windowsTerminalWindowName-input';
    const resetId = 'session-authoring-control-windowsTerminalWindowName-reset';
    expect(screen.findByTestId(inputId)?.props.value).toBe('Step window');
    await act(async () => { screen.changeTextByTestId(inputId, ''); });
    expect(current.blocks[0]).toMatchObject({ execution: { windowsTerminalWindowName: null } });
    expect(screen.findHostByTestId(resetId), 'an explicit blank still needs a way back to inheritance').not.toBeNull();
    await screen.pressByTestIdAsync(resetId);
    expect(current.blocks[0]).not.toHaveProperty('execution');
    expect(screen.findByTestId(inputId)?.props.value).toBe('Workflow window');
    expect(screen.findHostByTestId(resetId)).toBeNull();
    await act(async () => { changeDefault('Renamed workflow window'); });
    expect(screen.findByTestId(inputId)?.props.value).toBe('Renamed workflow window');
    await screen.unmount();
  });

  it('draws the selects presentation as unlabelled field selects that open the chip picker and write the same value', async () => {
    const { HappierFieldBoxTrigger } = await import('@happier-dev/plugin-ui/presentation');
    const selects = await renderControls({
      fields: ['permissionMode'],
      presentation: 'selects',
      facts: { agentTargets: [directCapableClaude()] },
    });
    // No settings row and no per-field label: the host's group names the set.
    expect(selects.screen.findByTestId('session-authoring-control-permissionMode-row')).toBeNull();
    expect(selects.screen.getTextContent()).not.toContain('settingsSession.permissions.title');
    // The trigger is the bordered field select, still named for assistive technology.
    expect(selects.screen.findAllByType(HappierFieldBoxTrigger).length).toBe(1);
    expect(selects.screen.findByTestId('session-authoring-control-permissionMode')?.props.accessibilityLabel)
      .toContain('settingsSession.permissions.title');
    await act(async () => {
      selects.screen.pressByTestId('session-authoring-control-permissionMode');
    });
    await act(async () => {
      selectOption(selects.screen, 'yolo');
    });
    expect(selects.onChangeField).toHaveBeenCalledWith('permissionMode', 'yolo');
    await selects.screen.unmount();
  });

  // WF-ACCEPT-1118B item 5 (lab round 1116b bhow-card): a workflow's unset Approval inherits the Machine's default, so
  // its select names that value, as a step's chip does; the composer's empty field keeps naming its field (QA-SHELL-1114 F3).
  it('names the inherited Machine default for an unset Approval where unset values inherit, and the field otherwise', async () => {
    const inherits = await renderControls({ presentation: 'selects', fields: ['approvalProfileId'], values: {}, inheritsUnsetValues: true });
    expect(inherits.screen.getTextContent()).toContain('workflows.triggers.guided.profile.machineDefault');
    expect(inherits.screen.getTextContent()).not.toContain('workflows.triggers.guided.profile.title');
    await inherits.screen.unmount();
    const composer = await renderControls({ presentation: 'chips', fields: ['approvalProfileId'], values: {} });
    expect(composer.screen.getTextContent()).toContain('workflows.triggers.guided.profile.title');
    await composer.screen.unmount();
  });

  it('keeps a field select\'s choices inside the panel that holds the selects', async () => {
    const { SessionAuthoringControls } = await import('./SessionAuthoringControls');
    const { PopoverBoundaryProvider } = await import('@/components/ui/popover/PopoverBoundary');
    const panelRef = React.createRef<unknown>();
    const screen = await renderScreen(
      <PopoverBoundaryProvider boundaryRef={panelRef}>
        <SessionAuthoringControls fields={['permissionMode']} values={baseValues()} onChangeField={() => {}}
          presentation="selects" facts={{ agentTargets: [directCapableClaude()] }} />
      </PopoverBoundaryProvider>,
    );
    await act(async () => { screen.pressByTestId('session-authoring-control-permissionMode'); });
    // A labelled select in a panel (Step options) opens within it (WF-ACCEPT-1118 item 1), not across the page.
    const popover = screen.root.findAllByType(AgentInputChipPickerPopover).find((node) => node.props.open);
    expect(popover?.props.boundaryRef).toBe(panelRef);
    await screen.unmount();
  });

  it('draws no field select for an Agent-owned field while its engine sits beside the selects (a step card header)', async () => {
    const { screen } = await renderControls({
      presentation: 'selects',
      fields: ['permissionMode', 'approvalProfileId'],
      values: {},
      engineChipBeside: true,
    });
    // The engine chip beside asks for the Agent once; its fields add only "Unavailable".
    expect(screen.findByTestId('session-authoring-control-permissionMode')).toBeNull();
    expect(screen.findByTestId('session-authoring-control-permissionMode-unavailable')).toBeNull();
    await screen.unmount();
  });

  it('says once that the Agent comes first instead of listing each Agent-owned field as unavailable', async () => {
    const { screen } = await renderControls({
      presentation: 'fields',
      fields: ['permissionMode', 'transcriptStorage'],
      values: {},
    });
    // No Agent chosen: its fields have nothing to answer yet, so the form says what to do once.
    expect(screen.findByTestId('session-authoring-control-permissionMode-row')).toBeNull();
    expect(screen.findByTestId('session-authoring-control-transcriptStorage-row')).toBeNull();
    expect(screen.findByTestId('session-authoring-control-requires-agent')).not.toBeNull();
    expect(screen.getTextContent()).toContain('newSession.chooseAgentFirst');
    await screen.unmount();
  });

  it('draws no chip for an Agent-owned field while no Agent is chosen (the engine chip already asks for one)', async () => {
    const { screen } = await renderControls({
      presentation: 'chips',
      fields: ['agentTarget', 'permissionMode', 'transcriptStorage'],
      values: {},
      onChangeFields: vi.fn(),
    });
    // A row of chips is not a form: two "Unavailable" words would repeat what the Agent chip says.
    expect(screen.findByTestId('session-authoring-control-permissionMode-unavailable')).toBeNull();
    expect(screen.findByTestId('session-authoring-control-transcriptStorage-unavailable')).toBeNull();
    await screen.unmount();
  });

  it('authors the unattended tool policy: other tools ask or deny, and the allowed list as typed', async () => {
    const { screen, onChangeField } = await renderControls({
      presentation: 'fields',
      fields: ['unlistedTools', 'allowedTools'],
      values: { ...baseValues(), allowedTools: ['Read'] },
    });

    await act(async () => {
      screen.pressByTestId('session-authoring-control-unlistedTools');
    });
    await act(async () => {
      selectOption(screen, 'deny');
    });
    expect(onChangeField).toHaveBeenCalledWith('unlistedTools', 'deny');

    const input = () =>
      screen.findByTestId('session-authoring-control-allowedTools-input');
    expect(input()?.props.value).toBe('Read');
    // A half-typed list keeps its text while the value is the parsed names.
    await act(async () => {
      input()?.props.onChangeText('Read, mcp__wilson__lookup,');
    });
    expect(onChangeField).toHaveBeenLastCalledWith('allowedTools', [
      'Read',
      'mcp__wilson__lookup',
    ]);
    expect(input()?.props.value).toBe('Read, mcp__wilson__lookup,');
    await act(async () => {
      input()?.props.onChangeText('  ');
    });
    expect(onChangeField).toHaveBeenLastCalledWith('allowedTools', undefined);

    await screen.unmount();
  });

  it('reports the chosen permission mode without writing any preference', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const before = storage.getState().settings;
    const { screen, onChangeField } = await renderControls({
      fields: ['permissionMode'],
    });

    await act(async () => {
      screen.pressByTestId('session-authoring-control-permissionMode');
    });
    await act(async () => {
      selectOption(screen, 'yolo');
    });

    expect(onChangeField).toHaveBeenCalledWith('permissionMode', 'yolo');
    // Choosing in an authoring surface is not a "remembered selection".
    expect(storage.getState().settings).toBe(before);

    await screen.unmount();
  });

  it('binds a chosen model exactly the way ordinary Session authoring binds it', async () => {
    const { updateSessionAuthoringDraftModelMode } =
      await import('@/components/sessions/authoring/draft/updateSessionAuthoringDraftFields');
    const { screen, onChangeField } = await renderControls({
      fields: ['modelSelection'],
      values: baseValues(),
    });

    await act(async () => {
      screen.pressByTestId('session-authoring-control-modelSelection');
    });
    const picker = screen.root
      .findAllByType(AgentInputChipPickerPopover)
      .find((node) => node.props.open)!;
    const modelId = (
      picker.props.options as ReadonlyArray<{ id: string }>
    ).find((option) => option.id !== 'default')?.id;
    expect(modelId).toBeTruthy();

    await act(async () => {
      selectOption(screen, modelId as string);
    });

    const newSessionSelection = updateSessionAuthoringDraftModelMode(
      { agentTarget: CLAUDE_TARGET } as never,
      modelId as never,
      1234,
    ).modelSelection;
    const [, authoredSelection] = onChangeField.mock.calls.at(-1) as [
      string,
      { ref: unknown },
    ];
    // Same picker, same binding: the exact same target-bound reference.
    expect(authoredSelection.ref).toEqual(newSessionSelection?.ref);

    await screen.unmount();
  });

  /**
   * Direct transcripts are an Agent-on-this-Machine capability, answered by
   * the selected Agent's own option rather than a surface-wide flag: the same
   * surface offers the choice for one Agent and states it unavailable for
   * another, and choosing reports the canonical value.
   */
  it('offers transcript storage only for an Agent that supports direct transcripts on this Machine', async () => {
    const unsupported = await renderControls({
      fields: ['transcriptStorage'],
      facts: { agentTargets: [directCapableClaude(false)] },
    });
    expect(
      unsupported.screen.findByTestId(
        'session-authoring-control-transcriptStorage-unavailable',
      ),
    ).toBeTruthy();
    await unsupported.screen.unmount();

    const { screen, onChangeField } = await renderControls({
      fields: ['transcriptStorage'],
      facts: { agentTargets: [directCapableClaude(true)] },
    });
    expect(
      screen.findByTestId(
        'session-authoring-control-transcriptStorage-unavailable',
      ),
    ).toBeNull();
    await act(async () => {
      screen.pressByTestId('session-authoring-control-transcriptStorage');
    });
    await act(async () => {
      selectOption(screen, 'direct');
    });
    expect(onChangeField).toHaveBeenCalledWith('transcriptStorage', 'direct');
    await screen.unmount();
  });

  /**
   * Connected Service bindings are authored through the incumbent New Session
   * owner — its chip, its per-service selection panel, its Team credential
   * resources — and what reaches the draft is the canonical `V2` payload, not
   * the owner's private option-state record.
   */
  it('edits Connected Service bindings through the incumbent New Session owner', async () => {
    connectedServicesContentProps.value = null;
    // A current public catalog entry, validated through its canonical schema:
    // the panel is handed the exact wire shape a Home projects, so the fixture
    // must satisfy the same contract the transport does.
    const teamResource = TeamCredentialResourceCatalogEntryV1Schema.parse({
      id: 'res-1',
      teamId: 'team-1',
      displayName: teamCredentialDisplayNameFixture('Shared GitHub app'),
      resourceRevision: 3,
      readiness: { kind: 'available' },
      recoveryAction: null,
      mayBroker: true,
      mayReceiveDirect: false,
      directMaterialState: 'never_delivered',
      sessionUsePolicy: 'personal_allowed',
      usageCapabilities: {
        inferenceRequests: 'available',
        totalTokens: 'unavailable',
        costUsd: 'unavailable',
        limitCoverage: 'unavailable',
      },
      providerModels: [],
      connectedServiceSelections: [
        {
          source: 'team_resource',
          resourceId: 'res-1',
          deliveryMode: 'brokered',
        },
      ],
      sourcePresentation: {
        kind: 'connected_service',
        service: { pluginId: 'happier.connect.github', localId: 'github' },
      },
    });
    // A second resource this Home no longer reports as current remains in
    // the picker so the shared selection owner can show its recovery path.
    const staleResource = TeamCredentialResourceCatalogEntryV1Schema.parse({
      ...teamResource,
      id: 'res-stale',
      readiness: { kind: 'source_unavailable' },
      recoveryAction: 'source_owner_action',
      connectedServiceSelections: [],
    });
    teamCredentialCatalog.resources = [teamResource, staleResource];
    teamCredentialCatalog.resourceStatusByKey = new Map([['team-1:res-1', { kind: 'current' as const }]]);
    teamCredentialCatalog.teamNameById = { 'team-1': 'Platform' };

    const { screen, onChangeField } = await renderControls({
      fields: ['connectedServices'],
      values: { agentTarget: CLAUDE_TARGET },
      facts: {
        agentTargets: [claudeWithGithubDeclaration()],
        connectedServices: { serverId: 'server-a' },
      },
    });
    await act(async () => {});

    expect(
      screen.findByTestId(
        'session-authoring-control-connectedServices-unavailable',
      ),
    ).toBeNull();
    expect(
      screen.findByTestId('new-session-connected-services-auth-chip'),
    ).toBeTruthy();

    await act(async () => {
      screen.pressByTestId('new-session-connected-services-auth-chip');
    });
    expect(screen.findByTestId('connected-services-content-stub')).toBeTruthy();
    // The owner is handed the exact Agent-declared service and the Team
    // resources this Home returns, with currentness kept separate from
    // retained choices that need recovery.
    expect(connectedServicesContentProps.value?.supportedServiceIds).toEqual([
      'happier.connect.github/github',
    ]);
    expect(
      connectedServicesContentProps.value?.teamCredentialResources,
    ).toEqual([teamResource, staleResource]);
    expect(
      connectedServicesContentProps.value?.teamCredentialResourceStatusByKey,
    ).toEqual(new Map([['team-1:res-1', { kind: 'current' }]]));
    expect(connectedServicesContentProps.value?.teamNameById).toEqual({
      'team-1': 'Platform',
    });

    const setBindingForService = connectedServicesContentProps.value
      ?.setBindingForService as (
      serviceId: string,
      binding: unknown,
    ) => Promise<void>;
    await act(async () => {
      await setBindingForService('happier.connect.github/github', {
        source: 'native',
      });
    });

    const [field, value] = onChangeField.mock.calls.at(-1) as [
      string,
      { v: number } | null,
    ];
    expect(field).toBe('connectedServices');
    // The canonical binding payload, not the owner's option-state record.
    expect(value).toEqual({
      v: 2,
      bindingsByServiceId: {
        'happier.connect.github/github': { source: 'native' },
      },
    });
    await screen.unmount();
  });

  /**
   * Omission and an authored `null` are different answers, and only one of
   * them may consult the Account's default Connected Service auth.
   *
   * Omission inherits, so the incumbent owner seeds its preview from the
   * Account purpose catalog exactly as New Session does. An authored `null` is the
   * explicit "no connected account" the workflow contract stores, so the
   * defaults must not reappear — and editing one service from that state must
   * not sweep an untouched Account default into the saved definition, which
   * would bind a credential the author never chose.
   */
  it('keeps an authored empty Connected Services value distinct from omission', async () => {
    const serverId = await seedAccountDefaultConnectedServiceAuth();
    const facts = {
      agentTargets: [claudeWithTwoDeclarations()],
      connectedServices: { serverId },
    };

    const inherited = await renderControls({
      fields: ['connectedServices'],
      values: { agentTarget: CLAUDE_TARGET },
      facts,
    });
    await act(async () => {});
    // Omitted: this Account's defaults are the preview, as in New Session.
    expect(await readPanelBindings(inherited.screen)).toEqual(
      ACCOUNT_DEFAULT_AUTH_BINDINGS,
    );
    expect(inherited.onChangeField).not.toHaveBeenCalled();
    await inherited.screen.unmount();

    connectedServicesContentProps.value = null;
    const { screen, onChangeField } = await renderControls({
      fields: ['connectedServices'],
      values: { agentTarget: CLAUDE_TARGET, connectedServices: null },
      facts,
    });
    await act(async () => {});
    // Authored "none": nothing is bound, and reopening reports nothing.
    expect(await readPanelBindings(screen)).toEqual({});
    expect(onChangeField).not.toHaveBeenCalled();

    const setBindingForService = connectedServicesContentProps.value
      ?.setBindingForService as (
      serviceId: string,
      binding: unknown,
    ) => Promise<void>;
    await act(async () => {
      await setBindingForService(GITHUB_SERVICE_KEY, { source: 'native' });
    });

    const [field, value] = onChangeField.mock.calls.at(-1) as [string, unknown];
    expect(field).toBe('connectedServices');
    // Editing one service cannot import the untouched service's Account
    // default; it stays native because nothing was authored for it.
    expect(value).toEqual({
      v: 2,
      bindingsByServiceId: {
        [GITHUB_SERVICE_KEY]: { source: 'native' },
        [LINEAR_SERVICE_KEY]: { source: 'native' },
      },
    });
    await screen.unmount();
  });

  it('does not report rehydrated Connected Services after the controlled value is reset', async () => {
    const serverId = await seedAccountDefaultConnectedServiceAuth();
    const facts = {
      agentTargets: [claudeWithTwoDeclarations()],
      connectedServices: { serverId },
    };
    const { SessionAuthoringControls } =
      await import('./SessionAuthoringControls');
    const onChangeField = vi.fn();
    const screen = await renderScreen(
      <SessionAuthoringControls
        fields={['connectedServices']}
        values={{ agentTarget: CLAUDE_TARGET, connectedServices: null }}
        facts={facts}
        onChangeField={onChangeField}
      />,
    );

    await readPanelBindings(screen);
    const setBindingForService = connectedServicesContentProps.value
      ?.setBindingForService as (
      serviceId: string,
      binding: unknown,
    ) => Promise<void>;
    await act(async () => {
      await setBindingForService(GITHUB_SERVICE_KEY, { source: 'native' });
    });
    expect(onChangeField).toHaveBeenCalledTimes(1);

    // The parent reset removes the authored override. Rehydrating the
    // incumbent owner's preview from Account defaults is not another edit.
    await screen.update(
      <SessionAuthoringControls
        fields={['connectedServices']}
        values={{ agentTarget: CLAUDE_TARGET }}
        facts={facts}
        onChangeField={onChangeField}
      />,
    );
    await act(async () => {});

    expect(await readPanelBindings(screen)).toEqual(
      ACCOUNT_DEFAULT_AUTH_BINDINGS,
    );
    expect(onChangeField).toHaveBeenCalledTimes(1);

    const setBindingAfterReset = connectedServicesContentProps.value
      ?.setBindingForService as (
      serviceId: string,
      binding: unknown,
    ) => Promise<void>;
    await act(async () => {
      await setBindingAfterReset(GITHUB_SERVICE_KEY, { source: 'native' });
    });
    expect(onChangeField).toHaveBeenCalledTimes(2);
    await screen.unmount();
  });

  it('keeps an authored qualified binding when that service is no longer declared', async () => {
    const preservedLinearBinding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      profileId: 'lin-work',
    };
    const { screen, onChangeField } = await renderControls({
      fields: ['connectedServices'],
      values: {
        agentTarget: CLAUDE_TARGET,
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            [GITHUB_SERVICE_KEY]: { source: 'native' },
            [LINEAR_SERVICE_KEY]: preservedLinearBinding,
          },
        },
      },
      facts: {
        // Linear was valid when authored but is no longer declared by
        // the current Agent projection, so the picker offers GitHub only.
        agentTargets: [claudeWithGithubDeclaration()],
        connectedServices: { serverId: 'server-a' },
      },
    });

    // The panel is handed the option-state parser's normalised shape: a
    // profile selection is carried by its account identity, since
    // `selection: 'profile'` is the canonical V2 default whenever a
    // `profileId` is present. The authored binding is preserved losslessly
    // where that contract actually lives — the emitted V2 payload below,
    // which re-emits the explicit `selection`.
    expect(await readPanelBindings(screen)).toEqual({
      [GITHUB_SERVICE_KEY]: { source: 'native' },
      [LINEAR_SERVICE_KEY]: {
        source: 'connected',
        profileId: preservedLinearBinding.profileId,
      },
    });
    expect(connectedServicesContentProps.value?.supportedServiceIds).toEqual([
      GITHUB_SERVICE_KEY,
    ]);

    const setBindingForService = connectedServicesContentProps.value
      ?.setBindingForService as (
      serviceId: string,
      binding: unknown,
    ) => Promise<void>;
    await act(async () => {
      await setBindingForService(GITHUB_SERVICE_KEY, { source: 'native' });
    });

    expect(onChangeField).toHaveBeenCalledWith('connectedServices', {
      v: 2,
      bindingsByServiceId: {
        [GITHUB_SERVICE_KEY]: { source: 'native' },
        [LINEAR_SERVICE_KEY]: preservedLinearBinding,
      },
    });
    await screen.unmount();
  });

  it('states Connected Services unavailable when the Agent declares none or the Home is unknown', async () => {
    const noDeclarations = await renderControls({
      fields: ['connectedServices'],
      facts: {
        agentTargets: [directCapableClaude()],
        connectedServices: { serverId: 'server-a' },
      },
    });
    expect(
      noDeclarations.screen.findByTestId(
        'session-authoring-control-connectedServices-unavailable',
      ),
    ).toBeTruthy();
    await noDeclarations.screen.unmount();

    const noHome = await renderControls({
      fields: ['connectedServices'],
      facts: { agentTargets: [claudeWithGithubDeclaration()] },
    });
    expect(
      noHome.screen.findByTestId(
        'session-authoring-control-connectedServices-unavailable',
      ),
    ).toBeTruthy();
    await noHome.screen.unmount();
  });

  /**
   * The terminal field authors the one choice the incumbent New Session
   * terminal owner offers and the spawn resolver honours: whether a spawned
   * Session runs inside tmux. Omission is its own option — this machine's own
   * terminal settings still decide — and is not the same as choosing "off".
   */
  it('authors the incumbent tmux choice and keeps omission distinct from off', async () => {
    const { screen, onChangeField } = await renderControls({
      fields: ['terminal'],
      values: { agentTarget: CLAUDE_TARGET },
      facts: { agentTargets: [directCapableClaude()] },
    });
    expect(
      screen.findByTestId('session-authoring-control-terminal-unavailable'),
    ).toBeNull();

    await act(async () => {
      screen.pressByTestId('session-authoring-control-terminal');
    });
    await act(async () => {
      selectOption(screen, 'tmux');
    });
    expect(onChangeField).toHaveBeenLastCalledWith('terminal', {
      mode: 'tmux',
    });

    await act(async () => {
      selectOption(screen, 'plain');
    });
    expect(onChangeField).toHaveBeenLastCalledWith('terminal', {
      mode: 'plain',
    });

    await act(async () => {
      selectOption(screen, '__none__');
    });
    expect(onChangeField).toHaveBeenLastCalledWith('terminal', null);
    await screen.unmount();
  });

  it('preserves an authored tmux session name when the terminal mode is re-picked', async () => {
    const { screen, onChangeField } = await renderControls({
      fields: ['terminal'],
      values: {
        agentTarget: CLAUDE_TARGET,
        terminal: {
          mode: 'plain',
          tmux: { sessionName: 'review', isolated: true },
        },
      },
      facts: { agentTargets: [directCapableClaude()] },
    });
    await act(async () => {
      screen.pressByTestId('session-authoring-control-terminal');
    });
    await act(async () => {
      selectOption(screen, 'tmux');
    });
    expect(onChangeField).toHaveBeenLastCalledWith('terminal', {
      mode: 'tmux',
      tmux: { sessionName: 'review', isolated: true },
    });
    await screen.unmount();
  });

  it('states the terminal choice unsupported on a Windows target', async () => {
    const { screen } = await renderControls({
      fields: ['terminal'],
      facts: { agentTargets: [directCapableClaude()], targetIsWindows: true },
    });
    expect(
      screen.findByTestId('session-authoring-control-terminal-unavailable'),
    ).toBeTruthy();
    await screen.unmount();
  });

  it('authors Windows Terminal only when the selected Windows target reports it available', async () => {
    const unavailable = await renderControls({
      fields: ['windowsRemoteSessionLaunchMode'],
      facts: { targetIsWindows: true, windowsTerminalAvailable: false },
    });
    await act(async () => {
      unavailable.screen.pressByTestId(
        'session-authoring-control-windowsRemoteSessionLaunchMode',
      );
    });
    const unavailablePicker = unavailable.screen.root
      .findAllByType(AgentInputChipPickerPopover)
      .find((node) => node.props.open)!;
    expect(
      (
        unavailablePicker.props.options as ReadonlyArray<{
          id: string;
          disabled?: boolean;
          subtitle?: string;
        }>
      ).find((option) => option.id === 'windows_terminal'),
    ).toMatchObject({
      disabled: true,
      subtitle: expect.stringContaining(
        'machine.windows.windowsTerminalUnavailableSuffix',
      ),
    });
    await unavailable.screen.unmount();

    const capable = await renderControls({
      fields: ['windowsRemoteSessionLaunchMode'],
      facts: { targetIsWindows: true, windowsTerminalAvailable: true },
    });
    await act(async () => {
      capable.screen.pressByTestId(
        'session-authoring-control-windowsRemoteSessionLaunchMode',
      );
    });
    await act(async () => {
      selectOption(capable.screen, 'windows_terminal');
    });
    expect(capable.onChangeField).toHaveBeenCalledWith(
      'windowsRemoteSessionLaunchMode',
      'windows_terminal',
    );
    await capable.screen.unmount();
  });

  /** Every field a host can list has a canonical localized name. */
  it('names every field with its canonical control title', async () => {
    const { resolveSessionAuthoringFieldTitle } = await import('./sessionAuthoringFieldControls');
    const { WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS } = await import('@happier-dev/protocol/workflows/workflowV1');

    for (const field of WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS) {
      const title = resolveSessionAuthoringFieldTitle(field);
      expect(title, `no canonical title for ${field}`).toBeTruthy();
      // A title is a name, never the schema id a reader cannot act on.
      expect(title).not.toBe(field);
    }

    expect(resolveSessionAuthoringFieldTitle('runtimeDescriptorV1')).toBe(
      'workflows.editor.agentRuntime',
    );

    // The Agent that declares a runtime choice names it.
    expect(
      resolveSessionAuthoringFieldTitle('runtimeDescriptorV1', {
        ...directCapableClaude(),
        runtimeBackendMode: { title: 'Backend mode', options: [] },
      }),
    ).toBe('Backend mode');
  });

  it('retires an Agent-bound runtime descriptor when the selected Agent no longer contributes it', async () => {
    const {
      resolveSessionAuthoringRuntimeDescriptorAvailability,
      retireUnavailableSessionAuthoringRuntimeDescriptor,
    } = await import('./sessionAuthoringFieldControls');
    const descriptor = {
      v: 1 as const,
      agentId: 'opencode',
      agent: { backendMode: 'acp' },
    };
    const opencode = {
      ...directCapableClaude(),
      agentId: 'opencode',
      target: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
      },
    };
    const claude = directCapableClaude();
    const facts = { agentTargets: [opencode, claude] };

    expect(
      retireUnavailableSessionAuthoringRuntimeDescriptor({
        runtimeDescriptorV1: descriptor,
        agentTarget: opencode.target,
        facts,
      }),
    ).toBe(descriptor);
    expect(
      retireUnavailableSessionAuthoringRuntimeDescriptor({
        runtimeDescriptorV1: descriptor,
        agentTarget: claude.target,
        facts,
      }),
    ).toBeNull();
    expect(
      resolveSessionAuthoringRuntimeDescriptorAvailability({
        values: {
          agentTarget: opencode.target,
          runtimeDescriptorV1: descriptor,
        },
        facts: {
          agentTargets: [
            {
              ...opencode,
              runtimeBackendMode: {
                title: 'Backend mode',
                options: [{ id: 'server', label: 'Server' }],
              },
            },
            claude,
          ],
        },
      }),
    ).toBe('unavailable');
  });

  it('omits runtime options for a resolved external Agent that declares no runtime choice', async () => {
    const target: AgentExecutionTargetV1 = {
      kind: 'agent', identity: { pluginId: 'acme.reviewer', localId: 'reviewer' },
    };
    const { screen } = await renderControls({
      presentation: 'fields', fields: ['runtimeDescriptorV1'], values: { agentTarget: target },
      facts: { agentTargets: [{ id: 'external-reviewer', label: 'Reviewer', target, agentId: 'acme.reviewer/reviewer' }] },
    });
    expect(screen.findByTestId('session-authoring-control-runtimeDescriptorV1-row')).toBeNull();
    await screen.unmount();
  });

  it('authors the selected Agent runtime mode as a strict portable descriptor', async () => {
    const opencodeTarget = {
      kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
    };
    const { screen, onChangeField } = await renderControls({
      fields: ['runtimeDescriptorV1'],
      values: { agentTarget: opencodeTarget },
      facts: {
        agentTargets: [
          {
            id: 'agent:happier.agent.opencode/opencode',
            label: 'OpenCode',
            target: opencodeTarget,
            agentId: 'opencode',
            runtimeBackendMode: {
              title: 'Mode du moteur',
              options: [
                { id: 'server', label: 'Serveur' },
                { id: 'acp', label: 'ACP historique' },
              ],
            },
          },
        ],
      },
    });
    await act(async () => {
      screen.pressByTestId('session-authoring-control-runtimeDescriptorV1');
    });
    await act(async () => {
      selectOption(screen, 'acp');
    });
    expect(onChangeField).toHaveBeenLastCalledWith('runtimeDescriptorV1', {
      v: 1,
      agentId: 'opencode',
      agent: { backendMode: 'acp' },
    });
    await screen.unmount();
  });

  /**
   * These chips and the window-name input are the real press frames. On the
   * native fixture they must honor the touch floor, not the smaller precise-
   * pointer floor of a desktop web environment.
   */
  it('keeps the chip and the window-name input at their design height, never the touch target', async () => {
    const target = resolveHappierMinimumInteractiveTargetSize('ios');
    const { screen } = await renderControls({
      fields: ['permissionMode', 'windowsTerminalWindowName'],
      facts: { agentTargets: [directCapableClaude()], targetIsWindows: true },
    });

    const chip = screen.findByTestId(
      'session-authoring-control-permissionMode',
    );
    const chipStyle = (
      chip?.props.style as (state: { pressed: boolean }) => unknown[]
    )({ pressed: false });
    const heights = chipStyle
      .flat()
      .map((entry) => (entry as { minHeight?: number } | null)?.minHeight)
      .filter((height) => height !== undefined);
    expect(heights).toEqual([]);

    const input = screen.findByTestId(
      'session-authoring-control-windowsTerminalWindowName-input',
    );
    const inputHeights = [input?.props.style]
      .flat()
      .map((entry) => (entry as { minHeight?: number } | null)?.minHeight)
      .filter((height): height is number => height !== undefined);
    expect(inputHeights.length).toBeGreaterThan(0);
    expect(Math.max(...inputHeights)).toBeLessThan(target);
    await screen.unmount();
  });

  it('states the MCP selection unavailable without a resolved Agent or an exact Machine and folder', async () => {
    const scoped = await renderControls({
      fields: ['capabilitySelection'],
      facts: {
        agentTargets: [directCapableClaude()],
        mcp: {
          machineId: 'machine-1',
          machineName: null,
          directory: '/p',
          serverId: null,
        },
      },
    });
    expect(
      scoped.screen.findByTestId(
        'session-authoring-control-capabilitySelection-unavailable',
      ),
    ).toBeNull();
    expect(
      scoped.screen.findByTestId('session-capabilities-chip'),
    ).toBeTruthy();
    await scoped.screen.unmount();

    const noAgent = await renderControls({
      fields: ['capabilitySelection'],
      values: {},
      facts: {
        mcp: {
          machineId: 'machine-1',
          machineName: null,
          directory: '/p',
          serverId: null,
        },
      },
    });
    expect(
      noAgent.screen.findByTestId(
        'session-authoring-control-capabilitySelection-unavailable',
      ),
    ).toBeTruthy();
    await noAgent.screen.unmount();

    const noScope = await renderControls({
      fields: ['capabilitySelection'],
      facts: { agentTargets: [directCapableClaude()] },
    });
    expect(
      noScope.screen.findByTestId(
        'session-authoring-control-capabilitySelection-unavailable',
      ),
    ).toBeTruthy();
    await noScope.screen.unmount();
  });
});
