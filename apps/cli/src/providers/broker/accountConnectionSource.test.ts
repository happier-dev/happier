import { describe, expect, it } from 'vitest';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, ProviderConnectionIdSchema,
  ProviderContributionV1Schema, ProviderSettingsV1Schema, splitProviderSettingsV1,
  createProviderConnectionSecurityFingerprintV1 } from '@happier-dev/protocol';
import { readProviderConnectionSourceFactsV1 } from '@happier-dev/protocol/providers/connections/sourceFactsV1';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import type { SignedProviderBrokerRouteGrantV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAccountConnectionBrokerSourceOpen } from './accountConnectionSource';
import { createBrokerProviderRegistry } from './providerBroker.testkit';
import { projectProviderBrokerApplication } from './applicationProjection';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';

describe('personal hub source admission', () => {
  it.each(['connectionSecurity', 'managedBinding', 'unchanged', 'legacyConnectionSecurity', 'sourceCurrentness', 'homeLiveness'] as const)('checks captured %s before projecting or acquiring the current hub', async (changedFact) => {
    const base = createBrokerProviderRegistry();
    const providersByContributionKey = new Map([...base.providersByContributionKey].map(([key, contribution]) => [key, {
      ...contribution, definition: ProviderContributionV1Schema.parse({ ...contribution.definition,
        managedRuntime: { ...contribution.definition.managedRuntime, sharing: 'connectionMachine', connectedAccounts: [] } }),
    }]));
    const registry = { providersByContributionKey };
    const connectionId = ProviderConnectionIdSchema.parse('personal-source');
    const initial = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{ v: 1, id: connectionId, source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
        deployment: { kind: 'managedLocal' },
        role: 'default', displayName: 'Gateway', displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1,
        gatewayPlacement: { kind: 'machine', machineId: 'hub-1' } }] });
    const resolve = (providerSettings: typeof initial) => resolveProviderConnectionForMachine({ connectionId,
      machineId: 'hub-1', providerSettings, registry, dnsEvidenceByEndpointUrl: new Map() });
    const resolved = resolve(initial);
    if (resolved.status !== 'resolved') throw new Error('Expected current managed source');
    const settings = ProviderSettingsV1Schema.parse({ ...initial, machineGrants: [{ v: 1, connectionId,
      machineId: 'hub-1', connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
      endpointSetFingerprint: resolved.record.endpointSetFingerprint, confirmedAt: 1 }] });
    const authorized = resolve(settings);
    if (authorized.status !== 'resolved' || !authorized.record.authorization.authorized) throw new Error('Expected hub grant');
    if (authorized.record.deployment.kind !== 'managedLocal') throw new Error('Expected managed source');
    const capturedManagedBinding = createProviderManagedRuntimeBindingFingerprintV1({
      implementationIdentity: authorized.record.deployment.implementationIdentity,
      managedRuntime: authorized.record.deployment.managedRuntime, purposeBindings: { v: 1, bindings: [] },
    });
    const application = projectProviderBrokerApplication({ connection: authorized.record,
      agentTargetKey: 'agent:happier.agent.claude/claude', protocol: 'openai-responses' });
    if (!application) throw new Error('Expected declared application');
    const { catalog, defaults } = splitProviderSettingsV1(settings);
    const snapshot: ActiveAccountSettingsSnapshot = { source: 'cache',
      settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
      providerConnectionsCatalog: { status: 'ready', revision: 1, catalog }, savedSecretResources: [],
      savedSecretCatalogState: 'ready', settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken('personal-account') };
    if (authorized.record.source.kind !== 'contribution') throw new Error('Expected contributed source');
    const legacyFingerprint = createProviderConnectionSecurityFingerprintV1({ securityContractVersion: 1, endpoints: [],
      ...readProviderConnectionSourceFactsV1(authorized.record.source.definition),
      managedDeployment: { gatewayPlacement: authorized.record.connection.gatewayPlacement,
        implementationIdentity: authorized.record.deployment.implementationIdentity,
        managedRuntime: authorized.record.deployment.managedRuntime,
        logicalEndpoints: authorized.record.source.definition.endpointTemplates
          .filter(endpoint => authorized.record.deployment.kind === 'managedLocal'
            && authorized.record.deployment.managedRuntime.endpointTemplateIds.includes(endpoint.id))
          .map(endpoint => ({ endpointTemplateId: endpoint.id, protocol: endpoint.protocol, publicHeaders: endpoint.publicHeaders })),
      } });
    const source = { kind: 'account_connection' as const, connectionId,
      expectedConnectionSecurityFingerprint: changedFact === 'connectionSecurity'
        ? 'connection-security:v1:stale' : changedFact === 'legacyConnectionSecurity' ? legacyFingerprint : authorized.record.connectionSecurityFingerprint,
      expectedManagedRuntimeBindingFingerprint: changedFact === 'managedBinding'
        ? 'managed-runtime-binding:v1:stale' : capturedManagedBinding };
    const authority: SignedProviderBrokerRouteGrantV2 = { payload: { v: 2, grantId: 'grant-1',
      aud: 'happier-provider-broker-route-v2', issuedAt: 1, expiresAt: 2, homeId: 'home-1', accountId: 'account-1',
      source, initiatorTokenEpoch: 0, initiator: { accountId: 'account-1', machineId: 'worker-1', endpointId: 'a'.repeat(64) },
      target: { custodianAccountId: 'account-1', machineId: 'hub-1', endpointId: 'b'.repeat(64) },
      consumer: { kind: 'session', sessionId: 'session-1' }, application },
      signature: { alg: 'Ed25519', keyId: 'key-1', valueBase64Url: Buffer.alloc(64).toString('base64url') } };
    let projectionReads = 0;
    let registryReads = 0;
    const failureCause = { phase: 'provider.registry', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
    const unused = (): never => { throw new Error('Unexpected effect boundary'); };
    const managed = createManagedServicesOwner({
      processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
      dependencies: unused, resolveScope: scope => scope,
    });
    const operation = { operationId: 'session-1', pluginId: application.implementationIdentity.pluginId,
      contributionQualifiedId: 'happier.provider.cliproxyapi/providers/cliproxyapi', occurrenceId: 'account-source',
      purposeBindingsEqualityKey: 'account-source', lifecycleKind: 'providerBroker' as const };
    // Keep the semantic/join owner real; only the authorized Provider child is an effect boundary.
    const custody: ManagedProviderExplicitStartCustody = {
      acquire: async input => {
        const joined = await managed.runManagedProviderExplicitStart({ ...operation,
          signal: input.signal, isCurrent: input.isAuthorizationCurrent,
          establish: async () => ({ status: 'running', projection: {
            access: { endpointUrl: () => 'http://127.0.0.1:43120/v1', request: unused },
            isCurrent: () => true, cleanup: async () => {},
          } }),
        });
        return joined.status === 'established' ? joined.value.projection : null;
      },
      retire: async () => await managed.retireManagedProviderExplicitStart(operation),
      retireExternalApiKey: unused,
      revalidateRetainedClaims: async signal => await managed.revalidateManagedProviderExplicitStarts(signal),
      retireAll: async () => await managed.retireManagedProviderExplicitStarts('providerBroker'),
    };
    let homeUnavailable = false;
    const open = createAccountConnectionBrokerSourceOpen({ homeId: 'home-1', accountId: 'account-1', machineId: 'hub-1',
      expectedAccountSettingsScopeKey: snapshot.scopeKey!,
      custody: changedFact === 'homeLiveness' || changedFact === 'sourceCurrentness' ? custody
        : createManagedProviderExplicitStartCustody({ machineId: 'hub-1', happyHomeDir: '/unreached-personal-source' }),
      withRegistry: async read => {
        if (++registryReads === 2 && changedFact === 'sourceCurrentness') {
          throw Object.assign(new Error('private registry transport detail'), { failureCause });
        }
        return await read(registry);
      }, getAccountSettingsSnapshot: () => snapshot,
      resolveBindingIntent: async () => { throw new Error('No purpose is declared'); },
      admitConsumer: async () => {
        if (changedFact === 'homeLiveness' && homeUnavailable) {
          throw Object.assign(new Error('private Home transport detail'), { failureCause });
        }
        return true;
      },
      // Canonical model projection is a remote Machine RPC boundary. A denied
      // captured source must not reach it, even if the current catalog is valid.
      projectModels: async () => {
        projectionReads++;
        // The genuine Machine RPC wire row is flat, unlike the internal
        // picker row. A stale observation must refuse before acquisition.
        return DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey: application.agentTargetKey,
          groups: [{ connectionId, providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'default',
            connectionDisplayNameMode: 'automatic', connectionRevision: 1,
            sourceAuthority: { provider: { identity: application.implementationIdentity, definitionRevision: 1 },
              connectionSecurityFingerprint: source.expectedConnectionSecurityFingerprint },
            authorization: { authorized: true },
            modelLoadAction: 'descriptor_absent', manualModelPolicy: 'allowed', supportsFreeformModelIds: false,
            suppressedConnectedServiceIds: [], rows: [{
              ref: { agentTargetKey: application.agentTargetKey, providerConnectionId: connectionId, modelId: 'model-a' },
              descriptor: { id: 'model-a', name: 'Model A' }, application,
              sources: { manual: false, static: false, probe: true }, confidence: 'probe',
              compatibility: { result: { status: 'verified', selectedProtocol: application.protocol,
                evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-09' } },
                compatibilityFingerprint: 'compatibility:v1:source', confirmed: false },
              endpointHealth: 'not_checked', catalog: { stale: changedFact !== 'sourceCurrentness' && changedFact !== 'homeLiveness' }, loadState: 'unknown', visibility: 'visible',
            }] }],
        });
      } });
    try {
      if (changedFact === 'homeLiveness') {
        const opened = await open({ authority, signal: new AbortController().signal });
        expect(opened).not.toBeNull();
        if (!opened) throw new Error('Expected source acquisition');
        homeUnavailable = true;
        await expect(opened.revalidate()).rejects.toMatchObject({ failureCause });
        homeUnavailable = false;
        await expect(opened.revalidate()).resolves.toBe(true);
        await opened.cleanup();
      } else if (changedFact === 'sourceCurrentness') {
        await expect(open({ authority, signal: new AbortController().signal })).rejects.toMatchObject({
          failure: { reasonCode: 'source_unavailable', sourceOpenFailureReason: 'source_currentness_unknown', failureCause },
        });
      } else {
        expect(await open({ authority, signal: new AbortController().signal })).toBeNull();
      }
      expect(projectionReads).toBe(changedFact === 'connectionSecurity' || changedFact === 'managedBinding' ? 0 : 1);
      expect(capturedManagedBinding).not.toContain(authorized.record.deployment.implementationIdentity.pluginId);
    } finally { await managed.dispose(); }
  });
});
