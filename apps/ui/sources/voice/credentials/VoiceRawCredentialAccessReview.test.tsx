import { waitForTestEvent } from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { PluginPermissionSubjectV1Schema } from '@happier-dev/protocol/plugins/permissions/grants';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';

let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
vi.mock('socket.io-client', async original => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(original));
type MachineResponses = Readonly<{ inspect: (...args: never[]) => unknown; request: (...args: never[]) => unknown }>;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));

await loadSyncSingletonForTests();
const { t } = await import('@/text');
const { createPluginPermissionGrantActions } = await import('@/sync/domains/plugins/permissions/actions');
const { createPluginPermissionGrantHttpActionExecutor } = await import('@/sync/domains/plugins/permissions/api');
const { PluginPermissionGrantSheet } = await import('@/components/plugins/permissions/PluginPermissionGrantSheet');
const { RawCredentialAuthorizationClient } = await import('./rawCredentialAuthorizationClient');

function machineClient(responses: MachineResponses) {
  return new RawCredentialAuthorizationClient({
    machineRpc: async <R, A>(request: ServerScopedMachineRpcParams<A, R>): Promise<R> => {
      const respond = request.method === RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT
        ? responses.inspect : responses.request;
      const input = request.payload as { contribution: unknown; rawGrant: unknown };
      // Synthetic daemon transport bytes; the real client parses its wire response.
      return await Reflect.apply(respond, undefined, [input.contribution, input.rawGrant]) as R;
    },
  });
}

function httpActions(responders: Readonly<Record<string, (input: never) => unknown>>) {
  return createPluginPermissionGrantActions({ execute: createPluginPermissionGrantHttpActionExecutor({
    request: async (path, init) => {
      const operation = String(path).split('/').at(-1)!;
      const respond = responders[operation];
      if (!respond) throw new Error(`Unexpected permission request: ${path}`);
      // HTTP fixture dispatch is untyped; the real executor validates both wire sides.
      const response: unknown = await Reflect.apply(respond, undefined, [JSON.parse(String(init?.body))]);
      return Response.json(response);
    },
  }) });
}

const contribution = Object.freeze({ pluginId: 'acme.voice', localId: 'browser' });
const rawGrant = Object.freeze({
  realm: 'web' as const,
  phase: 'connection' as const,
  request: Object.freeze({
    kind: 'httpHeaders' as const,
    origin: 'https://voice.example.test',
    headerNames: Object.freeze(['authorization']),
  }),
});
const subject = PluginPermissionSubjectV1Schema.parse({
  kind: 'credential_access_disclosure' as const,
  contribution,
  credentialSlotId: 'api_key',
  purpose: 'voice.browser',
  accessDeclarationDigest: 'b'.repeat(64),
  selectedAuthorityDigest: 'c'.repeat(64),
  selectedRawAccessDigest: 'd'.repeat(64),
});
// The daemon supplies the authenticated Account and exact credential subject.
// A different installation within that Account is not a different custodian.
const thisInstallation = Object.freeze({
  kind: 'machine_installation' as const,
  machineId: 'machine-a',
  installationId: 'installation-1',
});
const otherMachine = Object.freeze({
  kind: 'machine_installation' as const,
  machineId: 'machine-b',
  installationId: 'installation-1',
});
const replacedInstallation = Object.freeze({
  kind: 'machine_installation' as const,
  machineId: 'machine-a',
  installationId: 'installation-2',
});
const authorization = Object.freeze({
  pluginId: contribution.pluginId,
  capability: 'credentials.materialize.raw' as const,
  targetScope: Object.freeze({ kind: 'account' as const }),
  subject,
  authoritySource: thisInstallation,
  // Mutable to match the protocol's `z.array(...)` output; freezing the array
  // is what previously forced the fixture behind an `as never` cast.
  disclosures: [{
    sourceClass: Object.freeze({ kind: 'savedSecret' as const, secretKinds: ['apiKey' as const] }),
    realm: 'web' as const,
    phase: 'connection' as const,
    materialization: 'httpHeaders' as const,
    origin: 'https://voice.example.test',
    destination: 'authorization',
  }],
});
const review = Object.freeze({
  plugin: Object.freeze({ id: contribution.pluginId, name: 'Acme Voice', version: '2.0.0' }),
  package: Object.freeze({ identity: '@acme/voice' }),
  distribution: Object.freeze({
    kind: 'npm' as const,
    packageName: '@acme/voice',
    registryOrigin: 'https://registry.npmjs.org',
  }),
  publisher: Object.freeze({ status: 'unavailable' as const }),
  contribution: Object.freeze({ identity: contribution, name: 'Browser Voice' }),
  credentialSlot: Object.freeze({ id: 'api_key', name: 'API key', purpose: 'voice.browser' }),
});

