import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';

import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { DaemonProviderModelProjectionRequestV1Schema } from '@happier-dev/protocol/rpc/providers';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { createProviderOperationLifetime } from '@/providers/operationLifetime';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { createRuntimeProviderModelManagementServices } from './runtimeServices';

afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); });

it.each([true, false])('G1 projects only the owning Account source and purpose without ambient fallback or refresh (probe catalog: %s)', async probeCatalog => {
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true, probeCatalog });
  try {
    if (!fixture.gateway) throw new Error('Expected physical gateway fixture');
    if (typeof fixture.lease.registry.generation !== 'number') throw new Error('Expected authoritative registry generation');
    const registry = resolveProviderContributionRegistryView(fixture.lease.registry.contributes,
      fixture.lease.registry.generation, fixture.lease.registry.readPluginOccurrenceId);
    const ambientSettings = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings, machineGrants: [],
      connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
        displayName: 'Ambient Gateway', displayNameMode: 'custom',
        purposeBindingDefaults: { upstream: { kind: 'account', account: {
          service: { pluginId: fixture.gateway!.pluginId, localId: 'accounts' }, accountId: 'ambient-upstream',
        } } },
      })),
    });
    const ambientResolution = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: fixture.machineId,
      providerSettings: ambientSettings,
      registry, dnsEvidenceByEndpointUrl: new Map() });
    if (ambientResolution.status !== 'resolved') throw new Error('Expected ambient connection');
    const admittedAmbientSettings = ProviderSettingsV1Schema.parse({ ...ambientSettings, machineGrants: [{ v: 1,
      connectionId: 'run-gateway', machineId: fixture.machineId, confirmedAt: 1,
      connectionSecurityFingerprint: ambientResolution.record.connectionSecurityFingerprint,
      endpointSetFingerprint: ambientResolution.record.endpointSetFingerprint,
    }] });
    const { catalog, defaults } = splitProviderSettingsV1(admittedAmbientSettings);
    const ambientSnapshot = { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken('ambient-account'),
      settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
      providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog },
    };
    setActiveAccountSettingsSnapshot(ambientSnapshot);
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected account materialization'); };
    // Account transport truth is the boundary. Purpose validation remains the
    // real owner and refuses the other Account's upstream binding.
    const ambientPurposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async (target, signal) => {
        signal.throwIfAborted();
        return target.kind === 'account' && target.account.accountId === 'ambient-upstream'
          ? { account: target.account, displayName: 'Ambient upstream' } : null;
      },
    });
    const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
      acquireRuntimeLease: async () => {
        const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected canonical registry lease');
        return lease;
      },
      resolveManagedPurposeBindingIntent: ambientPurposes.resolveBindingIntent,
      modelSettingsMutation: unexpected,
    });
    const request = DaemonProviderModelProjectionRequestV1Schema.parse({ machineId: fixture.machineId,
      agentTargetKey: fixture.agentTargetKey, mode: 'management', sourceConnectionId: 'run-gateway', refreshPolicy: 'current_only' });
    const ambient = await services.projectModels(request);
    expect(ambient, JSON.stringify(ambient)).toMatchObject({ status: 'success', groups: [{ connectionId: 'run-gateway', connectionName: 'Ambient Gateway',
      sourceAuthority: { connectionSecurityFingerprint: ambientResolution.record.connectionSecurityFingerprint },
      rows: [{ descriptor: { id: 'example' } }],
    }] });
    const admittedAmbient = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: fixture.machineId,
      providerSettings: admittedAmbientSettings, registry, dnsEvidenceByEndpointUrl: new Map() });
    if (admittedAmbient.status !== 'resolved') throw new Error('Expected admitted ambient connection');
    await expect(services.summary({ connectionId: 'run-gateway', machineId: fixture.machineId,
      accountSettings: ambientSnapshot.settings, providerSettings: admittedAmbientSettings, registry,
      dnsEvidence: new Map(), resolution: admittedAmbient,
      lifetime: createProviderOperationLifetime({ wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs }),
    })).resolves.toMatchObject({ status: 'success' });

    const controller = new AbortController();
    let current = true;
    const context = { getAccountSettingsSnapshot: () => fixture.snapshot,
      resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
      signal: controller.signal, isCurrent: async () => current };
    const owned = await services.projectModelsForAccount({ ...request, forceRefresh: true, refreshPolicy: undefined }, context);
    expect(owned).toMatchObject({ status: 'success', groups: [{ connectionId: 'run-gateway', connectionName: 'Gateway',
      sourceAuthority: { connectionSecurityFingerprint: fixture.connectionSecurityFingerprint },
      rows: [{ descriptor: { id: 'example' } }],
    }] });
    expect(owned).not.toEqual(ambient);
    await expect(access(join(fixture.gateway.directory, 'gateway-started'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(services.projectModelsForAccount(request, { ...context, getAccountSettingsSnapshot: () => null }))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_settings_invalid' } });
    current = false;
    await expect(services.projectModelsForAccount(request, context))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    current = true;
    let releaseTransport = () => {};
    let transportStarted = () => {};
    const entered = new Promise<void>(resolve => { transportStarted = resolve; });
    const released = new Promise<void>(resolve => { releaseTransport = resolve; });
    const pausedPurposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async (target, signal) => {
        transportStarted();
        await released;
        signal.throwIfAborted();
        return target.kind === 'account' ? { account: target.account, displayName: 'Owning upstream' } : null;
      },
    });
    const pending = services.projectModelsForAccount(request, {
      ...context, resolveManagedPurposeBindingIntent: pausedPurposes.resolveBindingIntent,
    });
    await entered;
    current = false;
    releaseTransport();
    await expect(pending).resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
  } finally { await fixture.cleanup(); }
});
