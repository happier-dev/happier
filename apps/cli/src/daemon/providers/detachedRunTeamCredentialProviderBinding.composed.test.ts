import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import {
  computeTeamCredentialSourceMemberKeyV1, createTeamCredentialDirectMaterialStoredV1,
  TeamCredentialDirectMaterialPayloadV1Schema,
} from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { TeamCredentialResourceEntitledPageV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';

import { prepareExecutionRunRuntimeProviderLaunch } from '@/agent/runtime/bridges/executionRun/runtime/providerPreparation';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { readSessionTeamCredentialApplications } from '@/session/services/sessionTeamCredentialProviderCatalog';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';

import {
  createDetachedRunTeamCredentialProviderBindingPreparer,
  openDaemonSessionTeamCredentialProviderBinding,
} from './sessionTeamCredentialProviderBindingComposition';

function fixtureToken(accountId: string): string {
  return `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`;
}

it.each([
  { surface: 'detached Run', requester: 'guest', audience: 'guest', admitted: true },
  { surface: 'detached Run', requester: 'custodian', audience: 'custodian', admitted: true },
  { surface: 'detached Run', requester: 'guest', audience: 'custodian', admitted: false },
  { surface: 'detached Run', requester: 'guest', audience: 'custodian', admitted: false, teamHidden: true },
  { surface: 'detached Run', requester: 'guest', audience: 'guest', admitted: false, noModels: true },
  { surface: 'Session', requester: 'guest', audience: 'guest', admitted: true },
])('opens a $surface as $requester against the $audience-only Team offer ($admitted/$teamHidden/$noModels)', async ({
  surface, requester, audience, admitted, teamHidden, noModels,
}) => {
  const controller = createPluginReloadController();
  const fixture = await createManagedRunLaunchFixture({ controller });
  const home = vi.spyOn(axios, 'request');
  const material = vi.spyOn(axios, 'post');
  const encryption = vi.spyOn(axios, 'get');
  try {
    const { machineId, agentTargetKey, agentId, happyHomeDir } = fixture;
    const application = readSessionTeamCredentialApplications(fixture)
      .find(row => row.implementationIdentity.pluginId === 'acme.managed-run');
    if (!application) throw new Error('Fixture Agent does not support the offered application');
    const selection = {
      kind: 'team_credential_provider_model' as const, teamId: 'team', resourceId: `${audience}-offer`,
      expectedResourceRevision: 1, agentTargetKey, modelId: 'model-a', deliveryMode: 'direct' as const,
    };
    const sourceMember = { kind: 'provider_credential_slot' as const, connectionId: 'run-gateway', credentialSlotId: 'apiKey' };
    const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);
    const sourceVersion = 'fixture-source-version';
    const credentialTransport = { id: 'bearer', protocols: [application.protocol] as const, uses: ['runtime'] as const,
      destination: { kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const } };
    const offered = TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [{
      id: selection.resourceId, teamId: selection.teamId, resourceRevision: selection.expectedResourceRevision,
      displayName: null, readiness: { kind: 'available' }, recoveryAction: null, mayBroker: false, mayReceiveDirect: true,
      directMaterialState: 'current', sessionUsePolicy: 'personal_allowed', sourcePresentation: null,
      providerModels: [{ selection, application, descriptor: { id: selection.modelId, name: 'Model A' },
        sourceRevision: 'fixture-catalog', availability: 'available',
        sourceFacts: { endpoint: { id: application.endpointTemplateId, protocol: application.protocol,
          capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } },
          credential: { kind: 'apiKey', required: true, slotId: 'apiKey',
          transports: [credentialTransport] } },
        direct: { sourceMemberKey, sourceVersion } }],
    }] });
    const daemonHome = 'https://installed-home.example';
    const serverHttpBaseUrl = requester === 'guest' ? 'https://requester-home.example' : daemonHome;
    const recipientBearer = `Bearer ${fixtureToken(audience)}`;
    // The Home HTTP boundary exposes the offer to exactly one bearer.
    home.mockImplementation(async config => {
      expect(config.url).toBe(`${serverHttpBaseUrl}/v1/teams/credential-resources/entitled/list`);
      expect(config.data).toMatchObject({ resourceId: selection.resourceId, executionMachineId: machineId });
      if (config.headers?.Authorization === recipientBearer) {
        const data = noModels ? TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [{ ...offered.resources[0],
          sourcePresentation: { kind: 'connected_service', service: { pluginId: 'acme.managed-run', localId: 'accounts' } },
          providerModels: [],
        }] }) : offered;
        return { status: 200, data };
      }
      return teamHidden
        ? { status: 404, data: { error: 'not_found_or_not_visible' } }
        : { status: 200, data: { resources: [], nextCursor: null } };
    });
    const payload = TeamCredentialDirectMaterialPayloadV1Schema.parse({
      v: 1, domain: 'happier.team-credential-direct-material', homeServerIdentityId: 'home',
      teamId: selection.teamId, resourceId: selection.resourceId, resourceRevision: selection.expectedResourceRevision,
      recipientAccountId: audience, sourceMember, sourceVersion,
      material: { kind: 'provider_api_key', value: 'fixture-direct-material',
        runtimeBinding: { provider: { identity: application.implementationIdentity, definitionRevision: 1 },
          endpoint: { endpointTemplateId: application.endpointTemplateId, normalizedUrl: serverHttpBaseUrl,
            protocol: application.protocol, publicHeaders: {} }, credentialTransport } },
    });
    material.mockImplementation(async (url, body, config) => {
      if (url !== `${serverHttpBaseUrl}/v2/teams/team/credential-resources/${selection.resourceId}/direct-material`
        || config?.headers?.Authorization !== recipientBearer) {
        return { status: 200, data: { status: 'unavailable', reason: 'access_removed' } };
      }
      expect(body).toMatchObject({ resourceId: selection.resourceId, sourceMemberKey,
        consumer: surface === 'Session' ? { kind: 'session', sessionId: 'session' }
          : { kind: 'execution_run', executionRunId: 'run', workerMachineId: machineId } });
      return { status: 200, data: {
        status: 'ready', recipientMode: 'plain',
        stored: createTeamCredentialDirectMaterialStoredV1({ payload, recipientMode: 'plain' }),
        expected: { homeServerIdentityId: payload.homeServerIdentityId, teamId: payload.teamId,
          resourceId: payload.resourceId, resourceRevision: payload.resourceRevision, recipientAccountId: audience,
          sourceMemberKey, sourceVersion },
      } };
    });
    encryption.mockImplementation(async (url, config) => url === `${serverHttpBaseUrl}/v1/account/encryption`
      && config?.headers?.Authorization === recipientBearer
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
      : { status: 403, data: {} });
    const operation = requester === 'guest' ? createInvocationSavedSecretOperationContextV1({
      credentials: { token: fixtureToken(requester), encryption: null }, serverHttpBaseUrl,
      snapshot: { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken(fixtureToken(requester)) },
      isCurrent: async () => true,
    }) : undefined;
    const credentials = { token: fixtureToken('custodian'), encryption: null };
    const openBinding = (input: Parameters<typeof openDaemonSessionTeamCredentialProviderBinding>[0]) =>
      openDaemonSessionTeamCredentialProviderBinding(input, {
        machineId, accountId: 'custodian', serverId: 'home', serverHttpBaseUrl: daemonHome, credentials, happyHomeDir,
        controller, resolveTrustRoots: () => [],
      });
    if (surface === 'Session') {
      const binding = await openBinding({ ...selection, agentId, sessionId: 'session',
        providerSettingsOperationContext: operation, signal: new AbortController().signal });
      await binding.cleanup();
      expect(material).toHaveBeenCalledTimes(1);
      expect(encryption).toHaveBeenCalledTimes(1);
      return;
    }
    const prepareRun = createDetachedRunTeamCredentialProviderBindingPreparer(openBinding, () => machineId);
    const result = prepareExecutionRunRuntimeProviderLaunch({
      scope: 'detached', runId: 'run', agentId, machineId, happyHomeDir,
      backendTarget: buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } }),
      teamCredentialModel: selection, prepareTeamCredentialProviderBinding: prepareRun,
      resolveAccountSettingsSnapshot: Object.assign(async () => operation?.readSnapshot() ?? fixture.snapshot,
        { readOperationContext: () => operation ?? null }),
    });
    if (!admitted) {
      await expect(result.then(async launch => { await launch.cleanupOnExit?.(); })).rejects.toMatchObject(noModels
        ? { code: 'team_credential_provider_selection_not_current' }
        : { code: 'session_team_credential_binding_rejected', reason: 'access_removed' });
      expect(material).not.toHaveBeenCalled();
      expect(encryption).not.toHaveBeenCalled();
      return;
    }
    const launch = await result;
    try {
      expect(launch.providerBinding?.source).toMatchObject({ kind: 'team_resource', resourceId: selection.resourceId });
      expect(launch.environment.RUN_PROVIDER_TOKEN).toBe('fixture-direct-material');
      expect(material).toHaveBeenCalledTimes(1);
      expect(encryption).toHaveBeenCalledTimes(1);
    } finally {
      await launch.cleanupOnExit?.();
    }
  } finally {
    home.mockRestore();
    material.mockRestore();
    encryption.mockRestore();
    await fixture.cleanup();
  }
});
