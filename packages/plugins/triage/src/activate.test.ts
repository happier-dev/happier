import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue, PluginServices, PluginInvocationContext, PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { SessionIdSchema, SessionStatusActionResultV1Schema } from '@happier-dev/plugin-sdk/sessions';
import type { StorageService } from '@happier-dev/plugin-sdk/storage';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import {
  TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1,
  TriageEntryRefV1Schema,
  TriageSetFixPullRequestResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TriageDataActionContext } from './actions/dataContext.js';

import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesResultV1Schema } from './actions/listEntriesProtocol.js';
import {
  TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
  TriageSetEntryPinnedResultV1Schema,
  TriageListPinnedEntriesResultV1Schema,
} from './actions/userMarksProtocol.js';
import {
  TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
  TriageAdministerSavedViewResultV1Schema,
  TriageReadSavedViewsResultV1Schema,
  TriageSavedViewsCatalogValueV1Schema,
} from './actions/savedViewsProtocol.js';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN } from './manifest.js';
import { activate } from './activate.js';
import { activate as activateAccount } from './accountRuntime.js';
import { CORPUS_USER_MARKS_COLLECTION } from './corpus/collections/definitions.js';
import {
  CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
  CORPUS_SESSION_LINKS_COLLECTION_ID,
  CORPUS_USER_MARKS_INDEX_ID,
} from './corpus/collections/ids.js';
import { administerConfiguredSourceInstance, findConfiguredSourceInstanceRow } from './corpus/configuration/administerConfiguredSourceInstance.js';
import { createTestkitCorpusCollections } from './corpus/testkit/corpusCollections.test-support.js';
import { createTestkitAccountKv } from './settings/testkit/accountKv.test-support.js';
import { TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 } from './settings/savedViews.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from './projection/listWindow.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, TRIAGE_DEFAULT_ACTIONS_V1, planTriageOfferedActionsV1 } from './settings/actions.js';
import { TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
  TriageReadActionsResultV1Schema, TriageAdministerActionResultV1Schema } from './actions/actionsCatalogProtocol.js';
import { createDirectTriageActionsTransport, readTriageActionsProjectionV1 } from './ui/actions/actionsCommand.js';
import { readTriageSessionHandoffChoicesV1, type TriageSessionHandoffHostV1 } from '@happier-dev/triage-sources/runtime';
import { TRIAGE_DEFAULT_FIX_ACTION_ID_V1, TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1 } from '@happier-dev/triage-protocol/v1';
import { buildAgentTargetKeyV2 } from '@happier-dev/plugin-sdk/agents';
import { runTriageConfiguredHandoffV1 } from './sessions/configuredActionRun.js';
import { createTestkitActionInvoker, spawnSuccess, testkitReadOnlySourceSnapshot, TESTKIT_LINK_DISPLAY } from './sessions/testkit/entrySessionTestkit.test-support.js';
import { PLUGIN_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol';
import { TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, TriageReadSourceSessionLinksActionResultV1Schema } from './actions/sessionLinksProtocol.js';
import { linkEntryToSession } from './sessions/entrySessionLinks.js';
import { testkitEntryRef } from './corpus/testkit/observations.test-support.js';

async function withRegisteredPlugin(run: (fixture: Readonly<{
  plugin: PluginTestkit;
  corpus: ReturnType<typeof createTestkitCorpusCollections>;
  kv: ReturnType<typeof createTestkitAccountKv>;
}>) => Promise<void>, module: Parameters<typeof createPluginTestkit>[0]['module'] = TRIAGE_PLUGIN) {
  const corpus = createTestkitCorpusCollections();
  const kv = createTestkitAccountKv();
  // Account storage is the network/database boundary. The existing testkits
  // retain real collection schema validation, identity derivation and CAS.
  const storage = { account: {
    kv: kv.kv,
    collection: (definition: { id: string }) => {
      if (definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID) return corpus.collections.sourceInstances;
      if (definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID) return corpus.collections.sessionLinks;
      if (definition.id === CORPUS_USER_MARKS_COLLECTION.id) return corpus.collections.userMarks;
      throw new Error(`Unexpected collection ${definition.id}`);
    },
  } } as unknown as StorageService;
  let plugin!: PluginTestkit;
  // The SDK produces this empty admitted snapshot from the real declarations;
  // the subscription adapter models only the plugin-to-host service boundary.
  const targetedContributions = { observeForSelf: (point: Parameters<PluginTestkit['readTargetedContributionFixture']>[0]) => ({
    readCurrent: async () => plugin.readTargetedContributionFixture(point),
    dispose: () => {},
  }) } as unknown as PluginServices['targetedContributions'];
  plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module, services: { storage, targetedContributions } });
  try {
    await run({ plugin, corpus, kv });
  } finally {
    await plugin.dispose();
  }
}

