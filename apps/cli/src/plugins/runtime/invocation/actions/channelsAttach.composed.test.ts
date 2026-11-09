import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import type { JsonValue, PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { createTargetActionExecutor } from '../actionExecutor';
import { createUnavailablePluginInvocationServiceBinding } from '../services/factory';
import { createPluginInvocationActionsService } from '../services/actions';
import { createPluginActionCallerMaterializationFixture } from '../services/actionCaller.testkit';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliTranscriptActionDeps } from '@/session/actions/cliActionDeps/transcript';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { encodeBase64, encrypt } from '@/api/encryption';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { CHANNELS_PLUGIN, CHANNELS_PROVIDER_POINT_REF, PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/channels/src/manifest';
import { GITHUB_PLUGIN } from '../../../../../../../packages/plugins/scm-github/src/manifest';
import { MemoryCollection } from '../../../../../../../packages/plugins/channels/src/testkit/memoryCollection';
import { channelsOperationOnlyTargetedContributionsFixture } from '../../../../../../../packages/plugins/channels/src/testkit/operationOnlyTargetedContributionsFixture';
import { CHANNEL_STATE_FIELD, CHANNEL_STATE_FIXED_ROW_ID, CHANNEL_STATE_RECORD_KIND } from '../../../../../../../packages/plugins/channels/src/collections';

afterEach(() => vi.restoreAllMocks());

describe('Session PR attach through current-intent and registered Channels management', () => {
  it.each(['cli', 'ui'] as const)('links an E2EE Session with an unsettled older turn through %s', async surface => {
    const secret = new Uint8Array(32).fill(13);
    const credentials = { token: 'fixture-owner-token', encryption: { type: 'legacy' as const, secret } };
    // Home HTTP is the boundary: lookup, crypto admission, Action dispatch and
    // the Channels no-history frontier all run their production implementations.
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }) };
      if (path === '/v2/sessions/c1234567890123456789012345') return { status: 200, data: { session: createSessionRecordFixture({ id: 'c1234567890123456789012345', encryptionMode: 'e2ee', seq: 4 }) } };
      if (path === '/v1/sessions/c1234567890123456789012345/messages') return { status: 200, data: {
        messages: [2, 4].map(seq => ({ id: `old-${seq}`, seq, createdAt: seq, messageRole: 'user',
          content: { t: 'encrypted', c: encodeBase64(encrypt(secret, 'legacy', { role: 'user', content: { type: 'text', text: 'older input' } })) } })),
        hasMore: true, publicationBlocked: false,
        externalShareableSnapshot: { turns: [], turnSettlementBlockedFromSeq: 2 },
      } };
      throw new Error(`Unexpected Home HTTP read ${path}`);
    });
    const transcriptActions = createPluginInvocationActionsService({
      seed: { plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
        occurrenceId: 'channels', surface, signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture(PLUGIN_MANIFEST.id).resolveCurrentPluginMaterializationRef },
      actionExecutor: createActionExecutor({ ...createUnavailableActionTransportDeps(),
        ...createCliTranscriptActionDeps({ credentials }, { resolveServerRequestHeaders: () => ({ Authorization: `Bearer ${credentials.token}` }) }) }),
      invokeContributedAction: async () => { throw new Error('Unexpected nested contributed Action'); },
    });
    expect(await transcriptActions.execute('session.transcript.get', {
      sessionId: 'c1234567890123456789012345', projection: 'externalShareableV1', cursor: null,
    })).toMatchObject({ items: [], scannedThroughSeq: 0, hasMore: true });
    get.mockClear();
    const input = { kind: 'attach', sessionId: 'c1234567890123456789012345', pullRequestUrl: 'https://github.com/acme/widgets/pull/12',
      credentialRef: { service: { pluginId: GITHUB_PLUGIN.manifest.id, localId: 'github-account' }, accountId: '99' } };
    const paths: string[] = [];
    const http = createPluginHttpFixture({ request: async request => {
      if (request.method && request.method !== 'GET') throw new Error('Attach must not write to GitHub');
      const path = new URL(request.url).pathname;
      paths.push(path);
      const body = path === '/repos/acme/widgets' ? { id: 77, full_name: 'acme/widgets', name: 'widgets', owner: { login: 'acme' } }
        : path === '/user' ? { id: 99, login: 'native-user' }
        : path === '/repos/acme/widgets/issues/comments' ? []
        : path === '/repos/acme/widgets/issues/12' ? { id: 300, number: 12, title: 'Existing PR', pull_request: {} }
        : path === '/search/users' ? { items: [{ id: 99, login: 'native-user', type: 'User' }] } : undefined;
      if (body === undefined) throw new Error(`Unexpected GitHub read ${path}`);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) };
    } });
    const provider = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
      resolveCurrentPluginMaterializationRef: () => ({ pluginId: GITHUB_PLUGIN.manifest.id, machineId: 'machine-1', materializationId: 'github' }),
      services: { http: { ...http, async openWebSocket() { throw new Error('No socket'); } }, connectedAccounts: {
        getBinding: async () => { throw new Error('Exact credential must not fall back'); },
        materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-token' } }),
      } as unknown as PluginServices['connectedAccounts'] },
    });
    const state = new MemoryCollection<Record<string, JsonValue>>();
    await state.put({ id: CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey,
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.connectionIdentityKey, v: 1,
      payload: { connectionIdentityKey: 'A'.repeat(43) } }, { expectedRevision: 'absent' });
    const core = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: CHANNELS_PLUGIN,
      targetedContributionContributors: [provider],
      resolveCurrentPluginMaterializationRef: () => ({ pluginId: PLUGIN_MANIFEST.id, machineId: 'machine-1', materializationId: 'channels' }),
      // Only host Session reads, Account persistence, HTTP and credential acquisition
      // are substituted. The manifests, binding policy and both plugins stay real.
      services: { storage: { account: { collection: () => state } },
        actions: { execute: async (id: string, input: JsonValue) => {
          if (id === 'session.transcript.get') return transcriptActions.execute(id, input);
          if (id === 'session.targets.resolve') return { coverage: 'complete', addresses: [{ serverId: 'srv_plugin_testkit', sessionId: 'c1234567890123456789012345' }], error: null };
          if (id === 'session.status.get') return { session: { id: 'c1234567890123456789012345' }, acceptedWorkspace: {
            checkout: { serverId: 'srv_plugin_testkit', workspaceId: 'workspace-1', machineId: 'machine-1', rootPath: '/accepted/repo' },
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' },
          } };
          if (id === 'plugins.settings.list') return { ok: true, kind: id, data: { scope: { kind: 'account' }, target: { kind: 'account' }, revision: '1', fields: [] } };
          throw new Error(`Unexpected host Action ${id}`);
        } } as unknown as PluginServices['actions'],
        settings: { forScope: () => ({ snapshot: async () => ({ scope: { kind: 'account' as const }, revision: '1', values: {} }),
          get: async () => null, describe: () => [], watch: () => ({ dispose() {} }),
          set: async () => { throw new Error('No Settings write'); }, reset: async () => { throw new Error('No Settings reset'); } }) },
      },
    });
    const declaration = normalizePluginManifestV2(PLUGIN_MANIFEST).contributes.actions.find(a => a.id === 'session-pull-request-binding-v1');
    if (!declaration) throw new Error('Missing Channels binding declaration');
    const approvals: TargetActionApprovalRequestV1[] = [];
    const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
      create: async request => { approvals.push(request); return { artifactId: 'attach-ask' }; }, read: async () => null,
    });
    let ask: boolean | undefined;
    let handlerFailure: unknown;
    const executor = createTargetActionExecutor({
      resolve: () => ({ ...declaration, qualifiedId: 'happier.channels/actions/session-pull-request-binding-v1',
        pluginId: PLUGIN_MANIFEST.id, localId: declaration.id, occurrenceId: '7', hostAccess: [], input,
        sourceCustody: { kind: 'development', registeredRootId: 'channels' }, policyFingerprint: 'b'.repeat(64),
        ...(ask === undefined ? {} : { approvalRequiredByActionSettings: ask }) }),
      resolveAuthorizationFacts: () => ({ generation: { targetGeneration: '7', desiredGeneration: '7', appliedGeneration: '7' },
        resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
      resolveHostBinding: async action => ({ action, serviceBinding: createUnavailablePluginInvocationServiceBinding('7', 'cli-attach') }),
      requestCurrentIntent,
      invoke: async () => {
        try {
          return { status: 'executed', value: await core.invokeAction(declaration.id, input, { surface, services: {
            targetedContributions: channelsOperationOnlyTargetedContributionsFixture(core, CHANNELS_PROVIDER_POINT_REF, [GITHUB_PLUGIN.manifest]),
          } }) };
        } catch (error) { handlerFailure = error; throw error; }
      },
    });
    const invoke = () => executor.execute({ pluginId: PLUGIN_MANIFEST.id, localId: declaration.id, input,
      surface, invocationAuthority: 'account_automation' });
    try {
      const result = await invoke();
      expect(handlerFailure).toBeUndefined();
      expect(result.status, result.status === 'failed' ? result.code : undefined).toBe('executed');
      expect(result).toMatchObject({ status: 'executed', value: { kind: 'attached' } });
      const frontier = [...state.rows.values()].find(row => row.value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.projectionFrontier);
      expect(frontier?.value.payload).toMatchObject({ targetSessionId: 'c1234567890123456789012345', transcriptCursor: '4', lastScannedSeq: 4 });
      // PR-link admission still proves transcript access once; acquiring the
      // no-history baseline adds no message read or publication wait.
      expect(get.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/messages'))).toHaveLength(1);
      expect(approvals).toHaveLength(0);
      expect(paths).toHaveLength(6);
      expect(await core.invokeAction(declaration.id, { kind: 'readRelations', credentialRef: input.credentialRef,
        pullRequest: { repositoryId: '77', number: 12 } }, { surface, services: {
          targetedContributions: channelsOperationOnlyTargetedContributionsFixture(core, CHANNELS_PROVIDER_POINT_REF, [GITHUB_PLUGIN.manifest]),
        } }))
        .toMatchObject({ kind: 'relations', links: [{ sessionId: 'c1234567890123456789012345', repositoryId: '77' }] });
      if (surface === 'cli') {
        const rowsBeforeAsk = [...state.rows.values()];
        ask = true;
        expect(await invoke()).toEqual({ status: 'deferred', artifactId: 'attach-ask' });
        expect(approvals).toHaveLength(1);
        expect(approvals[0]).toMatchObject({ requestedSurface: surface, input });
        expect(paths).toHaveLength(6);
        expect([...state.rows.values()]).toEqual(rowsBeforeAsk);
      }
    } finally { await core.dispose(); await provider.dispose(); }
  });
});