const pendingRequest = Object.freeze({
  v: 1 as const,
  id: 'request-1',
  accountId: 'account-1',
  pluginId: contribution.pluginId,
  capability: authorization.capability,
  targetScope: authorization.targetScope,
  subject,
  authoritySource: thisInstallation,
  requester: Object.freeze({ kind: 'plugin' as const, pluginId: contribution.pluginId }),
  reason: 'Voice provider raw credential access review',
  status: 'pending' as const,
  createdAt: 1,
  updatedAt: 1,
});

const subjectB = PluginPermissionSubjectV1Schema.parse({
  ...subject,
  selectedAuthorityDigest: 'e'.repeat(64),
});
const authorizationB = Object.freeze({
  ...authorization,
  subject: subjectB,
});
const reviewB = Object.freeze({
  ...review,
  credentialSlot: Object.freeze({
    ...review.credentialSlot,
    name: 'Account B API key',
  }),
});
const pendingRequestB = Object.freeze({
  ...pendingRequest,
  id: 'request-2',
  subject: subjectB,
});

const grant = Object.freeze({
  v: 1 as const,
  id: 'grant-1',
  accountId: 'account-1',
  pluginId: contribution.pluginId,
  capability: authorization.capability,
  targetScope: authorization.targetScope,
  subject,
  authoritySource: thisInstallation,
  status: 'active' as const,
  requestId: pendingRequest.id,
  grantedByUserId: 'user-1',
  grantedAt: 2,
  createdAt: 2,
  updatedAt: 2,
});