describe('Triage activation', () => {
  it.each(['agent', 'mcp', 'cli'] as const)('returns own-Session links through the declared portable %s Action', async surface => {
    await withRegisteredPlugin(async ({ plugin, corpus }) => {
      const sessionId = SessionIdSchema.parse('source-links-session');
      const entryRef = testkitEntryRef();
      expect(await linkEntryToSession({ collections: corpus.collections, entryRef, sessionId,
        display: TESTKIT_LINK_DISPLAY, nowMs: 1 })).toMatchObject({ status: 'linked' });
      // The host's admitted-contribution transport is the system boundary;
      // registration, Account activation, schema parsing and relation reads are real.
      const targetedContributions = { observeForSelf: () => ({
        readCurrent: async () => testkitReadOnlySourceSnapshot(), dispose() {},
      }) } as unknown as PluginServices['targetedContributions'];
      const result = TriageReadSourceSessionLinksActionResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, { v: 1, sessionId },
        { surface, sessionId, services: { targetedContributions } }));
      expect(result).toMatchObject({ kind: 'partial', links: [{ entryRef, sessionId,
        linkedAtMs: 1, displayPath: TESTKIT_LINK_DISPLAY.locator.displayPath }] });
    }, { activate, activateAccount });
  });

  it.each(['new', 'existing', 'mismatchedAgent', 'statusApprovalDeferred'] as const)('runs the registered headless investigation through the same creation and input owners on the affected Machine ($0)', async destination => {
    await withRegisteredPlugin(async ({ plugin }) => {
      const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.example.agent', localId: 'example' } } as const;
      const targetKey = buildAgentTargetKeyV2(agentTarget);
      const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess({ sessionId: 'session-a' })],
        send: [{ status: 'accepted', localId: 'health-input' }] });
      const payload = { topic: 'resource_limit', phase: 'started', kind: 'cpu_busy', machineId: 'machine-a',
        at: 2, since: 1, guardEnabled: false, evidence: { abovePct: 90, sustainMs: 1000, busyPct: 95 } };
      const calls: string[] = [];
      // Only ordinary host Action transport is substituted. Account activation,
      // live catalog, private Artifact admission, placement and custody stay real.
      const actions = { execute: async (action: string, value: JsonValue, options?: Parameters<PluginServices['actions']['execute']>[2]) => {
        calls.push(action);
        if (action === 'agents.backends.list') return { items: [{ targetKey, agentTarget, enabled: true }] };
        if (action === 'artifact.get') return { artifact: { artifactId: 'resource-notice', ownerAccountId: 'account-a',
          access: 'owner', publicAudience: 'none', header: { v: 1, kind: 'usage_notice.v1', title: 'Busy CPU', status: 'open', notice: payload },
          body: JSON.stringify({ v: 1, notice: payload }), revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1 } };
        if (action === 'localServices.launcher.snapshot') return { v: 1, machineId: 'machine-a', updatedAt: 1, targets: [] };
        if (action === 'session.status.get') {
          expect(options?.sessionAddress).toEqual({ serverId: 'server-a', sessionId: 'session-a' });
          if (destination === 'statusApprovalDeferred') return { kind: 'approval_request_created',
            artifactId: 'status-approval', actionId: 'session.status.get' };
          return SessionStatusActionResultV1Schema.parse({ ok: true, session: { id: 'session-a', machineId: 'machine-a',
            createdAt: 1, updatedAt: 1, active: true, activeAt: 1, encryption: null },
            agentTarget: destination === 'mismatchedAgent' ? { ...agentTarget, identity: { ...agentTarget.identity, localId: 'other' } } : agentTarget });
        }
        if (action === 'session.spawn_new') return invoker.execute(action, PLUGIN_ACTION_INPUT_SCHEMAS[action].parse(value));
        if (action === 'session.message.send') return invoker.execute(action, PLUGIN_ACTION_INPUT_SCHEMAS[action].parse(value));
        throw new Error(`Unexpected host Action ${action}`);
      } } as unknown as PluginServices['actions'];
      const notice = { kind: 'host', artifactId: 'resource-notice', source: { kind: 'host', topic: 'resource_limit' } };
      const result = await plugin.invokeAction('sessions/run-configured-v1', { v: 1, handoff: {
        task: 'investigate', configuredActionId: 'investigate', context: { kind: 'healthAlert', notice,
          target: { kind: 'machine', machine: { serverId: 'server-a', machineId: 'machine-a' } } },
        evidence: [{ kind: 'alert', notice }], sessionChoice: destination === 'new' ? { kind: 'new' }
          : { kind: 'existing', session: 'session-a' },
        agentChoice: { kind: 'target', targetKey }, delivery: 'send',
      } }, { surface: 'plugin', accountScope: { serverId: 'server-a', accountId: 'account-a' },
        sessionTargetsV1: { actionId: 'action.invoke', field: 'input.handoff.sessionChoice.session', selector: false,
          targets: [{ serverId: 'server-a', sessionId: 'session-a' }] }, services: { actions } });
      if (destination === 'mismatchedAgent' || destination === 'statusApprovalDeferred') {
        expect(result).toMatchObject({ v: 1, handoff: { kind: 'unavailable',
          reason: destination === 'mismatchedAgent' ? 'agentMismatch' : 'sessionUnavailable' } });
        expect(invoker.callsFor('session.spawn_new')).toHaveLength(0);
        expect(invoker.callsFor('session.message.send')).toHaveLength(0);
        return;
      }
      expect(result, JSON.stringify({ result, calls })).toMatchObject({ v: 1, handoff: { kind: 'sendResult', session: { serverId: 'server-a', sessionId: 'session-a' },
        result: { status: 'accepted', localId: 'health-input' } } });
      expect(invoker.callsFor('session.spawn_new')).toHaveLength(destination === 'new' ? 1 : 0);
      if (destination === 'new') expect(invoker.callsFor('session.spawn_new')[0]?.input).toMatchObject({
        executionTarget: { serverId: 'server-a', machineId: 'machine-a' }, directory: { kind: 'managed' } });
      expect(invoker.callsFor('session.message.send')).toHaveLength(1);
      expect(JSON.stringify(invoker.callsFor('session.message.send'))).toContain('cpu_busy');
      expect(calls.filter(id => id === 'artifact.get')).toHaveLength(1);
    });
  });
  it('admits the same configured handoff as a portable Account Action without inventing a headless composer', async () => {
    await withRegisteredPlugin(async ({ plugin }) => {
      const repository = { kind: 'github', deployment: 'https://github.com', repository: 'example/repository' };
      expect(await plugin.invokeAction('sessions/run-configured-v1', { v: 1, handoff: {
        task: 'investigate', configuredActionId: 'investigate', context: { kind: 'repository', repository },
        evidence: [{ kind: 'releaseNotes', repository, selector: { kind: 'proposed', tagName: 'v1', targetCommitish: 'main' },
          contextText: 'Retain the exact selected evidence.' }],
        sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'compose',
      } }, { surface: 'plugin' })).toMatchObject({ v: 1, handoff: { kind: 'unavailable', reason: 'composerUnavailable' } });
    });
  });
  it.each(['ui', 'plugin'] as const)('reads the absent handoff choice through the registered %s Account Action without writes', async (surface) => {
    await withRegisteredPlugin(async ({ plugin, kv }) => {
      const host: TriageSessionHandoffHostV1 = { executeAction: async (ref, input) => {
        expect(ref).toEqual(TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1);
        return plugin.invokeAction(ref.localId, input, { surface });
      } };
      const choices = await readTriageSessionHandoffChoicesV1(host);
      expect(choices.kind).toBe('choices');
      if (choices.kind !== 'choices') throw new Error('Expected the absent catalog seed');
      expect(choices.defaultActionId).toBe(TRIAGE_DEFAULT_FIX_ACTION_ID_V1);
      expect(choices.actions).toEqual(TRIAGE_DEFAULT_ACTIONS_V1.map(action => ({ label: action.label,
        selection: { configuredActionId: action.actionId, sessionChoice: { kind: 'configured' },
          agentChoice: { kind: 'configured' }, delivery: 'configured' } })));
      const legacy = TriageReadActionsResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, { v: 1 }, { surface: 'ui' }));
      expect(legacy).toMatchObject({ availability: 'absent', actions: TRIAGE_DEFAULT_ACTIONS_V1, revision: 'absent' });
      expect(kv.setCallCount()).toBe(0);
      expect(kv.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toBeUndefined();
    });
  });

  it('keeps handoff choice order without substituting the first action for a disabled Fix or an unreadable catalog', async () => {
    await withRegisteredPlugin(async ({ plugin, kv }) => {
      const fix = TRIAGE_DEFAULT_ACTIONS_V1.find(action => action.actionId === TRIAGE_DEFAULT_FIX_ACTION_ID_V1);
      if (fix === undefined || fix.target.kind !== 'agent') throw new Error('Expected the canonical Fix seed');
      const custom = { ...fix, actionId: 'custom-first', label: 'Custom first' };
      const formalReview = { ...fix, actionId: 'formal-review', label: 'Formal review', appliesTo: ['pullRequest'],
        workspaceMode: 'pull_request', target: { kind: 'reviewStart', promptInvocationId: 'review-prompt' } };
      kv.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 1, actions: [custom, formalReview,
        ...TRIAGE_DEFAULT_ACTIONS_V1.map(action => ({ ...action,
          ...(action.actionId === TRIAGE_DEFAULT_FIX_ACTION_ID_V1
            ? { label: 'Repair in current profile', profileId: 'profile-a', target: { ...fix.target, delivery: 'send' } } : {}) }))] });
      const host: TriageSessionHandoffHostV1 = { executeAction: (ref, input) => plugin.invokeAction(ref.localId, input, { surface: 'ui' }) };
      const choices = await readTriageSessionHandoffChoicesV1(host);
      expect(choices.kind).toBe('choices');
      if (choices.kind !== 'choices') throw new Error('Expected current configured choices');
      expect.soft(choices.defaultActionId).toBe(TRIAGE_DEFAULT_FIX_ACTION_ID_V1);
      expect(choices.actions.map(action => action.selection.configuredActionId)).toEqual([
        'custom-first', ...TRIAGE_DEFAULT_ACTIONS_V1.map(action => action.actionId),
      ]);
      expect(choices.actions.find(action => action.selection.configuredActionId === TRIAGE_DEFAULT_FIX_ACTION_ID_V1)).toEqual({
        label: 'Repair in current profile', selection: { configuredActionId: TRIAGE_DEFAULT_FIX_ACTION_ID_V1,
          sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured' },
      });
      expect(kv.setCallCount()).toBe(0);
      const legacy = TriageReadActionsResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, { v: 1 }, { surface: 'ui' }));
      await plugin.invokeAction(TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
        { v: 1, kind: 'delete', actionId: TRIAGE_DEFAULT_FIX_ACTION_ID_V1, expectedRevision: legacy.revision }, { surface: 'ui' });
      const writesBeforeRead = kv.setCallCount();
      const disabled = await readTriageSessionHandoffChoicesV1(host);
      expect(disabled.kind).toBe('choices');
      if (disabled.kind !== 'choices') throw new Error('Expected the retained disabled choice to be excluded');
      expect.soft(disabled.defaultActionId).toBeNull();
      expect(disabled.actions.map(action => action.selection.configuredActionId)).not.toContain(TRIAGE_DEFAULT_FIX_ACTION_ID_V1);
      expect(disabled.actions[0]?.selection.configuredActionId).toBe('custom-first');
      kv.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 99 });
      expect(await readTriageSessionHandoffChoicesV1(host)).toEqual({ v: 1, kind: 'unavailable', reason: 'catalogUnavailable' });
      expect(TriageReadActionsResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, { v: 1 }, { surface: 'ui' })))
        .toMatchObject({ availability: 'unavailable', actions: [] });
      expect(kv.setCallCount()).toBe(writesBeforeRead);
    });
  });

  it('delegates a handoff choice to the actual runner current profile and delivery rather than copying its seed preferences', async () => {
    await withRegisteredPlugin(async ({ plugin, kv }) => {
      const fix = TRIAGE_DEFAULT_ACTIONS_V1.find(action => action.actionId === TRIAGE_DEFAULT_FIX_ACTION_ID_V1);
      if (fix === undefined || fix.target.kind !== 'agent') throw new Error('Expected the canonical Fix seed');
      const current = (profileId: string) => ({ v: 1, actions: TRIAGE_DEFAULT_ACTIONS_V1.map(action =>
        action.actionId === TRIAGE_DEFAULT_FIX_ACTION_ID_V1
          ? { ...fix, profileId, target: { ...fix.target, delivery: 'send' } } : action) });
      kv.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, current('profile-a'));
      const choices = await readTriageSessionHandoffChoicesV1({ executeAction: (ref, input) =>
        plugin.invokeAction(ref.localId, input, { surface: 'ui' }) });
      if (choices.kind !== 'choices') throw new Error('Expected the current handoff choices');
      const selected = choices.actions.find(action => action.selection.configuredActionId === choices.defaultActionId)?.selection;
      if (selected === undefined) throw new Error('Expected the canonical configured Fix choice');
      kv.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, current('profile-b'));
      const reads: string[] = [];
      const effects: string[] = [];
      const targetKey = buildAgentTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.example.agent', localId: 'example' } });
      const host = {
        version: () => ({ methods: [] }),
        openNewSession: async () => { effects.push('author'); },
        selectActionInput: async () => { effects.push('select'); return { kind: 'cancelled' }; },
        executeAction: async (ref: string | PluginContributionRef, input: JsonValue) => {
          const id = typeof ref === 'string' ? ref : ref.pluginId === 'happier.triage' ? ref.localId : '';
          reads.push(id);
          if (id === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1) return plugin.invokeAction(id, input, { surface: 'ui' });
          if (id === 'sessions.spawn.profiles.list') return { items: [{ id: 'profile-b', name: 'Current profile', preferredAgentTargetKey: targetKey }] };
          if (id === 'agents.backends.list') return { items: [] };
          effects.push(id);
          throw new Error(`Unexpected effect ${id}`);
        },
      } satisfies Parameters<typeof runTriageConfiguredHandoffV1>[0];
      const repository = { kind: 'github', deployment: 'https://github.com', repository: 'example/repository' } as const;
      expect(await runTriageConfiguredHandoffV1(host, { ...selected, task: 'draftReleaseNotes',
        context: { kind: 'repository', repository }, evidence: [{ kind: 'releaseNotes', repository,
          selector: { kind: 'proposed', tagName: 'v1', targetCommitish: 'main' }, contextText: 'Selected notes context' }],
      }, { entries: [], signal: new AbortController().signal })).toMatchObject({ v: 1,
        handoff: { kind: 'selectionRequired', fields: ['agentChoice'] } });
      expect(reads).toEqual([TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, 'sessions.spawn.profiles.list', 'agents.backends.list']);
      expect(effects).toEqual([]);
      expect(kv.setCallCount()).toBe(0);
    });
  });

  it('accepts daemon and portable invocation capabilities through the same data handler context', () => {
    expectTypeOf<PluginInvocationContext>().toMatchTypeOf<TriageDataActionContext>();
    expectTypeOf<PluginAccountActionContext>().toMatchTypeOf<TriageDataActionContext>();
  });
  it('registers personal source configuration only through the portable Account activation', async () => {
    const account = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const accountActionIds = PLUGIN_MANIFEST.contributes.actions.filter(action => action.execution.target === 'account').map(action => action.id);
      const registrations = account.registrations().filter(entry => entry.family === 'actions' && accountActionIds.some(id => id === entry.localId));
      expect(registrations.find(entry => entry.family === 'actions' && entry.localId === 'internal/tasks/configure-v1')).toBeDefined();
      expect(registrations.filter(entry => entry.family === 'actions').map(entry => entry.localId).sort())
        .toEqual(PLUGIN_MANIFEST.contributes.actions.filter(action => action.execution.target === 'account').map(action => action.id).sort());
      expect(plugin.registration('actions', 'internal/tasks/configure-v1')).toBeUndefined();
      expect(plugin.registrations().filter(entry => entry.family === 'actions').map(entry => entry.localId).sort())
        .toEqual(PLUGIN_MANIFEST.contributes.actions.filter(action => action.execution.target === 'daemon').map(action => action.id).sort());
    } finally { await Promise.all([plugin.dispose(), account.dispose()]); }
  });

  it.each(['agent', 'mcp', 'cli'] as const)('keeps built-ins and explicit opt-outs identical on registered %s Actions and direct UI reads', async (surface) => {
    await withRegisteredPlugin(async ({ plugin, kv }) => {
      kv.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 1, actions: [] });
      const read = async () => TriageReadActionsResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, { v: 1 }, { surface }));
      const initial = await read();
      expect(initial.actions).toEqual(TRIAGE_DEFAULT_ACTIONS_V1);
      const disabled = TriageAdministerActionResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1, { v: 1, kind: 'delete', actionId: 'explain-pr', expectedRevision: initial.revision }, { surface }));
      expect(disabled.status).toBe('applied');
      const after = await read();
      expect(after.actions.find(action => action.actionId === 'explain-pr')?.enabled).toBe(false);
      const ui = await createDirectTriageActionsTransport(kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), { admitAction: async () => true }).read();
      expect(ui).toEqual(after);
      expect(planTriageOfferedActionsV1(readTriageActionsProjectionV1(ui).value.actions, 'pullRequest')
        .some(action => action.actionId === 'explain-pr')).toBe(false);
      const original = initial.actions.find(action => action.actionId === 'explain-pr');
      if (!original || original.target.kind !== 'agent') throw new Error('Missing built-in explanation Action');
      const enabled = TriageAdministerActionResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1, { v: 1, kind: 'update', actionId: original.actionId,
          expectedRevision: after.revision, label: original.label, enabled: true, appliesTo: original.appliesTo,
          profileId: original.profileId, workspaceMode: original.workspaceMode,
          target: { kind: 'agent', promptInvocationId: original.target.promptInvocationId, delivery: original.target.delivery },
        }, { surface }));
      expect(enabled.status).toBe('applied');
      expect((await read()).actions).toEqual(initial.actions);
      const reset = TriageAdministerActionResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
        { v: 1, kind: 'reset', expectedRevision: (await read()).revision }, { surface }));
      expect(reset.status).toBe('applied');
      expect(kv.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toBeUndefined();
      const absent = await read();
      expect(absent).toMatchObject({ availability: 'absent', actions: initial.actions, revision: reset.revision });
      expect(await createDirectTriageActionsTransport(kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), { admitAction: async () => true }).read()).toEqual(absent);
    });
  });

  it('registers exactly the daemon and Account Actions the manifest declares', async () => {
    await withRegisteredPlugin(async ({ plugin }) => {
      const registered = plugin.registrations().filter((entry) => entry.family === 'actions').map((entry) => entry.localId);

      // An activation that registers nothing leaves the declared Action
      // undispatchable, and an activation that registers something undeclared
      // exposes a contribution the host never admitted. Both fail here.
      expect(registered).toEqual(expect.arrayContaining([
        TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
        TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
        TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
      ]));
      expect(PLUGIN_MANIFEST.contributes.actions
        .filter((action) => action.execution.target !== 'client')
        .map((action) => action.id).sort()).toEqual([...registered].sort());
    });
  });

  it('registers a runtime for every attachment lifecycle role the manifest declares', async () => {
    await withRegisteredPlugin(async ({ plugin }) => {
      const registered = plugin.registrations().filter((entry) => entry.family === 'composerAttachments').map((entry) => {
        const runtime = plugin.registration('composerAttachments', entry.localId);
        if (!runtime) throw new Error('Attachment runtime missing');
        return { id: entry.localId, roles: Object.keys(runtime).filter((key) => runtime[key as keyof typeof runtime] !== undefined) };
      });

      // A declared role with no registration is a draft the host asks this plugin
      // to resolve and gets nothing back for; a registered role the manifest never
      // declared is never invoked. Both are silent, so both fail here.
      expect(registered).toEqual(PLUGIN_MANIFEST.contributes.composerAttachments
        .filter((attachment) => attachment.runtime !== undefined)
        .map((attachment) => ({
          id: attachment.id,
          roles: Object.keys(attachment.runtime).filter(
            (role) => attachment.runtime[role as keyof typeof attachment.runtime] === true,
          ),
        })));
    });
  });

  it('creates, edits and deletes a saved view through registered Actions and strict persisted/read schemas', async () => {
    await withRegisteredPlugin(async ({ plugin, kv }) => {
      const options = { surface: 'agent' as const, sessionId: 'triage-audit-session' };
      const draft = { v: 1 as const, label: 'Review café 🧪', query: '', filters: TRIAGE_LIST_NO_FILTERS_V1,
        order: 'smart', smartPolicy: { v: 1, precedence: ['attention', 'activity'] }, view: 'board' };
      const created = TriageAdministerSavedViewResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1, { ...draft, kind: 'create', expectedRevision: 'absent' }, options));
      expect(created.status).toBe('applied');
      if (!created.viewId || !created.revision) throw new Error('Applied view must carry identity and revision');
      expect(created).not.toHaveProperty('selectedViewId');
      expect(TriageSavedViewsCatalogValueV1Schema.parse(kv.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1)).views)
        .toEqual(created.views);

      const updated = TriageAdministerSavedViewResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1, { ...draft, kind: 'update', viewId: created.viewId,
          expectedRevision: created.revision, label: 'Renamed', query: 'parser', view: 'list' }, options));
      expect(updated.status).toBe('applied');
      expect(TriageReadSavedViewsResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1, { v: 1 }, options)).views)
        .toEqual(updated.views);
      expect(updated.views?.[0]).toMatchObject({ viewId: created.viewId, label: 'Renamed', query: 'parser', view: 'list' });
      expect(TriageAdministerSavedViewResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1, { ...draft, kind: 'update', viewId: created.viewId,
          expectedRevision: created.revision }, options))).toEqual({ v: 1, status: 'conflict' });

      const deleted = TriageAdministerSavedViewResultV1Schema.parse(await plugin.invokeAction(
        TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1, { v: 1, kind: 'delete', viewId: created.viewId,
          expectedRevision: updated.revision! }, options));
      expect(deleted).toMatchObject({ status: 'applied', views: [] });
      const persisted = TriageSavedViewsCatalogValueV1Schema.parse(kv.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1));
      expect(persisted).toEqual({ v: 1, views: [] });
      expect(TriageSavedViewsCatalogValueV1Schema.safeParse({ ...persisted, providerPayload: {} }).success).toBe(false);
    });
  });

  it('lists from a session-qualified registered Action and retains a configured source whose plugin is unavailable', async () => {
    await withRegisteredPlugin(async ({ plugin, corpus }) => {
      const fixture = createTriageSourceV1Fixture();
      const configured = fixture.configuredInstance;
      if (fixture.administrationInput.kind !== 'create') throw new Error('Canonical fixture must offer source creation');
      expect(await administerConfiguredSourceInstance({ collections: corpus.collections,
        source: configured.instance.source, declaredPurpose: fixture.descriptor.purpose,
        request: { kind: 'create', draft: fixture.administrationInput.draft }, nowMs: 1,
        mintSourceInstanceId: () => configured.instance.sourceInstanceId,
      })).toEqual({ kind: 'active', sourceInstanceId: configured.instance.sourceInstanceId });
      const result = TriageListEntriesResultV1Schema.parse(await plugin.invokeAction(TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
        { v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest' },
        { surface: 'agent', sessionId: 'triage-audit-session' }));
      expect(result.configuredSources).toEqual([{
        source: configured.instance.source, sourceInstanceId: configured.instance.sourceInstanceId,
        configurationRowId: (await findConfiguredSourceInstanceRow(corpus.collections.sourceInstances,
          configured.instance.sourceInstanceId))?.rowId,
        configurationRevision: 1, available: false, displayLabel: configured.locator?.displayLabel,
      }]);
      expect(result.window.rows).toEqual([]);
      expect(result.window.coverage).toBe('partial');
      expect((await corpus.collections.sourceInstances.query({ index: 'by-lifecycle', order: 'asc' })).rows)
        .toHaveLength(1);
      expect(TriageListEntriesResultV1Schema.safeParse({ ...result, providerPayload: {} }).success).toBe(false);
    });
  });

  it('pins, reads and unpins schema2 marks through registered Actions without leaking row identity', async () => {
    await withRegisteredPlugin(async ({ plugin, corpus }) => {
      const pullRequest = createTriageSourceV1Fixture().detailInput.observation.entryRef;
      const entryRef = TriageEntryRefV1Schema.parse({ ...pullRequest, kindId: 'issue', entryId: 'issue-17' });
      const options = { surface: 'agent' as const, sessionId: 'triage-audit-session' };
      const displayAtMark = { title: 'Review café 🧪', scopeLabel: 'example/repository' };
      // Produce the schema2-only relationship through its registered writer;
      // Pin and Unpin must preserve this independent durable user choice.
      expect(TriageSetFixPullRequestResultV1Schema.parse(await plugin.invokeAction(TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1,
        { v: 1, linked: true, entryRef, displayAtMark, fixPullRequest: pullRequest, displayAtLink: displayAtMark }, options)))
        .toEqual({ v: 1, status: 'linked' });
      expect(TriageSetEntryPinnedResultV1Schema.parse(await plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
        { v: 1, pinned: true, entryRef, displayAtMark }, options))).toEqual({ v: 1, status: 'pinned' });
      const pinned = TriageListPinnedEntriesResultV1Schema.parse(await plugin.invokeAction(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
        { v: 1, limit: 1 }, options));
      expect(pinned.pins).toEqual([{ entryRef, displayAtMark, markedAtMs: expect.any(Number) }]);
      const stored = await corpus.collections.userMarks.query({ index: CORPUS_USER_MARKS_INDEX_ID.byPinned, order: 'asc' });
      expect(stored.rows).toHaveLength(1);
      const declared = compilePluginJsonSchema(CORPUS_USER_MARKS_COLLECTION.schema);
      expect(isValidPluginJsonSchemaValue(declared, stored.rows[0]!.value)).toBe(true);
      expect(stored.rows[0]!.value).toMatchObject({ fixPullRequests: { linked: [{ entryRef: pullRequest }] } });
      expect(isValidPluginJsonSchemaValue(declared, { ...stored.rows[0]!.value, providerPayload: {} })).toBe(false);
      expect(pinned.pins[0]).not.toHaveProperty('markTag');

      await expect(plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
        { v: 1, pinned: false, entryRef, displayAtMark }, options)).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
      expect(TriageListPinnedEntriesResultV1Schema.parse(await plugin.invokeAction(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
        { v: 1, limit: 1 }, options)).pins).toEqual(pinned.pins);
      expect(TriageSetEntryPinnedResultV1Schema.parse(await plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
        { v: 1, pinned: false, entryRef }, options))).toEqual({ v: 1, status: 'unpinned' });
      expect(TriageListPinnedEntriesResultV1Schema.parse(await plugin.invokeAction(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
        { v: 1, limit: 1 }, options))).toEqual({ v: 1, pins: [] });
      expect((await corpus.collections.userMarks.query({ index: CORPUS_USER_MARKS_INDEX_ID.byPinned, order: 'asc' })).rows)
        .toEqual([expect.objectContaining({ value: expect.objectContaining({ pinned: false,
          fixPullRequests: expect.objectContaining({ linked: [expect.objectContaining({ entryRef: pullRequest })] }),
        }) })]);
    });
  });
});
