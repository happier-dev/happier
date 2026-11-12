import { readPluginTranslationResources } from '../../../../scripts/testing/readPluginTranslationResources.js';

import { readFileSync } from 'node:fs';
import { TRIAGE_DISPLAY_NAME } from './displayName.js';

import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginActionPresentUserGate } from '@happier-dev/protocol';
import { checkTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import { PLUGIN_MANIFEST as GITHUB_MANIFEST, GITHUB_TRIAGE_ACTION_IDS_V1 } from '../../scm-github/src/manifest.js';
import { GITHUB_FILE_VIEWED_ACTION_IDS_V1 } from '../../scm-github/src/triage/fileViewedContracts.js';
import { PLUGIN_MANIFEST as CHANNELS_MANIFEST } from '../../channels/src/manifest.js';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  PLUGIN_MANIFEST,
  TRIAGE_PLUGIN,
  TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
} from './manifest.js';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 } from './actions/listEntriesProtocol.js';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 } from './actions/sessionLinksProtocol.js';
import {
  TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
  TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
  TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
} from './actions/entrySessionProtocol.js';
import { TRIAGE_TASKS_LINK_ACTION_LOCAL_ID_V1 } from './actions/tasksProtocol.js';
import { TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1 } from './actions/savedViewsProtocol.js';
import { TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1 } from './actions/actionsCatalogProtocol.js';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, TriageMountedUiInputV1Schema } from './actions/mountedUiProtocol.js';
import { TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1 } from './composer/attachmentValue.js';
import { createTestkitCorpusCollections } from './corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from './corpus/testkit/observations.test-support.js';
import { createTriageSetEntryPinnedActionHandler, listTriagePinnedEntries } from './actions/userMarks.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from './internalTasks/configuration.js';

const PACKAGED_UI_TRANSLATIONS = readPluginTranslationResources(new URL('../', import.meta.url));

