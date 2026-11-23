import { expect, it } from 'vitest';
import { PluginConnectedAccountAuthenticationV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { ProviderContributionV1Schema, DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol';
import { resolveProviderConnectedAccountDeclarationsV1 } from '@happier-dev/protocol/providers/contributions';

import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createManagedRunLaunchFixture } from './managedRunLaunch.testkit';
import { prepareProviderLaunch } from './prepareLaunch';

it.each([
  { required: 'oauth', recovery: 'refresh_sign_in' },
  { required: 'token', recovery: 'reconnect_token' },
] as const)('keeps catalog and launch recovery identical for a kindless $required source', async ({ required, recovery }) => {
  let kind: 'oauth' | 'token' | null = required;
  const service = { pluginId: 'acme.shared-registry', localId: 'accounts' };
  const target = { kind: 'account' as const, account: { service, accountId: 'source' } };
  const authentication = PluginConnectedAccountAuthenticationV2Schema.parse({
    defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
      fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }],
  });
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true,
    connectedAccountModels: [{ id: 'example', name: 'Example' }],
    resolveAccountTarget: async selected => selected.kind === 'account' ? {
      account: selected.account, displayName: 'Fixture account',
      observation: { authentication, profiles: [QualifiedConnectedAccountProfileV4Schema.parse({
        ref: selected.account, kind, status: 'connected', authenticationModeId: 'manual',
        configurationReady: true, configurationRevision: null,
        revisionSemantics: 'legacy_unfenced', credentialRevision: null,
      })] },
    } : null,
  });
  try {
    const contributions = fixture.lease.registry.contributes;
    const providersByContributionKey = new Map([...contributions.providersByContributionKey].map(([key, provider]) => {
      const definition = ProviderContributionV1Schema.parse({ ...provider.definition,
        connectedAccounts: provider.definition.connectedAccounts?.map(family => ({ ...family, credentialKinds: [required] })),
      });
      return [key, { ...provider, definition,
        connectedAccountDeclarations: resolveProviderConnectedAccountDeclarationsV1({ identity: provider.identity, definition }) }];
    }));
    const lease = { ...fixture.lease, registry: { ...fixture.lease.registry, contributes: { ...contributions, providersByContributionKey } } };
    const resolveSelection = fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection;
    const catalogs = createRuntimeProviderModelManagementServices({
      machineId: fixture.machineId, acquireRuntimeLease: async () => lease, featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: () => fixture.snapshot, resolveManagedPurposeBindingIntentSelection: resolveSelection,
      modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected catalog mutation'); },
    });
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
      'acme.shared-registry/accounts': { source: 'connected' as const, profileId: target.account.accountId },
    } };
    const request = { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, connectedServices };
    const catalog = () => catalogs.projectModels(request);
    const purpose = { consumer: { pluginId: 'acme.shared-registry', localId: 'gateway' }, purpose: 'upstream' };
    const launch = () => prepareProviderLaunch({
      backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
      machineId: fixture.machineId, agentId: fixture.agentId, previousBinding: null, confirmation: null,
      selection: { v: 2, updatedAt: 1, ref: { source: 'connected_account', purpose,
        agentTargetKey: fixture.agentTargetKey, endpointTemplateId: 'api', modelId: 'example' } },
      connectedServices, featureEnabled: true, resolvePrerequisites: async () => ({ ok: true }),
      createAuthorizationAttempt: async () => { throw new Error('Unexpected saved connection path'); },
      managedPurposeContext: { lease, happyHomeDir: fixture.happyHomeDir,
        resolveManagedPurposeBindingIntentSelection: resolveSelection, readProviderSettings: async () => DEFAULT_PROVIDER_SETTINGS_V1 },
    });
    expect(await catalog()).toMatchObject({ status: 'success', groups: [{ rows: [{ descriptor: { id: 'example' } }] }] });
    expect(await launch()).toMatchObject({ ok: true, kind: 'managedPurpose' });
    kind = null;
    const expected = { code: 'connected_service_credential_reconnect_required', credentialKindRecovery: recovery,
      retryable: false, connectedAccountTarget: target };
    expect.soft(await catalog()).toMatchObject({ status: 'error', error: expected });
    expect(await launch()).toMatchObject({ ok: false, error: expected });
  } finally { await fixture.cleanup(); }
});
