// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { Button } from '@happier-dev/plugin-ui';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TriageSourceAdministrationActionInputV1Schema,
  TriageListScopeUnitsInputV1Schema,
  TriageSourceInstanceDraftV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTriageSourceSettingsSurface,
  type TriageSourceSettingsDraftEditorPropsV1,
} from './surface.js';

/**
 * The settings page, mounted the way the host mounts it.
 *
 * Nothing between the press and the target is stood in for: the surface reaches
 * the published Actions through the SDK's own mounted Host API client, and the
 * administration request is admitted by the SAME published schema the target
 * parses. That is the whole point of these cases — a page whose own tests
 * import its component directly proves nothing about whether the host can reach
 * it, and a page that sends a draft the target would reject would still look
 * green under a hand-rolled assertion on its fields.
 *
 * The identity below is deliberately not one of the six shipped sources. This
 * page is the same page for every source, so a case that only passes because it
 * says "GitHub" would be testing a coincidence; the six packages each own one
 * small case proving they hand this factory their own identity.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLUGIN_ID = 'example.tracker';
const LIST_INSTANCES_LOCAL_ACTION_ID = 'triage-list-instances-v1';
const SOURCE_DISPLAY_NAME = 'Example Tracker';
const CONNECTED_ACCOUNT_SERVICE_LOCAL_ID = 'tracker-account';
const PURPOSE = 'tracker-connected-account';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

const renderSurface = createTriageSourceSettingsSurface({
  pluginId: PLUGIN_ID,
  listInstancesLocalActionId: LIST_INSTANCES_LOCAL_ACTION_ID,
  connectedAccountServiceLocalId: CONNECTED_ACCOUNT_SERVICE_LOCAL_ID,
  connectedAccountPurpose: PURPOSE,
  sourceDisplayName: SOURCE_DISPLAY_NAME,
});

function binding(accountId: string): JsonValue {
  return {
    purpose: PURPOSE,
    account: {
      service: { pluginId: PLUGIN_ID, localId: 'tracker-account' },
      accountId,
    },
  };
}

function candidate(scope: string, accountId = 'account-1'): JsonValue {
  return {
    v: 1,
    binding: binding(accountId),
    localInstanceKey: scope,
    keyStability: 'stable',
    configuration: { v: 1, token: `source:${scope}` },
    locator: { v: 1, displayLabel: scope, displayPath: scope },
  };
}

/**
 * One configured instance exactly as the target's caller-scoped read publishes
 * it, so what the page learns on mount comes through the same bytes the real
 * Action returns.
 */
function configuredRecord(
  scope: string,
  lifecycle: 'active' | 'retired',
  accountId = 'account-1',
): JsonValue {
  return {
    v: 1,
    lifecycle,
    configured: {
      v: 1,
      instance: {
        source: { pluginId: PLUGIN_ID, localId: 'tracker' },
        sourceInstanceId: INSTANCE_ID,
      },
      binding: binding(accountId),
      localInstanceKey: scope,
      configuration: { v: 1, token: `source:${scope}` },
      locator: { v: 1, displayLabel: scope, displayPath: scope },
    },
  };
}

type Recorded = Readonly<{ action: unknown; input: unknown }>;

function createHarness(options: Readonly<{
  discovery: JsonValue | ((signal: AbortSignal) => Promise<JsonValue>);
  scopeUnits?: JsonValue | ((input: unknown, signal: AbortSignal) => JsonValue | Promise<JsonValue>);
  /**
   * What the target says this source has already configured. Defaults to nothing
   * configured, which is the state a first visit is in.
   */
  configured?: JsonValue | (() => Promise<JsonValue>);
  /** What that read answers from the second time onward, i.e. after a Refresh. */
  configuredAgain?: JsonValue;
  /**
   * One answer, or one answer per administration press in order. The lifecycle
   * cases need a sequence because the whole point is that the row's next
   * control depends on the arm the target returned for the previous press.
   */
  administration?: readonly JsonValue[];
}>) {
  const recorded: Recorded[] = [];
  const answers: readonly JsonValue[] = options.administration
    ?? [{ kind: 'active', sourceInstanceId: INSTANCE_ID }];
  let administered = 0;
  let configuredReads = 0;

  async function executeAction(
    { action, input, signal }: Readonly<{ action: unknown; input: unknown; signal: AbortSignal }>,
  ): Promise<JsonValue> {
    recorded.push({ action, input });
    const ref = action as Readonly<{ pluginId?: string; localId?: string }>;
    if (ref.localId === 'author/list-units') return (typeof options.scopeUnits === 'function' ? options.scopeUnits(input, signal) : options.scopeUnits) ?? {
      kind: 'page', status: 'complete', selection: { kind: 'all' },
      units: [{ id: 'unit-1', label: 'First team' }, { id: 'unit-2', label: 'Second team' }],
    };
    if (ref.localId === LIST_INSTANCES_LOCAL_ACTION_ID) {
      return typeof options.discovery === 'function'
        ? await options.discovery(signal)
        : options.discovery;
    }
    if (
      ref.pluginId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.pluginId
      && ref.localId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId
    ) {
      const answer = configuredReads === 0
        ? options.configured
        : options.configuredAgain ?? options.configured;
      configuredReads += 1;
      if (typeof answer === 'function') return await answer();
      return answer ?? { kind: 'read', status: 'complete', instances: [] };
    }
    if (
      ref.pluginId === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.pluginId
      && ref.localId === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId
    ) {
      const answer = answers[Math.min(administered, answers.length - 1)];
      administered += 1;
      if (answer === undefined) throw new Error('no administration answer configured');
      return answer;
    }
    throw new Error(`unexpected action ${JSON.stringify(action)}`);
  }

  /** Every administration request, admitted by the schema the target parses. */
  function administrations(): readonly unknown[] {
    return recorded
      .filter((entry) => (
        (entry.action as Readonly<{ localId?: string }>).localId
          === TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.localId
      ))
      .map((entry) => TriageSourceAdministrationActionInputV1Schema.parse(entry.input));
  }

  const connectedAccountsRequests: unknown[] = [];

  return {
    recorded,
    executeAction,
    administrations,
    connectedAccountsRequests,
  };
}

