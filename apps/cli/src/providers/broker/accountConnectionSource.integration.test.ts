import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, ProviderConnectionIdSchema,
  ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { SignedProviderBrokerRouteGrantV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { createSharedGatewayRegistryTestkit } from '@/plugins/runtime/sharedGatewayRegistry.testkit';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAccountConnectionBrokerSourceOpen } from './accountConnectionSource';
import { projectProviderBrokerApplication } from './applicationProjection';

it('acquires the real own-source gateway but refuses unauthorized or foreign projection authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-account-source-'));
  const fixture = createSharedGatewayRegistryTestkit({ directory,
    resolveAccountTarget: async (target, signal) => {
      signal.throwIfAborted();
      if (target.kind !== 'account') throw new Error('Expected exact account metadata request');
      return { account: target.account, displayName: 'Upstream account' };
    } });
  const accesses: NonNullable<Awaited<ReturnType<ReturnType<typeof createAccountConnectionBrokerSourceOpen>>>>[] = [];
  try {
    await fixture.install(fixture.pluginId, '1.0.0', true);
    const lease = await fixture.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: () => fixture.createRegistry(new Set()) });
    const contributes = lease.registry.contributes;
    if (!contributes.providersByContributionKey) throw new Error('Missing committed Provider projection');
    const registry = { ...contributes, providersByContributionKey: contributes.providersByContributionKey };
    await lease.release();
    const connectionId = ProviderConnectionIdSchema.parse('pc_shared');
    const initial = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{ v: 1, id: connectionId,
      source: { kind: 'contribution', contributionKey: `${fixture.pluginId}/gateway` }, deployment: { kind: 'managedLocal' },
      gatewayPlacement: { kind: 'machine', machineId: 'machine' }, purposeBindingDefaults: { upstream: fixture.purposeBindings.bindings[0]!.target },
      role: 'default', displayName: 'Gateway', displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1 }] });
    const resolved = resolveProviderConnectionForMachine({ connectionId, machineId: 'machine', providerSettings: initial,
      registry, dnsEvidenceByEndpointUrl: new Map() });
    if (resolved.status !== 'resolved' || resolved.record.deployment.kind !== 'managedLocal') throw new Error('Expected managed source');
    const settings = ProviderSettingsV1Schema.parse({ ...initial, machineGrants: [{ v: 1, connectionId, machineId: 'machine',
      connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, endpointSetFingerprint: resolved.record.endpointSetFingerprint, confirmedAt: 1 }] });
    const application = projectProviderBrokerApplication({ connection: resolved.record,
      agentTargetKey: 'agent:happier.agent.claude/claude', protocol: 'openai-responses' });
    if (!application) throw new Error('Expected declared own-source application');
    const { catalog, defaults } = splitProviderSettingsV1(settings);
    let snapshot: ActiveAccountSettingsSnapshot = { source: 'cache', scopeKey: resolveAccountSettingsScopeKeyForToken('account'),
      settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }), settingsVersion: 1,
      providerConnectionsCatalog: { status: 'ready', revision: 1, catalog }, loadedAtMs: 1, settingsSecretsReadKeys: [] };
    const authority: SignedProviderBrokerRouteGrantV2 = { payload: { v: 2, grantId: 'grant', aud: 'happier-provider-broker-route-v2',
      issuedAt: 1, expiresAt: 2, homeId: 'home', accountId: 'account', initiatorTokenEpoch: 0,
      source: { kind: 'account_connection', connectionId, expectedConnectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
        expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({
          implementationIdentity: fixture.identity, managedRuntime: resolved.record.deployment.managedRuntime, purposeBindings: fixture.purposeBindings }) },
      initiator: { accountId: 'account', machineId: 'worker', endpointId: 'a'.repeat(64) },
      target: { custodianAccountId: 'account', machineId: 'machine', endpointId: 'b'.repeat(64) },
      consumer: { kind: 'execution_run', executionRunId: 'run-positive' }, executionRunOccurrenceId: 'occurrence-positive', application },
      signature: { alg: 'Ed25519', keyId: 'key', valueBase64Url: Buffer.alloc(64).toString('base64url') } };
    let projectionKind: 'own' | 'unauthorized' | 'foreign' = 'own';
    const open = createAccountConnectionBrokerSourceOpen({ homeId: 'home', accountId: 'account', machineId: 'machine',
      expectedAccountSettingsScopeKey: snapshot.scopeKey!,
      custody: createManagedProviderExplicitStartCustody({ machineId: 'machine', happyHomeDir: fixture.happyHomeDir, controller: fixture.controller }),
      withRegistry: async read => await read(registry), getAccountSettingsSnapshot: () => snapshot,
      resolveBindingIntent: fixture.purposeBindingOwner.resolveBindingIntent, admitConsumer: async () => true,
      // Genuine Machine RPC response boundary; private source, purpose and
      // operation admission plus OS gateway supervision execute for real.
      projectModels: async () => DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey: application.agentTargetKey,
        groups: [{ connectionId, providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'default', connectionDisplayNameMode: 'automatic',
          connectionRevision: 1, sourceAuthority: { provider: { identity: projectionKind === 'foreign'
            ? { pluginId: 'acme.foreign', localId: 'gateway' } : fixture.identity, definitionRevision: 1 },
            connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint },
          authorization: projectionKind === 'unauthorized' ? { authorized: false,
            error: createProviderErrorV1('provider_not_enabled_on_machine', { connectionId, machineId: 'machine' }) } : { authorized: true },
          modelLoadAction: 'descriptor_absent', manualModelPolicy: 'allowed', supportsFreeformModelIds: false, suppressedConnectedServiceIds: [],
          rows: [{ ref: { agentTargetKey: application.agentTargetKey, providerConnectionId: connectionId, modelId: 'example' },
            descriptor: { id: 'example', name: 'Example' }, application, sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
            compatibility: { result: { status: 'verified', selectedProtocol: application.protocol,
              evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-09' } }, compatibilityFingerprint: 'compatibility:v1:fixture', confirmed: false },
            endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible' }] }] }) });
    const signal = new AbortController().signal;
    const positive = await open({ authority, signal });
    expect(positive).not.toBeNull();
    if (!positive) throw new Error('Expected real acquired gateway');
    accesses.push(positive);
    expect(Number(await readFile(join(directory, 'gateway-started'), 'utf8'))).toBeGreaterThan(0);
    for (const denied of ['unauthorized', 'foreign'] as const) {
      projectionKind = denied;
      const deniedAccess = await open({ authority: { ...authority, payload: { ...authority.payload,
        consumer: { kind: 'execution_run', executionRunId: `run-${denied}` }, executionRunOccurrenceId: `occurrence-${denied}` } }, signal });
      if (deniedAccess) accesses.push(deniedAccess);
      expect(deniedAccess).toBeNull();
    }
    projectionKind = 'own';
    snapshot = { ...snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken('different-account') };
    const changedAccount = await open({ authority: { ...authority, payload: { ...authority.payload,
      consumer: { kind: 'execution_run', executionRunId: 'run-other-account' }, executionRunOccurrenceId: 'occurrence-other-account' } }, signal });
    if (changedAccount) accesses.push(changedAccount);
    expect(changedAccount).toBeNull();
    expect(await positive.revalidate(signal)).toBe(false);
  } finally {
    for (const access of accesses) { await access.retire(); await access.cleanup(); }
    await fixture.controller.shutdown(); fixture.disposeCredentialBoundary();
    await rm(directory, { recursive: true, force: true });
  }
});