describe('VoiceRawCredentialAccessReview', () => {
  beforeEach(async () => {
    const features = createRootLayoutFeaturesResponse();
    tryWriteServerEnabledBitInPlace(features, 'machines.liveStream.serverRouted', true);
    tryWriteServerEnabledBitInPlace(features, 'encryption.plaintextStorage', true);
    account = await restoreServerAccountForTest({ serverUrl: `https://raw-${crypto.randomUUID()}.example.test`,
      accountId: 'account-1', credentialScope: 'restored-home', request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'account-1' }));
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
        if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'machine-a', accountId: 'account-1' })]);
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
          id => id === 'machine-a' ? createPlainMachineRowFixture({ id, accountId: 'account-1' }) : null);
        if (path === '/v1/machines/machine-a') return Response.json({ machine: createPlainMachineRowFixture({ id: 'machine-a', accountId: 'account-1' }) });
        return new Response('{}', { status: 404 });
      } });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().applySettingsForScope({ serverId: account.home.id, accountId: 'account-1' },
      (await import('@/sync/domains/settings/settings')).settingsParse({ voice: {
        executionMachine: { mode: 'fixed', machineId: 'machine-a' },
      } }), 1);
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', activeAt: Date.now(), installationId: 'installation-1' })], true, { sourceServerId: account.home.id });
    observeMachinePresenceForTest({ serverId: account.home.id, accountId: 'account-1' }, ['machine-a']);
  });
  afterEach(async () => { standardCleanup(); await account.dispose(); });

  it('hides the separate review and performs no permission reads for the shared linked decision', async () => {
    const entered = createDeferred<void>();
    const linked = { ok: true as const, authorization: { ...authorization, grantRequirement: 'linked' as const }, review };
    const response = createDeferred<typeof linked>();
    const inspected = vi.fn(() => { entered.resolve(); return response.promise; });
    const list = vi.fn(async () => ({ grants: [], pendingRequests: [] }));
    const { VoiceRawCredentialAccessReview } = await import('./VoiceRawCredentialAccessReview');
    const screen = await renderScreen(<VoiceRawCredentialAccessReview contribution={contribution} rawGrant={rawGrant}
      client={machineClient({ inspect: inspected, request: vi.fn() })} actions={httpActions({ list })} testID="raw-access" />);
    await act(async () => { await entered.promise; response.resolve(linked); });
    expect(screen.findHostByTestId('raw-access')).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('does not re-inspect for unrelated Account preference revisions', async () => {
    const client = {
      inspect: vi.fn(async () => ({ ok: true as const, authorization, review })),
      request: vi.fn(),
    };
    const actions = {
      list: vi.fn(async () => ({ grants: [], pendingRequests: [] })),
      request: vi.fn(), grant: vi.fn(), revoke: vi.fn(), dismissRequest: vi.fn(),
    };
    const { VoiceRawCredentialAccessReview } = await import('./VoiceRawCredentialAccessReview');
    const screen = await renderScreen(<VoiceRawCredentialAccessReview contribution={contribution} rawGrant={rawGrant}
      client={machineClient(client)} actions={httpActions(actions)} testID="raw-access" />);
    await waitForTestEvent(screen.subscribe, () => actions.list.mock.calls.length, count => count === 1);
    const initial = client.inspect.mock.calls.length;
    const { storage } = await import('@/sync/domains/state/storage');
    for (let index = 0; index < 20; index += 1) {
      await act(async () => { storage.setState(state => ({
        settings: { ...state.settings, analyticsOptOut: !state.settings.analyticsOptOut },
        settingsVersion: (state.settingsVersion ?? 0) + 1,
      })); });
    }
    expect(client.inspect.mock.calls.length - initial).toBe(0);
  });

  it('lists, requests, approves, and revokes the exact host-derived raw credential subject', async () => {
    const listed = createDeferred<void>();
    const requested = createDeferred<void>();
    const granted = createDeferred<void>();
    const revoked = createDeferred<void>();
    const client = {
      inspect: vi.fn(async () => ({ ok: true as const, authorization, review })),
      request: vi.fn(async () => { requested.resolve(); return { ok: true as const, authorization, review, pendingRequest }; }),
    };
    const actions = {
      list: vi.fn(async () => { listed.resolve(); return { grants: [], pendingRequests: [] }; }),
      request: vi.fn(),
      grant: vi.fn(async () => { granted.resolve(); return {
        grant,
        pendingRequest: { ...pendingRequest, status: 'granted' as const, grantId: grant.id, decidedAt: 2 },
      }; }),
      revoke: vi.fn(async () => { revoked.resolve(); return { grant: { ...grant, status: 'revoked' as const, revokedAt: 3 } }; }),
      dismissRequest: vi.fn(async () => ({
        pendingRequest: { ...pendingRequest, status: 'dismissed' as const, decidedAt: 3 },
      })),
    };
    const { VoiceRawCredentialAccessReview } = await import('./VoiceRawCredentialAccessReview');
    const screen = await renderScreen(
      <VoiceRawCredentialAccessReview
        contribution={contribution}
        rawGrant={rawGrant}
        client={machineClient(client)}
        actions={httpActions(actions)}
        testID="raw-access"
      />,
    );

    await act(async () => { await listed.promise; });
    expect(actions.list).toHaveBeenCalledWith({
      pluginId: contribution.pluginId,
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject,
      includeRevoked: false,
      includeResolvedRequests: false,
      limit: 200,
    });

    await act(async () => {
      screen.tree.findByTestId('raw-access')?.props.onPress();
    });
    await act(async () => { await requested.promise; });
    expect(client.request).toHaveBeenCalledWith(contribution, rawGrant);
    const sheet = screen.tree.findAllByType(PluginPermissionGrantSheet)[0] ?? null;
    expect(sheet).not.toBeNull();
    expect(JSON.stringify(sheet?.props.detailRows)).toContain('@acme/voice');
    expect(JSON.stringify(sheet?.props.detailRows)).toContain('https://registry.npmjs.org');
    expect(JSON.stringify(sheet?.props.detailRows)).not.toContain('registry-signing-key');
    expect(JSON.stringify(sheet?.props.detailRows)).not.toContain('recipientApprovalPackageSignature');
    expect(JSON.stringify(sheet?.props.detailRows)).not.toContain('verified publisher');
    expect(JSON.stringify(sheet?.props.detailRows)).toContain('authorization');
    expect(JSON.stringify(sheet?.props.detailRows)).not.toContain('secret-value');
    const decisionBody = sheet?.props.labels.body({ pluginName: 'Acme Voice' });
    expect(decisionBody).toContain(contribution.pluginId);
    expect(decisionBody).toContain(contribution.localId);
    expect(decisionBody).toContain('api_key');
    expect(decisionBody).toContain('savedSecret(apiKey)');
    expect(decisionBody).toContain('web');
    expect(decisionBody).toContain('connection');
    expect(decisionBody).not.toContain('credentials.materialize.raw');

    await act(async () => {
      screen.tree.pressByTestId('raw-access-sheet-grant');
      await granted.promise;
    });
    await waitForTestEvent(screen.subscribe, () => expect(screen.tree.findAll(node => node.props.testID === 'raw-access' && typeof node.props.title === 'string')[0]?.props.destructive).toBe(true));

    await act(async () => {
      screen.tree.findByTestId('raw-access')?.props.onPress();
    });
    await act(async () => { await revoked.promise; });
    expect(actions.revoke).toHaveBeenCalledWith({ grantId: grant.id });
    expect(actions.request).not.toHaveBeenCalled();
  });

  it('consumes an active Account approval without a second installation guard', async () => {
    const listed = createDeferred<void>();
    const client = {
      inspect: vi.fn(async () => ({ ok: true as const, authorization, review })),
      request: vi.fn(),
    };
    const actions = {
      list: vi.fn(async () => { listed.resolve(); return {
        grants: [
          { ...grant, id: 'grant-other-machine', authoritySource: otherMachine },
          { ...grant, id: 'grant-replaced-installation', authoritySource: replacedInstallation },
        ],
        pendingRequests: [
          { ...pendingRequest, id: 'request-other-machine', authoritySource: otherMachine },
        ],
      }; }),
      request: vi.fn(),
      grant: vi.fn(),
      revoke: vi.fn(),
      dismissRequest: vi.fn(),
    };
    const { VoiceRawCredentialAccessReview } = await import('./VoiceRawCredentialAccessReview');
    const screen = await renderScreen(
      <VoiceRawCredentialAccessReview
        contribution={contribution}
        rawGrant={rawGrant}
        client={machineClient(client)}
        actions={httpActions(actions)}
        testID="raw-access"
      />,
    );

    await act(async () => { await listed.promise; });
    expect(actions.list).toHaveBeenCalled();
    await waitForTestEvent(screen.subscribe, () => expect(screen.tree.findAll(node => node.props.testID === 'raw-access' && typeof node.props.title === 'string')[0]?.props.loading).toBe(false));
    expect(screen.tree.findAll(node => node.props.testID === 'raw-access' && typeof node.props.title === 'string')[0]?.props.destructive).toBe(true);
    expect(screen.tree.findAll(node => node.props.testID === 'raw-access' && typeof node.props.title === 'string')[0]?.props.detail)
      .toBe(t('common.applied'));
    expect(client.request).not.toHaveBeenCalled();
    expect(actions.revoke).not.toHaveBeenCalled();
  });

  it('revokes the active Account subject grant supplied by the shared owner', async () => {
    const listed = createDeferred<void>();
    const revoked = createDeferred<void>();
    const client = {
      inspect: vi.fn(async () => ({ ok: true as const, authorization, review })),
      request: vi.fn(async () => ({ ok: true as const, authorization, review, pendingRequest })),
    };
    const actions = {
      // Account-scoped grants are usable across its installations.
      list: vi.fn(async () => { listed.resolve(); return {
        grants: [
          { ...grant, id: 'grant-other-machine', authoritySource: otherMachine },
          grant,
        ],
        pendingRequests: [],
      }; }),
      request: vi.fn(),
      grant: vi.fn(),
      revoke: vi.fn(async () => { revoked.resolve(); return { grant: { ...grant, status: 'revoked' as const, revokedAt: 3 } }; }),
      dismissRequest: vi.fn(),
    };
    const { VoiceRawCredentialAccessReview } = await import('./VoiceRawCredentialAccessReview');
    const screen = await renderScreen(
      <VoiceRawCredentialAccessReview
        contribution={contribution}
        rawGrant={rawGrant}
        client={machineClient(client)}
        actions={httpActions(actions)}
        testID="raw-access"
      />,
    );

    await act(async () => { await listed.promise; });
    await waitForTestEvent(screen.subscribe, () => expect(screen.tree.findAll(node => node.props.testID === 'raw-access' && typeof node.props.title === 'string')[0]?.props.destructive).toBe(true));
    await act(async () => {
      screen.tree.findByTestId('raw-access')?.props.onPress();
    });
    await act(async () => { await revoked.promise; });
    expect(actions.revoke).toHaveBeenCalledWith({ grantId: 'grant-other-machine' });
  });

  it('re-inspects before deciding a captured request when account settings switch', async () => {
    let selectedAccount: 'A' | 'B' = 'A';
    const requested = createDeferred<void>();
    const listedB = createDeferred<void>();
    let relistedA = createDeferred<void>();
    const inspectionForSelectedAccount = () => selectedAccount === 'A'
      ? { ok: true as const, authorization, review }
      : { ok: true as const, authorization: authorizationB, review: reviewB };
    const client = {
      inspect: vi.fn(async () => inspectionForSelectedAccount()),
      request: vi.fn(async () => { requested.resolve(); return { ok: true as const, authorization, review, pendingRequest }; }),
    };
    const actions = {
      list: vi.fn(async (input: Readonly<{ subject: unknown }>) => {
        const accountB = JSON.stringify(input.subject) === JSON.stringify(subjectB);
        if (accountB) listedB.resolve(); else relistedA.resolve();
        return { grants: [], pendingRequests: accountB ? [pendingRequestB] : [] };
      }),
      request: vi.fn(),
      grant: vi.fn(),
      revoke: vi.fn(),
      dismissRequest: vi.fn(),
    };
    const { VoiceRawCredentialAccessReview } = await import('./VoiceRawCredentialAccessReview');
    const permissionActions = httpActions(actions);
    const rawClient = machineClient(client);
    const renderReview = () => (
      <VoiceRawCredentialAccessReview
        contribution={contribution}
        rawGrant={rawGrant}
        client={rawClient}
        actions={permissionActions}
        testID="raw-access"
      />
    );
    const screen = await renderScreen(renderReview());

    await act(async () => {
      screen.tree.findByTestId('raw-access')?.props.onPress();
    });
    await act(async () => { await requested.promise; });
    expect(client.request).toHaveBeenCalledWith(contribution, rawGrant);
    const staleSheet = screen.tree.findAllByType(PluginPermissionGrantSheet)[0] ?? null;
    expect(staleSheet).not.toBeNull();
    const staleGrant = screen.tree.findByTestId('raw-access-sheet-grant')?.props.onPress;
    const staleDismiss = screen.tree.findByTestId('raw-access-sheet-dismiss')?.props.onPress;

    selectedAccount = 'B';
    const { storage } = await import('@/sync/domains/state/storage');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    storage.setState(state => ({ settingsVersion: 2, settings: settingsParse({ ...state.settings,
      voiceSettingsV1: { ...state.settings.voiceSettingsV1, credentialBindings: [{ contribution,
        credentialSlotId: 'api_key', credentialSource: { kind: 'savedSecret' },
        credentialBindings: { account: { api_key: 'account-b-secret' } },
      }] },
    }) }));

    // A user decision can race the subscription render. The action itself
    // must therefore re-inspect rather than decide the captured request.
    await act(async () => {
      staleGrant?.();
    });
    await act(async () => { await listedB.promise; });
    await waitForTestEvent(screen.subscribe, () => {
      expect(screen.tree.findAllByType(PluginPermissionGrantSheet)[0]?.props.pendingRequest.id).toBe(pendingRequestB.id);
    });
    expect(JSON.stringify(screen.tree.findAllByType(PluginPermissionGrantSheet)[0]?.props.detailRows)).toContain('Account B API key');
    expect(actions.grant).not.toHaveBeenCalled();

    const inspectedBeforeDismissal = createDeferred<void>();
    client.inspect.mockImplementationOnce(async () => {
      inspectedBeforeDismissal.resolve();
      return inspectionForSelectedAccount();
    });
    await act(async () => { staleDismiss?.(); await inspectedBeforeDismissal.promise; });
    await flushHookEffects();
    expect(actions.dismissRequest).not.toHaveBeenCalled();

    // A further settings switch must re-derive the authorization on its own,
    // without any decision driving it.
    selectedAccount = 'A';
    relistedA = createDeferred<void>();
    storage.setState(state => ({ settingsVersion: 3, settings: { ...state.settings,
      voiceSettingsV1: { ...state.settings.voiceSettingsV1, credentialBindings: [] },
    } }));
    await act(async () => {
      screen.tree.update(renderReview());
    });
    await act(async () => { await relistedA.promise; });
    expect(actions.list).toHaveBeenLastCalledWith(expect.objectContaining({ subject }));
    await waitForTestEvent(screen.subscribe, () => expect(screen.tree.findByTestId('raw-access-sheet')).toBeNull());
    expect(screen.tree.findAll(node => node.props.testID === 'raw-access' && typeof node.props.title === 'string')[0]?.props.detail)
      .toBe(t('settingsVoice.externalCredentials.reviewRequired'));
  });
});
