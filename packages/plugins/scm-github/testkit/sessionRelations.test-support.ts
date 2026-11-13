import type { JsonValue, PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { GITHUB_TEST_ACCOUNT, createStubGithubTransport, githubChecksBatchResponse } from '../src/triage/testkit/githubTriage.test-support.js';
import { GITHUB_PULL_REQUEST_RESPONSE, GITHUB_REPOSITORY_RESPONSE } from '../src/triage/__fixtures__/githubResponses.js';
import { GITHUB_PLUGIN } from '../src/manifest.js';
import { encodeGithubTriageConfiguration } from '../src/triage/configuration.js';
import { buildGithubEntryLocator } from '../src/triage/locator.js';
import { toTriageLocator } from '../src/triage/mapping/protocol.js';
import { CHANNELS_PLUGIN } from '../../channels/src/manifest.js';
import * as collections from '../../channels/src/collections.js';
import { MemoryCollection } from '../../channels/src/testkit/memoryCollection.js';
import { channelsOperationOnlyTargetedContributionsFixture } from '../../channels/src/testkit/operationOnlyTargetedContributionsFixture.js';

/** Real registered GitHub → Channels writes; only HTTP, credentials, host
 * Session reads and Account persistence are supplied at their system boundaries. */
export async function createGithubSessionRelationTestkit(options: Readonly<{ refuseRepositoryRead?: boolean; sessionWorkspace?: 'none' | 'other-repository' }> = {}) {
  const transport = createStubGithubTransport({ respond: request => {
    const path = new URL(request.url).pathname;
    if (path === '/repositories/4210') return options.refuseRepositoryRead
      ? { status: 403, headers: { 'x-github-request-id': 'github-repository-read-403' }, body: { message: 'Forbidden' } }
      : { status: 200, body: GITHUB_REPOSITORY_RESPONSE };
    if (path === '/user') return { status: 200, body: { id: 99, login: 'fixture-user' } };
    if (path === '/search/users') return { status: 200, body: { items: [{ id: 99, login: 'fixture-user', type: 'User' }] } };
    if (path.endsWith('/issues/comments') || path.endsWith('/sub_issues') || path.endsWith('/blocked_by')) return { status: 200, body: [] };
    if (path.endsWith('/parent')) return { status: 404, body: {} };
    if (path.endsWith('/issues/1284')) return { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE, pull_request: {} } };
    if (path.endsWith('/pulls/1284')) return { status: 200, body: GITHUB_PULL_REQUEST_RESPONSE };
    if (path.endsWith('/graphql')) return githubChecksBatchResponse(request);
    return undefined;
  } });
  const providerServices = { http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    // Cross-plugin host dispatch enters the actual registered Channels Action,
    // including its input/result schemas; it never manufactures an acknowledgement.
    actions: { execute: async (action: Readonly<{ pluginId: string; localId: string }>, input: JsonValue,
      options?: Readonly<{ signal?: AbortSignal }>) => {
      if (action.pluginId !== CHANNELS_PLUGIN.manifest.id) throw new Error('Unexpected relation Action target');
      return invokeBinding(action.localId, input, options?.signal);
    } } as unknown as PluginServices['actions'],
  };
  const placement = (pluginId: string) => () => ({ pluginId, machineId: 'relation-machine', materializationId: `${pluginId}-fixture` });
  const provider = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
    resolveCurrentPluginMaterializationRef: placement(GITHUB_PLUGIN.manifest.id), services: providerServices });
  const state = new MemoryCollection<Record<string, JsonValue>>();
  const deliveries = new MemoryCollection<Record<string, JsonValue>>();
  await state.put({ id: collections.CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey,
    [collections.CHANNEL_STATE_FIELD.recordKind]: collections.CHANNEL_STATE_RECORD_KIND.connectionIdentityKey,
    v: 1, payload: { connectionIdentityKey: 'A'.repeat(43) } }, { expectedRevision: 'absent' });
  const core: Awaited<ReturnType<typeof createPluginTestkit>> = await createPluginTestkit({
    manifest: CHANNELS_PLUGIN.manifest, module: CHANNELS_PLUGIN, targetedContributionContributors: [provider],
    resolveCurrentPluginMaterializationRef: placement(CHANNELS_PLUGIN.manifest.id),
    services: {
      storage: { account: { collection: (definition: { id: string }) => {
        if (definition.id === collections.CHANNEL_STATE_COLLECTION.id) return state;
        if (definition.id === collections.CHANNEL_DELIVERIES_COLLECTION.id) return deliveries;
        throw new Error(`Unexpected Channels Collection ${definition.id}`);
      } } } as unknown as PluginServices['storage'],
      settings: { forScope: () => ({ snapshot: async () => ({ scope: { kind: 'account' }, revision: '1', values: {} }),
        get: async () => null, describe: () => [], watch: () => ({ dispose() {} }),
        set: async () => { throw new Error('Linking must not mutate Settings'); },
        reset: async () => { throw new Error('Linking must not mutate Settings'); } }) },
      actions: { execute: async (actionId: string, input: JsonValue) => {
        const sessionId = input !== null && typeof input === 'object' && 'sessionId' in input ? input.sessionId : undefined;
        if (actionId === 'session.targets.resolve') return { coverage: 'complete', addresses: [{ serverId: 'srv_plugin_testkit', sessionId }], error: null };
        if (actionId === 'session.transcript.get') return { ok: true, projection: 'externalShareableV1', sessionId,
          items: [], scannedThroughSeq: 0, hasMore: false };
        if (actionId === 'session.status.get' && options.sessionWorkspace === 'none') return { session: { id: sessionId } };
        if (actionId === 'session.status.get') return { session: { id: sessionId }, acceptedWorkspace: {
          checkout: { serverId: 'srv_plugin_testkit', workspaceId: 'workspace-1', machineId: 'relation-machine', rootPath: '/accepted/repo' },
          repository: { kind: 'github', deployment: 'https://github.com', repository: options.sessionWorkspace === 'other-repository' ? 'other-org/other-repo' : 'octo-org/example-app' },
        } };
        throw new Error(`Unexpected host Action ${actionId}`);
      } } as unknown as PluginServices['actions'],
    },
  });
  const invokeBinding = (localId: string, input: JsonValue, signal?: AbortSignal) => core.invokeAction(localId, input, {
    surface: 'plugin', ...(signal === undefined ? {} : { signal }), services: { targetedContributions: {
      observeForSelf: (point, options) => channelsOperationOnlyTargetedContributionsFixture(core, point, [GITHUB_PLUGIN.manifest])
        .observeForSelf(point, options),
    } },
  });
  const seed = createTriageSourceV1Fixture().configuredInstance;
  const token = encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'selected', unitIds: ['octo-org/example-app'] } });
  if (token === null) throw new Error('Invalid configured GitHub fixture');
  const instance = { ...seed, instance: { ...seed.instance, source: { pluginId: GITHUB_PLUGIN.manifest.id, localId: 'github-forge' } },
    binding: { purpose: 'github-connected-account', account: GITHUB_TEST_ACCOUNT }, localInstanceKey: 'github.com', configuration: { v: 1 as const, token } };
  const localRef = { kindId: 'pull-request', collisionScope: 'github:4210', entryId: '1284' };
  const locator = buildGithubEntryLocator({ owner: 'octo-org', name: 'example-app', entryNumber: localRef.entryId,
    webUrl: 'https://github.com/octo-org/example-app/pull/1284' });
  if (locator === null) throw new Error('Invalid GitHub entry fixture');
  return { source: provider, invokeBinding, instance, localRef, locator: toTriageLocator(locator), state, transport,
    async dispose() { await core.dispose(); await provider.dispose(); } };
}
