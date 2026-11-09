import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  AccountSettingsSchema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderSettingsV1Schema,
  createEmptyProviderRuntimeStateFileV1,
  formatSharedSavedSecretRefV1,
  normalizeActionsSettingsV1,
  sealSavedSecretResourceStoredContentV1,
  splitProviderSettingsV1,
} from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { signRunnerClaimV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { TeamCredentialResourceSummaryV1Schema, verifyRunnerBrokerReadinessRequestV1 } from '@happier-dev/protocol/teams';
import { admitTeamCredentialSourceModelRowsV1 } from '@happier-dev/protocol/rpc/providers';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import { bindPluginRuntimeSourceAuthority } from '@/plugins/runtime/sourceAuthority';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { resolveRunnerCredentialSelectionCurrentness } from '@/providers/broker/daemonProviderBrokerRuntime';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import type { ProviderRuntimeStateStore } from '@/providers/runtimeState';
import { createScopedRuntimeActionSettingsProvider } from '@/settings/scopedRuntimeActionSettingsProvider';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import packageJson from '../../package.json';

import { acquireReviewedRunnerPluginRuntimeLease } from './runnerPluginRuntimeLease';
import { checkProductionRunnerBrokerReadiness } from './productionRunnerBrokerReadiness';

function createReadinessFacts() {
    const activation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(73));
    const binding = {
      activationId: '00000000-0000-4000-8000-000000000071',
      homeServerIdentityId: 'srv_home',
      creatorAccountId: 'creator',
      creatorTokenEpoch: 2,
      activationExpiresAt: null,
      workspace: { kind: 'choose_on_endpoint' as const },
      sessionId: 'session',
      machineId: 'runner-machine',
      activationSigningPublicKey: encodeBase64(activation.publicKey, 'base64url'),
      authoringCommitment: encodeBase64(new Uint8Array(32).fill(79), 'base64url'),
      artifact: { product: 'happier-runner' as const, version: '0.3.0', target: 'linux-x64' as const, sha256: 'a'.repeat(64) },
      endpointFactsRecipient: { mode: 'plain' as const, creatorAccountId: 'creator' },
    };
    const claim = signRunnerClaimV1({
      payload: {
        v: 1,
        purpose: 'happier.ephemeral-session-runner.claim',
        binding,
        runnerBoxPublicKey: encodeBase64(new Uint8Array(32).fill(81), 'base64url'),
        installation: {
          installationId: 'installation-1',
          publicKey: encodeBase64(installation.publicKey, 'base64url'),
          proof: signMachineInstallationProof({
            payload: { version: 1, installationId: 'installation-1', machineId: 'runner-machine', accountId: 'creator' },
            privateKey: encodeBase64(installation.secretKey, 'base64url'),
          }),
        },
        protocolEpoch: 1,
      },
      activationSecretKey: activation.secretKey,
    });
    return { activation, installation, binding, claim };
}

