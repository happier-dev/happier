import { describe, expect, it, vi } from 'vitest';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { QualifiedConnectedAccountGroupV4Schema, QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ConnectedAccountUiProjectionEntryV1Schema, projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import {
  getGeneratedLegacyConnectedServiceRegistryFallback,
  getLegacyConnectedServiceRegistryEntry,
  getQualifiedConnectedServiceRegistryEntry,
  getConnectedServiceRegistrySnapshot,
  getAccountConnectedServiceConfigurationMode,
  installConnectedAccountDescriptorProjection,
  subscribeConnectedServiceRegistry,
  retireConnectedAccountDescriptorProjection,
  canExecuteConnectedServiceAction,
  getConnectedServiceSetupPresentation,
  getConnectedServiceRegistryIdentityFallback,
  isConnectedServiceUsageCapable,
  getConnectedAccountAuthentication,
  getConnectedAccountNativeLoginConstraints,
  projectConnectedServiceRegistryEntries,
} from './connectedServiceRegistry';
import { buildConnectedAccountPurposeTargetChoices } from './connectedAccountPurposeTargetChoices';
import { advanceConnectedAccountDescriptorProjectionState, createConnectedAccountDescriptorProjectionLoadingState,
  mergeConnectedAccountDescriptorProjections, type ConnectedAccountDescriptorProjectionState } from './connectedAccountDescriptorProjection';

function manualAuthentication(fields: Array<Readonly<{
  id: string;
  title: string;
  secret: boolean;
}>>) {
  return {
    defaultModeId: 'manual',
    modes: [{
      id: 'manual',
      kind: 'manual' as const,
      outcomeReconciliation: 'none' as const,
      fields: fields.map((field) => ({
        ...field,
        schema: { type: 'string' as const, minLength: 1 },
      })),
    }],
  };
}

describe('connectedServiceRegistry', () => {
  it('keeps a current publisher with no native-login constraints authoritative over bundled fallback', () => {
    const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
    expect(getConnectedAccountNativeLoginConstraints(service, { entries: [] }).length).toBeGreaterThan(0);
    const declaration = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.agent.muse/muse-account']!;
    const descriptor = projectConnectedAccountDescriptorV1({ descriptor: declaration.descriptor,
      serviceId: service.localId, pluginId: service.pluginId, provenance: 'first_party', sourceKind: 'bundled',
      availability: { state: 'available', reason: 'resolved' }, diagnostics: [], nativeLoginRequiredBy: [] });
    const resolution = mergeConnectedAccountDescriptorProjections([{ kind: 'ready', descriptors: [descriptor] }]);
    const entries = projectConnectedServiceRegistryEntries({ scopeKey: 'scope', status: 'ready', descriptors: resolution.descriptors ?? [],
      conflicts: [], errorReason: null });
    expect(getConnectedAccountNativeLoginConstraints(service, { entries })).toEqual([]);
  });
  it.each(['loading', 'ready', 'stale', 'error'] as const)('offers bundled Account-runtime authentication during %s Machine coverage without native execution', (status) => {
    const entries = projectConnectedServiceRegistryEntries({ scopeKey: 'account-cloud', status,
      descriptors: [], conflicts: [], errorReason: status === 'stale' || status === 'error' ? 'partial_machine_failure' : null });
    const hetzner = entries.find(entry => entry.service?.pluginId === 'happier.machine.hetzner'
      && entry.service.localId === 'hetzner-account');
    expect(hetzner).toMatchObject({ executable: false, projectionStatus: 'ready',
      projectedDescriptor: { ui: { category: 'cloud-machines' } } });
    expect(canExecuteConnectedServiceAction(hetzner!, 'advertised-v4')).toBe(true);
  });

  it('normalizes bundled declarations through the closed UI projection without leaking producer metadata', () => {
    const bundled = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.agent.codex/openai-codex']!;
    const descriptor = projectConnectedAccountDescriptorV1({ descriptor: bundled.descriptor,
      pluginId: bundled.service.pluginId, serviceId: bundled.service.localId, provenance: 'first_party', sourceKind: 'bundled',
      availability: { state: 'available', reason: 'resolved' }, diagnostics: [] });
    const result = mergeConnectedAccountDescriptorProjections([{ kind: 'ready', descriptors: [descriptor] }]);
    expect(result.kind).toBe('ready');
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse(result.descriptors?.[0]).success).toBe(true);
  });

  it.each([
    { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
    { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
  ])('offers another $localId account from its admitted auth declaration without granting native execution', (service) => {
    const entry = getConnectedServiceRegistryIdentityFallback(service);
    expect(entry.executable).toBe(false);
    expect(canExecuteConnectedServiceAction(entry, 'advertised-v4')).toBe(true);
    expect(canExecuteConnectedServiceAction({ ...entry, availability: {
      state: 'blocked', reason: 'execution_origin_unavailable',
    } }, 'advertised-v4')).toBe(true);
    for (const availability of [
      { state: 'disabled' as const, reason: 'disabled' },
      { state: 'blocked' as const, reason: 'policy_refused' },
    ]) {
      expect(canExecuteConnectedServiceAction({ ...entry, availability }, 'advertised-v4')).toBe(false);
    }
    expect(canExecuteConnectedServiceAction({ ...entry, projectionStatus: 'conflict' }, 'advertised-v4')).toBe(false);
  });

  it('publishes selected Account authentication declarations without manufacturing native execution or unchanged updates', () => {
    const service = { pluginId: 'acme.portable-auth', localId: 'portable' };
    const descriptor = projectConnectedAccountDescriptorV1({ descriptor: {
      id: service.localId, title: 'Portable account', authentication: {
        defaultModeId: 'device', account: { artifactId: 'account-auth', exportName: 'activate' },
        modes: [{ id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }],
      },
    }, serviceId: service.localId, pluginId: service.pluginId, provenance: 'external', sourceKind: 'account_release',
      availability: { state: 'available', reason: 'account_declaration' }, diagnostics: [] });
    const declarations = [descriptor];
    const lifetime = { scope: { serverId: 'portable-home', accountId: 'account-a' }, isCurrent: () => true,
      onRetire: () => ({ dispose() {} }) };
    const projection = { scopeKey: 'portable-home', status: 'ready' as const, descriptors: [], conflicts: [], errorReason: null };
    let publications = 0;
    const unsubscribe = subscribeConnectedServiceRegistry(() => { publications += 1; });
    try {
      installConnectedAccountDescriptorProjection(projection, lifetime, declarations);
      const entry = getQualifiedConnectedServiceRegistryEntry(service);
      expect(entry).toMatchObject({ executable: false, projectionStatus: 'ready',
        projectedDescriptor: { authentication: { account: { artifactId: 'account-auth', exportName: 'activate' } } } });
      expect(canExecuteConnectedServiceAction(entry!, 'advertised-v4')).toBe(true);
      expect(publications).toBe(1);
      installConnectedAccountDescriptorProjection(projection, lifetime, declarations);
      expect(publications).toBe(1);
      expect(getQualifiedConnectedServiceRegistryEntry(service)).toBe(entry);
      installConnectedAccountDescriptorProjection(projection, lifetime, []);
      expect(getQualifiedConnectedServiceRegistryEntry(service)).toBeNull();
      expect(publications).toBe(2);
    } finally { unsubscribe(); retireConnectedAccountDescriptorProjection(lifetime); }
  });

  it('keeps selected Account authoring independent from an enrolled Machine declaration', () => {
    const descriptor = projectConnectedAccountDescriptorV1({ descriptor: {
      id: 'portable', title: 'Current Account title', authentication: {
        defaultModeId: 'device', account: { artifactId: 'account-auth', exportName: 'activate' },
        modes: [{ id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }],
      },
    }, serviceId: 'portable', pluginId: 'acme.portable-auth', provenance: 'external', sourceKind: 'account_release',
      availability: { state: 'available', reason: 'account_declaration' }, diagnostics: [] });
    const machineDescriptor = { ...descriptor, title: 'Old Machine title', sourceKind: 'installed',
      authentication: manualAuthentication([]), availability: { state: 'disabled' as const, reason: 'disabled' } };
    const projection = { scopeKey: 'portable-home', status: 'ready' as const,
      descriptors: [machineDescriptor], conflicts: [], errorReason: null };
    const readPortable = (entries: ReturnType<typeof projectConnectedServiceRegistryEntries>) => entries.find(
      entry => entry.service?.pluginId === 'acme.portable-auth' && entry.service.localId === 'portable',
    )!;
    const entry = readPortable(projectConnectedServiceRegistryEntries(projection, [descriptor]));
    expect(entry).toMatchObject({ projectedTitle: 'Current Account title', executable: false, projectionStatus: 'ready' });
    expect(canExecuteConnectedServiceAction(entry, 'advertised-v4')).toBe(true);
    const nativeEntry = readPortable(projectConnectedServiceRegistryEntries({ ...projection,
      descriptors: [{ ...machineDescriptor, availability: { state: 'available', reason: 'resolved' } }],
    }, [descriptor]));
    expect(nativeEntry).toMatchObject({ projectedTitle: 'Current Account title', executable: true });
  });

  it('offers the bundled Account-direct key declaration without inventing a Machine executable', () => {
    const entries = projectConnectedServiceRegistryEntries({ scopeKey: 'no-machine-home', status: 'ready',
      descriptors: [], conflicts: [], errorReason: null });
    const entry = entries.find(entry => entry.service?.pluginId === 'happier.agent.claude' && entry.service.localId === 'anthropic');
    expect(entry).toMatchObject({ executable: false, projectionStatus: 'ready',
      authenticationModes: [expect.objectContaining({ id: 'api-key', accountDirectSave: true })] });
    expect(canExecuteConnectedServiceAction(entry!, 'advertised-v4')).toBe(true);
    expect(canExecuteConnectedServiceAction({ ...entry!, availability: { state: 'disabled', reason: 'disabled' } }, 'advertised-v4')).toBe(false);
  });
  it('orders projected services by qualified key code units without platform locale collation', () => {
    // Hermes on Android answers each String#localeCompare through a JNI Collator copy;
    // an iOS DEV cold start still spent ~1,900 of them ordering these keys.
    const original = String.prototype.localeCompare;
    let collations = 0;
    String.prototype.localeCompare = function (this: string, ...args: Parameters<typeof original>) {
      collations += 1;
      return original.apply(this, args);
    };
    try {
      const entries = projectConnectedServiceRegistryEntries({ scopeKey: 'collation-home', status: 'ready',
        descriptors: [], conflicts: [], errorReason: null });
      const keys = entries.flatMap(entry => entry.service ? [buildQualifiedPluginContributionKey(entry.service)] : []);
      expect(keys.length).toBeGreaterThan(1);
      expect(keys).toEqual([...keys].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
      expect(collations).toBe(0);
    } finally {
      String.prototype.localeCompare = original;
    }
  });
  it('admits retained bundled Account-direct authoring without borrowing missing native execution or bypassing real policy', () => {
    const service = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
    const declared = projectConnectedServiceRegistryEntries({ scopeKey: 'declaration', status: 'ready',
      descriptors: [], conflicts: [], errorReason: null }).find(entry => entry.service?.pluginId === service.pluginId && entry.service.localId === service.localId)!;
    const resolved = mergeConnectedAccountDescriptorProjections([{ kind: 'ready', descriptors: [declared.projectedDescriptor!],
      executionUnavailablePluginIds: [service.pluginId] }]);
    if (resolved.kind !== 'ready') throw new Error('Expected retained declaration');
    const lifetime = { scope: { serverId: 'offline-home', accountId: 'account-a' }, isCurrent: () => true,
      onRetire: () => ({ dispose() {} }) };
    const projection = { ...resolved, scopeKey: 'offline-home', status: 'stale' as const, answeredDescriptorIdentities: [], errorReason: 'transport' as const };
    installConnectedAccountDescriptorProjection(projection, lifetime);
    const entry = getQualifiedConnectedServiceRegistryEntry(service)!;
    expect(entry.availability).toEqual({ state: 'blocked', reason: 'execution_origin_unavailable' });
    expect(entry.executable).toBe(false);
    expect(canExecuteConnectedServiceAction(entry, 'advertised-v4')).toBe(true);
    expect(getAccountConnectedServiceConfigurationMode({ service, modeId: 'api-key' }, lifetime.scope)).toMatchObject({ accountDirectSave: true });
    for (const availability of [{ state: 'disabled' as const, reason: 'disabled' },
      { state: 'blocked' as const, reason: 'plugin_declaration_unusable' }]) {
      installConnectedAccountDescriptorProjection({ ...projection, status: 'ready', answeredDescriptorIdentities: undefined,
        descriptors: projection.descriptors.map(descriptor => ({ ...descriptor, availability })) }, lifetime);
      expect(canExecuteConnectedServiceAction(getQualifiedConnectedServiceRegistryEntry(service)!, 'advertised-v4')).toBe(false);
      expect(getAccountConnectedServiceConfigurationMode({ service, modeId: 'api-key' }, lifetime.scope)).toBeNull();
    }
    retireConnectedAccountDescriptorProjection(lifetime);
  });
  it('keeps a repeated descriptor publication stable while adopting replacement Account lifetimes', () => {
    const projection = createConnectedAccountDescriptorProjectionLoadingState('publication-home');
    const lifetime = { scope: { serverId: 'publication-home', accountId: 'account-a' }, isCurrent: () => true,
      onRetire: () => ({ dispose() {} }) };
    installConnectedAccountDescriptorProjection(projection, lifetime);
    const snapshot = getConnectedServiceRegistrySnapshot();
    const notify = vi.fn();
    const stop = subscribeConnectedServiceRegistry(notify);
    try {
      installConnectedAccountDescriptorProjection(projection, lifetime);
      expect(getConnectedServiceRegistrySnapshot()).toBe(snapshot);
      expect(notify).not.toHaveBeenCalled();
      installConnectedAccountDescriptorProjection(projection, { ...lifetime });
      expect(notify).toHaveBeenCalledTimes(1);
      installConnectedAccountDescriptorProjection({ ...projection, status: 'stale', errorReason: 'transport' }, lifetime);
      expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'transport' });
      expect(notify).toHaveBeenCalledTimes(2);
      retireConnectedAccountDescriptorProjection(lifetime);
      installConnectedAccountDescriptorProjection(projection);
      expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ scopeKey: projection.scopeKey, status: 'loading' });
      expect(notify).toHaveBeenCalledTimes(4);
    } finally { stop(); }
  });
  it('does not extend the released scalar service contract from a generated-only compatibility key', () => {
    expect(getGeneratedLegacyConnectedServiceRegistryFallback({
      pluginId: 'happier.agent.antigravity', localId: 'antigravity-account',
    })).toBeNull();
  });
  it('reads generated compatibility without revalidating its static keys on presentation reads', () => {
    // Count real schema work without replacing the parser or registry logic.
    const parses = vi.spyOn(ConnectedServiceIdSchema, 'safeParse');
    try {
      for (let index = 0; index < 3; index++) {
        expect(getConnectedServiceSetupPresentation({ pluginId: 'happier.agent.claude', localId: 'claude-subscription' }))
          .toMatchObject({ firstRun: true });
        expect(getConnectedServiceSetupPresentation({ pluginId: 'acme.external', localId: 'claude-subscription' })).toBeNull();
      }
      expect(parses).not.toHaveBeenCalled();
    } finally { parses.mockRestore(); }
  });
  it('reads setup presentation from the exact qualified declaration instead of a built-in service map', () => {
    const service = { pluginId: 'acme.external', localId: 'claude-subscription' };
    const setup = { order: 12, firstRun: true, catalogDescription: 'Use an Acme account' };
    const projectedDescriptor = projectConnectedAccountDescriptorV1({
      descriptor: { id: service.localId, title: 'Acme', ui: { setup }, authentication: manualAuthentication([]) },
      pluginId: service.pluginId, serviceId: service.localId, provenance: 'external', sourceKind: 'installed',
      availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    });
    expect(getConnectedServiceSetupPresentation(service, { projectedDescriptor })).toEqual(setup);
    expect(getConnectedServiceSetupPresentation(service)).toBeNull();
    const builtIn = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
    expect(getConnectedServiceSetupPresentation(builtIn, { projectedDescriptor: { ...projectedDescriptor,
      pluginId: builtIn.pluginId, ui: { setup: { firstRun: false } },
    } })).toEqual({ firstRun: false });
  });
  it('selects usage services by their exact capability owner, including installed services', () => {
    const descriptor = (pluginId: string, capabilities: string[]) => ({
      id: 'account', serviceId: 'account', pluginId, title: 'Account', provenance: 'external' as const,
      sourceKind: 'installed', authentication: manualAuthentication([]), capabilities,
      availability: { state: 'available' as const, reason: 'resolved' }, diagnostics: [],
    });
    install([descriptor('acme.metered', ['usage']), descriptor('acme.email', [])]);
    expect(isConnectedServiceUsageCapable({ pluginId: 'acme.metered', localId: 'account' })).toBe(true);
    expect(isConnectedServiceUsageCapable({ pluginId: 'acme.email', localId: 'account' })).toBe(false);
    expect(isConnectedServiceUsageCapable({ pluginId: 'unknown', localId: 'openai-codex' })).toBe(false);
    expect(isConnectedServiceUsageCapable({ pluginId: 'happier.agent.codex', localId: 'openai-codex' })).toBe(true);
  });
  const install = (
    descriptors: ConnectedAccountDescriptorProjectionState['descriptors'],
    status: ConnectedAccountDescriptorProjectionState['status'] = 'ready',
  ) => installConnectedAccountDescriptorProjection({
    scopeKey: 'server-a', status, descriptors, conflicts: [], errorReason: status === 'stale' ? 'transport' : null,
  });

  it.each(['no Machine', 'two Machines', 'two Machines with different declarations'] as const)('keeps a saved bundled pool selectable with %s supplying declarations', (suppliers) => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const bundled = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS[`${service.pluginId}/${service.localId}`]!;
    const descriptor = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({
      descriptor: bundled.descriptor, pluginId: service.pluginId, serviceId: service.localId,
      provenance: 'first_party', sourceKind: 'bundled',
      availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    }));
    const { usageIdentity, ...withoutUsageIdentity } = descriptor;
    expect(usageIdentity).toBeDefined();
    const merged = mergeConnectedAccountDescriptorProjections(suppliers === 'no Machine' ? [] : [
      { kind: 'ready', descriptors: [suppliers === 'two Machines with different declarations' ? {
        ...withoutUsageIdentity, title: 'Older Machine title', capabilities: [],
        authentication: manualAuthentication([]), usageIdentity: { providerId: 'older.usage' },
      } : withoutUsageIdentity] },
      { kind: 'ready', descriptors: [descriptor] },
    ]);
    installConnectedAccountDescriptorProjection(advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'), merged,
    ));
    const account = QualifiedConnectedAccountProfileV4Schema.parse({
      ref: { service, accountId: 'work' }, status: 'connected', authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      configurationReady: true, configurationRevision: null, scopes: [],
    });
    const group = QualifiedConnectedAccountGroupV4Schema.parse({
      v: 1, ref: { service, groupId: 'work-pool' }, incarnation: 'work-pool-row', displayName: 'Work pool',
      policy: {}, activeConnectedAccountId: 'work', generation: 1, runtimeStateRevision: 1,
      state: { status: 'ready' }, createdAt: 1, updatedAt: 1,
      members: [{ v: 1, connectedAccountId: 'work', priority: 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 }],
    });
    const choices = buildConnectedAccountPurposeTargetChoices({
      declaration: { purpose: 'openai-upstream', service, required: false },
      selectedTarget: { kind: 'group', service, groupId: 'work-pool' },
      accounts: [account], groups: [group], labelsByKey: {}, serviceTitle: 'ChatGPT',
      sourceNegotiation: 'advertised-v4',
      resolveAuthentication: target => getConnectedAccountAuthentication(target, getConnectedServiceRegistrySnapshot()),
    });
    const selected = choices.find(choice => choice.current && choice.kind === 'group');
    expect(selected).toMatchObject({ eligibility: 'usable', selectable: true });
    expect(selected?.presentation.unavailableReason).toBeUndefined();
    // Account-runtime authoring stays offered without granting native execution.
    if (suppliers === 'no Machine') expect(getQualifiedConnectedServiceRegistryEntry(service)).toMatchObject({
      executable: false, projectionStatus: 'ready',
    });
    else {
      expect(merged.kind).toBe('ready');
      expect(merged.descriptors).toHaveLength(1);
      expect(merged.descriptors?.[0]).toMatchObject({
        title: bundled.descriptor.title, authentication: bundled.descriptor.authentication,
        capabilities: bundled.descriptor.capabilities ?? [], usageIdentity: bundled.descriptor.usageIdentity,
      });
      expect(getQualifiedConnectedServiceRegistryEntry(service)?.projectedDescriptorCandidates).toHaveLength(1);
    }
    expect(getConnectedAccountAuthentication({ pluginId: 'acme.foreign', localId: service.localId })).toBeNull();
  });

  it.each(['external', 'external with bundled key', 'unknown bundled', 'first-party installed'] as const)('refuses genuinely divergent usage declarations for %s supplies', (variant) => {
    const bundled = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.agent.codex/openai-codex']!;
    const service = { pluginId: variant === 'first-party installed' || variant === 'external with bundled key' ? bundled.service.pluginId : 'acme.accounts', localId: bundled.service.localId };
    const descriptor = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({
      descriptor: bundled.descriptor, pluginId: service.pluginId, serviceId: service.localId,
      provenance: variant.startsWith('external') ? 'external' : 'first_party',
      sourceKind: variant === 'first-party installed' ? 'installed' : 'bundled',
      availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    }));
    const other = { ...descriptor, usageIdentity: { providerId: 'acme.usage' } };
    const merged = mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [descriptor] }, { kind: 'ready', descriptors: [other] },
    ]);
    installConnectedAccountDescriptorProjection(advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'), merged,
    ));
    expect(merged.kind).toBe('conflict');
    expect(merged.descriptors).toHaveLength(2);
    expect(getConnectedAccountAuthentication(service)).toBeNull();
  });

  it('does not fill omitted usage metadata for an external declaration', () => {
    const bundled = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.agent.codex/openai-codex']!;
    const service = { pluginId: 'acme.accounts', localId: bundled.service.localId };
    const descriptor = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({
      descriptor: { ...bundled.descriptor, title: 'Different declaration' }, pluginId: service.pluginId, serviceId: service.localId,
      provenance: 'external', sourceKind: 'bundled',
      availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    }));
    const { usageIdentity: omitted, ...withoutUsageIdentity } = descriptor;
    expect(omitted).toBeDefined();
    const merged = mergeConnectedAccountDescriptorProjections([
      { kind: 'ready', descriptors: [withoutUsageIdentity] }, { kind: 'ready', descriptors: [descriptor] },
    ]);
    expect(merged.kind).toBe('conflict');
    expect(merged.descriptors).toHaveLength(2);
  });

  it('preserves projected authentication and refuses conflicting suppliers rather than borrowing bundled modes', () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const descriptor: ConnectedAccountDescriptorProjectionState['descriptors'][number] = {
      id: service.localId, pluginId: service.pluginId, serviceId: 'openai-codex', title: 'ChatGPT',
      provenance: 'first_party', sourceKind: 'bundled', authentication: manualAuthentication([]), capabilities: [],
      availability: { state: 'blocked', reason: 'runtime_unavailable' }, diagnostics: [],
    };
    install([descriptor]);
    expect(getConnectedAccountAuthentication(service)).toEqual(descriptor.authentication);
    install([descriptor, { ...descriptor, authentication: manualAuthentication([{ id: 'other', title: 'Other', secret: true }]) }], 'conflict');
    expect(getConnectedAccountAuthentication(service)).toBeNull();
  });

  it('admits Account configuration from the exact current descriptor even without a native executable', () => {
    const service = { pluginId: 'acme.multi', localId: 'cloud' };
    const mode = { id: 'manual', kind: 'manual' as const, outcomeReconciliation: 'none' as const,
      fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' as const, minLength: 1 } }],
      configuration: { scope: 'service' as const, changeBehavior: 'reconnect' as const, fields: [] } };
    const projection: ConnectedAccountDescriptorProjectionState = { scopeKey: 'server-a', status: 'ready', conflicts: [], errorReason: null,
      descriptors: [{ id: service.localId, pluginId: service.pluginId, serviceId: 'cloud', title: 'Cloud', provenance: 'external',
        sourceKind: 'installed', authentication: { defaultModeId: mode.id, modes: [mode] }, capabilities: [], ui: { category: 'cloud-machines' },
        availability: { state: 'blocked', reason: 'runtime_unavailable' }, diagnostics: [] }] };
    let current = true;
    const lifetime = { scope: { serverId: 'server-a', accountId: 'account-a' }, isCurrent: () => current,
      onRetire: () => ({ dispose() {} }) };
    const target = { service, modeId: mode.id };
    installConnectedAccountDescriptorProjection(projection);
    expect(getAccountConnectedServiceConfigurationMode(target, lifetime.scope)).toBeNull();
    expect(getConnectedServiceRegistrySnapshot(lifetime.scope).entries).toEqual([]);
    installConnectedAccountDescriptorProjection(projection, lifetime);
    expect(getConnectedServiceRegistrySnapshot(lifetime.scope).entries.filter(entry => entry.service?.pluginId === service.pluginId
      && entry.service.localId === service.localId)).toHaveLength(1);
    expect(getConnectedServiceRegistrySnapshot({ ...lifetime.scope, accountId: 'account-b' }).entries).toEqual([]);
    expect(getQualifiedConnectedServiceRegistryEntry(service)?.executable).toBe(false);
    expect(getQualifiedConnectedServiceRegistryEntry(service)?.projectedDescriptor?.ui).toEqual({ category: 'cloud-machines' });
    expect(getAccountConnectedServiceConfigurationMode(target, lifetime.scope)).toEqual(mode);
    expect(getAccountConnectedServiceConfigurationMode(target, { ...lifetime.scope, accountId: 'account-b' })).toBeNull();
    installConnectedAccountDescriptorProjection({ ...projection, status: 'stale' }, lifetime);
    expect(getAccountConnectedServiceConfigurationMode(target, lifetime.scope)).toBeNull();
    installConnectedAccountDescriptorProjection(projection, lifetime);
    current = false;
    expect(getAccountConnectedServiceConfigurationMode(target, lifetime.scope)).toBeNull();
    expect(getConnectedServiceRegistrySnapshot(lifetime.scope).entries).toEqual([]);
  });

  it('admits healthy token, OAuth and service configuration while an unsupported Machine leaves the Account census stale', () => {
    const service = { pluginId: 'acme.multi', localId: 'cloud' };
    const manual = { ...manualAuthentication([{ id: 'token', title: 'Token', secret: true }]).modes[0]!,
      configuration: { scope: 'service' as const, changeBehavior: 'reconnect' as const, fields: [] } };
    const descriptor: ConnectedAccountDescriptorProjectionState['descriptors'][number] = {
      id: service.localId, pluginId: service.pluginId, serviceId: 'cloud', title: 'Cloud', provenance: 'external',
      sourceKind: 'installed', authentication: { defaultModeId: 'manual', modes: [manual,
        { id: 'browser', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'none' }] },
      capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    };
    const scope = { serverId: 'server-a', accountId: 'account-a' };
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const partial = advanceConnectedAccountDescriptorProjectionState(
      createConnectedAccountDescriptorProjectionLoadingState('server-a'),
      mergeConnectedAccountDescriptorProjections([
        { kind: 'ready', descriptors: [descriptor] }, { kind: 'error', reason: 'unsupported' },
      ]),
    );
    installConnectedAccountDescriptorProjection(partial, lifetime);
    const entry = getQualifiedConnectedServiceRegistryEntry(service)!;
    expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'partial_machine_failure' });
    expect(entry).toMatchObject({ executable: true, supportsToken: true, supportsOauth: true, projectionStatus: 'ready' });
    expect(canExecuteConnectedServiceAction(entry, 'advertised-v4')).toBe(true);
    expect(getAccountConnectedServiceConfigurationMode({ service, modeId: 'manual' }, scope)).toEqual(manual);

    const noSupplier = advanceConnectedAccountDescriptorProjectionState(partial,
      mergeConnectedAccountDescriptorProjections([{ kind: 'error', reason: 'unsupported' }]));
    installConnectedAccountDescriptorProjection(noSupplier, lifetime);
    expect(getQualifiedConnectedServiceRegistryEntry(service)).toMatchObject({ executable: false });
    expect(getAccountConnectedServiceConfigurationMode({ service, modeId: 'manual' }, scope)).toBeNull();
  });

  it('projects every declared authentication mode and preserves the default mode', () => {
    install([{
      id: 'multi-account',
      serviceId: 'multi-account',
      pluginId: 'acme.multi',
      provenance: 'external',
      sourceKind: 'installed',
      title: 'Multi account',
      authentication: {
        defaultModeId: 'manual',
        modes: [{
          id: 'manual',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Token',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }, {
          id: 'browser',
          kind: 'oauthAuthorizationCode',
          callbackUrl: 'http://127.0.0.1:4000/auth/callback',
          pkce: 'required',
          outcomeReconciliation: 'providerCheck',
        }, {
          id: 'device',
          kind: 'oauthDeviceCode',
          outcomeReconciliation: 'providerCheck',
        }],
      },
      capabilities: [],
      availability: { state: 'available', reason: 'resolved' },
      diagnostics: [],
    }]);

    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'acme.multi', localId: 'multi-account',
    })).toMatchObject({
      executable: true,
      supportsToken: true,
      supportsOauth: true,
      defaultAuthenticationModeId: 'manual',
      authenticationModes: [
        expect.objectContaining({ id: 'manual', kind: 'manual' }),
        expect.objectContaining({ id: 'browser', kind: 'oauthAuthorizationCode' }),
        expect.objectContaining({ id: 'device', kind: 'oauthDeviceCode' }),
      ],
      oauthAddActionModes: ['browser', 'paste', 'device'],
    });
  });

  it('consumes projected plugin descriptors through the canonical registry', () => {
    install([{ id: 'bitbucket-account', serviceId: 'bitbucket', pluginId: 'happier.scm.forge.bitbucket', provenance: 'external', sourceKind: 'bundled', title: 'Bitbucket account', authentication: manualAuthentication([{ id: 'token', title: 'Token', secret: true }]), capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }]);
    expect(getLegacyConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ connectCommand: 'happier connect bitbucket --token', supportsToken: true });
    install([]);
    expect(getLegacyConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ supportsToken: false });
  });

  it('publishes immutable replacement entry snapshots for projection currentness', () => {
    install([{ id: 'bitbucket-account', serviceId: 'bitbucket', pluginId: 'happier.scm.forge.bitbucket', provenance: 'external', sourceKind: 'bundled', title: 'Bitbucket account', authentication: manualAuthentication([{ id: 'token', title: 'Token', secret: true }]), capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }]);
    const previous = getConnectedServiceRegistrySnapshot();

    install([{ id: 'openai', serviceId: 'openai', pluginId: 'happier.voice.openai', provenance: 'first_party', sourceKind: 'bundled', title: 'OpenAI', authentication: manualAuthentication([{ id: 'token', title: 'API key', secret: true }]), capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }]);
    const current = getConnectedServiceRegistrySnapshot();

    expect(current.entries).not.toBe(previous.entries);
    expect(Object.isFrozen(current.entries)).toBe(true);
    expect(previous.entries.some(entry => entry.serviceId === 'bitbucket')).toBe(true);
    expect(current.entries.some(entry => entry.serviceId === 'bitbucket')).toBe(false);
    expect(current.entries.some(entry => entry.serviceId === 'openai')).toBe(true);
  });

  it('preserves rich blocked descriptor facts while keeping the service visible and non-executable', () => {
    const projected = {
      id: 'bitbucket-account', serviceId: 'bitbucket' as const, pluginId: 'happier.scm.forge.bitbucket', provenance: 'external' as const,
      sourceKind: 'bundled', title: { key: 'plugin.bitbucket.title', fallback: 'Bitbucket Cloud' },
      description: 'Connect repositories and pull requests',
      authentication: manualAuthentication([{ id: 'identity', title: 'Email', secret: false }, { id: 'token', title: 'API token', secret: true }]),
      capabilities: ['scm.repositories'], availability: { state: 'blocked' as const, reason: 'plugin_diagnostics' }, diagnostics: ['missing_runtime'],
    };
    install([projected]);

    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account',
    })).toMatchObject({
      executable: false,
      projectedDescriptor: projected,
      projectedTitle: projected.title,
      projectedDescription: projected.description,
      provenance: 'external',
      sourceKind: 'bundled',
      availability: { state: 'blocked', reason: 'plugin_diagnostics' },
      diagnostics: ['missing_runtime'],
      supportsOauth: false,
      supportsToken: false,
    });
  });

  it('retains last-known-good facts as stale and reports lifecycle without making them executable', () => {
    const projected = { id: 'bitbucket-account', serviceId: 'bitbucket' as const, pluginId: 'happier.scm.forge.bitbucket', provenance: 'external' as const, sourceKind: 'bundled', title: 'Bitbucket', authentication: manualAuthentication([{ id: 'token', title: 'Token', secret: true }]), capabilities: [], availability: { state: 'available' as const, reason: 'resolved' }, diagnostics: [] };
    install([projected], 'stale');

    expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'transport' });
    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account',
    })).toMatchObject({
      executable: false,
      projectionStatus: 'stale',
      projectedDescriptor: projected,
    });
  });

  it('keeps same-local-id services independent and reserves a legacy scalar for its generated owner', () => {
    const conflictedLeft = {
      id: 'github-account',
      serviceId: 'github' as const,
      pluginId: 'happier.scm.forge.github',
      provenance: 'first_party' as const,
      sourceKind: 'bundled',
      title: 'GitHub account',
      authentication: manualAuthentication([{ id: 'token', title: 'Token', secret: true }]),
      capabilities: [],
      availability: { state: 'available' as const, reason: 'resolved' },
      diagnostics: [],
    };
    const conflictedRight = {
      ...conflictedLeft,
      id: 'github',
      pluginId: 'acme.vertical-a',
      provenance: 'external' as const,
      title: 'Packed GitHub account',
    };
    const unrelated = {
      ...conflictedLeft,
      id: 'novel-cloud',
      serviceId: 'forge',
      pluginId: 'acme.vertical-a',
      provenance: 'external' as const,
      title: 'Novel Cloud',
    };
    const unrelatedBuiltIn = {
      ...conflictedLeft,
      id: 'anthropic',
      serviceId: 'anthropic',
      pluginId: 'happier.agent.claude',
      title: 'Anthropic API key',
    };

    installConnectedAccountDescriptorProjection({
      scopeKey: 'server-a',
      status: 'ready',
      descriptors: [conflictedLeft, conflictedRight, unrelated, unrelatedBuiltIn],
      conflicts: [],
      errorReason: null,
    });

    expect(getLegacyConnectedServiceRegistryEntry('github')).toMatchObject({
      service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
      executable: true,
      projectionStatus: 'ready',
    });
    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'acme.vertical-a', localId: 'github',
    })).toMatchObject({
      service: { pluginId: 'acme.vertical-a', localId: 'github' },
      executable: true,
      projectionStatus: 'ready',
    });
    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'acme.vertical-a', localId: 'novel-cloud',
    })).toMatchObject({
      service: { pluginId: 'acme.vertical-a', localId: 'novel-cloud' },
      executable: true,
      projectionStatus: 'ready',
    });
    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'happier.agent.claude', localId: 'anthropic',
    })).toMatchObject({
      service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
      executable: true,
      projectionStatus: 'ready',
    });

    installConnectedAccountDescriptorProjection({
      scopeKey: 'server-a',
      status: 'ready',
      descriptors: [conflictedLeft, unrelatedBuiltIn],
      conflicts: [],
      errorReason: null,
    });

    expect(getLegacyConnectedServiceRegistryEntry('github')).toMatchObject({
      service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
      executable: true,
      projectionStatus: 'ready',
    });
    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'acme.vertical-a', localId: 'novel-cloud',
    })).toBeNull();
  });

  it('names a built-in service from its stored qualified identity while no machine publishes it', () => {
    install([]);

    // The account's `ref.service` distinguishes the two Claude services exactly;
    // an offline machine must not collapse either into the generic title.
    expect(getGeneratedLegacyConnectedServiceRegistryFallback({
      pluginId: 'happier.agent.claude', localId: 'anthropic',
    })).toMatchObject({ projectedTitle: BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.agent.claude/anthropic']!.descriptor.title, executable: false });
    expect(getGeneratedLegacyConnectedServiceRegistryFallback({
      pluginId: 'happier.agent.claude', localId: 'claude-subscription',
    })).toMatchObject({ projectedTitle: BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.agent.claude/claude-subscription']!.descriptor.title, executable: false });
    expect(getLegacyConnectedServiceRegistryEntry('openai-codex').projectedTitle)
      .toEqual(BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.agent.codex/openai-codex']!.descriptor.title);
    // A service with no released built-in identity has nothing to name it by.
    expect(getGeneratedLegacyConnectedServiceRegistryFallback({
      pluginId: 'external.plugin', localId: 'gateway',
    })).toBeNull();
  });

  it('does not infer executable built-in behavior before the daemon projection arrives', () => {
    install([]);

    expect(getLegacyConnectedServiceRegistryEntry('openai-codex')).toMatchObject({
      supportsOauth: false,
      supportsToken: false,
      executable: false,
    });
    expect(getLegacyConnectedServiceRegistryEntry('openai')).toMatchObject({
      connectCommand: 'happier connect openai',
      supportsToken: false,
      executable: false,
    });
    expect(getLegacyConnectedServiceRegistryEntry('gemini')).toMatchObject({
      supportsOauth: false,
      supportsToken: false,
      executable: false,
    });
  });

  it('makes the exact qualified bundled projection authoritative over the legacy built-in presentation', () => {
    const legacyEntry = getLegacyConnectedServiceRegistryEntry('openai');
    install([{
      id: 'openai',
      serviceId: 'openai',
      pluginId: 'happier.voice.openai',
      provenance: 'first_party',
      sourceKind: 'bundled',
      title: 'OpenAI API key',
      authentication: manualAuthentication([{ id: 'token', title: 'API key', secret: true }]),
      capabilities: [],
      availability: { state: 'available', reason: 'resolved' },
      diagnostics: [],
    }]);

    const projectedEntry = getLegacyConnectedServiceRegistryEntry('openai');
    expect(projectedEntry).not.toBe(legacyEntry);
    expect(projectedEntry).toMatchObject({
      service: { pluginId: 'happier.voice.openai', localId: 'openai' },
      projectedDescriptor: expect.objectContaining({
        pluginId: 'happier.voice.openai',
        id: 'openai',
      }),
      defaultAuthenticationModeId: 'manual',
      authenticationModes: [
        expect.objectContaining({ id: 'manual', kind: 'manual' }),
      ],
    });
  });

  it('projects Bitbucket API-token setup metadata from descriptors', () => {
    install([{
      id: 'bitbucket-account', serviceId: 'bitbucket', pluginId: 'happier.scm.forge.bitbucket', provenance: 'external', sourceKind: 'bundled',
      title: 'Bitbucket account', authentication: manualAuthentication([
        { id: 'identity', title: 'Email or username', secret: false },
        { id: 'token', title: 'API token', secret: true },
      ]),
      capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    }]);
    const entry = getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account',
    })!;

    expect(entry.connectCommand).toBe('happier connect bitbucket --token');
    expect(entry.displayNameKey).toBeUndefined();
    expect(entry.supportsOauth).toBe(false);
    expect(entry.supportsToken).toBe(true);
    expect(entry.tokenKind).toBe('api-token');
    expect(entry.tokenSetupUrl).toBeUndefined();
    expect(entry.tokenIdentityPromptLabelKey).toBe('Email or username');
    expect(entry.tokenPromptLabelKey).toBe('API token');
  });

  it('does not claim an executable token action for unsupported multi-secret manual forms', () => {
    install([{
      id: 'complex-account', serviceId: 'bitbucket', pluginId: 'complex-plugin', provenance: 'external', sourceKind: 'bundled',
      title: 'Complex account', authentication: manualAuthentication([
        { id: 'client-secret', title: 'Client secret', secret: true },
        { id: 'access-token', title: 'Access token', secret: true },
      ]),
      capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    }]);

    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'complex-plugin', localId: 'complex-account',
    })).toMatchObject({
      supportsToken: false,
      connectCommand: 'happier connect bitbucket',
    });
  });

  it('keeps same-local-id services from different plugins independently qualified', () => {
    const left = {
      id: 'shared-service',
      serviceId: 'shared-service',
      pluginId: 'acme.connected.left',
      provenance: 'external' as const,
      sourceKind: 'installed',
      title: 'Left service',
      authentication: manualAuthentication([{ id: 'token', title: 'Token', secret: true }]),
      capabilities: [],
      availability: { state: 'available' as const, reason: 'resolved' },
      diagnostics: [],
    };
    const right = {
      ...left,
      pluginId: 'acme.connected.right',
      title: 'Right service',
    };

    install([left, right]);

    expect(getConnectedServiceRegistrySnapshot().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: { pluginId: 'acme.connected.left', localId: 'shared-service' },
        executable: true,
      }),
      expect.objectContaining({
        service: { pluginId: 'acme.connected.right', localId: 'shared-service' },
        executable: true,
      }),
    ]));
  });
});