const mounted: PluginUiTestkit[] = [];

async function mountSettings(
  harness: ReturnType<typeof createHarness>,
  translations: Readonly<Record<string, string>> = {},
  surface: typeof renderSurface = renderSurface,
  surfaceContext = createSurfaceContextFixture({ translations }),
): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-1', mountNonce: 'fixture-mount-1' },
      authorPlugin: { id: PLUGIN_ID, version: '0.0.0' },
      surface,
      surfaceContext,
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: {
        executeAction: async ({ action, input, signal }) => await harness.executeAction({ action, input, signal }),
        openConnectedAccounts: async ({ request }) => {
          harness.connectedAccountsRequests.push(request);
          return null;
        },
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

async function pressControl(page: PluginUiTestkit, name: string): Promise<void> {
  await act(async () => {
    await page.press(await page.getByRole('button', { name }));
  });
}

/** Remove is a rare, consequential arm: it lives in the row's More actions, not beside Update. */
async function removeRow(page: PluginUiTestkit, title: string): Promise<void> {
  await pressControl(page, `More actions for ${title}`);
  await act(async () => {
    await page.press(await page.getByRole('menuitem', { name: `Remove ${title} from PRs & Issues` }));
  });
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted PRs & Issues source settings page', () => {
  it('enumerates Account source candidates without a Machine and refreshes through the same Action', async () => {
    let discoveryReads = 0;
    const harness = createHarness({ discovery: async () => {
      discoveryReads += 1;
      return { kind: 'complete', candidates: [candidate('Account repository')], failures: [] };
    } });
    const page = await mountSettings(harness, {}, renderSurface, createSurfaceContextFixture({
      requesterExecutionReady: true, machineConnectionPending: false, machineExecutionReady: false,
    }));
    await expect(page.getByRole('button', { name: 'Add Account repository to PRs & Issues' })).resolves.toBeDefined();
    expect(discoveryReads).toBe(1);
    await pressControl(page, 'Refresh');
    expect(discoveryReads).toBe(2);
    expect(harness.administrations()).toEqual([]);
  });

  it('defers configured reads and Refresh until its requester is admitted independently of Machine discovery', async () => {
    let configuredReads = 0;
    const harness = createHarness({ discovery: { kind: 'complete', candidates: [], failures: [] },
      configured: async () => {
        configuredReads += 1;
        return { kind: 'read', status: 'complete', instances: [configuredRecord('Already configured', 'active')] };
      },
    });
    const page = await mountSettings(harness, {}, renderSurface, createSurfaceContextFixture({
      requesterExecutionReady: false, machineConnectionPending: false, machineExecutionReady: false,
    }));
    expect(configuredReads).toBe(0);
    await pressControl(page, 'Refresh');
    expect(configuredReads).toBe(0);
    await act(async () => { await page.updateSurface(createSurfaceContextFixture({
      requesterExecutionReady: true, machineConnectionPending: true, machineExecutionReady: false,
    })); });
    await expect(page.getByText('Already configured')).resolves.toBeDefined();
    expect(configuredReads).toBe(1);
    await act(async () => { await page.updateSurface(createSurfaceContextFixture({
      requesterExecutionReady: true, machineConnectionPending: false, machineExecutionReady: true,
    })); });
    expect(configuredReads).toBe(1);
  });

  it('dispatches discovery without a Machine, ignores Machine churn, and reacquires on requester readmission', async () => {
    let discoveryReads = 0;
    const harness = createHarness({
      discovery: async () => {
        discoveryReads += 1;
        return { kind: 'complete', candidates: [candidate(`Workspace ${discoveryReads}`)], failures: [] };
      },
      configured: { kind: 'read', status: 'complete', instances: [configuredRecord('Already configured', 'active')] },
    });
    const ready = createSurfaceContextFixture({ requesterExecutionReady: true, machineConnectionPending: false, machineExecutionReady: false });
    const pending = createSurfaceContextFixture({ requesterExecutionReady: false, machineConnectionPending: false, machineExecutionReady: false });
    const page = await mountSettings(harness, {}, renderSurface, ready);

    await expect(page.getByText('Already configured')).resolves.toBeDefined();
    await expect(page.getByRole('button', { name: 'Add Workspace 1 to PRs & Issues' })).resolves.toBeDefined();
    expect(discoveryReads).toBe(1);
    // Machine presence cannot preempt or repeat the Action owner's placement.
    await act(async () => { await page.updateSurface(createSurfaceContextFixture({
      requesterExecutionReady: true, machineConnectionPending: true, machineExecutionReady: false,
    })); });
    await act(async () => { await page.updateSurface(createSurfaceContextFixture({
      requesterExecutionReady: true, machineConnectionPending: false, machineExecutionReady: true,
    })); });
    await act(async () => { await page.updateSurface(ready); });
    expect(discoveryReads).toBe(1);
    await pressControl(page, 'Refresh');
    await expect(page.getByRole('button', { name: 'Add Workspace 2 to PRs & Issues' })).resolves.toBeDefined();
    expect(discoveryReads).toBe(2);
    await act(async () => { await page.updateSurface(pending); });
    expect(discoveryReads).toBe(2);
    await act(async () => { await page.updateSurface(ready); });
    await expect(page.getByRole('button', { name: 'Add Workspace 3 to PRs & Issues' })).resolves.toBeDefined();
    expect(harness.administrations()).toEqual([]);
  });

  it('reacquires discovery after withdrawal while the previous provider read is still pending', async () => {
    let oldSignal: AbortSignal | undefined;
    let releaseOld!: (value: JsonValue) => void;
    const oldRead = new Promise<JsonValue>((resolve) => { releaseOld = resolve; });
    const harness = createHarness({ discovery: async (signal) => {
      if (!oldSignal) { oldSignal = signal; return await oldRead; }
      return { kind: 'complete', candidates: [candidate('Current workspace')], failures: [] };
    } });
    const ready = createSurfaceContextFixture({ machineConnectionPending: false, machineExecutionReady: true });
    const page = await mountSettings(harness, {}, renderSurface, ready);
    expect(oldSignal?.aborted).toBe(false);
    try {
      await act(async () => { await page.updateSurface(createSurfaceContextFixture({ requesterExecutionReady: false, machineConnectionPending: true, machineExecutionReady: false })); });
      expect(oldSignal?.aborted).toBe(true);
      await act(async () => { await page.updateSurface(ready); });
      await expect(page.getByRole('button', { name: 'Add Current workspace to PRs & Issues' })).resolves.toBeDefined();
      await act(async () => { releaseOld({ kind: 'complete', candidates: [candidate('Obsolete workspace')], failures: [] }); });
      await expect(page.queryByRole('button', { name: 'Add Obsolete workspace to PRs & Issues' })).resolves.toBeUndefined();
      expect(harness.administrations()).toEqual([]);
    } finally {
      releaseOld({ kind: 'complete', candidates: [], failures: [] });
    }
  });

  it('lets a separately authored source configure a selected set through the shared editor and real administration schema', async () => {
    let directoryReads = 0;
    let oldSignal: AbortSignal | undefined;
    let releaseOldRead!: (value: JsonValue) => void;
    const oldRead = new Promise<JsonValue>((resolve) => { releaseOldRead = resolve; });
    const surface = createTriageSourceSettingsSurface({
      pluginId: PLUGIN_ID, listInstancesLocalActionId: LIST_INSTANCES_LOCAL_ACTION_ID,
      connectedAccountServiceLocalId: CONNECTED_ACCOUNT_SERVICE_LOCAL_ID,
      connectedAccountPurpose: PURPOSE, sourceDisplayName: SOURCE_DISPLAY_NAME,
      DraftFields: ({ draft, busy, onChange }) => <Button title="Choose another workspace" disabled={busy}
        onPress={() => onChange({ ...draft, localInstanceKey: 'Other workspace', configuration: { v: 1, token: 'source:Other workspace' } })} />,
      scopeSelection: {
        unitLabel: 'Teams', listScopeUnitsLocalActionId: 'author/list-units',
        readSelection: () => ({ kind: 'all' }),
        writeSelection: (draft, selection) => ({ ...draft, configuration: { v: 1, token: JSON.stringify({ v: 1, selection }) } }),
      },
    });
    const harness = createHarness({ discovery: { kind: 'complete', candidates: [candidate('Workspace')], failures: [] },
      scopeUnits: (input, signal) => {
        const key = TriageListScopeUnitsInputV1Schema.parse(input).draft.localInstanceKey;
        if (key !== 'Other workspace' && ++directoryReads === 2) {
          oldSignal = signal;
          return oldRead;
        }
        return { kind: 'page', status: 'complete', selection: { kind: 'all' }, units: key === 'Other workspace'
          ? [{ id: 'unit-3', label: 'Third team' }, { id: 'unit-4', label: 'Fourth team' }]
          : [{ id: 'unit-1', label: 'First team' }, { id: 'unit-2', label: 'Second team' }] };
      },
    });
    const page = await mountSettings(harness, {}, surface);
    await pressControl(page, 'Add Workspace to PRs & Issues');
    expect(harness.administrations()).toEqual([]);
    await act(async () => { await page.press(await page.getByRole('radio', { name: 'Selected…' })); });
    await expect(page.getByRole('button', { name: 'Save selection', state: { disabled: true } })).resolves.toBeDefined();
    await act(async () => { await page.press(await page.getByRole('checkbox', { name: 'First team' })); });
    await act(async () => { await page.press(await page.getByRole('checkbox', { name: 'Second team' })); });
    await pressControl(page, 'Search');
    await pressControl(page, 'Choose another workspace');
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { await page.press(await page.getByRole('radio', { name: 'Selected…' })); });
    await act(async () => { releaseOldRead({ kind: 'page', status: 'complete', selection: { kind: 'all' },
      units: [{ id: 'unit-1', label: 'First team' }] }); });
    await expect(page.queryByRole('checkbox', { name: 'First team' })).resolves.toBeUndefined();
    await expect(page.getByRole('button', { name: 'Save selection', state: { disabled: true } })).resolves.toBeDefined();
    await act(async () => { await page.press(await page.getByRole('checkbox', { name: 'Third team' })); });
    await act(async () => { await page.press(await page.getByRole('checkbox', { name: 'Fourth team' })); });
    await pressControl(page, 'Save selection');
    expect(harness.administrations()).toMatchObject([{ kind: 'create', draft: {
      configuration: { token: JSON.stringify({ v: 1, selection: { kind: 'selected', unitIds: ['unit-3', 'unit-4'] } }) },
      localInstanceKey: 'Other workspace', binding: binding('account-1'),
    } }]);
  });
  it('says why a selection cannot be saved, and keeps listed units in place while the next page loads', async () => {
    let releaseNextPage!: (value: JsonValue) => void;
    const nextPage = new Promise<JsonValue>((resolve) => { releaseNextPage = resolve; });
    const surface = createTriageSourceSettingsSurface({
      pluginId: PLUGIN_ID, listInstancesLocalActionId: LIST_INSTANCES_LOCAL_ACTION_ID,
      connectedAccountServiceLocalId: CONNECTED_ACCOUNT_SERVICE_LOCAL_ID,
      connectedAccountPurpose: PURPOSE, sourceDisplayName: SOURCE_DISPLAY_NAME,
      scopeSelection: {
        unitLabel: 'teams', listScopeUnitsLocalActionId: 'author/list-units',
        readSelection: () => ({ kind: 'all' }),
        // The source's token holds at most two units: a third cannot be encoded.
        writeSelection: (draft, selection) => selection.kind === 'selected' && selection.unitIds.length > 2
          ? null
          : { ...draft, configuration: { v: 1, token: JSON.stringify({ v: 1, selection }) } },
      },
    });
    const harness = createHarness({ discovery: { kind: 'complete', candidates: [candidate('Workspace')], failures: [] },
      scopeUnits: (input) => TriageListScopeUnitsInputV1Schema.parse(input).cursor === undefined
        ? { kind: 'page', status: 'partial', selection: { kind: 'all' }, nextCursor: { v: 1, token: 'page-2' },
          units: [{ id: 'unit-1', label: 'First team' }, { id: 'unit-2', label: 'Second team' }, { id: 'unit-3', label: 'Third team' }] }
        : nextPage,
    });
    const page = await mountSettings(harness, {}, surface);
    await pressControl(page, 'Add Workspace to PRs & Issues');
    await act(async () => { await page.press(await page.getByRole('radio', { name: 'Selected…' })); });

    // A disabled Save says what it needs; a page with more to load offers that once.
    await expect(page.getByText('Choose at least one to save.')).resolves.toBeDefined();
    await expect(page.queryByText('More teams may be available')).resolves.toBeUndefined();
    await act(async () => { await page.press(await page.getByRole('checkbox', { name: 'First team' })); });
    await expect(page.getByText('1 selected')).resolves.toBeDefined();
    await act(async () => { await page.press(await page.getByRole('checkbox', { name: 'Second team' })); });
    await act(async () => { await page.press(await page.getByRole('checkbox', { name: 'Third team' })); });
    await expect(page.getByText('This selection can’t be saved. Choose fewer.')).resolves.toBeDefined();
    await expect(page.getByRole('button', { name: 'Save selection', state: { disabled: true } })).resolves.toBeDefined();

    // Loading the next page never replaces or pushes down the units already listed.
    await pressControl(page, 'Load more');
    await expect(page.getByRole('checkbox', { name: 'First team' })).resolves.toBeDefined();
    await expect(page.queryByRole('progressbar', { name: 'Reading teams' })).resolves.toBeUndefined();
    await act(async () => { releaseNextPage({ kind: 'page', status: 'complete', selection: { kind: 'all' },
      units: [{ id: 'unit-4', label: 'Fourth team' }] }); });
    await expect(page.getByRole('checkbox', { name: 'Fourth team' })).resolves.toBeDefined();
    await expect(page.queryByRole('button', { name: 'Load more' })).resolves.toBeUndefined();
  });
  it('configures the native login with source-owned translated copy and no connected-account editor', async () => {
    const nativeBinding = { purpose: PURPOSE, source: 'native', service: { pluginId: PLUGIN_ID, localId: CONNECTED_ACCOUNT_SERVICE_LOCAL_ID } };
    const nativeDraft = { v: 1, binding: nativeBinding, localInstanceKey: 'native-scope', keyStability: 'stable', configuration: { v: 1, token: 'scope:native' }, locator: { v: 1, displayLabel: 'local-user' } };
    const surface = createTriageSourceSettingsSurface({
      pluginId: PLUGIN_ID, listInstancesLocalActionId: LIST_INSTANCES_LOCAL_ACTION_ID,
      connectedAccountServiceLocalId: CONNECTED_ACCOUNT_SERVICE_LOCAL_ID, connectedAccountPurpose: PURPOSE, sourceDisplayName: SOURCE_DISPLAY_NAME,
      nativeLoginLabel: { key: 'example.nativeLogin', fallback: 'Use this machine’s CLI login' },
      nativeAuthenticationFailureLabel: { key: 'example.nativeRepair', fallback: 'Sign in on this machine.' },
    });
    const harness = createHarness({ discovery: { kind: 'complete', candidates: [nativeDraft], failures: [{ binding: nativeBinding, failure: { class: 'authentication', code: 'native-login-unavailable' } }] } });
    const page = await mountSettings(harness, { 'example.nativeLogin': 'Translated machine login', 'example.nativeRepair': 'Translated native repair' }, surface);
    await expect(page.getByText('Translated native repair')).resolves.toBeDefined();
    await pressControl(page, 'Add Translated machine login to PRs & Issues');
    expect(harness.administrations()).toEqual([{ v: 1, kind: 'create', draft: nativeDraft }]);
    await expect(page.queryByRole('button', { name: 'Reconnect' })).resolves.toBeUndefined();
    expect(harness.connectedAccountsRequests).toEqual([]);
  });

  it('opens the canonical Connected Accounts destination for this source', async () => {
    const harness = createHarness({ discovery: { kind: 'complete', candidates: [], failures: [] } });
    const page = await mountSettings(harness);

    await pressControl(page, 'Connect account');

    expect(harness.connectedAccountsRequests).toEqual([{
      service: { pluginId: PLUGIN_ID, localId: CONNECTED_ACCOUNT_SERVICE_LOCAL_ID },
      purpose: { consumer: { pluginId: PLUGIN_ID, localId: LIST_INSTANCES_LOCAL_ACTION_ID }, purpose: PURPOSE },
    }]);
  });

  it('lets a source refine a discovered draft before the canonical page submits it', async () => {
    const original = candidate('acme/api');
    const configured = candidate('acme/api-configured');
    const Editor = (props: TriageSourceSettingsDraftEditorPropsV1) => React.createElement(Button, {
      title: 'Save source-specific configuration',
      onPress: () => { void props.onSubmit(TriageSourceInstanceDraftV1Schema.parse(configured)); },
    });
    const configurableSurface = createTriageSourceSettingsSurface({
      pluginId: PLUGIN_ID,
      listInstancesLocalActionId: LIST_INSTANCES_LOCAL_ACTION_ID,
      connectedAccountServiceLocalId: CONNECTED_ACCOUNT_SERVICE_LOCAL_ID,
      connectedAccountPurpose: PURPOSE,
      sourceDisplayName: SOURCE_DISPLAY_NAME,
      DraftEditor: Editor,
    });
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [original], failures: [] },
    });

    let page!: PluginUiTestkit;
    await act(async () => {
      page = await createPluginUiTestkit({
        identity: { instanceId: 'fixture-instance-2', mountNonce: 'fixture-mount-2' },
        authorPlugin: { id: PLUGIN_ID, version: '0.0.0' },
        surface: configurableSurface,
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: {
          executeAction: async ({ action, input, signal }) => await harness.executeAction({ action, input, signal }),
        },
      });
    });
    mounted.push(page);

    await pressControl(page, 'Add acme/api to PRs & Issues');
    expect(harness.administrations()).toHaveLength(0);
    await pressControl(page, 'Save source-specific configuration');

    expect(harness.administrations()).toEqual([
      expect.objectContaining({
        kind: 'create',
        draft: expect.objectContaining({ localInstanceKey: 'acme/api-configured' }),
      }),
    ]);
  });

  it('seeds each stateful source editor with its own persisted opaque configuration', async () => {
    const Editor = ({ draft, onSubmit }: TriageSourceSettingsDraftEditorPropsV1) => {
      const [configuration] = React.useState(draft.configuration);
      return React.createElement(Button, {
        title: 'Save source-specific configuration',
        onPress: () => { void onSubmit({ ...draft, configuration }); },
      });
    };
    const configurableSurface = createTriageSourceSettingsSurface({
      pluginId: PLUGIN_ID,
      listInstancesLocalActionId: LIST_INSTANCES_LOCAL_ACTION_ID,
      connectedAccountServiceLocalId: CONNECTED_ACCOUNT_SERVICE_LOCAL_ID,
      connectedAccountPurpose: PURPOSE,
      sourceDisplayName: SOURCE_DISPLAY_NAME,
      DraftEditor: Editor,
    });
    const first = TriageSourceInstanceDraftV1Schema.parse(candidate('acme/api'));
    const second = TriageSourceInstanceDraftV1Schema.parse(candidate('acme/tools', 'account-2'));
    const sourceInstanceIds = [INSTANCE_ID, '22222222-2222-4222-8222-222222222222'];
    const records = [first, second].map((draft, index) => ({
      v: 1 as const, lifecycle: 'active', configured: {
        v: 1 as const, binding: draft.binding, localInstanceKey: draft.localInstanceKey,
        configuration: { v: 1 as const, token: `saved:${draft.localInstanceKey}` },
        locator: { v: 1 as const, displayLabel: 'Previous label' },
        instance: { source: { pluginId: PLUGIN_ID, localId: 'tracker' }, sourceInstanceId: sourceInstanceIds[index]! },
      },
    }));
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [first, second], failures: [] },
      configured: { kind: 'read', status: 'complete', instances: records },
      administration: sourceInstanceIds.map((sourceInstanceId) => ({ kind: 'reconfigured', sourceInstanceId })),
    });
    const page = await mountSettings(harness, {}, configurableSurface);
    await pressControl(page, 'Update acme/api from the provider');
    await pressControl(page, 'Save source-specific configuration');
    await pressControl(page, 'Update acme/api from the provider');
    await pressControl(page, 'Update acme/tools from the provider');
    await pressControl(page, 'Save source-specific configuration');
    expect(harness.administrations()).toEqual([first, second].map((draft, index) => ({
      v: 1, kind: 'reconfigure', sourceInstanceId: sourceInstanceIds[index],
      draft: { ...draft, configuration: { v: 1, token: `saved:${draft.localInstanceKey}` } },
    })));
  });

  it('asks the exact source it was handed, and the target for the rest', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
    });
    await mountSettings(harness);

    // The three identity facts are the whole of what a source contributes. A page
    // that enumerated through some other plugin's Action would list scopes the
    // user cannot configure here.
    expect(harness.recorded.map((entry) => entry.action)).toContainEqual({
      pluginId: PLUGIN_ID,
      localId: LIST_INSTANCES_LOCAL_ACTION_ID,
    });
    expect(harness.recorded.map((entry) => entry.action))
      .toContainEqual({ ...TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 });
  });

  it('lists what this source can reach and configures the one the user chose', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText('acme/api')).resolves.toEqual({ content: 'acme/api' });

    await pressControl(page, 'Add acme/api to PRs & Issues');

    // Admitted by the published schema the target itself parses, so a draft this
    // page would send but the target would reject cannot pass here.
    const administrations = harness.administrations();
    expect(administrations).toHaveLength(1);
    expect(administrations[0]).toMatchObject({
      v: 1,
      kind: 'create',
      draft: { binding: binding('account-1'), localInstanceKey: 'acme/api' },
    });
    await expect(page.getByText('Added to PRs & Issues.'))
      .resolves.toEqual({ content: 'Added to PRs & Issues.' });
  });

  it('never asks the target to configure anything merely by opening the page', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
    });
    await mountSettings(harness);

    // Both mount reads are reads. A page that configured a discovered candidate
    // on mount would turn "look at my accounts" into a durable Account write.
    expect(new Set(harness.recorded.map((entry) => (
      (entry.action as Readonly<{ localId?: string }>).localId
    )))).toEqual(new Set([
      LIST_INSTANCES_LOCAL_ACTION_ID,
      TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId,
    ]));
    expect(harness.administrations()).toEqual([]);
  });

  it('knows what an earlier visit configured before the user presses anything', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'active')],
      },
    });
    const page = await mountSettings(harness);

    // This is the remount: nothing was pressed here, and the exact-row arms are
    // reachable anyway because the target itself named the row.
    await expect(page.getByText('In PRs & Issues.')).resolves.toBeDefined();
    await expect(page.queryByRole('button', { name: 'Add acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
    // Update is the row's everyday control; Remove is never a second slab beside it.
    await expect(page.queryByRole('button', { name: 'Remove acme/api from PRs & Issues' }))
      .resolves.toBeUndefined();
    await removeRow(page, 'acme/api');
    expect(harness.administrations()).toEqual([
      { v: 1, kind: 'remove', sourceInstanceId: INSTANCE_ID },
    ]);
  });

  it('reads as a settings page: its accounts and scopes are one titled section', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
    });
    const page = await mountSettings(harness);

    // An untitled group has no sheet and no column: the rows sat flush on the page.
    await expect(page.getByRole('heading', { name: 'Accounts and scopes' })).resolves.toBeDefined();
    await expect(page.getByRole('button', { name: 'Add acme/api to PRs & Issues' })).resolves.toBeDefined();
  });

  it('says a refused read once, in words, and never shows the bare refusal code', async () => {
    const refusal = () => Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
    const harness = createHarness({ discovery: refusal, configured: refusal });
    const page = await mountSettings(harness);

    await expect(page.getByText(`${SOURCE_DISPLAY_NAME} could not be read`)).resolves.toBeDefined();
    await expect(page.queryByText('unavailable')).resolves.toBeUndefined();
    // Both reads failed for one reason; the page says it once, where the rows would be.
    await expect(page.queryByText('What is already configured could not be read')).resolves.toBeUndefined();
  });

  it('restores what an earlier visit removed, under the exact ref the target named', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'retired')],
      },
      administration: [{ kind: 'reactivated', sourceInstanceId: INSTANCE_ID }],
    });
    const page = await mountSettings(harness);

    // A source the user removed must not reappear as a fresh Add: that asks the
    // target to mint a sibling row for one intent, and it refuses with `conflict`.
    await expect(page.queryByRole('button', { name: 'Add acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
    await pressControl(page, 'Restore acme/api to PRs & Issues');

    expect(harness.administrations()).toEqual([
      { v: 1, kind: 'reactivate', sourceInstanceId: INSTANCE_ID, draft: candidate('acme/api') },
    ]);
    await expect(page.getByText('Restored to PRs & Issues.')).resolves.toBeDefined();
  });

  it('lets a Refresh replace what its own presses taught it', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'active')],
      },
      // Another device put it back between the two reads.
      configuredAgain: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'active')],
      },
      administration: [{ kind: 'removed', sourceInstanceId: INSTANCE_ID }],
    });
    const page = await mountSettings(harness);

    await removeRow(page, 'acme/api');
    await expect(page.getByRole('button', { name: 'Restore acme/api to PRs & Issues' }))
      .resolves.toBeDefined();

    await pressControl(page, 'Refresh');

    // The re-read observes these rows after that press committed, so it is the
    // newer fact. A press result kept beside it is how a row that changed on
    // another device keeps showing this page's stale answer.
    await expect(page.getByRole('button', { name: 'More actions for acme/api' }))
      .resolves.toBeDefined();
    await expect(page.queryByRole('button', { name: 'Restore acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
  });

  it('keeps the target answer when a press it made was refused', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'retired')],
      },
      administration: [{ kind: 'currentnessConflict' }],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Restore acme/api to PRs & Issues');

    // A refused press says nothing about what the row is. Recording it as
    // knowledge would drop the row back to Add and lose the only control that can
    // bring the user's own configuration back.
    await expect(page.getByText('Something changed while this was saving. Try again.'))
      .resolves.toBeDefined();
    await expect(page.getByRole('button', { name: 'Restore acme/api to PRs & Issues' }))
      .resolves.toBeDefined();
    await expect(page.queryByRole('button', { name: 'Add acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
  });

  it('shows the account the source itself named alongside the class remedy, not instead of it', async () => {
    const harness = createHarness({
      discovery: {
        kind: 'complete',
        candidates: [candidate('acme/api')],
        failures: [{
          binding: binding('account-2'),
          failure: {
            class: 'permission',
            code: 'scope-not-visible',
            detail: 'acme/private is not visible to this account.',
          },
        }],
      },
    });
    const page = await mountSettings(harness);

    // The source knows WHICH scope failed and this page does not, so its words
    // must survive. But the class sentence carries the REMEDY, and this is the
    // page the reader came to in order to fix the connection — so the two are
    // rendered together. Substituting one for the other drops either the fact
    // the reader can act on or the action they can take.
    await expect(page.getByText(
      'The connected account cannot see this scope. Grant it access at the provider.'
      + ' (acme/private is not visible to this account.)',
    )).resolves.toBeDefined();
    // Neither half renders alone.
    await expect(page.queryByText('acme/private is not visible to this account.'))
      .resolves.toBeUndefined();
  });

  it('renders a declared failure sentence in the reader own language', async () => {
    const harness = createHarness({
      discovery: {
        kind: 'complete',
        candidates: [candidate('acme/api')],
        failures: [{
          binding: binding('account-2'),
          failure: { class: 'authentication', code: 'token-expired' },
        }],
      },
    });
    const page = await mountSettings(harness, {
      'plugins.triage.sourceSettings.failure.authentication':
        'Le compte connecté n’est plus autorisé. Reconnectez-le dans Comptes connectés.',
    });

    await expect(page.getByText('Le compte connecté n’est plus autorisé. Reconnectez-le dans Comptes connectés.'))
      .resolves.toBeDefined();
  });

  it('keeps a configured account it can no longer reach visible and removable', async () => {
    const harness = createHarness({
      discovery: {
        kind: 'complete',
        candidates: [],
        failures: [{
          binding: binding('account-1'),
          failure: { class: 'authentication', code: 'provider-token-expired' },
        }],
      },
      configured: {
        kind: 'read',
        status: 'complete',
        instances: [configuredRecord('acme/api', 'active')],
      },
      administration: [{ kind: 'removed', sourceInstanceId: INSTANCE_ID }],
    });
    const page = await mountSettings(harness);

    // A disconnected account stops producing candidates. The configured instance
    // is still real, still in the product, and still the user's to remove — so it
    // gets an unusable state and the one arm that does not need a fresh draft.
    await expect(page.getByText(
      `In PRs & Issues, but ${SOURCE_DISPLAY_NAME} can no longer reach it. Its entries stop arriving until the account or scope comes back.`,
    )).resolves.toBeDefined();
    await expect(page.queryByRole('button', { name: 'Update acme/api from the provider' }))
      .resolves.toBeUndefined();
    await removeRow(page, 'acme/api');
    expect(harness.administrations()).toEqual([
      { v: 1, kind: 'remove', sourceInstanceId: INSTANCE_ID },
    ]);
  });

  it('says it could not read what is configured instead of silently offering Add', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      configured: { kind: 'currentnessConflict' },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText('This page read while something was changing'))
      .resolves.toBeDefined();
    // Add stays available — the target refuses a duplicate safely — but the page
    // never implies that nothing is configured.
    await expect(page.getByRole('button', { name: 'Add acme/api to PRs & Issues' }))
      .resolves.toBeDefined();
  });

  it('offers no exact-row control until the target has named the row', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
    });
    const page = await mountSettings(harness);

    // Remove, Update and Restore each name one exact configured row. The target's
    // read named none here, so offering any of them would be a control that
    // cannot be honoured.
    await expect(page.queryByRole('button', { name: 'More actions for acme/api' }))
      .resolves.toBeUndefined();
    await expect(page.queryByRole('button', { name: 'Update acme/api from the provider' }))
      .resolves.toBeUndefined();
    await expect(page.queryByRole('button', { name: 'Restore acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
  });

  it('takes a configured source back out again, and can bring it back', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      administration: [
        { kind: 'active', sourceInstanceId: INSTANCE_ID },
        { kind: 'reconfigured', sourceInstanceId: INSTANCE_ID },
        { kind: 'removed', sourceInstanceId: INSTANCE_ID },
        { kind: 'reactivated', sourceInstanceId: INSTANCE_ID },
      ],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Add acme/api to PRs & Issues');
    await pressControl(page, 'Update acme/api from the provider');
    await removeRow(page, 'acme/api');

    // Removal says exactly what it costs. Entries are a projection of what the
    // source can still see, so they go; a pin and a Session link are the user's
    // own state and outlive the configured row.
    await expect(page.getByText(
      'Removed from PRs & Issues. Its entries leave the list; the pins and Session links you made stay.',
    )).resolves.toBeDefined();

    // Restore is the only arm that may revive a retired row, and it names that
    // row's exact stable ref rather than asking for a second one.
    await pressControl(page, 'Restore acme/api to PRs & Issues');
    await expect(page.getByText('Restored to PRs & Issues.')).resolves.toBeDefined();

    expect(harness.administrations().map((input) => {
      const arm = input as Readonly<{ kind: string; sourceInstanceId?: string }>;
      return [arm.kind, arm.sourceInstanceId ?? null];
    })).toEqual([
      ['create', null],
      ['reconfigure', INSTANCE_ID],
      ['remove', INSTANCE_ID],
      ['reactivate', INSTANCE_ID],
    ]);
  });

  it('never turns a create the target refused into a silent revival', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      administration: [{ kind: 'conflict' }],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Add acme/api to PRs & Issues');

    // A conflict is a retired row this page cannot see. Retrying as reactivate
    // would be this surface deciding a lifecycle the target refused.
    await expect(page.getByText('You removed this earlier. This page cannot bring it back yet.'))
      .resolves.toBeDefined();
    expect(harness.administrations().map((input) => (input as Readonly<{ kind: string }>).kind))
      .toEqual(['create']);
    await expect(page.queryByRole('button', { name: 'Restore acme/api to PRs & Issues' }))
      .resolves.toBeUndefined();
  });

  it('says the list may be short instead of rendering an incomplete listing as the whole truth', async () => {
    const harness = createHarness({
      discovery: {
        kind: 'incomplete',
        candidates: [candidate('acme/api')],
        failures: [],
        failure: { class: 'rateLimit', code: 'provider-secondary-rate-limit' },
      },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText('This list may be incomplete'))
      .resolves.toEqual({ content: 'This list may be incomplete' });
    await expect(page.getByText('acme/api')).resolves.toEqual({ content: 'acme/api' });
  });

  it('names the account that stopped working rather than dropping it from the page', async () => {
    const harness = createHarness({
      discovery: {
        kind: 'complete',
        candidates: [],
        failures: [{
          binding: binding('account-2'),
          localInstanceKey: 'acme/legacy',
          failure: { class: 'authentication', code: 'provider-token-expired' },
        }],
      },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText('acme/legacy')).resolves.toEqual({ content: 'acme/legacy' });
    await expect(page.getByText(
      'The connected account is no longer authorized. Reconnect it in Connected Accounts.',
    )).resolves.toBeDefined();
  });

  it('reports a source that could not be reached rather than an empty list', async () => {
    const harness = createHarness({
      discovery: { kind: 'failed', failure: { class: 'transient', code: 'provider-unreachable' } },
    });
    const page = await mountSettings(harness);

    await expect(page.getByText(`${SOURCE_DISPLAY_NAME} could not be read`))
      .resolves.toEqual({ content: `${SOURCE_DISPLAY_NAME} could not be read` });
    await expect(page.queryByText(`No ${SOURCE_DISPLAY_NAME} scopes to add`)).resolves.toBeUndefined();
  });

  it('cancels held discovery when the host withdraws it and ignores its late answer', async () => {
    let sourceSignal: AbortSignal | undefined;
    let resolveLate: ((result: JsonValue) => void) | undefined;
    const harness = createHarness({
      discovery: async (signal) => await new Promise<JsonValue>((resolve) => {
        sourceSignal = signal;
        resolveLate = resolve;
      }),
    });
    const page = await mountSettings(harness);
    expect(sourceSignal?.aborted).toBe(false);
    await act(async () => {
      await page.updateSurface(createSurfaceContextFixture({
        requesterExecutionReady: false, machineConnectionPending: true, machineExecutionReady: false,
      }));
    });
    expect(sourceSignal?.aborted).toBe(true);

    await act(async () => {
      resolveLate?.({ kind: 'complete', candidates: [candidate('acme/api')], failures: [] });
      await Promise.resolve();
    });
    await expect(page.getByText('This read did not finish')).resolves.toBeDefined();
    await expect(page.queryByText('acme/api')).resolves.toBeUndefined();
  });

  it('tells the user a source the host no longer admits cannot be configured', async () => {
    const harness = createHarness({
      discovery: { kind: 'complete', candidates: [candidate('acme/api')], failures: [] },
      administration: [{ kind: 'invalidCaller' }],
    });
    const page = await mountSettings(harness);

    await pressControl(page, 'Add acme/api to PRs & Issues');

    await expect(page.getByText(
      `${SOURCE_DISPLAY_NAME} is no longer an admitted PRs & Issues source on this account.`,
    )).resolves.toBeDefined();
  });
});
