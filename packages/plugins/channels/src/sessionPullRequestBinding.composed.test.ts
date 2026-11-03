import { describe, expect, it, vi } from 'vitest';
import { definePlugin, PluginError, type JsonValue, type PluginInvocationContext, type PluginServices } from '@happier-dev/plugin-sdk';
import type { TargetedContributionPointRef } from '@happier-dev/plugin-sdk/contributions';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  SessionPullRequestBindingResultV1Schema,
  SessionPullRequestLinkCompletionsContributionProtocolV1,
  SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_ID_V1,
  SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_REF_V1,
  SessionPullRequestLinkCompletionInputV1Schema,
  SessionPullRequestLinkCompletionResultV1Schema,
} from '@happier-dev/channels-protocol/v1';

import { GITHUB_PLUGIN } from '../../scm-github/src/manifest.js';
import { CHANNELS_PLUGIN, CHANNELS_PROVIDER_POINT_REF, PLUGIN_MANIFEST } from './manifest.js';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_FIELD, CHANNEL_STATE_FIXED_ROW_ID, CHANNEL_STATE_RECORD_KIND } from './collections.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { channelsOperationOnlyTargetedContributionsFixture } from './testkit/operationOnlyTargetedContributionsFixture.js';

describe('registered Session PR URL attach', () => {
  it('attaches the detected URL with exact Account credentials and retains its original relationship clock', async () => {
    let currentMachineId = 'machine-1';
    const materializedAccounts: unknown[] = [];
    const credential = { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: '99' };
    const requests: Array<Readonly<{ method?: string; url: string }>> = [];
    const http = createPluginHttpFixture({ request: async (request) => {
      requests.push(request);
      if (request.method !== undefined && request.method !== 'GET') throw new Error('Linking an existing PR must not write to GitHub');
      const path = new URL(request.url).pathname;
      const body = path === '/repos/acme/widgets' ? { id: 77, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } }
        : path === '/user' ? { id: 99, login: 'native-user' }
        : path === '/repos/acme/widgets/issues/comments' ? []
        : /^\/repos\/acme\/widgets\/issues\/[0-9]+$/.test(path) ? { id: 288 + Number(path.split('/').at(-1)), number: Number(path.split('/').at(-1)), title: 'Existing PR', pull_request: {} }
        : path === '/search/users' ? { items: [{ id: 99, login: 'native-user', type: 'User' }] }
        : undefined;
      if (body === undefined) throw new Error(`Unexpected GitHub read ${path}`);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) };
    } });
    const provider = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      resolveCurrentPluginMaterializationRef: () => ({ pluginId: GITHUB_PLUGIN.manifest.id,
        machineId: currentMachineId, materializationId: 'github-native-provider' }),
      services: { http: { ...http, async openWebSocket() { throw new Error('PR attach must not open a socket'); } }, connectedAccounts: {
        getBinding: async () => { throw new Error('An explicit account must never fall back to the selected account'); },
        materialize: async (...args: Parameters<PluginServices['connectedAccounts']['materialize']>) => {
          materializedAccounts.push(args[2]?.expectedAccount);
          return { kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-token' } };
        },
      // The Connected Account materializer is the external secret boundary.
      } as unknown as PluginServices['connectedAccounts'] },
    });
    const state = new MemoryCollection<Record<string, JsonValue>>();
    await state.put({ id: CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey,
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.connectionIdentityKey, v: 1,
      payload: { connectionIdentityKey: 'A'.repeat(43) } }, { expectedRevision: 'absent' });
    const completions: JsonValue[] = [];
    const peerCompletions: JsonValue[] = [];
    const completionCallers: PluginInvocationContext['caller'][] = [];
    const committedBindingCounts: number[] = [];
    const warnings = vi.fn();
    let completionFailure: 'approval_required' | 'outcome_uncertain' | undefined;
    let completionUnavailable = false;
    let baselineFailure: PluginError | undefined;
    let baselineReadCount = 0;
    const completionPlugin = definePlugin({ id: 'example.first-link-completion', version: '1.0.0',
      actions: { complete: {
        title: 'Complete an explicitly linked Session', execution: { target: 'daemon' }, surfaces: ['plugin'],
        dangerLevel: 'safe', inputSchema: SessionPullRequestLinkCompletionInputV1Schema,
        resultSchema: SessionPullRequestLinkCompletionResultV1Schema,
        run: async (input, context) => {
          completions.push(input);
          completionCallers.push(context.caller);
          committedBindingCounts.push([...state.rows.values()].filter(row => !row.deleted
            && row.value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.binding).length);
          if (completionFailure) throw new PluginError({ code: completionFailure, message: completionFailure });
          return { kind: completionUnavailable ? 'unavailable' as const : 'added' as const };
        },
      } },
      contributesTo: { 'happier.channels': {
        [SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_ID_V1]: {
          external: SessionPullRequestLinkCompletionsContributionProtocolV1.contribute({ descriptor: {},
            operations: { complete: SessionPullRequestLinkCompletionsContributionProtocolV1.operations.complete.bind('complete') } }),
        },
      } },
    });
    const completion = await createPluginTestkit({ manifest: completionPlugin.manifest, module: completionPlugin });
    const peerPlugin = definePlugin({ id: 'example.second-link-completion', version: '1.0.0', actions: {
      complete: { title: 'Complete another link presentation', execution: { target: 'daemon' }, surfaces: ['plugin'],
        dangerLevel: 'safe', inputSchema: SessionPullRequestLinkCompletionInputV1Schema,
        resultSchema: SessionPullRequestLinkCompletionResultV1Schema,
        run: input => { peerCompletions.push(input); return { kind: 'present' as const }; } },
    }, contributesTo: { 'happier.channels': {
      [SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_ID_V1]: {
        peer: SessionPullRequestLinkCompletionsContributionProtocolV1.contribute({ descriptor: {}, operations: {
          complete: SessionPullRequestLinkCompletionsContributionProtocolV1.operations.complete.bind('complete'),
        } }),
      },
    } } });
    const peer = await createPluginTestkit({ manifest: peerPlugin.manifest, module: peerPlugin });
    const execute = vi.fn(async (actionId: string, input: JsonValue) => {
      const sessionId = input !== null && typeof input === 'object' && !Array.isArray(input) ? input.sessionId : undefined;
      if (actionId === 'session.transcript.get') {
        if (input !== null && typeof input === 'object' && 'cursor' in input) {
          baselineReadCount += 1;
          if (baselineFailure !== undefined) throw baselineFailure;
        }
        return { ok: true, projection: 'externalShareableV1', sessionId, items: [], scannedThroughSeq: 0, hasMore: false };
      }
      if (actionId === 'session.targets.resolve') return { coverage: 'complete', addresses: [{ serverId: 'srv_plugin_testkit', sessionId: 'session-1' }], error: null };
      if (actionId === 'plugins.settings.list') return { ok: true, kind: 'plugins.settings.list', data: {
        scope: { kind: 'account' }, target: { kind: 'account' }, revision: '1', fields: [],
      } };
      if (actionId === 'session.status.get') {
        expect(input).toEqual({ sessionId, includeAcceptedWorkspace: true });
        return { session: { id: sessionId }, acceptedWorkspace: {
          checkout: { serverId: 'srv_plugin_testkit', workspaceId: 'workspace-1', machineId: currentMachineId, rootPath: '/accepted/repo' },
          repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' },
        } };
      }
      throw new Error(`Unexpected host Action ${actionId}`);
    });
    // Only Account persistence and host Session reads are supplied here; the
    // real manifests, Action handlers, provider selection and codecs compose.
    const core = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: CHANNELS_PLUGIN,
      targetedContributionContributors: [provider, completion, peer],
      resolveCurrentPluginMaterializationRef: () => ({ pluginId: PLUGIN_MANIFEST.id,
        machineId: currentMachineId, materializationId: 'channels-native-core' }),
      services: { logger: { debug() {}, info() {}, warn: warnings, error() {}, diagnostic() {} },
      storage: { account: { collection(definition: { id: string }) {
        if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected Collection');
        return state;
      } } } as unknown as PluginServices['storage'],
      // Account settings persistence is a host boundary; declaration/default
      // selection remains the production Watch policy owner.
      settings: { forScope: () => ({
        snapshot: async () => ({ scope: { kind: 'account' as const }, revision: '1', values: {} }),
        get: async () => null,
        describe: () => [],
        watch: () => ({ dispose() {} }),
        set: async () => { throw new Error('Watch must not mutate Settings'); },
        reset: async () => { throw new Error('Watch must not mutate Settings'); },
      }) },
      actions: { execute } as unknown as PluginServices['actions'] },
    });
    let completionObservations = 0;
    let disposedCompletionObservations = 0;
    const services = { targetedContributions: {
      observeForSelf<T>(point: TargetedContributionPointRef<T>, options: Readonly<{ onInvalidated: () => void }>) {
        const isCompletion = point.id === SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_ID_V1;
        const observation = channelsOperationOnlyTargetedContributionsFixture(core,
          isCompletion ? SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_REF_V1 : CHANNELS_PROVIDER_POINT_REF, [GITHUB_PLUGIN.manifest])
          .observeForSelf(point, options);
        if (isCompletion) completionObservations += 1;
        return { ...observation, dispose() {
          if (isCompletion) disposedCompletionObservations += 1;
          observation.dispose();
        } };
      },
    } };
    try {
      const credentialRef = credential;
      const input = { kind: 'attach', sessionId: 'session-1', pullRequestUrl: 'https://github.com/acme/widgets/pull/12', credentialRef };
      const stateReads = vi.spyOn(state, 'get');
      const result = SessionPullRequestBindingResultV1Schema.parse(await core.invokeAction('session-pull-request-binding-v1', input, {
        surface: 'mcp', services,
      }));
      expect(result).toMatchObject({ kind: 'attached', bindingId: expect.any(String) });
      if (result.kind !== 'attached') throw new Error('Expected an attached PR');
      const connectionId = state.rows.get(result.bindingId)?.value[CHANNEL_STATE_FIELD.connectionId];
      // Cold create consumes the write receipt; only the binding's final CAS
      // admission reads the connection. Resolvers reuse the admitted facts.
      expect(stateReads.mock.calls.filter(([id]) => id === connectionId)).toHaveLength(1);
      // Setup reads repository/viewer; test reads viewer/comment access. The
      // admitted endpoint and audience each need only their own native read.
      expect(requests.map(request => new URL(request.url).pathname).sort()).toEqual([
        '/repos/acme/widgets', '/repos/acme/widgets/issues/12', '/repos/acme/widgets/issues/comments',
        '/search/users', '/user', '/user',
      ]);
      expect(completions).toEqual([{ v: 1, session: { serverId: 'srv_plugin_testkit', sessionId: 'session-1' } }]);
      expect(peerCompletions).toEqual(completions);
      expect(completionCallers[0]).toMatchObject({ kind: 'plugin', pluginId: 'happier.channels' });
      expect(committedBindingCounts).toEqual([1]);
      expect(completionObservations).toBe(1);
      expect(disposedCompletionObservations).toBe(completionObservations);
      if (result.kind !== 'attached') throw new Error('Expected the existing PR link');
      const linkedAtMs = (await state.get(result.bindingId))?.value[CHANNEL_STATE_FIELD.createdAt];
      expect(linkedAtMs).toEqual(expect.any(Number));
      expect((await state.get(result.bindingId))?.value.payload).toMatchObject({ enabled: false, target: {
        kind: 'session', sessionId: 'session-1', pullRequestLink: { repository: 'acme/widgets', number: 12 },
      } });
      expect(requests.some(request => new URL(request.url).pathname === '/repos/acme/widgets/issues/12')).toBe(true);
      expect(requests.every(request => request.method === undefined || request.method === 'GET')).toBe(true);
      await expect(core.invokeAction('session-pull-request-binding-v1', { ...input, expectedRepositoryId: '88' }, {
        surface: 'mcp', services,
      })).rejects.toMatchObject({ code: 'channels_pr_link_repository_mismatch' });
      await expect(core.invokeAction('session-pull-request-binding-v1', { ...input, credentialRef: null }, {
        surface: 'mcp', services,
      })).rejects.toMatchObject({ code: 'channels_pr_link_native_origin_unavailable' });
      const read = () => core.invokeAction('session-pull-request-binding-v1', {
        kind: 'readRelations', credentialRef, pullRequest: { repositoryId: '77', number: 12 },
      }, { surface: 'plugin', services });
      const beforeRead = requests.length;
      expect(await read()).toMatchObject({ kind: 'relations', links: [{ bindingId: result.bindingId,
        sessionId: 'session-1', repositoryId: '77', pullRequest: { repository: 'acme/widgets', number: 12 }, linkedAtMs }] });
      expect(requests).toHaveLength(beforeRead);
      expect(await core.invokeAction('session-pull-request-binding-v1', { kind: 'list', sessionId: 'session-1' },
        { surface: 'mcp', services })).toMatchObject({ kind: 'links', sessionId: 'session-1' });
      expect(completions).toHaveLength(1);
      expect(await core.invokeAction('session-pull-request-binding-v1', { kind: 'readRelations',
        credentialRef: { ...credential, accountId: 'another-account' },
        pullRequest: { repositoryId: '77', number: 12 },
      }, { surface: 'plugin', services })).toEqual({ kind: 'relations', links: [] });
      expect(await core.invokeAction('session-pull-request-binding-v1', input, {
        surface: 'mcp', services,
      })).toEqual(result);
      expect(completions).toHaveLength(2);
      expect(await read()).toMatchObject({ kind: 'relations', links: [{ linkedAtMs }] });
      const retained = await state.get(result.bindingId);
      if (!retained) throw new Error('Missing attached binding');
      const configured = await core.invokeAction('session-pull-request-watch-v1', {
        kind: 'configure', sessionId: 'session-1', bindingId: result.bindingId, expectedRevision: retained.revision,
        policy: { mode: 'notify', archiveAfterMerge: false },
      }, { surface: 'ui' });
      expect(configured).toMatchObject({ kind: 'updated', bindingId: result.bindingId });
      expect(await core.invokeAction('session-pull-request-binding-v1', input, {
        surface: 'mcp', services,
      })).toEqual(result);
      expect(completions).toHaveLength(3);
      expect((await state.get(result.bindingId))?.value.payload).toMatchObject({ enabled: true,
        target: { pullRequestWatch: { policy: { mode: 'notify' } } } });
      expect(await read()).toMatchObject({ kind: 'relations', links: [{ linkedAtMs }] });
      const metadata = await core.invokeAction('session-pull-request-watch-v1', { kind: 'get', sessionId: 'session-1' }, { surface: 'ui', services });
      expect(metadata).toMatchObject({ kind: 'ready', sessionId: 'session-1', bindings: [{ bindingId: result.bindingId,
        watch: { policy: { mode: 'notify' }, reason: null, fixAttemptLimit: 3, roundsStarted: 0 }, latestUpdate: null,
      }] });
      await state.put({ id: 'retained-pr-update', 'record-kind': 'ingress-obligation',
        'session-id': 'session-1', 'binding-id': result.bindingId, 'pr-update-at': 20,
        payload: { occurrenceIds: ['provider-cycle-1'], sessionInput: { sessionId: 'session-1', localId: 'accepted-input-1' },
          prUpdate: { v: 1, bindingId: result.bindingId, sessionId: 'session-1',
            pullRequest: { repository: 'acme/widgets', number: 12 }, head: { sha: 'head-sha', ref: 'feature' },
            events: [{ kind: 'comment', id: 'comment-1', revision: '1', occurredAt: 20,
              author: { principalId: 'reviewer', kind: 'person' }, body: 'Please update this.' }] } },
      }, { expectedRevision: 'absent' });
      expect(await core.invokeAction('session-pull-request-watch-v1', { kind: 'get', sessionId: 'session-1' }, { surface: 'ui', services }))
        .toMatchObject({ kind: 'ready', bindings: [{ latestUpdate: { occurrenceId: 'provider-cycle-1', occurredAtMs: 20,
          kinds: ['comment'], location: { kind: 'sessionInput', localId: 'accepted-input-1' } } }] });
      await expect(core.invokeAction('session-pull-request-watch-v1', {
        kind: 'configure', sessionId: 'session-1', bindingId: result.bindingId, expectedRevision: retained.revision,
        policy: { mode: 'autoFix', archiveAfterMerge: false },
      }, { surface: 'ui' })).rejects.toMatchObject({ code: 'channels_pr_watch_conflict' });
      expect(completions).toHaveLength(3);
      expect(peerCompletions).toHaveLength(3);
      warnings.mockClear();
      completionUnavailable = true;
      expect(await core.invokeAction('session-pull-request-binding-v1', input, { surface: 'mcp', services })).toEqual(result);
      expect(completions).toHaveLength(4);
      expect(peerCompletions).toHaveLength(4);
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(warnings.mock.calls[0]?.[1]).toMatchObject({ sessionId: 'session-1',
        pluginId: completionPlugin.manifest.id, contributionId: 'external' });
      completionUnavailable = false;
      for (const failure of ['approval_required', 'outcome_uncertain'] as const) {
        completionFailure = failure;
        const before = completions.length;
        expect(await core.invokeAction('session-pull-request-binding-v1', input, { surface: 'mcp', services })).toEqual(result);
        expect(completions).toHaveLength(before + 1);
        expect(peerCompletions).toHaveLength(completions.length);
        expect(disposedCompletionObservations).toBe(completionObservations);
      }
      await completion.dispose();
      const beforeRetirement = completions.length;
      const peerBeforeRetirement = peerCompletions.length;
      expect(await core.invokeAction('session-pull-request-binding-v1', input, { surface: 'mcp', services })).toEqual(result);
      expect(completions).toHaveLength(beforeRetirement);
      expect(peerCompletions).toHaveLength(peerBeforeRetirement + 1);
      expect(disposedCompletionObservations).toBe(completionObservations);
      // The same Account/repository/principal rejoins on another Machine with
      // its own selected credential, without transferring the retained Watch.
      const retainedConnection = await state.get(String(connectionId));
      const retainedBinding = await state.get(result.bindingId);
      currentMachineId = 'machine-2';
      const rejoinCredential = { ...credential, accountId: '100' };
      materializedAccounts.length = 0;
      requests.length = 0;
      expect(await core.invokeAction('session-pull-request-binding-v1', {
        ...input, credentialRef: rejoinCredential,
      }, { surface: 'mcp', services })).toEqual(result);
      expect(materializedAccounts.length).toBeGreaterThan(0);
      for (const account of materializedAccounts) expect(account).toEqual(rejoinCredential);
      expect(requests.map(request => new URL(request.url).pathname).sort()).toEqual([
        '/repos/acme/widgets', '/repos/acme/widgets/issues/12', '/repos/acme/widgets/issues/comments',
        '/search/users', '/user', '/user',
      ]);
      expect(await state.get(String(connectionId))).toEqual(retainedConnection);
      expect([...state.rows.values()].filter(row => row.value[CHANNEL_STATE_FIELD.recordKind] === 'connection')).toHaveLength(1);
      expect((await state.get(result.bindingId))?.value.payload).toEqual(retainedBinding?.value.payload);
      expect(await read()).toMatchObject({ kind: 'relations', links: [{ linkedAtMs }] });
      for (const failure of [{ code: 'unsupported_action', retryable: false }, { code: 'connection_unavailable', retryable: true }]) {
        baselineFailure = new PluginError({ ...failure, message: 'PRIVATE_TRANSCRIPT_DIAGNOSTIC', details: { private: 'PRIVATE_TRANSCRIPT_DETAIL' } });
        const before = peerCompletions.length;
        const beforeBaselineReads = baselineReadCount;
        const rejected = core.invokeAction('session-pull-request-binding-v1', {
          ...input, sessionId: 'session-2', credentialRef: rejoinCredential,
        }, { surface: 'mcp', services });
        await expect(rejected).rejects.toMatchObject({ ...failure,
          details: { reason: 'transcriptUnavailable' },
        });
        await expect(rejected).rejects.not.toHaveProperty('message', 'PRIVATE_TRANSCRIPT_DIAGNOSTIC');
        await expect(rejected).rejects.not.toHaveProperty('details.private');
        expect(baselineReadCount - beforeBaselineReads).toBe(1);
        expect(peerCompletions).toHaveLength(before);
        expect(await read()).toMatchObject({ kind: 'relations', links: [{ sessionId: 'session-1', bindingId: result.bindingId }] });
      }
      baselineFailure = undefined;
      const second = SessionPullRequestBindingResultV1Schema.parse(await core.invokeAction('session-pull-request-binding-v1', {
        ...input, sessionId: 'session-2', credentialRef: rejoinCredential,
      }, { surface: 'mcp', services }));
      expect(second).toMatchObject({ kind: 'attached' });
      if (second.kind !== 'attached') throw new Error('Expected the second Session PR link');
      expect(second.bindingId).not.toBe(result.bindingId);
      expect(await state.get(String(connectionId))).toEqual(retainedConnection);
      expect((await state.get(result.bindingId))?.value.payload).toEqual(retainedBinding?.value.payload);
      expect((await state.get(second.bindingId))?.value.payload).toMatchObject({ enabled: false,
        target: { kind: 'session', sessionId: 'session-2', pullRequestLink: { repository: 'acme/widgets', number: 12 } },
      });
      expect(await read()).toMatchObject({ kind: 'relations', links: expect.arrayContaining([
        expect.objectContaining({ bindingId: result.bindingId, sessionId: 'session-1', linkedAtMs }),
        expect.objectContaining({ bindingId: second.bindingId, sessionId: 'session-2' }),
      ]) });
      execute.mockClear();
      requests.length = 0;
      const beforeBulkCompletion = peerCompletions.length;
      const bulk = SessionPullRequestBindingResultV1Schema.parse(await core.invokeAction('session-pull-request-binding-v1', {
        kind: 'attach', sessionId: 'session-1', credentialRef: rejoinCredential,
        pullRequests: [...[12, 13, 14, 15].map(number => ({ repository: 'acme/widgets', number })),
          { repository: 'ACME/Widgets', number: 13 }],
      }, { surface: 'mcp', services }));
      expect(bulk).toMatchObject({ kind: 'links', pullRequestLinks: [12, 13, 14, 15].map(number => ({ number })) });
      // Request admission and repository setup are shared; only endpoint work
      // scales with distinct PRs. A recursive singular Action would multiply both.
      expect(execute.mock.calls.filter(([id, input]) => id === 'session.transcript.get'
        && input !== null && typeof input === 'object' && !('cursor' in input))).toHaveLength(1);
      expect(execute.mock.calls.filter(([id]) => id === 'session.status.get')).toHaveLength(1);
      expect(requests.filter(request => new URL(request.url).pathname === '/repos/acme/widgets')).toHaveLength(1);
      expect(requests.filter(request => new URL(request.url).pathname === '/repos/acme/widgets/issues/13')).toHaveLength(1);
      expect(peerCompletions).toHaveLength(beforeBulkCompletion + 1);
      expect(await core.invokeAction('session-pull-request-binding-v1', {
        kind: 'attach', sessionId: 'session-1', credentialRef: rejoinCredential,
        pullRequestUrls: ['https://github.com/acme/widgets/pull/13', 'https://github.com/acme/widgets/pull/14'],
      }, { surface: 'mcp', services })).toMatchObject({ kind: 'links', pullRequestLinks: [12, 13, 14, 15].map(number => ({ number })) });
      const beforeInvalidAttach = requests.length;
      await expect(core.invokeAction('session-pull-request-binding-v1', {
        kind: 'attach', sessionId: 'session-1', credentialRef: rejoinCredential,
        pullRequests: [{ repository: 'acme/widgets', number: 13 }, { repository: 'acme/another', number: 22 }],
      }, { surface: 'mcp', services })).rejects.toMatchObject({ code: 'channels_pr_link_checkout_not_verified' });
      expect(requests).toHaveLength(beforeInvalidAttach);
      const bulkRelations = SessionPullRequestBindingResultV1Schema.parse(await core.invokeAction('session-pull-request-binding-v1', {
        kind: 'readRelations', sessionId: 'session-1', credentialRef,
      }, { surface: 'plugin', services }));
      if (bulkRelations.kind !== 'relations') throw new Error('Expected retained bulk relationships');
      for (const relation of bulkRelations.links) {
        const stateName = relation.pullRequest.number === 12 ? 'merged' : relation.pullRequest.number === 13 ? 'closed'
          : relation.pullRequest.number === 14 ? 'open' : undefined;
        if (stateName === undefined) continue;
        const row = await state.get(relation.bindingId);
        if (!row || typeof row.value.payload !== 'object' || row.value.payload === null || Array.isArray(row.value.payload)) throw new Error('Missing bulk binding');
        const endpoint = row.value.payload.endpoint;
        if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) throw new Error('Missing PR endpoint');
        await state.put({ ...row.value, payload: { ...row.value.payload, endpoint: { ...endpoint,
          pullRequestState: { state: stateName, observedAt: 40 } } } }, { expectedRevision: row.revision });
        if (relation.pullRequest.number === 14) await state.put({ ...row.value, id: 'stale-merged-pr-14',
          'binding-id': 'stale-merged-pr-14', payload: { ...row.value.payload, endpoint: { ...endpoint,
            pullRequestState: { state: 'merged', observedAt: 39 } } } }, { expectedRevision: 'absent' });
      }
      const beforeFilteredUnlink = requests.length;
      execute.mockClear();
      expect(await core.invokeAction('session-pull-request-binding-v1', {
        kind: 'unlink', sessionId: 'session-1', states: ['merged', 'closed'],
      }, { surface: 'mcp', services })).toEqual({ kind: 'removed' });
      expect(execute.mock.calls.filter(([id]) => id === 'session.transcript.get')).toHaveLength(1);
      expect(requests).toHaveLength(beforeFilteredUnlink);
      expect(await core.invokeAction('session-pull-request-binding-v1', { kind: 'list', sessionId: 'session-1' },
        { surface: 'mcp', services })).toMatchObject({ kind: 'links', pullRequestLinks: [{ number: 14 }, { number: 15 }] });
      const remaining = bulkRelations.links.filter(link => link.pullRequest.number >= 14);
      const operands = await Promise.all(remaining.map(async link => ({ bindingId: link.bindingId,
        expectedRevision: (await state.get(link.bindingId))!.revision })));
      await expect(core.invokeAction('session-pull-request-binding-v1', { kind: 'unlink', sessionId: 'session-1',
        bindings: [...operands, { bindingId: second.bindingId, expectedRevision: (await state.get(second.bindingId))!.revision }],
      }, { surface: 'mcp', services })).rejects.toMatchObject({ code: 'channels_pr_link_binding_not_verified' });
      await expect(core.invokeAction('session-pull-request-binding-v1', { kind: 'unlink', sessionId: 'session-1',
        bindings: operands.map((operand, index) => index === 1 ? { ...operand, expectedRevision: operand.expectedRevision + 1 } : operand),
      }, { surface: 'mcp', services })).rejects.toMatchObject({ code: 'channels_pr_link_conflict' });
      expect(await core.invokeAction('session-pull-request-binding-v1', { kind: 'list', sessionId: 'session-1' },
        { surface: 'mcp', services })).toMatchObject({ kind: 'links', pullRequestLinks: [{ number: 14 }, { number: 15 }] });
      expect(await core.invokeAction('session-pull-request-binding-v1', { kind: 'unlink', sessionId: 'session-1',
        bindings: operands }, { surface: 'mcp', services })).toEqual({ kind: 'removed' });
      expect(await core.invokeAction('session-pull-request-binding-v1', { kind: 'list', sessionId: 'session-1' },
        { surface: 'mcp', services })).toEqual({ kind: 'links', sessionId: 'session-1', pullRequestLinks: [] });
      expect(await core.invokeAction('session-pull-request-binding-v1', { kind: 'list', sessionId: 'session-2' },
        { surface: 'mcp', services })).toMatchObject({ kind: 'links', pullRequestLinks: [{ number: 12 }] });
      expect(requests.every(request => request.method === undefined || request.method === 'GET')).toBe(true);
      const beforeUnlink = peerCompletions.length;
      const current = await state.get(result.bindingId);
      if (!current) throw new Error('Missing retained link before explicit unlink');
      expect(await core.invokeAction('session-pull-request-binding-v1', { kind: 'unlink', sessionId: 'session-1',
        bindingId: result.bindingId, expectedRevision: current.revision }, { surface: 'mcp', services })).toEqual({ kind: 'removed' });
      expect(peerCompletions).toHaveLength(beforeUnlink);
    } finally { await core.dispose(); await completion.dispose(); await peer.dispose(); await provider.dispose(); }
  });
});
