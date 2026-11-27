import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { TeamCredentialDirectMaterialPayloadV1Schema } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
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
  { requester: 'guest', audience: 'guest', admitted: true },
  { requester: 'custodian', audience: 'custodian', admitted: true },
  { requester: 'guest', audience: 'custodian', admitted: false },
])('opens a detached Run as $requester against the $audience-only Team offer', async ({ requester, audience, admitted }) => {
  const controller = createPluginReloadController();
  const fixture = await createManagedRunLaunchFixture({ controller });
  const home = vi.spyOn(axios, 'request');
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
        direct: { sourceMemberKey: 'provider:fixture', sourceVersion } }],
    }] });
    const serverHttpBaseUrl = 'https://home.example';
    // The Home HTTP boundary exposes the offer to exactly one bearer.
    home.mockImplementation(async config => {
      expect(config.url).toBe(`${serverHttpBaseUrl}/v1/teams/credential-resources/entitled/list`);
      expect(config.data).toMatchObject({ resourceId: selection.resourceId, executionMachineId: machineId });
      return config.headers?.Authorization === `Bearer ${fixtureToken(audience)}`
        ? { status: 200, data: offered }
        : { status: 404, data: { error: 'not_found_or_not_visible' } };
    });
    const openTeamDirect = vi.fn(async () => ({
      ok: true as const,
      payload: TeamCredentialDirectMaterialPayloadV1Schema.parse({
        v: 1, domain: 'happier.team-credential-direct-material', homeServerIdentityId: 'home',
        teamId: selection.teamId, resourceId: selection.resourceId, resourceRevision: selection.expectedResourceRevision,
        recipientAccountId: audience, sourceMember, sourceVersion,
        material: { kind: 'provider_api_key', value: 'fixture-direct-material',
          runtimeBinding: { provider: { identity: application.implementationIdentity, definitionRevision: 1 },
            endpoint: { endpointTemplateId: application.endpointTemplateId, normalizedUrl: serverHttpBaseUrl,
              protocol: application.protocol, publicHeaders: {} }, credentialTransport } },
      }),
    }));
    const operation = requester === 'guest' ? createInvocationSavedSecretOperationContextV1({
      credentials: { token: fixtureToken(requester), encryption: null }, serverHttpBaseUrl,
      snapshot: { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken(fixtureToken(requester)) },
      isCurrent: async () => true,
    }) : undefined;
    const prepareRun = createDetachedRunTeamCredentialProviderBindingPreparer(
      input => openDaemonSessionTeamCredentialProviderBinding(input, {
        machineId, accountId: 'custodian', serverId: 'home', serverHttpBaseUrl,
        credentials: { token: fixtureToken('custodian'), encryption: null }, happyHomeDir,
        controller, resolveTrustRoots: () => [], openTeamDirect,
      }), () => machineId,
    );
    const result = prepareExecutionRunRuntimeProviderLaunch({
      scope: 'detached', runId: 'run', agentId, machineId, happyHomeDir,
      backendTarget: buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } }),
      teamCredentialModel: selection, prepareTeamCredentialProviderBinding: prepareRun,
      resolveAccountSettingsSnapshot: Object.assign(async () => operation?.readSnapshot() ?? fixture.snapshot,
        { readOperationContext: () => operation ?? null }),
    });
    if (!admitted) {
      await expect(result.then(async launch => { await launch.cleanupOnExit?.(); })).rejects.toMatchObject({
        code: 'session_team_credential_binding_rejected', reason: 'access_removed',
      });
      expect(openTeamDirect).not.toHaveBeenCalled();
      return;
    }
    const launch = await result;
    try {
      expect(launch.providerBinding?.source).toMatchObject({ kind: 'team_resource', resourceId: selection.resourceId });
      expect(launch.environment.RUN_PROVIDER_TOKEN).toBe('fixture-direct-material');
    } finally {
      await launch.cleanupOnExit?.();
    }
  } finally {
    home.mockRestore();
    await fixture.cleanup();
  }
});