describe('Triage plugin manifest', () => {
  it('conforms to the public source contract for its built-in task source', () => {
    const result = checkTriageSourceContributionV1(PLUGIN_MANIFEST);
    expect(result.ok, result.ok ? undefined : result.errors.join('\n')).toBe(true);
  });
  it('runs reversible present-user edits directly while preserving explicit Ask and automated defaults', async () => {
    // SIMPLIFY-CHALLENGE-1106 #5/M1 changes the default, never a person's Ask preference.
    for (const id of [TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1, TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
      TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_LINK_ACTION_LOCAL_ID_V1,
      TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1, TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1]) {
      const action = PLUGIN_MANIFEST.contributes.actions.find(entry => entry.id === id);
      if (!action) throw new Error(`Missing reversible Action: ${id}`);
      const gate = (ask = false) => createPluginActionPresentUserGate({ resolve: () => ({ status: 'resolved', action,
        policy: { qualifiedId: `${PLUGIN_MANIFEST.id}/${id}`, occurrenceId: 'triage-edit-occurrence',
          dangerLevel: action.dangerLevel, confirmation: action.confirmation, confirmationWhen: action.confirmationWhen,
          scopes: action.scopes, surfaces: action.surfaces,
          ...(ask ? { approvalRequiredByActionSettings: true } : {}),
          authorization: { generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' },
            resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } },
      }) });
      const input = id === TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1 ? { kind: 'saveDefaults' } : {};
      expect(await gate().admit({ surface: 'ui', invocationSurface: 'ui', invocationAuthority: 'present_user', input }), id)
        .toMatchObject({ status: 'admitted' });
      expect(await gate(true).admit({ surface: 'ui', invocationSurface: 'ui', invocationAuthority: 'present_user', input }), `${id} explicit Ask`)
        .toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
      for (const surface of ['agent', 'mcp']) {
        expect(await gate().admit({ surface, invocationSurface: surface, input: {} }), `${id} ${surface}`)
          .toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
      }
    }
  });
  it('runs reversible personal PR state directly through the shared approval owner, retaining explicit Ask', async () => {
    const cases = [
      { manifest: PLUGIN_MANIFEST, id: TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, input: { sessionId: 'session-a' }, asks: [] as string[] },
      { manifest: PLUGIN_MANIFEST, id: TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1, input: { sessionId: 'session-a' }, asks: [] as string[] },
      ...[true, false].map(linked => ({ manifest: GITHUB_MANIFEST,
        id: GITHUB_TRIAGE_ACTION_IDS_V1.linkSession, input: { sessionId: 'session-a', linked }, asks: [] as string[] })),
      ...[true, false].map(viewed => ({ manifest: GITHUB_MANIFEST,
        id: GITHUB_FILE_VIEWED_ACTION_IDS_V1.set, input: { viewed }, asks: [] as string[] })),
      ...['attach', 'unlink'].map(kind => ({ manifest: CHANNELS_MANIFEST,
        id: 'session-pull-request-binding-v1', input: { sessionId: 'session-a', kind }, asks: [] as string[] })),
      { manifest: CHANNELS_MANIFEST, id: 'session-pull-request-binding-v1',
        input: { sessionId: 'session-a', kind: 'attach', target: { automationId: 'automation-a' } }, asks: ['ui', 'agent', 'mcp'] },
      { manifest: CHANNELS_MANIFEST, id: 'session-pull-request-binding-v1',
        input: { sessionId: 'session-a', kind: 'removeTrigger' }, asks: ['ui', 'cli', 'agent', 'mcp'] },
    ];
    for (const { manifest, id, input, asks } of cases) {
      const action = manifest.contributes.actions?.find(entry => entry.id === id);
      if (!action) throw new Error(`Missing relationship Action: ${manifest.id}/${id}`);
      const gate = (ask = false) => createPluginActionPresentUserGate({ resolve: () => ({ status: 'resolved', action,
        policy: { qualifiedId: `${manifest.id}/${id}`, occurrenceId: 'link-direct-occurrence',
          dangerLevel: action.dangerLevel, confirmation: action.confirmation, confirmationWhen: action.confirmationWhen,
          scopes: action.scopes, surfaces: action.surfaces,
          ...(ask ? { approvalRequiredByActionSettings: true } : {}),
          authorization: { generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' },
            resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } },
      }) });
      for (const surface of ['ui', 'cli', 'agent', 'mcp']) {
        // Nested Account Actions retain automation authority, even with a physical UI origin.
        const outerTriageAction = manifest.id === PLUGIN_MANIFEST.id;
        expect(await gate().admit({ surface, invocationSurface: surface,
          invocationAuthority: outerTriageAction && surface === 'ui' ? 'present_user' : 'account_automation', input }),
          `${manifest.id}/${id} ${surface} ${JSON.stringify(input)}`).toMatchObject(asks.includes(surface)
            ? { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' } : { status: 'admitted' });
        expect(await gate(true).admit({ surface, invocationSurface: surface, input }), `${manifest.id}/${id} explicit Ask`)
          .toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
      }
    }
  });
  it('admits personal Account task writes directly by their declared defaults', async () => {
    for (const id of ['tasks/create-v1', 'tasks/edit-v1', 'tasks/transition-v1',
      'internal/tasks/create-v1', 'internal/tasks/edit-v1', 'internal/tasks/transition-v1', 'internal/tasks/link-session-v1']) {
      const action = PLUGIN_MANIFEST.contributes.actions.find(entry => entry.id === id)!;
      const gate = (ask = false) => createPluginActionPresentUserGate({ resolve: () => ({ status: 'resolved', action,
        policy: { qualifiedId: `${PLUGIN_MANIFEST.id}/${id}`, occurrenceId: 'triage-occurrence',
          dangerLevel: action.dangerLevel, confirmation: action.confirmation, confirmationWhen: action.confirmationWhen,
          scopes: action.scopes, surfaces: action.surfaces,
          ...(ask ? { approvalRequiredByActionSettings: true } : {}),
          authorization: { generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' },
            resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } },
      }) });
      const input = { v: 1, instance: INTERNAL_TASK_SOURCE_RECORD_V1.value.configured };
      for (const surface of ['ui', 'agent', 'mcp', 'cli']) {
        expect(await gate().admit({ surface, invocationSurface: surface, input }), id)
          .toMatchObject({ status: 'admitted' });
        expect(await gate(true).admit({ surface, invocationSurface: surface, input }), `${id} explicit Ask`)
          .toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
      }
    }
  });
  it('keeps outward GitHub Action defaults at Ask', async () => {
    const actions = GITHUB_MANIFEST.contributes.actions.filter(action => action.dangerLevel === 'writesRemote'
      && action.surfaces.includes('ui') && action.id !== GITHUB_FILE_VIEWED_ACTION_IDS_V1.set);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      const gate = createPluginActionPresentUserGate({ resolve: () => ({ status: 'resolved', action,
        policy: { qualifiedId: `${GITHUB_MANIFEST.id}/${action.id}`, occurrenceId: 'github-occurrence',
          dangerLevel: action.dangerLevel, confirmation: action.confirmation, confirmationWhen: action.confirmationWhen,
          scopes: action.scopes, surfaces: action.surfaces,
          authorization: { generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' },
            resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } },
      }) });
      expect(await gate.admit({ surface: 'ui', invocationSurface: 'ui', input: {} }), action.id)
        .toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
    }
  });
  it('admits the owning Resource plugin surface to the shared relation read', async () => {
    const action = PLUGIN_MANIFEST.contributes.actions.find(entry => entry.id === 'sessions/read-source-links-v1');
    if (!action) throw new Error('Relation read must be declared');
    const gate = createPluginActionPresentUserGate({ resolve: () => ({ status: 'resolved', action,
      policy: { qualifiedId: `${PLUGIN_MANIFEST.id}/${action.id}`, occurrenceId: 'triage-occurrence',
        dangerLevel: action.dangerLevel, scopes: action.scopes, surfaces: action.surfaces,
        authorization: { generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' },
          resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } },
    }) });
    expect(await gate.admit({ surface: 'plugin', invocationSurface: 'plugin', input: { v: 1, sessionId: 'session-a' } }))
      .toMatchObject({ status: 'admitted' });
  });
  it('declares the Session relation read operand for host admission and Machine source placement', () => {
    const action = PLUGIN_MANIFEST.contributes.actions.find(entry => entry.id === 'sessions/read-source-links-v1');
    expect(action).toMatchObject({ sessionTarget: { field: 'sessionId', cardinality: 'one' } });
  });
  it('admits the shared Session PR Resource and its native read on the portable Account owner', () => {
    expect(PLUGIN_MANIFEST.contributes.resources.find(resource => resource.id === 'session-pull-request-status-v1'))
      .toMatchObject({ source: 'dynamic', scope: 'session', contentType: 'application/json',
        execution: { target: 'account', account: { artifactId: 'triage-account-runtime', exportName: 'activate' } } });
    expect(PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'entries/read-pull-request-status-v1'))
      .toMatchObject({ readOnly: true,
        execution: { target: 'account', account: { artifactId: 'triage-account-runtime', exportName: 'activate' } } });
  });
  it('places aggregate and personal task operations on the portable Account artifact', () => {
    const dataActions = [
      'tasks/list-v1', 'tasks/create-v1', 'tasks/edit-v1', 'tasks/transition-v1',
      TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, 'entries/read-detail-v1',
      'internal/tasks/configure-v1', 'internal/tasks/list-instances-v1',
      'internal/tasks/scan-v1', 'internal/tasks/get-v1', 'internal/tasks/create-v1',
      'internal/tasks/edit-v1', 'internal/tasks/transition-v1',
    ];
    for (const id of dataActions) {
      expect(PLUGIN_MANIFEST.contributes.actions.find(action => action.id === id), id).toMatchObject({
        execution: { target: 'account', account: { artifactId: 'triage-account-runtime', exportName: 'activate' } },
      });
    }
  });
  it('contributes one rail destination and keeps the old Tasks entrance contextual with /task through its create Action', () => {
    const pages = PLUGIN_MANIFEST.contributes.ui.views.filter((view) => view.container === 'appPage');
    expect(pages.filter((view) => view.placement?.kind === 'rail').map((view) => view.id)).toEqual(['triage']);
    const tasks = pages.find((view) => view.id === 'tasks');
    expect(tasks).toMatchObject({ container: 'appPage', renderer: 'tasks-page' });
    expect(tasks?.placement).toBeUndefined();
    const page = pages.find((view) => view.id === 'triage');
    expect(page).toMatchObject({ icon: 'change-open', placement: { kind: 'rail' } });
    expect(page).not.toHaveProperty('column');
    expect(PLUGIN_MANIFEST.contributes.ui.renderers.map((renderer) => renderer.id)).not.toContain('views-column');
    expect(PLUGIN_MANIFEST.contributes.actions.find((action) => action.id === 'tasks/open-create-v1')).toMatchObject({
      slash: { tokens: ['/task'] }, surfaces: expect.arrayContaining(['ui', 'voice', 'agent', 'mcp', 'cli']),
      // Session slash discovery selects session scope; a global-only declaration is unreachable there.
      scopes: expect.arrayContaining(['global', 'session', 'message']),
      placementBindings: expect.arrayContaining(['composer.slash', 'commandPalette', 'message.menu']),
    });
  });
  it.each([
    { kind: 'selectLinkedSession', sessionId: 'linked-session' },
    { kind: 'setGroupExpanded', group: 'completed', expanded: true },
  ])('keeps $kind requestable on the incumbent mounted client Action', async (operation) => {
    const action = PLUGIN_MANIFEST.contributes.actions.find((entry) => entry.id === TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1);
    if (!action) throw new Error('Mounted action must be declared');
    expect(action.surfaces).toEqual(expect.arrayContaining(['ui', 'agent', 'mcp', 'cli']));
    expect(action.execution).toMatchObject({ target: 'client', client: { exportName: 'activate' } });
    const input = TriageMountedUiInputV1Schema.parse({ mountId: 'active-detail', operation });
    const gate = createPluginActionPresentUserGate({ resolve: () => ({ status: 'resolved', action,
      policy: { qualifiedId: `${PLUGIN_MANIFEST.id}/${action.id}`, occurrenceId: 'triage-occurrence',
        dangerLevel: action.dangerLevel, scopes: action.scopes, surfaces: action.surfaces,
        authorization: { generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' },
          resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } },
    }) });
    expect(await gate.admit({ surface: 'agent', invocationSurface: 'agent', input })).toMatchObject({ status: 'admitted' });
  });
  it('declares its qualified entry source and Session link target through the public families', () => {
    expect(PLUGIN_MANIFEST.contributes).toHaveProperty('dragSources', [expect.objectContaining({
      id: 'entry-reference', client: { artifactId: 'triage-entity-drag-drop-native', exportName: 'activate' },
    })]);
    expect(PLUGIN_MANIFEST.contributes).toHaveProperty('dropTargets', expect.arrayContaining([expect.objectContaining({
      id: 'entry-session', acceptedKinds: ['session'],
      actions: [{ kind: 'plugin', action: 'sessions/link-entry-v1' }],
    })]));
  });
  it('admits an agent pin through the shared gate and writes the same canonical mark', async () => {
    const action = PLUGIN_MANIFEST.contributes.actions.find((entry) => entry.id === 'marks/set-pinned-v1');
    if (!action) throw new Error('Pin action must be declared');
    const gate = createPluginActionPresentUserGate({ resolve: () => ({
      status: 'resolved', action,
      policy: {
        qualifiedId: `${PLUGIN_MANIFEST.id}/${action.id}`, occurrenceId: 'triage-occurrence',
        dangerLevel: action.dangerLevel, scopes: action.scopes, surfaces: action.surfaces,
        authorization: {
          generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' },
          resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [],
        },
      },
    }) });
    expect(await gate.admit({ surface: 'agent', invocationSurface: 'agent', input: {} }))
      .toMatchObject({ status: 'admitted' });
    const { collections } = createTestkitCorpusCollections();
    const entryRef = testkitEntryRef();
    // Only Account storage is substituted at the host boundary; real mark logic runs.
    const context = {
      surface: 'agent', signal: new AbortController().signal,
      services: { storage: { account: { collection: () => collections.userMarks } } },
    } as unknown as PluginInvocationContext;
    expect(await createTriageSetEntryPinnedActionHandler()({ v: 1, entryRef, pinned: true,
      displayAtMark: { title: 'Agent-pinned entry', scopeLabel: 'example/repository' },
    }, context)).toEqual({ v: 1, status: 'pinned' });
    const read = await listTriagePinnedEntries({ v: 1, limit: 10 }, { collections, nowMs: () => 1 });
    expect(read.pins.map((pin) => pin.entryRef)).toEqual([entryRef]);
  });

  it('admits every public Triage action on the centrally authorized agent, MCP and CLI surfaces', () => {
    for (const action of PLUGIN_MANIFEST.contributes.actions.filter(action => !action.surfaces.every(surface => surface === 'plugin'))) {
      expect(action.surfaces, action.id).toEqual(expect.arrayContaining(['agent', 'mcp', 'cli']));
    }
  });
  it('offers mounted UI a safe exact-entry PR-status read without a global affordance', () => {
    expect(PLUGIN_MANIFEST.contributes.actions.find((action) => action.id === 'entries/read-pull-request-status-v1'))
      .toMatchObject({ dangerLevel: 'safe', surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'], placementBindings: [], hostAccess: ['account-storage'] });
  });
  it('projects its prior cold identity and declared contribution families through one definePlugin value', () => {
    const normalized = parsePluginManifest(TRIAGE_PLUGIN.manifest);

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error('Expected the Triage definePlugin manifest to normalize');
    expect(TRIAGE_PLUGIN.manifest).toBe(PLUGIN_MANIFEST);
    expect({
      id: normalized.manifest.id,
      version: normalized.manifest.version,
      entrypoints: normalized.manifest.entrypoints,
    }).toEqual({
      id: 'happier.triage',
      version: '0.0.0',
      entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
    });
    expect(Object.keys(TRIAGE_PLUGIN.manifest.contributes).sort()).toEqual([
      'accountCollections',
      'actions',
      'backgroundServices',
      'composerAttachments',
      'composerControls',
      'composerRegions',
      'dragSources',
      'dropTargets',
      'inputTypes',
      'notifications',
      'pluginContributionPoints',
      'resources',
      'searchProviders',
      'targetedPluginContributions',
      'ui',
      'workItems',
    ]);
  });

  it('keeps Protocol test-only because production uses public SDK and feature protocol owners', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{
      dependencies?: Readonly<Record<string, string>>;
      devDependencies?: Readonly<Record<string, string>>;
    }>;

    expect(packageJson.dependencies?.['@happier-dev/protocol']).toBeUndefined();
    expect(packageJson.devDependencies?.['@happier-dev/protocol']).toBe('0.0.0');
  });

  it('is admitted by the canonical public manifest parser', () => {
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    expect(parsed.ok ? null : parsed.diagnostics).toBe(null);
  });

  it('declares its Home latest widget as shown by default', () => {
    expect(PLUGIN_MANIFEST.contributes.ui.views).toContainEqual(expect.objectContaining({
      id: 'latest',
      container: 'widget',
      target: { kind: 'app' },
      renderer: 'latest-widget',
      home: { default: 'shown' },
    }));
    expect(PLUGIN_MANIFEST.contributes.ui.renderers).toContainEqual(expect.objectContaining({
      id: 'latest-widget',
      artifact: 'triage-latest-widget-native',
    }));
  });

  it('retains confirmation copy for durable local mutations when approval is required', () => {
    const nonSafeActions = PLUGIN_MANIFEST.contributes.actions
      .filter((action) => action.dangerLevel !== 'safe');

    expect(nonSafeActions.length).toBeGreaterThan(0);
    for (const action of nonSafeActions) {
      expect(action.confirmation, action.id).toMatchObject({
        title: expect.anything(),
        body: expect.anything(),
        confirmLabel: expect.anything(),
      });
    }
  });

  it('keeps mounted UI Actions out of global placement discovery', () => {
    const uiActions = PLUGIN_MANIFEST.contributes.actions
      .filter((action) => action.surfaces.includes('ui'));

    expect(uiActions.length).toBeGreaterThan(0);
    // The explicit empty list is the canonical mounted-only declaration: the
    // definePlugin projection preserves it on the wire, and the host admits it
    // while global placement discovery reads no destination from it.
    for (const action of uiActions.filter((action) => action.id !== 'tasks/open-create-v1')) {
      expect(action, action.id).toMatchObject({ placementBindings: [] });
    }
  });

  it('declares the persisted identity that source contributions target', () => {
    // The plugin id is the persisted connected-account, contribution and
    // Collection-row key, so it is asserted as an exact literal rather than
    // read back from the manifest. It must also equal the protocol-published
    // target id: a mismatch aims every source contribution at no plugin.
    expect(PLUGIN_MANIFEST.id).toBe('happier.triage');
    expect(PLUGIN_MANIFEST.id).toBe(TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1);
  });

  it('declares the one target-owned V1 source contribution point', () => {
    const expectedPoint = {
      id: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
      maxContributionsPerContributor: 1,
      protocols: [{
        id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
        version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
      }],
    };

    const sourcePoints = PLUGIN_MANIFEST.contributes.pluginContributionPoints
      .filter(point => point.id === TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1);
    expect(sourcePoints).toHaveLength(1);
    expect(sourcePoints[0]).toMatchObject(expectedPoint);
    // The public target reference may also carry the Protocol-owned semantic
    // decoder. This assertion owns only the stable routing identity.
    expect(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1).toMatchObject({
      targetPluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
      id: expectedPoint.id,
      protocol: expectedPoint.protocols[0],
    });
  });

  it('offers the entries control only in the scopes that can carry an attachment', () => {
    // `core/COMPOSER.md` §1 fixes the set. The host reads an ABSENT `scopes` as
    // EVERY scope (`pluginContributedActionComposerChips.tsx`
    // `qualifiesForComposerScope`), so leaving it undeclared is not "no policy
    // yet" — it is the widest possible one. `automationAuthoring` has no
    // Message-attachment capability at all, so the control would open a picker
    // whose attachment nothing could ever hold; `participantMessage` has no
    // approved V1 journey.
    const control = PLUGIN_MANIFEST.contributes.composerControls?.find(
      (candidate) => candidate.id === TRIAGE_ENTRIES_CONTROL_LOCAL_ID_V1,
    );

    expect(control?.scopes).toEqual(['session', 'newSession', 'pendingMessage']);
  });

  it('names the product, not the program, everywhere a user can read it', () => {
    expect(PLUGIN_MANIFEST.displayName).toBe(TRIAGE_DISPLAY_NAME);
    expect(`${PLUGIN_MANIFEST.displayName} ${PLUGIN_MANIFEST.description}`).not.toMatch(/triage/iu);
  });

  it('carries the daemon entrypoint the bundled activation source resolves', () => {
    // The canonical packager (`scripts/migrations/extensions/generateBundledPluginEntries.ts`)
    // emits the daemon runtime at `.happier-plugin-build/daemon.js` and the release
    // contract pins that exact path
    // (`scripts/release/publish_cli_binaries_native_matrix.contract.test.mjs`).
    // `./dist/index.js` is the retired pre-packager entry: it is this package's
    // `main` for in-repo importers, not the path the host loads.
    expect(PLUGIN_MANIFEST.entrypoints.daemon).toBe('./.happier-plugin-build/daemon.js');
  });

  it('offers one existing safe list read to Voice through its canonical Account Action', () => {
    const action = PLUGIN_MANIFEST.contributes.actions.find(
      (candidate) => candidate.id === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    );

    // Voice shares the same bounded read and source admission owner.
    expect(action).toMatchObject({
      id: TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
      surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli'],
      execution: { target: 'account', account: { artifactId: 'triage-account-runtime', exportName: 'activate' } },
    });
  });

  it('declares localized Voice Action presentation in every shipped Triage bundle', () => {
    const action = PLUGIN_MANIFEST.contributes.actions.find(
      (candidate) => candidate.id === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    );

    expect(action).toMatchObject({
      title: {
        key: 'plugins.triage.action.listEntries.title',
        fallback: 'Read the current list window',
      },
      description: {
        key: 'plugins.triage.action.listEntries.description',
        fallback: 'Reads one bounded ordered window of pull requests, issues and error groups from the configured sources.',
      },
    });
    for (const messages of Object.values(PACKAGED_UI_TRANSLATIONS)) {
      expect(messages['plugins.triage.action.listEntries.title']).toEqual(expect.any(String));
      expect(messages['plugins.triage.action.listEntries.description']).toEqual(expect.any(String));
    }
  });

  it('requires current-context publication only for the list-page renderer', () => {
    const renderers = PLUGIN_MANIFEST.contributes.ui?.renderers ?? [];
    const listPage = renderers.find((candidate) => candidate.id === 'list-page');

    expect(listPage?.requiredHostMethods).toEqual([
      'executeAction',
      'publishCurrentUiContext',
    ]);
    expect(renderers
      .filter((candidate) => candidate.id !== 'list-page' && candidate.id !== 'tasks-page')
      .some((candidate) => candidate.requiredHostMethods?.includes('publishCurrentUiContext')))
      .toBe(false);
  });
});
