import { describe, expect, it, vi } from 'vitest';
import { definePlugin, type JsonValue, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ConversationBindingV1Schema, SessionPullRequestBindingInputV1Schema, SessionPullRequestBindingResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { GITHUB_PLUGIN } from '../../scm-github/src/manifest.js';
import { githubNativeReadActionId } from '../../scm-github/src/triage/readActions.js';
import { CHANNELS_PLUGIN } from './manifest.js';
import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { withChannelStateSessionIdentity } from './collectionMigrations.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import * as management from './management.js';
import { channelsProviderDescriptorFixture } from './testkit/operationOnlyTargetedContributionsFixture.js';
import { activate as activateAccount } from './accountRuntime.js';

describe('registered GitHub PR source → native Channels relationships', () => {
  it('reads retained Account links through the portable Channels registration without a Machine', async () => {
    const credentialRef = { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: '99' };
    const state = new MemoryCollection<Record<string, JsonValue>>();
    const connection = createCurrentConversationConnectionFixture({ connectionId: 'account-connection', authority: {
      providerPluginId: 'happier.scm.forge.github', providerContributionSelection: { contributionId: 'github' },
      providerSetupInput: { repository: 'acme/widgets', credentialRef }, credentialRef,
      transportOrigin: { serverIdentityId: 'srv_plugin_testkit', machineId: 'offline-machine' },
      providerConnectionKey: 'github:repository:77', providerConfig: { v: 1,
        repository: { v: 1, repositoryId: '77', owner: 'acme', name: 'widgets', nameWithOwner: 'acme/widgets' },
        integrationPrincipal: { id: '99', label: 'Account user' } },
      routingIdentityKey: 'f'.repeat(43), integrationPrincipal: { id: '99' }, authorityEpoch: 1,
    } });
    await state.put(connection, { expectedRevision: 'absent' });
    const target = { kind: 'session', sessionId: 'session-1', pullRequestLink: { repository: 'acme/widgets', number: 12 },
      policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } };
    await state.put(withChannelStateSessionIdentity({ id: 'account-binding', 'record-kind': 'binding', v: 1,
      'connection-id': connection.id, 'binding-id': 'account-binding', 'created-at': 42, 'updated-at': 42,
      payload: { endpoint: { kind: 'githubPullRequest', audience: 'shared', id: 'github:repository:77:issue:300:number:12', parentId: '77',
        pullRequest: { repository: 'acme/widgets', number: 12 } }, target, allowedPrincipalIds: ['99'], allowBotSenders: false,
        inputMode: 'allAllowedMessages', inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off',
        authorityEpoch: 1, enabled: false, deletionState: 'none' } }, target), { expectedRevision: 'absent' });
    const core = await createPluginTestkit({ manifest: CHANNELS_PLUGIN.manifest,
      module: { activate: CHANNELS_PLUGIN.activate, activateAccount }, resolveCurrentPluginMaterializationRef: () => null,
      services: { targetedContributions: channelsProviderDescriptorFixture(GITHUB_PLUGIN.manifest),
        storage: { account: { collection: () => state } } as unknown as PluginServices['storage'] } });
    try {
      expect(await core.invokeAction('session-pull-request-relations-v1', {
        kind: 'readRelations', credentialRef, sessionId: 'session-1',
      }, { surface: 'ui' })).toMatchObject({ kind: 'relations', links: [{ sessionId: 'session-1',
        bindingId: 'account-binding', repositoryId: '77', pullRequest: { repository: 'acme/widgets', number: 12 }, linkedAtMs: 42 }] });
      expect(await core.invokeAction('session-pull-request-relations-v1', {
        kind: 'readRelations', credentialRef: { ...credentialRef, accountId: 'other-account' }, sessionId: 'session-1',
      }, { surface: 'ui' })).toMatchObject({ kind: 'relations', links: [{ sessionId: 'session-1', bindingId: 'account-binding' }] });
      expect(await core.invokeAction('session-pull-request-relations-v1', {
        kind: 'readRelations', credentialRef: { ...credentialRef, accountId: 'other-account' },
        pullRequest: { repositoryId: '77', number: 12 },
      }, { surface: 'ui' })).toMatchObject({ kind: 'relations', links: [{ sessionId: 'session-1', bindingId: 'account-binding' }] });
      expect(await core.invokeAction('session-pull-request-relations-v1', {
        kind: 'readRelations', credentialRef, pullRequest: { repositoryId: '78', number: 12 },
      }, { surface: 'ui' })).toEqual({ kind: 'relations', links: [] });
      await expect(core.invokeAction('session-pull-request-relations-v1', {
        kind: 'readRelations', credentialRef: null, sessionId: 'session-1',
      }, { surface: 'ui' })).resolves.toMatchObject({ kind: 'relations', links: [{ sessionId: 'session-1', bindingId: 'account-binding' }] });
      await expect(core.invokeAction('session-pull-request-relations-v1', {
        kind: 'unlink', sessionId: 'session-1', bindingId: 'account-binding', expectedRevision: 1,
      }, { surface: 'ui' })).rejects.toMatchObject({ code: 'plugin_action_read_observation_read_only_required' });
      const invalidated = vi.fn();
      const observation = await core.observeAction('session-pull-request-relations-v1', {
        kind: 'readRelations', credentialRef, sessionId: 'session-1',
      }, invalidated, { surface: 'ui' });
      invalidated.mockClear();
      const retained = await state.get('account-binding');
      if (retained === null) throw new Error('Missing retained Account binding');
      await state.put({ ...retained.value, 'updated-at': 43 }, { expectedRevision: retained.revision });
      expect(invalidated).toHaveBeenCalledOnce();
      await observation.dispose();
    } finally { await core.dispose(); }
  });
  it.each(['account', 'native'] as const)('reads and unlinks exact retained %s links with host-stamped callers', async mode => {
    const credentialRef = mode === 'native' ? null : { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: '99' };
    const state = new MemoryCollection<Record<string, JsonValue>>();
    const repository = { v: 1, repositoryId: '77', owner: 'acme', name: 'widgets', nameWithOwner: 'acme/widgets' };
    const connection = createCurrentConversationConnectionFixture({ connectionId: 'connection-1', authority: {
      providerPluginId: 'happier.scm.forge.github', providerContributionSelection: { contributionId: 'github' },
      providerSetupInput: { repository: 'acme/widgets', credentialRef }, credentialRef,
      transportOrigin: { serverIdentityId: 'srv_plugin_testkit', machineId: 'machine-1' },
      providerConnectionKey: 'github:repository:77', providerConfig: { v: 1, repository, integrationPrincipal: { id: '99', label: 'native-user' } },
      routingIdentityKey: 'f'.repeat(43), integrationPrincipal: { id: '99' }, authorityEpoch: 1,
    } });
    await state.put(connection, { expectedRevision: 'absent' });
    const binding = ConversationBindingV1Schema.parse({ v: 1, id: 'binding-1', connectionId: connection.id,
      endpoint: { kind: 'githubPullRequest', audience: 'shared', id: 'github:repository:77:issue:300:number:12', parentId: '77', pullRequest: { repository: 'acme/widgets', number: 12 } },
      target: { kind: 'session', sessionId: 'session-1', pullRequestLink: { repository: 'acme/widgets', number: 12 },
        policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
      allowedPrincipalIds: ['99'], allowBotSenders: false, inputMode: 'allAllowedMessages', inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: false, deletionState: 'none', createdAt: 42, updatedAt: 42 });
    const { v: _v, id: _id, connectionId: _connectionId, createdAt: _createdAt, updatedAt: _updatedAt, ...payload } = binding;
    await state.put(withChannelStateSessionIdentity({ id: binding.id, 'record-kind': 'binding', v: 1,
      'connection-id': connection.id, 'binding-id': binding.id, 'created-at': 42, 'updated-at': 42, payload }, binding.target), { expectedRevision: 'absent' });
    const ordinaryTarget = { kind: 'session', sessionId: 'session-1', policy: binding.target.kind === 'session' ? binding.target.policy : {} };
    await state.put(withChannelStateSessionIdentity({ id: 'ordinary-session-binding', 'record-kind': 'binding', v: 1,
      'connection-id': connection.id, 'binding-id': 'ordinary-session-binding', 'created-at': 42, 'updated-at': 42,
      payload: { ...payload, target: ordinaryTarget } }, ordinaryTarget), { expectedRevision: 'absent' });
    const fetchedRows: string[] = [];
    const query = state.query.bind(state);
    // Collection retrieval is the external boundary: an unrelated private
    // Session binding body must not be fetched just to select PR membership.
    vi.spyOn(state, 'query').mockImplementation(async (...args) => {
      const page = await query(...args);
      fetchedRows.push(...page.rows.map(row => row.rowId));
      return page;
    });
    let coreMachineId = 'machine-1';
    const targetedContributions = channelsProviderDescriptorFixture(GITHUB_PLUGIN.manifest);
    const core = await createPluginTestkit({ manifest: CHANNELS_PLUGIN.manifest, module: CHANNELS_PLUGIN,
      resolveCurrentPluginMaterializationRef: () => ({ pluginId: 'happier.channels', machineId: coreMachineId, materializationId: 'channels-registration' }),
      services: { targetedContributions, storage: { account: { collection(definition: { id: string }) {
        if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected Collection');
        return state;
      } } } as unknown as PluginServices['storage'],
      actions: { async execute(actionId: string) {
        if (actionId === 'session.transcript.get') return { sessionId: 'session-1', projection: 'externalShareableV1' };
        throw new Error(`Unexpected host Action ${actionId}`);
      } } as unknown as PluginServices['actions'] },
    });
    let machineId = 'machine-1';
    const source = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN, actionTargets: [core],
      resolveCurrentPluginMaterializationRef: () => ({ pluginId: 'happier.scm.forge.github', machineId, materializationId: 'github-registration' }),
      // Retained relationship reads/unlinks must not materialize credentials or
      // contact GitHub. Unprovided service boundaries fail loudly in this host.
    });
    const configured = createTriageSourceV1Fixture().configuredInstance;
    const sourceBinding: Readonly<Record<string, JsonValue>> = credentialRef === null
      ? { purpose: 'github-connected-account', source: 'native', service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' } }
      : { purpose: 'github-connected-account', account: credentialRef };
    const instance = { ...configured, instance: { ...configured.instance, source: { pluginId: 'happier.scm.forge.github', localId: 'github-forge' } },
      binding: sourceBinding,
      localInstanceKey: 'github.com', configuration: { v: 1, token: JSON.stringify({ v: 1, selection: { kind: 'all' } }) } };
    const localRef = { kindId: 'pull-request', collisionScope: 'github:77', entryId: '12' };
    const readInput = { v: 1, instance, localRef, sessionId: 'session-1' };
    // This composition owns the native daemon caller stamp; the GitHub Account
    // dispatcher tests separately cover selecting this exact daemon child.
    const readActionId = mode === 'native' ? githubNativeReadActionId('triage/read-github-session-links') : 'triage/read-github-session-links';
    try {
      if (mode === 'native') {
        const request = { kind: 'readRelations', credentialRef: null, sessionId: 'session-1' };
        await expect(core.invokeAction('session-pull-request-binding-v1', request, { surface: 'ui' }))
          .resolves.toMatchObject({ kind: 'relations', links: [{ sessionId: 'session-1', repositoryId: '77',
            pullRequest: { repository: 'acme/widgets', number: 12 }, linkedAtMs: 42 }] });
        const unrelatedPlugin = definePlugin({ id: 'example.unrelated-source', version: '1.0.0', actions: { read: {
          title: 'Read native relationships', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
          inputSchema: SessionPullRequestBindingInputV1Schema, resultSchema: SessionPullRequestBindingResultV1Schema,
          run: async (input, context) => SessionPullRequestBindingResultV1Schema.parse(await context.services.actions.execute(
            { pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' }, input, { signal: context.signal })),
        } } });
        const unrelated = await createPluginTestkit({ manifest: unrelatedPlugin.manifest, module: unrelatedPlugin, actionTargets: [core] });
        try {
          await expect(unrelated.invokeAction('read', request, { surface: 'plugin' }))
            .resolves.toMatchObject({ kind: 'relations', links: [{ sessionId: 'session-1', repositoryId: '77',
              pullRequest: { repository: 'acme/widgets', number: 12 }, linkedAtMs: 42 }] });
        } finally { await unrelated.dispose(); }
      }
      expect(await source.invokeAction(readActionId, readInput, { surface: 'ui' }))
        .toMatchObject({ kind: 'complete', links: [{ localRef, sessionId: 'session-1', linkedAtMs: 42 }] });
      const otherGithubProfile = { ...instance, binding: { purpose: 'github-connected-account', account: {
        service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: mode === 'native' ? '99' : 'another-account',
      } } };
      expect(await source.invokeAction(readActionId, { ...readInput, instance: otherGithubProfile }, { surface: 'ui' }))
        .toMatchObject({ kind: 'complete', links: [{ localRef, sessionId: 'session-1', linkedAtMs: 42 }] });
      expect(fetchedRows).not.toContain('ordinary-session-binding');
      if (mode === 'account') {
        const signal = new AbortController();
        // The in-memory Collection implements the persistence boundary only.
        const context = { signal: signal.signal, services: {
          targetedContributions: targetedContributions,
          storage: { account: { collection: () => state } } as unknown as PluginServices['storage'] } };
        const changed = vi.fn();
        const observation = await management.observeSessionPullRequestBindingAction(
          { kind: 'readRelations', credentialRef, sessionId: 'session-1' }, changed, context);
        changed.mockClear();
        const ordinary = await state.get('ordinary-session-binding');
        if (ordinary === null) throw new Error('Missing ordinary fixture');
        await state.put({ ...ordinary.value, 'updated-at': 43 }, { expectedRevision: ordinary.revision });
        expect(changed).not.toHaveBeenCalled();
        const retained = await state.get(connection.id);
        if (retained === null) throw new Error('Missing connection fixture');
        await state.put({ ...retained.value, 'updated-at': 43 }, { expectedRevision: retained.revision });
        expect(changed).toHaveBeenCalled();
        await observation.dispose();
        changed.mockClear();
        const current = await state.get(binding.id);
        if (current === null) throw new Error('Missing binding fixture');
        await state.put({ ...current.value, 'updated-at': 43 }, { expectedRevision: current.revision });
        expect(changed).not.toHaveBeenCalled();
        await expect(management.observeSessionPullRequestBindingAction(
          { kind: 'unlink', sessionId: 'session-1', bindingId: binding.id, expectedRevision: current.revision }, changed, context))
          .rejects.toMatchObject({ code: 'plugin_action_read_observation_read_only_required' });
        const watch = vi.spyOn(state, 'watch');
        const allChanged = vi.fn();
        const all = await management.observeSessionPullRequestBindingAction({ kind: 'readRelations', credentialRef }, allChanged, context);
        const future = { ...connection, id: 'future-connection', 'connection-id': 'future-connection' };
        await state.put(future, { expectedRevision: 'absent' });
        await vi.waitFor(() => expect(watch).toHaveBeenCalledWith({ index: 'by-connection-binding-v2',
          prefix: [future.id], order: 'asc' }, expect.any(Function)));
        allChanged.mockClear();
        const futureTarget = { ...binding.target, sessionId: 'session-2' };
        await state.put(withChannelStateSessionIdentity({ id: 'future-binding', 'record-kind': 'binding', v: 1,
          'connection-id': future.id, 'binding-id': 'future-binding', 'created-at': 42, 'updated-at': 42,
          payload: { ...payload, target: futureTarget } }, futureTarget), { expectedRevision: 'absent' });
        expect(allChanged).toHaveBeenCalledOnce();
        signal.abort();
        await all.dispose();
        allChanged.mockClear();
        state.resetObservation();
        expect(allChanged).not.toHaveBeenCalled();
      }
      if (mode === 'native') {
        machineId = 'another-machine';
        await expect(source.invokeAction(readActionId, readInput, { surface: 'ui' }))
          .rejects.toMatchObject({ code: 'plugin_action_execution_origin_mismatch' });
        // A current same-Machine Channels placement can read an Account link
        // whose retained connection still executes on its original Machine.
        coreMachineId = machineId;
        expect(await source.invokeAction(readActionId, readInput, { surface: 'ui' }))
          .toMatchObject({ kind: 'complete', links: [{ localRef, sessionId: 'session-1', linkedAtMs: 42 }] });
        const selected = { ...instance, configuration: { v: 1,
          token: JSON.stringify({ v: 1, selection: { kind: 'selected', unitIds: ['acme/widgets'] } }) } };
        expect(await source.invokeAction(readActionId, { v: 1, instance: selected }, { surface: 'ui' }))
          .toMatchObject({ kind: 'complete', links: [{ localRef, sessionId: 'session-1', linkedAtMs: 42 }] });
        const excluded = { ...selected, configuration: { v: 1,
          token: JSON.stringify({ v: 1, selection: { kind: 'selected', unitIds: ['another/repository'] } }) } };
        expect(await source.invokeAction(readActionId, { v: 1, instance: excluded }, { surface: 'ui' }))
          .toEqual({ kind: 'complete', links: [] });
        expect(await state.get(binding.id)).not.toBeNull();
      }
      expect(await source.invokeAction('triage/link-github-session', { ...readInput, linked: false }, { surface: 'ui' })).toEqual({ status: 'unlinked' });
      expect(await source.invokeAction(readActionId, readInput, { surface: 'ui' })).toEqual({ kind: 'complete', links: [] });
    } finally { await source.dispose(); await core.dispose(); }
  });
});