describe('production Runner broker readiness', () => {
  it('derives the exact reviewed target and unique Provider protocol, dual-signs the carrier request, and signs content-free readiness', async () => {
    const { activation, installation, binding, claim } = createReadinessFacts();
    const selection = { v: 1 as const, resourceId: 'resource-1', brokerMachineId: 'broker-machine', revision: 9,
      application: { agentTargetKey: 'agent:happier.agent.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' },
      sourceRevision: 'source-revision-9' };
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const transportCheck = vi.fn(async (input: Parameters<NonNullable<Parameters<typeof checkProductionRunnerBrokerReadiness>[0]['transportCheck']>>[0]) => {
      const request = input.createRequest('c'.repeat(64));
      expect(verifyRunnerBrokerReadinessRequestV1({
        request,
        claim,
        expectedBinding: binding,
        expectedFacts: {
          v: 1,
          kind: 'provider_broker_readiness',
          homeServerIdentityId: 'srv_home',
          activationId: binding.activationId,
          launchManifestCommitment: encodeBase64(new Uint8Array(32).fill(89), 'base64url'),
          resourceId: 'resource-1',
          agentTargetKey: 'agent:happier.agent.codex/codex',
          protocol: 'openai-responses',
          modelId: 'gpt-5',
          initiator: { installationId: 'installation-1', endpointId: 'c'.repeat(64) },
          target: { machineId: 'broker-machine', endpointId: 'd'.repeat(64) },
        },
      })).toEqual(request);
      return { kind: 'available' as const };
    });

    const checkInput: Parameters<typeof checkProductionRunnerBrokerReadiness>[0] = {
      binding,
      claim,
      manifest: {
        preparedAuthoring: { authoring: { agentTarget } },
        credentialSelectionBinding: selection,
        reviewedProviderModel: {
          selection: { modelId: 'gpt-5' },
          descriptor: { id: 'gpt-5', name: 'GPT-5' },
        },
      } as never,
      launchManifestCommitment: encodeBase64(new Uint8Array(32).fill(89), 'base64url'),
      activationSecretKey: activation.secretKey,
      installationSecretKey: installation.secretKey,
      preparation: {
        managed: { resolution: { source: 'managed', command: '/managed/codex' } },
        pluginRuntime: {
          selected: { pluginId: 'happier.agent.codex', localId: 'codex', agentId: 'codex', runtimeSpec: { id: 'codex' } },
          lease: { registry: {
            contributes: {
              agentDefinitionsById: new Map([['codex', { definition: { providerRequirements: {
                acceptsProtocols: ['openai-responses'], required: {}, credentialSupport: { supportsNoAuth: false, apiKeyTransports: [{ destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] }, protocol: 'openai-responses' }] }, authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] }, materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
              } } }]]),
              providersByContributionKey: new Map([['happier.provider.openai/openai', { identity: { pluginId: 'happier.provider.openai', localId: 'openai' }, definition: {
                v: 1, endpointTemplates: [
                  { id: 'responses', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } },
                  { id: 'chat', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unsupported', reasoningControls: 'unsupported' } },
                ], credential: { kind: 'apiKey', required: true, slotId: 'apiKey', transports: [{ id: 'runtime-bearer', uses: ['runtime'], protocols: ['openai-responses', 'openai-chat'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
              } }]]),
            },
          } },
        },
      } as never,
      projection: {
        credentialSelectionBinding: selection,
        target: { endpointId: 'd'.repeat(64) },
        provider: { identity: { pluginId: 'happier.provider.openai', localId: 'openai' }, definitionRevision: 1 },
        readiness: { kind: 'available' },
      },
      happyHomeDir: '/runner-home',
      signal: new AbortController().signal,
      transportCheck,
    };
    const result = await checkProductionRunnerBrokerReadiness(checkInput);

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.readiness.payload.installation).toEqual({
        agentTarget,
        agentRuntimeId: 'codex',
        executablePath: '/managed/codex',
        authoritativeVersion: null,
      });
      expect(result.readiness.payload.credentialSelectionBinding).toEqual(selection);
    }
    const reconnect = { kind: 'source_unavailable' as const, reason: 'connected_service_credential_reconnect_required' as const };
    transportCheck.mockClear();
    expect(await checkProductionRunnerBrokerReadiness({ ...checkInput, projection: { ...checkInput.projection, readiness: reconnect } }))
      .toEqual({ status: 'denied', reason: reconnect.reason });
    expect(transportCheck).not.toHaveBeenCalled();
    expect(await checkProductionRunnerBrokerReadiness({ ...checkInput, transportCheck: async () => reconnect }))
      .toEqual({ status: 'denied', reason: reconnect.reason });
  });

  it('uses a separately installed public-SDK Provider on the broker, without installing it on the Runner, and rejects revoked sources', async () => {
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    // The external author's entire declaration uses the public SDK. The host
    // fixture below loads it through the ordinary immutable-generation catalog.
    const { manifest: providerManifest } = definePlugin({
      id: 'acme.runner-models', version: '1.0.0', engines: { happier: `^${packageJson.version}` },
      providers: {
        gateway: { declaration: {
          v: 1, name: 'Runner fixture models', kind: 'cloud',
          endpointTemplates: [{
            id: 'responses', protocol: 'openai-responses', baseUrl: 'https://models.example.test/v1',
            capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' },
          }],
          credential: {
            kind: 'apiKey', slotId: 'apiKey', required: true,
            transports: [{ id: 'bearer', protocols: ['openai-responses'], uses: ['runtime', 'probe'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }],
          },
          catalog: { source: 'static', manualModelPolicy: 'catalog-only', staticModels: [{ id: 'fixture-model', name: 'Fixture model', capabilities: { toolRoundTrips: 'supported', reasoningControls: 'supported' } }] },
          compatibilityOverrides: [{
            agentTargetKey, protocol: 'openai-responses', status: 'verified', reason: 'Deterministic source fixture',
            evidence: { sourceUrls: ['https://models.example.test/docs'], verifiedAt: '2026-09-26' },
          }],
        } },
      },
    });
    const root = await mkdtemp(join(tmpdir(), 'happier-runner-broker-provider-'));
    const brokerHome = join(root, 'broker');
    const runnerHome = join(root, 'runner');
    const pluginRoot = join(root, 'provider');
    const resolveDevelopmentSourceAuthority = ({ rootPath }: Readonly<{ rootPath: string }>) => {
      const authority = bindPluginRuntimeSourceAuthority({
        custody: { kind: 'development', registeredRootId: 'runner-readiness-fixture' },
        resolvedRoot: rootPath, observedRevision: 1,
      });
      return authority.kind === 'development' ? authority : null;
    };
    const acquire = (happyHomeDir: string) => acquireReviewedRunnerPluginRuntimeLease({
      happyHomeDir, target: agentTarget,
      resolveDevelopmentSourceAuthority,
      scopedActionRuntime: {
        credentials: null,
        actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(normalizeActionsSettingsV1({ v: 1, actions: {} })),
      },
    });
    let runner: Awaited<ReturnType<typeof acquire>> | null = null;
    let broker: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
    try {
      await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
      await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(providerManifest));
      await seedCurrentLocalPathPluginFixture({ happyHomeDir: brokerHome, pluginRoot, pluginId: providerManifest.id, manifestVersion: providerManifest.version });
      runner = await acquire(runnerHome);
      expect(runner.lease.registry.contributes.providersByContributionKey?.has('acme.runner-models/gateway') ?? false).toBe(false);
      // A broker discovers its installed Providers. The Runner lease deliberately
      // selects only the reviewed executable Agent and cannot stand in for it.
      broker = await createAdmittedPluginRuntimeFixture({
        happyHomeDir: brokerHome,
        runtimeOptions: {
          scopedActionRuntime: {
            credentials: null,
            actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(normalizeActionsSettingsV1({ v: 1, actions: {} })),
          },
        },
      });
      const brokerController = broker.controller;
      const generation = broker.registry.generation;
      if (generation === undefined) throw new Error('Reviewed Runner registry has no generation');
      const registry = resolveProviderContributionRegistryView(broker.registry.contributes, generation, broker.registry.readPluginOccurrenceId);
      expect(registry.providersByContributionKey.get('acme.runner-models/gateway')?.provenance,
        JSON.stringify(broker.registry.contributes.pluginDiagnosticsByPluginId?.['acme.runner-models'] ?? []),
      ).toBe('external');

      const baseSettings = ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{ v: 1, id: 'fixture-connection', source: { kind: 'contribution', contributionKey: 'acme.runner-models/gateway' }, role: 'default', displayName: 'Fixture', displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1 }],
      });
      const resolved = resolveProviderConnectionForMachine({
        connectionId: 'fixture-connection', machineId: 'broker-machine', providerSettings: baseSettings, registry,
        dnsEvidenceByEndpointUrl: new Map([['https://models.example.test/v1', ['1.1.1.1']]]),
      });
      if (resolved.status !== 'resolved') throw new Error('Expected external Provider connection');
      const providerSettings = ProviderSettingsV1Schema.parse({
        ...baseSettings,
        secretBindingsByConnectionId: { 'fixture-connection': { account: { apiKey: formatSharedSavedSecretRefV1('fixture-secret') } } },
        accountGrants: [{ v: 1, connectionId: 'fixture-connection', connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, confirmedAt: 1 }],
      });
      const { catalog, defaults } = splitProviderSettingsV1(providerSettings);
      const snapshot: ActiveAccountSettingsSnapshot = {
        source: 'cache', settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
        providerConnectionsCatalog: { status: 'ready', revision: 1, catalog },
        savedSecretCatalogState: 'ready',
        savedSecretResources: [{ resourceId: 'fixture-secret', ownerAccountId: 'broker-account', displayName: 'Fixture',
          kind: 'apiKey', encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
          storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'fixture-secret', mode: 'plain',
            content: { v: 1, name: 'Fixture', kind: 'apiKey', value: 'fixture-upstream-key' } }) }],
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
        scopeKey: resolveAccountSettingsScopeKeyForToken('broker-account'),
      };
      // Account settings, DNS and persisted observation storage are boundaries;
      // catalog assembly, compatibility, registry lookup and eligibility are real.
      let state = createEmptyProviderRuntimeStateFileV1('broker-machine');
      const runtimeStore: ProviderRuntimeStateStore = {
        path: join(brokerHome, 'fixture-observations.json'),
        read: async () => state,
        update: async (transform) => { state = await transform(state); return state; },
        updateTransientEndpointHealth: async (transform) => { state = { ...state, endpointHealth: [...await transform(state.endpointHealth)] }; },
      };
      const services = createRuntimeProviderModelManagementServices({
        machineId: 'broker-machine', happyHomeDir: brokerHome, registry, runtimeStore,
        featureGate: { isEnabled: () => true },
        resolveAddresses: async () => ['1.1.1.1'],
        acquireRuntimeLease: () => acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: brokerHome, controller: brokerController }),
        getAccountSettingsSnapshot: () => snapshot,
        modelSettingsMutation: async (intent) => ({ status: 'success', action: intent.action }),
      });
      const source = { v: 1 as const, kind: 'provider_connection' as const, connectionId: ProviderConnectionIdSchema.parse('fixture-connection'), connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, credentialSlotId: 'apiKey' };
      const projected = await services.projectModels({ machineId: 'broker-machine', agentTargetKey, providerConnection: { connectionId: source.connectionId, expectedConnectionSecurityFingerprint: source.connectionSecurityFingerprint }, sourceCatalog: true, refreshPolicy: 'current_only', mode: 'picker' });
      if (projected.status !== 'success') throw new Error(`Expected broker model projection: ${JSON.stringify(projected)}`);
      expect(admitTeamCredentialSourceModelRowsV1(projected)).toMatchObject({ status: 'success' });
      const group = projected.groups[0];
      const row = group?.rows[0];
      if (!group?.sourceRevision || !row?.application || !group.sourceAuthority) throw new Error(`Expected authoritative external Provider row: ${JSON.stringify(projected)}`);
      const selection = { v: 1 as const, resourceId: 'resource-1', brokerMachineId: 'broker-machine', revision: 9, application: row.application, sourceRevision: group.sourceRevision };
      const resource = TeamCredentialResourceSummaryV1Schema.parse({
        id: selection.resourceId, teamId: 'team-1', custodianAccountId: 'custodian', displayName: 'Fixture', enabled: true, revision: 9,
        disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', source,
        sourcePresentation: { kind: 'provider', provider: group.sourceAuthority.provider },
        requestPolicy: null, brokerPlacement: { kind: 'machine', machineId: 'broker-machine' }, allMembersDeliveryMode: null,
        groupGrants: [], memberGrants: [], readiness: { kind: 'available' }, recoveryAction: null,
        brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] }, createdAt: '', updatedAt: '',
      });
      const currentness = () => resolveRunnerCredentialSelectionCurrentness({
        registeredMachineId: 'broker-machine', selection, modelId: row.descriptor.id, signal: new AbortController().signal,
        readResource: async () => resource,
        resolveEligibility: services.resolveTeamCredentialBrokerEligibility,
      });
      expect(await currentness()).toEqual({ kind: 'available' });
      const { activation, installation, binding, claim } = createReadinessFacts();
      const checkInput = {
        binding, claim,
        // Unrelated authoring fields have already crossed the sealed-manifest
        // boundary; this fixture exercises the real readiness/registry corridor.
        manifest: { preparedAuthoring: { authoring: { agentTarget } }, credentialSelectionBinding: selection, reviewedProviderModel: { selection: { modelId: row.descriptor.id }, descriptor: row.descriptor } } as never,
        launchManifestCommitment: encodeBase64(new Uint8Array(32).fill(89), 'base64url'),
        activationSecretKey: activation.secretKey, installationSecretKey: installation.secretKey,
        preparation: { managed: { resolution: { command: '/managed/codex' } }, pluginRuntime: runner },
        // Home projects the executable application, not the separate source
        // Provider. Team Provider Connections use the canonical broker gateway.
        projection: { credentialSelectionBinding: selection, target: { endpointId: 'd'.repeat(64) }, provider: { identity: selection.application.implementationIdentity, definitionRevision: 1 as const }, readiness: { kind: 'available' as const } },
        happyHomeDir: runnerHome, signal: new AbortController().signal,
        transportCheck: async (input: Parameters<NonNullable<Parameters<typeof checkProductionRunnerBrokerReadiness>[0]['transportCheck']>>[0]) => {
          input.createRequest('c'.repeat(64));
          return await currentness();
        },
      };
      const readiness = await checkProductionRunnerBrokerReadiness(checkInput);
      expect(readiness.status, readiness.status === 'ready' ? 'ready' : readiness.reason).toBe('ready');
      expect(readiness).toMatchObject({ status: 'ready', readiness: { payload: { installation: { agentRuntimeId: 'codex', executablePath: '/managed/codex' } } } });
      resource.enabled = false;
      expect(await checkProductionRunnerBrokerReadiness(checkInput)).toEqual({ status: 'denied', reason: 'source_unavailable' });
    } finally {
      await broker?.dispose();
      await runner?.release();
      await rm(root, { recursive: true, force: true });
    }
  });
});
