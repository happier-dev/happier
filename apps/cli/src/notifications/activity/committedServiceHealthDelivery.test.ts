import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { x25519 } from '@noble/curves/ed25519';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { HealthCheckSourceConfigV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { PushNotificationClient } from '@/api/pushNotifications';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { registerDaemonCommittedServiceHealthDeliveryRpcHandler } from './committedServiceHealthDelivery';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { createAutomationAccountEncryptionMaterialSnapshotV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createEphemeralPluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createStablePluginNotificationsOwner } from '@/plugins/runtime/invocation/services/notifications';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PLUGIN_MANIFEST as slackManifest, activate as activateSlack } from '@happier-dev/plugins-channel-slack';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

describe('committed service health receiver admission', () => {
  it('binds the Home identity once at receiver admission', async () => {
    const source = await readFile(new URL('./committedServiceHealthDelivery.ts', import.meta.url), 'utf8');
    expect([...source.matchAll(/\bisServerProfileHomeIdentity\(/g)]).toHaveLength(1);
    expect([...source.matchAll(/\breadAccountIdFromToken\(/g)]).toHaveLength(0);
  });
  it.each(['plain', 'e2ee'] as const)('delivers the exact private %s revision with one admission and one Artifact read', async mode => {
    const accountId = 'health-owner';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const machineKey = new Uint8Array(randomBytes(32));
    const credentials = { token, encryption: mode === 'plain' ? null
      : { type: 'dataKey' as const, machineKey, publicKey: x25519.getPublicKey(machineKey) } };
    const material = createAutomationAccountEncryptionMaterialSnapshotV1(credentials);
    const currentness = createAccountEncryptionCurrentnessFixture({ mode, contentKeyFingerprint: material
      ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) : null });
    const baseUrl = `http://committed-health-${mode}.test`;
    const rows = new Map<string, { id: string } & Record<string, unknown>>();
    const reads: string[] = [];
    let savedSource: ReturnType<typeof AutomationDefinitionDetailSchema.parse> | null = null;
    let sourceReads = 0;
    let sourceUnavailable = false;
    // Only Home HTTP, installed-runtime lifetime and native push are boundary
    // substitutes; RPC admission, C1 codecs/privacy and dispatch remain real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: currentness };
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), [...rows.values()]) };
      const row = rows.get(path.split('/')[3]!);
      if (row && path.endsWith('/recipients')) return { status: 200, data: {
        artifactId: row.id, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
        dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey,
        provenanceDataEncryptionKey: row.provenanceDataEncryptionKey,
        callerProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey, recipients: [],
      } };
      return row ? { status: 200, data: row } : { status: 404, data: {} };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, input: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v3/automations/query') {
        sourceReads++;
        if (sourceUnavailable) throw Object.assign(new Error('Saved source unavailable'), { code: 'health_source_access_unavailable' });
        return { status: 200, data: { automations: savedSource ? [savedSource] : [], nextCursor: null } };
      }
      if (path === '/v1/artifacts/read') {
        reads.push(path);
        return artifactReadResponse(input, id => rows.get(id) ?? null);
      }
      const mutation = readCarrierMutation(input);
      const id = typeof mutation.id === 'string' ? mutation.id : path.split('/').at(-1)!;
      const version = Number(rows.get(id)?.bodyVersion ?? 0) + 1;
      rows.set(id, { ...rows.get(id), ...mutation, id, ownerAccountId: accountId, access: 'owner',
        publicAudience: 'none', encryptionMode: mode, headerVersion: version, bodyVersion: version,
        seq: version, createdAt: 1, updatedAt: version });
      return { status: 200, data: { id, success: true, headerVersion: version, bodyVersion: version } };
    });
    const push = vi.spyOn(PushNotificationClient.prototype, 'sendToAllDevicesAsync').mockResolvedValue(true);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
      notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [
        NotificationChannelRecordV1Schema.parse({ v: 1, id: 'health-push', kind: 'expo_push', topics: { machines: true } }),
      ] } });
    const subject = { kind: 'deployment', machineId: 'source-machine', environmentId: 'environment',
      environmentInstanceId: 'instance', composeService: 'db', serviceId: 'instance/db' } as const;
    const store = createCredentialedAccountArtifactStore(credentials);
    const receipt = await runWithServerHttpBaseUrl(baseUrl, () => store.writeNotice({ accountId,
      source: { kind: 'host', topic: 'service_health', subject }, page: { kind: 'host', page: 'machine_service',
        machine: { serverId: 'home', machineId: subject.machineId }, service: subject },
      title: 'db needs attention', type: 'blocked', healthPhase: 'open', resolved: false, body: 'Service health: failed.' }));
    let admissionReads = 0;
    let admitted = true;
    const runtimeCurrent = vi.fn(async () => true);
    const receiver = new RpcHandlerManager({ scopePrefix: 'controller', localMachineId: 'controller',
      encryptionMode: 'plain', logger: () => {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'controller', resolveCustodianAccountId: async () => accountId,
        resolveInstallationId: () => 'installation',
        verifyMachineAdmission: async () => { admissionReads++; return admitted; },
      }) });
    registerDaemonCommittedServiceHealthDeliveryRpcHandler(receiver, {
      target: () => ({ serverId: 'home', machineId: 'controller', installationId: 'installation', custodianAccountId: accountId }),
      resolveRuntime: async () => ({ credentials, accountId, serverId: 'home', serverHttpBaseUrl: baseUrl,
        machineId: 'controller', isCurrent: runtimeCurrent }),
    });
    const invoke = (actorAccountId = accountId, revision = receipt.revision, serverId = 'home',
      alerts?: HealthCheckSourceConfigV1['alerts'], artifactId = receipt.artifactId) => receiver.handleRequest({
      method: `controller:${RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER}`,
      callerAuthority: 'account_automation', params: { machineId: 'controller', serverId, artifactId, revision,
        ...(alerts === undefined ? {} : { alerts }) },
      machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ machineId: 'controller', installationId: 'installation',
        actorAccountId, custodianAccountId: accountId, role: 'manage', encryptionMode: mode }),
    });
    const testMissingSource = () => receiver.handleRequest({
      method: `controller:${RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER}`, callerAuthority: 'account_automation',
      params: { kind: 'test', machineId: 'controller', serverId: 'home', sourceInstanceId: 'saved-source',
        channelId: 'health-push', channelIndex: 0, expectedSourceRevision: 'missing-source' },
      machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ machineId: 'controller', installationId: 'installation',
        actorAccountId: accountId, custodianAccountId: accountId, role: 'manage', encryptionMode: mode }),
    });
    expect(await testMissingSource()).toEqual({ status: 'unavailable', controllerMachineId: 'controller', channelId: 'health-push',
      reason: 'health_check_source_unconfigured' });
    expect(push).not.toHaveBeenCalled();
    sourceUnavailable = true;
    expect(await testMissingSource()).toEqual({ status: 'unavailable', controllerMachineId: 'controller', channelId: 'health-push',
      reason: 'health_source_access_unavailable' });
    sourceUnavailable = false;
    expect(await invoke(accountId, receipt.revision, 'home', { channels: [], phases: ['open'] })).toEqual({ kind: 'attempted' });
    expect(push).not.toHaveBeenCalled();
    admissionReads = 0;
    reads.length = 0;
    expect(await invoke()).toEqual({ kind: 'attempted' });
    expect(admissionReads).toBe(1);
    const artifactPath = `/v1/artifacts/${encodeURIComponent(receipt.artifactId)}`;
    expect(reads.filter(path => path === artifactPath)).toHaveLength(1);
    expect(reads.filter(path => path !== artifactPath && !path.startsWith('/v1/account/encryption'))).toEqual([]);
    expect(runtimeCurrent).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
    // Each new request is a natural admission boundary, including denial.
    const pushes = push.mock.calls.length;
    expect(await invoke('another-person')).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(await invoke(accountId, receipt.revision, 'another-home')).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(push).toHaveBeenCalledTimes(pushes);
    const committedRevision = receipt.revision;
    if (!committedRevision) throw new Error('Committed notice revision is required');
    expect(await invoke(accountId, { ...committedRevision, bodyVersion: committedRevision.bodyVersion + 1 })).toEqual({ kind: 'suppressed' });
    expect(push).toHaveBeenCalledTimes(pushes);
    const row = rows.get(receipt.artifactId)!;
    rows.set(receipt.artifactId, { ...row, ownerAccountId: 'another-person' });
    expect(await invoke()).toEqual({ kind: 'suppressed' });
    expect(push).toHaveBeenCalledTimes(pushes);
    rows.set(receipt.artifactId, row);
    const recovery = await runWithServerHttpBaseUrl(baseUrl, () => store.writeNotice({ accountId,
      source: { kind: 'host', topic: 'service_health', subject }, page: { kind: 'host', page: 'machine_service',
        machine: { serverId: 'home', machineId: subject.machineId }, service: subject },
      title: 'db recovered', type: 'update', healthPhase: 'recovered', resolved: false, body: 'Service health: recovered.' }));
    expect(await invoke(accountId, recovery.revision)).toEqual({ kind: 'suppressed' });
    expect(push).toHaveBeenCalledTimes(pushes);
    expect(await invoke(accountId, recovery.revision, 'home', {
      channels: [{ channelId: 'health-push' }], phases: ['recovered'],
    })).toEqual({ kind: 'attempted' });
    expect(push).toHaveBeenCalledTimes(pushes + 1);
    if (mode === 'plain') {
      const eventRef = HEALTH_CHECK_EVENT_REFS_V1.failed;
      const triggerId = AutomationTriggerIdSchema.parse('11111111-1111-4111-8111-111111111111');
      const binding = { v: 1 as const, automationId: 'saved-health', triggerId, triggerRevision: 0,
        triggerKind: 'pluginEvent' as const, eventRef, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('c79a9957-537c-4f21-a08d-289245801c05') };
      const save = (alerts: NonNullable<HealthCheckSourceConfigV1['alerts']>) => {
        savedSource = AutomationDefinitionDetailSchema.parse({ id: binding.automationId, name: 'Saved health',
          description: null, enabled: true, targetType: null, existingSessionId: null, templateVersion: 1,
          lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
          observationOnly: { kind: 'observationOnly', templateVersion: 1 }, triggers: [{ id: triggerId, revision: 0,
            enabled: true, createdAt: 1, updatedAt: 1, kind: 'pluginEvent', eventRef,
            sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
            observation: { kind: 'checkpointedPull', watcher: { machineId: 'controller', machineInstallationId: 'installation',
              pluginId: eventRef.pluginId, materializationId: 'services' } }, sourceStatus: null, sourceCatalogStatus: null,
            triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ binding, mode: 'plain',
              definition: { v: 1, sourceInstanceId: 'saved-source', sourceConfig: { v: 1,
                subject: { kind: 'machineService', machineId: 'watched-service', serviceId: 'db' }, checks: [{ checkId: 'tcp',
                  kind: { pluginId: eventRef.pluginId, localId: 'tcp' }, binding: { kind: 'healthCheck' },
                  config: { host: 'localhost', port: 5432 }, periodMs: 60000, consecutiveFailuresBeforeAlerting: 1 }], alerts },
                displayLabel: 'Saved health', filter: null, maximumObservationAgeMs: null } })) }] });
      };
      const test = (expectedSourceRevision = `saved-health:${triggerId}:0`) => receiver.handleRequest({
        method: `controller:${RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER}`, callerAuthority: 'account_automation',
        params: { kind: 'test', machineId: 'controller', serverId: 'home', sourceInstanceId: 'saved-source',
          channelId: 'health-push', channelIndex: 0, expectedSourceRevision },
        machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ machineId: 'controller', installationId: 'installation',
          actorAccountId: accountId, custodianAccountId: accountId, role: 'manage', encryptionMode: mode }),
      });
      save({ channels: [], phases: ['open', 'recovered'] });
      expect(await test()).toEqual({ status: 'off', controllerMachineId: 'controller', channelId: 'health-push' });
      expect(push).toHaveBeenCalledTimes(pushes + 1);
      save({ channels: [{ channelId: 'health-push' }], phases: ['open', 'recovered'] });
      expect(await test('stale')).toMatchObject({ status: 'unavailable', reason: 'health_check_source_revision_changed' });
      sourceReads = 0;
      const preview = await receiver.handleRequest({
        method: `controller:${RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER}`, callerAuthority: 'account_automation',
        params: { kind: 'prepareTest', machineId: 'controller', serverId: 'home', sourceInstanceId: 'saved-source',
          channelId: 'health-push', channelIndex: 0, expectedSourceRevision: `saved-health:${triggerId}:0` },
        machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ machineId: 'controller', installationId: 'installation',
          actorAccountId: accountId, custodianAccountId: accountId, role: 'manage', encryptionMode: mode }),
      });
      expect(preview).toMatchObject({ controllerMachineId: 'controller', destination: { kind: 'expo_push', channelId: 'health-push' },
        request: { channelId: 'health-push', channelIndex: 0, expectedSourceRevision: `saved-health:${triggerId}:0` } });
      expect(preview).toHaveProperty('disclosure');
      expect(sourceReads).toBe(1);
      expect(push).toHaveBeenCalledTimes(pushes + 1);
      sourceReads = 0;
      expect(await test()).toEqual({ status: 'sent', controllerMachineId: 'controller', channelId: 'health-push' });
      expect(sourceReads).toBe(1);
      expect(push).toHaveBeenCalledTimes(pushes + 2);
      const destination = { connectionId: 'production-slack', endpoint: { kind: 'shared' as const,
        audience: 'shared' as const, id: 'deployments', label: 'Deployment alerts' } };
      const pluginId = 'example.slack';
      const pluginChannelId = `${pluginId}/alerts`;
      const emptyRuntime = await resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}), pluginIds: [] });
      const pluginNotifications = createStablePluginNotificationsOwner({ categories: [], channels: [{
        provenance: 'external', source: { kind: 'path' }, pluginId,
        definition: { id: 'alerts', kind: 'plugin', title: 'Slack', defaultEnabled: true,
          metadata: { destinationSetup: { pluginId, localId: 'notification-destination-setup' } } },
      }], activateChannel: async () => { throw new Error('Preparation must not activate a sender'); }, readChannel: () => null });
      // The installed runtime lease is the process boundary. Discovery and
      // metadata are supplied by the actual stable notifications owner.
      vi.spyOn(pluginReloadController, 'tryAcquireRuntimeRegistry').mockImplementation(() =>
        createEphemeralPluginRuntimeRegistryLease({ ...emptyRuntime, pluginNotifications }));
      save({ channels: [{ channelId: pluginChannelId, destination }], phases: ['open', 'recovered'] });
      sourceReads = 0;
      const providerPreview = await receiver.handleRequest({
        method: `controller:${RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER}`, callerAuthority: 'account_automation',
        params: { kind: 'prepareTest', machineId: 'controller', serverId: 'home', sourceInstanceId: 'saved-source',
          channelId: pluginChannelId, channelIndex: 0, expectedSourceRevision: `saved-health:${triggerId}:0` },
        machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ machineId: 'controller', installationId: 'installation',
          actorAccountId: accountId, custodianAccountId: accountId, role: 'manage', encryptionMode: mode }),
      });
      expect(providerPreview).toMatchObject({ controllerMachineId: 'controller', destination,
        request: { channelId: pluginChannelId } });
      expect(sourceReads).toBe(1);
      expect(push).toHaveBeenCalledTimes(pushes + 2);
      const secondDestination = { ...destination, endpoint: { ...destination.endpoint,
        id: 'production-incidents', label: 'Production incidents' } };
      save({ channels: [{ channelId: pluginChannelId, destination },
        { channelId: pluginChannelId, destination: secondDestination }], phases: ['open', 'recovered'] });
      sourceReads = 0;
      const secondPreview = await receiver.handleRequest({
        method: `controller:${RPC_METHODS.DAEMON_SERVICE_HEALTH_DELIVER}`, callerAuthority: 'account_automation',
        params: { kind: 'prepareTest', machineId: 'controller', serverId: 'home', sourceInstanceId: 'saved-source',
          channelId: pluginChannelId, channelIndex: 1, expectedSourceRevision: `saved-health:${triggerId}:0` },
        machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ machineId: 'controller', installationId: 'installation',
          actorAccountId: accountId, custodianAccountId: accountId, role: 'manage', encryptionMode: mode }),
      });
      expect(secondPreview).toMatchObject({ controllerMachineId: 'controller', destination: secondDestination,
        request: { channelId: pluginChannelId, channelIndex: 1 } });
      expect(sourceReads).toBe(1);
      expect(push).toHaveBeenCalledTimes(pushes + 2);
    } else {
      const kit = await createPluginTestkit({ manifest: slackManifest, module: { activate: activateSlack } });
      try {
        const sender = kit.registration('notificationChannels', 'alerts');
        if (!sender) throw new Error('Slack host sender registration missing');
        const writes: unknown[] = [];
        const connection = { v: 1, connectionId: 'production-slack', providerConnectionKey: 'slack:team:T1:app:A1',
          providerConfigVersion: 1, providerConfig: { teamId: 'T1', appId: 'A1', botUserId: 'U1', botId: 'B1', label: 'Happier' },
          credentialRef: { service: { pluginId: 'happier.channel.slack', localId: 'slack-bot' }, accountId: 'slack-test' },
          authorityEpoch: 1, enabled: true, deletionState: 'none', requiresFullSharedMessageContent: false };
        // Plugin host-service RPC, credential materialization and Slack HTTP are boundaries.
        const context = { plugin: { id: slackManifest.id, version: '0.0.0' }, surface: 'plugin', invokedAtMs: 1,
          contribution: { id: 'alerts', qualifiedId: `${slackManifest.id}/notificationChannels/alerts` },
          signal: new AbortController().signal, services: {
            actions: { execute: async () => ({ [connection.connectionId]: connection }) },
            connectedAccounts: { materialize: async () => ({ kind: 'environment', env: { SLACK_BOT_TOKEN: 'xoxb-test-bot', SLACK_APP_TOKEN: 'xapp-test-app' } }) },
            http: { request: async (request: Readonly<{ url: string; body?: Uint8Array }>) => {
              const url = new URL(request.url);
              const method = url.pathname.split('/').at(-1);
              const channel = url.searchParams.get('channel');
              const payload: unknown = request.body ? JSON.parse(new TextDecoder().decode(request.body)) : null;
              const postedChannel = payload !== null && typeof payload === 'object' && 'channel' in payload ? payload.channel : null;
              const body = method === 'auth.test' ? { ok: true, team_id: 'T1', user_id: 'U1', bot_id: 'B1' }
                : method === 'bots.info' ? { ok: true, bot: { id: 'B1', user_id: 'U1', app_id: 'A1', name: 'Happier' } }
                  : method === 'conversations.info' ? { ok: true, channel: { id: channel,
                    is_im: false, is_mpim: false, is_private: false, is_archived: false, name: channel } }
                    : method === 'chat.postMessage' ? { ok: true, channel: postedChannel, ts: '1700000000.000002' } : null;
              if (!body) throw new Error(`Unexpected Slack request ${method}`);
              if (method === 'chat.postMessage') writes.push(payload);
              return { status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
            } },
          } } as unknown as PluginInvocationContext;
        const pluginNotifications = createStablePluginNotificationsOwner({ categories: [], channels: [{
          provenance: 'external', source: { kind: 'path' }, pluginId: slackManifest.id,
          definition: { id: 'alerts', kind: 'plugin', title: 'Slack', defaultEnabled: true },
        }], activateChannel: async () => {}, readChannel: () => ({ occurrenceId: 'slack-current', isCurrent: () => true,
          send: (request, signal) => sender(request, { ...context, signal }) }) });
        const emptyRuntime = await resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}), pluginIds: [] });
        vi.spyOn(pluginReloadController, 'tryAcquireRuntimeRegistry').mockImplementation(() =>
          createEphemeralPluginRuntimeRegistryLease({ ...emptyRuntime, pluginNotifications }));
        const secondSubject = { ...subject, serviceId: 'instance/cache', composeService: 'cache' };
        const committed = await runWithServerHttpBaseUrl(baseUrl, () => store.writeNotice({ accountId,
          source: { kind: 'host', topic: 'service_health', subject: secondSubject }, page: { kind: 'host', page: 'machine_service',
            machine: { serverId: 'home', machineId: subject.machineId }, service: secondSubject },
          title: 'cache needs attention', type: 'blocked', healthPhase: 'open', resolved: false, body: 'Service health: failed.' }));
        const channels = ['C1', 'C2'].map(id => ({ channelId: `${slackManifest.id}/alerts`,
          destination: { connectionId: connection.connectionId, endpoint: { kind: 'shared', audience: 'shared', id: `slack:T1:channel:${id}` } } }));
        expect(await invoke(accountId, committed.revision, 'home', { channels, phases: ['open'] }, committed.artifactId))
          .toEqual({ kind: 'attempted' });
        expect(writes).toMatchObject([{ channel: 'C1' }, { channel: 'C2' }]);
      } finally { await kit.dispose(); }
    }
    admitted = false;
    expect(await invoke()).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(push).toHaveBeenCalledTimes(pushes + (mode === 'plain' ? 2 : 1));
  });
});
