import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionConnectedServiceAuthSwitchOptionsResultSchema } from '@happier-dev/protocol/connect/sessionConnectedServiceAuthSwitch';
import { TeamCredentialResourceEntitledPageV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import type { RpcHandler } from '@/api/rpc/types';
import { createSessionConnectedServiceAuthOptionsReader } from '@/daemon/connectedServices/sessionAuthSwitch/readSessionConnectedServiceAuthOptions';
import { createRequesterSessionAccountContextCustody } from '@/daemon/sessionEncryption/requesterSessionAccountContextCustody';
import { mintSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import type { TrackedSession } from '@/daemon/types';
import { teamSummaryFixture } from '../../../../ui/sources/dev/testkit/fixtures/teamFixtures';
import { registerMachineRpcHandlers } from './rpcHandlers';

const accountId = 'owner';
const machineId = 'machine-1';
const serverId = 'home-1';
const serverHttpBaseUrl = 'https://muse-route-options.test';
const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
const serviceId = buildQualifiedPluginContributionKey(service);
const teamSelection = {
  source: 'team_resource', resourceId: 'team-route', deliveryMode: 'direct',
  disclosedMember: { service, accountId: 'team-member' },
} as const;
const team = teamSummaryFixture();

afterEach(() => vi.restoreAllMocks());

it.each([
  { sessionId: 'auth-failed-stopped', active: false, teamScoped: false },
  { sessionId: 'healthy-running', active: true, teamScoped: false },
  { sessionId: 'team-stopped', active: false, teamScoped: true },
])('returns admitted routes for $sessionId through the Machine and Account owners', async ({ sessionId, active, teamScoped }) => {
  const credentials = { token: 'test-token', encryption: null } as const;
  const profileSelection = { source: 'connected', selection: 'profile', profileId: active ? 'subscription' : 'invalid-key' } as const;
  const connectedServices = { v: 2, bindingsByServiceId: { [serviceId]: teamScoped ? teamSelection : profileSelection } } as const;
  const metadata = { machineId, path: '/test/workspace', host: 'test', flavor: 'muse', connectedServices };
  const signal = new AbortController().signal;
  const teamRoutes = TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [{
    id: teamSelection.resourceId, teamId: team.id, resourceRevision: 7, displayName: null,
    readiness: { kind: 'available' }, recoveryAction: null, mayBroker: false, mayReceiveDirect: true,
    directMaterialState: 'never_delivered', sessionUsePolicy: 'team_visibility_required',
    connectedServiceSelections: [teamSelection], providerModels: [],
    sourcePresentation: { kind: 'connected_service', service },
  }], nextCursor: null });
  // Home HTTP is the only external boundary. No live runner, provider or control server is installed.
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    expect(config?.signal).toBe(signal);
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return { status: 200, data: { id: accountId,
      connectedAccountsV4: [
        { ref: { service, accountId: 'subscription' }, status: 'connected', kind: 'oauth', displayName: 'Subscription', authenticationModeId: 'device',
          configurationReady: true, configurationRevision: null, revisionSemantics: 'legacy_unfenced', credentialRevision: null },
        { ref: { service, accountId: 'invalid-key' }, status: 'needs_reauth', kind: 'token', displayName: 'Invalid key', authenticationModeId: 'api-key',
          configurationReady: true, configurationRevision: null, revisionSemantics: 'legacy_unfenced', credentialRevision: null },
      ],
    } };
    if (!active && path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (!active && path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: {
      id: sessionId, active, seq: 0, activeAt: 1, createdAt: 1, updatedAt: 1, dataEncryptionKey: null,
      metadata: JSON.stringify(metadata), metadataVersion: 1, agentState: null, agentStateVersion: 0, encryptionMode: 'plain',
      ...(teamScoped ? { primaryTeamId: team.id } : {}),
    } } };
    throw new Error(`Unexpected Home GET ${path}`);
  });
  vi.spyOn(axios, 'request').mockImplementation(async (config) => {
    expect(config.signal).toBe(signal);
    const path = new URL(String(config.url)).pathname;
    if (path === '/v1/teams/list') return { status: 200, data: { items: teamScoped ? [team] : [], nextCursor: null } };
    if (teamScoped && path === '/v1/teams/credential-resources/entitled/list') {
      expect(config.data).toMatchObject({ teamId: team.id, executionMachineId: machineId });
      return { status: 200, data: teamRoutes };
    }
    throw new Error(`Unexpected Home POST ${path}`);
  });
  const trackedSessions = new Map<TrackedSession['trackingKey'], TrackedSession>();
  if (active) {
    const trackingKey = mintSessionTrackingKey();
    trackedSessions.set(trackingKey, {
      trackingKey, pid: 1, startedBy: 'daemon', happySessionId: sessionId,
      happySessionMetadataFromLocalWebhook: metadata,
    });
  }
  const { withSessionAccountContext } = createRequesterSessionAccountContextCustody({
    trackedSessions, externalActionAccountId: accountId, machineId, serverId, isRetired: () => false,
  });
  const handlers = new Map<string, RpcHandler>();
  const registration = registerMachineRpcHandlers({
    rpcHandlerManager: { registerHandler: (method, handler) => handlers.set(method, handler as RpcHandler) },
    handlers: { spawnSession: async () => { throw new Error('The options read started a runner'); },
      stopSession: async () => { throw new Error('The options read stopped a runner'); }, requestShutdown() {} },
    deps: { currentMachineId: machineId, readSessionConnectedServiceAuthOptions: createSessionConnectedServiceAuthOptionsReader({
      credentials, serverId, requesterCustodyServerId: serverId, serverHttpBaseUrl, machineId,
      findTrackedSession: id => [...trackedSessions.values()].find(item => item.happySessionId === id),
      withSessionAccountContext, isRetired: () => false,
    }) },
  });
  try {
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_OPTIONS);
    if (!handler) throw new Error('Expected the Machine options handler');
    const result = SessionConnectedServiceAuthSwitchOptionsResultSchema.parse(await handler({ sessionId }, {
      signal, authorization: { kind: 'session.read', sessionId },
      machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId,
        installationId: 'test-installation', role: 'manage', encryptionMode: 'plain' },
    }));
    if (!result.ok) throw new Error(result.errorCode);
    expect(result.options.map(option => option.label)).toEqual(teamScoped ? ['Subscription', 'Team credential'] : ['Subscription']);
    expect(result.options[0]?.routing.bindings.bindingsByServiceId[serviceId])
      .toEqual({ source: 'connected', selection: 'profile', profileId: 'subscription' });
    if (teamScoped) expect(result.options[1]?.routing).toMatchObject({
      bindings: { bindingsByServiceId: { [serviceId]: teamSelection } },
      teamCredentialBindings: [{ resourceId: teamSelection.resourceId, expectedResourceRevision: 7, deliveryMode: 'direct' }],
      teamVisibilityGrantConsent: { teamId: team.id },
    });
  } finally { await registration.dispose(); }
});
