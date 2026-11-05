import type { ActionExecuteResult } from '../../actions/actionExecutionResult.js';
import type { ActionExecutorContext } from '../../actions/executor/types.js';
import type { AgentProviderRequirementsV1 } from '../compatibility/v1.js';
import { projectAccountProviderConnectionModelsV1, projectAccountProviderModelsV1, type AccountProviderDeclarationV1 } from '../catalog/accountModelProjectionV1.js';
export type { AccountProviderDeclarationV1 } from '../catalog/accountModelProjectionV1.js';
import { resolveProviderManagedRuntimeDeclarationV1, resolveManagedPurposeBindingIntentsV1 } from '../contributions/v1.js';
import { areProviderContributionKeysEqualV1, canonicalizeProviderContributionKeyV1, parseProviderContributionIdentityV1 } from '../contributionIdentityV1.js';
import { createProviderErrorV1, ProviderErrorV1Schema, type ProviderErrorCodeV1 } from '../errors.js';
import { canonicalizeFingerprintValue, createProviderFingerprintV1, isProviderDestinationGrantFingerprintV2 } from '../fingerprints.js';
import { PROVIDER_ACTION_OUTPUT_SCHEMAS_V1, resolveProviderActionOwnerV1, type ProviderActionRequestV1, type ProviderActionInputByIdV1 } from '../providerActionsV1.js';
import { createProviderConnectionSecurityFingerprintV1, createProviderConnectionSecurityFingerprintV2, PROVIDER_CONNECTION_SECURITY_CONTRACT_VERSION_V1 } from '../securityFingerprintsV1.js';
import { addProviderConnectionV1, bindProviderConnectionSecretV1,
  addOrUpdateProviderManualModelsV1, removeProviderManualModelV1, deleteProviderConnectionV1,
  setProviderModelVisibilityV1, resetProviderModelVisibilityV1, setProviderModelPickerVisibilityV1,
  setProviderExperimentalConfirmationV1, resolveProviderGrantV1 } from '../settings/operationsV1.js';
import type { ProviderSettingsV1 } from '../settings/v1.js';
import { ProviderConnectionV1Schema, type ProviderConnectionV1 } from './v1.js';
import { prepareProviderConnectionCreationV1 } from './creationV1.js';
import { composeProviderSettingsV1, splitProviderSettingsV1, type ProviderConnectionsCatalogV1,
  type ProviderConnectionsCatalogSnapshotV1 } from './connectionRowsV1.js';
import { DaemonProviderConnectionViewV1Schema, type DaemonProviderConnectionViewV1, type DaemonProviderConnectionsDescribeResponseV1 } from '../../rpc/providers.js';
import { readProviderConnectionSourceFactsV1, projectAvailableProviderContributionsV1 } from './sourceFactsV1.js';
import { createProviderCustomCopyTemplateV1 } from './customCopyV1.js';
import { chooseProviderGatewayContributionV1 } from '../gatewayContributionsV1.js';
import { resolveEffectiveProviderEndpointV1, patchProviderEndpointOverrideV1 } from './effectiveEndpointV1.js';
import { providerEndpointPolicySecurityFactsV1 } from '../endpointPolicyV1.js';

function refuse(code: ProviderErrorCodeV1, connectionId?: string): never {
  throw createProviderErrorV1(code, connectionId ? { connectionId } : {});
}

function sourceFor(connection: ProviderConnectionV1, definitions: readonly AccountProviderDeclarationV1[]) {
  if (connection.source.kind === 'custom') return { definition: connection.source.template, provenance: 'custom' as const };
  const key = connection.source.contributionKey;
  return definitions.find(row => areProviderContributionKeysEqualV1(row.contributionKey, key)) ?? null;
}

/** Syntax-only Account endpoint projection: no DNS, machine observation or authorization. */
function accountEndpoints(connection: ProviderConnectionV1, source: NonNullable<ReturnType<typeof sourceFor>>, machineId?: string) {
  if (connection.deployment.kind === 'managedLocal') return [];
  return source.definition.endpointTemplates.flatMap(endpoint => {
    const effective = resolveEffectiveProviderEndpointV1({ connection, template: endpoint, machineId });
    if (!effective.baseUrl && !('requiresEndpointOverride' in endpoint && endpoint.requiresEndpointOverride)) return [];
    return [{ endpointTemplateId: endpoint.id, protocol: endpoint.protocol, ...effective,
      ...providerEndpointPolicySecurityFactsV1(endpoint),
      ...(endpoint.publicHeaderHints ? { publicHeaderHints: endpoint.publicHeaderHints } : {}) }];
  });
}

function securityFingerprint(connection: ProviderConnectionV1, source: NonNullable<ReturnType<typeof sourceFor>>, machineId?: string, legacy = false) {
  const definition = source.definition;
  const facts = readProviderConnectionSourceFactsV1(definition);
  const contribution = connection.source.kind === 'contribution' && 'kind' in definition ? definition : null;
  const identity = connection.source.kind === 'contribution' ? parseProviderContributionIdentityV1(connection.source.contributionKey)?.identity : null;
  if (connection.deployment.kind === 'managedLocal' && (!contribution?.managedRuntime || !identity)) refuse('provider_connection_invalid', connection.id);
  const createFingerprint = legacy ? createProviderConnectionSecurityFingerprintV1 : createProviderConnectionSecurityFingerprintV2;
  return createFingerprint({
    securityContractVersion: PROVIDER_CONNECTION_SECURITY_CONTRACT_VERSION_V1,
    endpoints: accountEndpoints(connection, source, machineId).map(endpoint => ({ endpointTemplateId: endpoint.endpointTemplateId,
      protocol: endpoint.protocol, url: endpoint.baseUrl, publicHeaders: endpoint.publicHeaders,
      ...providerEndpointPolicySecurityFactsV1(endpoint) })),
    catalogProbes: facts.catalogProbes, credentialTransports: facts.credentialTransports,
    ...(facts.availabilityProbe ? { availabilityProbe: facts.availabilityProbe } : {}),
    ...(facts.catalogFallback ? { catalogFallback: facts.catalogFallback } : {}),
    ...(facts.modelLoad ? { modelLoad: facts.modelLoad } : {}),
    ...(facts.usageSources ? { usageSources: facts.usageSources } : {}),
    ...(connection.deployment.kind === 'managedLocal' && contribution?.managedRuntime && identity ? {
      managedDeployment: { implementationIdentity: identity, managedRuntime: contribution.managedRuntime,
        gatewayPlacement: connection.gatewayPlacement,
        logicalEndpoints: contribution.endpointTemplates.filter(endpoint => contribution.managedRuntime?.endpointTemplateIds.includes(endpoint.id))
          .map(endpoint => ({ endpointTemplateId: endpoint.id, protocol: endpoint.protocol, publicHeaders: endpoint.publicHeaders })) },
    } : {}),
  });
}

function accountEndpointsAreReady(connection: ProviderConnectionV1, source: NonNullable<ReturnType<typeof sourceFor>>) {
  const endpoints = accountEndpoints(connection, source);
  return endpoints.some(endpoint => endpoint.ready) && source.definition.endpointTemplates.every(template =>
    'requiresEndpointOverride' in template && template.requiresEndpointOverride
    || endpoints.some(endpoint => endpoint.endpointTemplateId === template.id && endpoint.ready));
}

export function describeAccountProviderConnectionV1(settings: ProviderSettingsV1, connection: ProviderConnectionV1,
  definitions: readonly AccountProviderDeclarationV1[]): DaemonProviderConnectionViewV1 {
  const source = sourceFor(connection, definitions);
  const contribution = source && 'kind' in source.definition ? source.definition : null;
  const credential = source?.definition.credential;
  const bindings = settings.secretBindingsByConnectionId[connection.id];
  const accountGrant = settings.accountGrants.find(grant => grant.connectionId === connection.id);
  const completeEndpoints = source && (connection.deployment.kind === 'managedLocal' || accountEndpointsAreReady(connection, source));
  const accountState = !accountGrant ? 'absent' : source && completeEndpoints
    ? resolveProviderGrantV1(settings, { scope: 'account', connectionId: connection.id, machineId: '',
      connectionSecurityFingerprint: securityFingerprint(connection, source), endpointSetFingerprint: '',
      ...(!isProviderDestinationGrantFingerprintV2(accountGrant.connectionSecurityFingerprint)
        ? { legacyGrantFingerprints: { connectionSecurityFingerprint: securityFingerprint(connection, source, undefined, true), endpointSetFingerprint: '' } } : {}),
    }).state : 'stale';
  const identity = connection.source.kind === 'contribution' ? parseProviderContributionIdentityV1(connection.source.contributionKey)?.identity : null;
  const managed = contribution?.managedRuntime && identity ? resolveProviderManagedRuntimeDeclarationV1({
    implementationIdentity: identity, managedRuntime: contribution.managedRuntime,
  }) : null;
  return DaemonProviderConnectionViewV1Schema.parse({ connectionId: connection.id,
    contributionKey: connection.source.kind === 'contribution' ? connection.source.contributionKey : null,
    provenance: source?.provenance ?? 'external', displayName: connection.displayName,
    providerName: source?.definition.name ?? connection.displayName, icon: contribution?.icon ?? null,
    ...(contribution?.websiteUrl ? { websiteUrl: contribution.websiteUrl } : {}), role: connection.role,
    displayNameMode: connection.displayNameMode, sourceStatus: source ? 'available' : 'unavailable',
    probeCapability: source && readProviderConnectionSourceFactsV1(source.definition).catalogProbes.length ? 'catalog' : contribution?.discovery?.availabilityProbe ? 'availability' : 'none',
    manualModelPolicy: source?.definition.catalog.manualModelPolicy ?? 'catalog-only', compatibility: [],
    grants: { accountEnabled: accountState === 'valid', accountState, enabledMachineIds: settings.machineGrants.filter(grant => grant.connectionId === connection.id).map(grant => grant.machineId),
      machineState: 'absent', effectiveState: 'absent' },
    credential: credential ? { required: credential.required, accountBound: Boolean(bindings?.account?.apiKey),
      boundMachineIds: Object.entries(bindings?.byMachineId ?? {}).filter(([, slots]) => slots.apiKey).map(([id]) => id),
      ...('keyUrl' in credential && credential.keyUrl ? { keyUrl: credential.keyUrl } : {}) } : null,
    deployment: connection.deployment.kind === 'managedLocal' ? { kind: 'managedLocal', targetMachineId: connection.gatewayPlacement?.kind === 'machine' ? connection.gatewayPlacement.machineId : null,
      effects: managed && identity ? { implementationIdentity: identity, protocols: contribution?.endpointTemplates.filter(endpoint => managed.endpointTemplateIds.includes(endpoint.id)).map(endpoint => endpoint.protocol) ?? [],
        connectedAccountPurposes: managed.connectedAccounts.filter(declaration => connection.purposeBindingDefaults?.[declaration.purpose])
          .map(({ endpointTemplateIds: _endpoints, staticModels: _models, ...declaration }) => ({ ...declaration, target: connection.purposeBindingDefaults?.[declaration.purpose] })),
        ...(managed.connectedAccountPurposeBindingPolicy ? { connectedAccountPurposeBindingPolicy: managed.connectedAccountPurposeBindingPolicy } : {}) } : null } : { kind: 'external' },
    ...(connection.gatewayPlacement ? { gatewayPlacement: connection.gatewayPlacement } : {}),
    ...(connection.claudeHelperModels ? { claudeHelperModels: connection.claudeHelperModels } : {}),
    managedLocalOption: managed ? { targetMachineId: null, connectedAccountPurposes: managed.connectedAccounts.map(({ endpointTemplateIds: _endpoints, staticModels: _models, ...declaration }) => declaration),
      ...(managed.connectedAccountPurposeBindingPolicy ? { connectedAccountPurposeBindingPolicy: managed.connectedAccountPurposeBindingPolicy } : {}) } : null,
    endpoints: source ? accountEndpoints(connection, source).map(({ ready: _ready, reason: _reason, ...endpoint }) => endpoint) : [],
    scope: null, authorized: false, authorizationError: source ? null : createProviderErrorV1('provider_contribution_unavailable', { connectionId: connection.id }),
    revision: connection.revision, runtime: { health: 'not_checked', modelCount: null, checkedAt: null, endpoints: [],
      ...(connection.deployment.kind === 'managedLocal' && managed && managed.connectedAccounts.length > 0
        ? { gateway: { status: 'not_checked', reachability: 'not_checked' } } : {}),
    },
  });
}

/** Display projection of an admitted Account catalog; it grants no Machine authority. */
export function describeAccountProviderConnectionsV1(catalog: ProviderConnectionsCatalogV1,
  definitions: readonly AccountProviderDeclarationV1[], connectionId?: string): Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }> {
  const settings = composeProviderSettingsV1(catalog, {});
  return { status: 'success', connections: settings.connections.filter(connection => !connectionId || connection.id === connectionId)
    .map(connection => describeAccountProviderConnectionV1(settings, connection, definitions)),
    available: projectAvailableProviderContributionsV1({ connections: settings.connections, definitions }),
    discoveryCandidates: [], discoveryCandidatesTruncated: false, localInstallations: [], diagnosticsTruncated: false, diagnostics: [], availableTruncated: false };
}

/** Account semantics, shared by UI, CLI and daemon compatibility dispatch. Transport owns CAS, mode admission and SavedSecret atomics. */
export function createAccountProviderActionExecuteV1(host: Readonly<{
  assertCurrent(): void;
  readCatalog(): Promise<ProviderConnectionsCatalogSnapshotV1>;
  writeCatalog(input: Readonly<{ catalog: ProviderConnectionsCatalogV1; expectedRevision: number }>): Promise<Readonly<{ status: string }>>;
  readDefinitions(): Promise<readonly AccountProviderDeclarationV1[]>;
  readAgentProviderRequirements?(agentTargetKey: string): AgentProviderRequirementsV1 | null | Promise<AgentProviderRequirementsV1 | null>;
  now(): number;
}>): (request: ProviderActionRequestV1, context: ActionExecutorContext) => Promise<ActionExecuteResult> {
  return async (request, context) => {
    context.signal?.throwIfAborted(); host.assertCurrent();
    if (resolveProviderActionOwnerV1(request) !== 'accountCatalog') {
      return { ok: false, errorCode: 'provider_account_action_unavailable', error: 'provider_account_action_unavailable' };
    }
    if (request.actionId === 'providers.gateways.choose') {
      const definitions = await host.readDefinitions();
      context.signal?.throwIfAborted(); host.assertCurrent();
      return { ok: true, result: PROVIDER_ACTION_OUTPUT_SCHEMAS_V1[request.actionId].parse(
        chooseProviderGatewayContributionV1(definitions, request.input)) };
    }
    const captured = await host.readCatalog();
    host.assertCurrent();
    if (captured.status !== 'ready' || captured.revision === 'absent') {
      return { ok: false, errorCode: 'provider_catalog_unavailable', error: 'provider_catalog_unavailable', details: captured };
    }
    let settings = composeProviderSettingsV1(captured.catalog, {});
    const needsDefinitions = request.actionId.startsWith('providers.connections.') || request.actionId === 'providers.models.list'
      || request.actionId === 'providers.models.projection' || request.actionId === 'providers.models.manual.add' || request.actionId === 'providers.models.manual.remove';
    const definitions = needsDefinitions ? await host.readDefinitions() : []; host.assertCurrent();
    const now = host.now();
    const find = (id: string) => settings.connections.find(connection => connection.id === id) ?? refuse('provider_connection_not_found', id);
    const requireSource = (connection: ProviderConnectionV1) => sourceFor(connection, definitions) ?? refuse('provider_contribution_unavailable', connection.id);
    const requireRevision = (connection: ProviderConnectionV1, revision: number) => {
      if (connection.revision !== revision) refuse('provider_connection_changed', connection.id);
    };
    const replace = (connection: ProviderConnectionV1) => { settings = { ...settings,
      connections: settings.connections.map(previous => previous.id === connection.id ? ProviderConnectionV1Schema.parse(connection) : previous) }; };
    const enable = (connection: ProviderConnectionV1, enabled: boolean) => {
      if (enabled && connection.deployment.kind === 'external') {
        const source = requireSource(connection);
        if (!accountEndpointsAreReady(connection, source)) refuse('provider_connection_invalid', connection.id);
      }
      const remaining = settings.accountGrants.filter(grant => grant.connectionId !== connection.id);
      settings = { ...settings, accountGrants: enabled ? [...remaining, { v: 1, connectionId: connection.id,
        connectionSecurityFingerprint: securityFingerprint(connection, requireSource(connection)), confirmedAt: now }] : remaining };
    };
    const updateConnection = (input: ProviderActionInputByIdV1['providers.connections.update']) => {
      const previous = find(input.connectionId); requireRevision(previous, input.expectedRevision);
      if (input.template && previous.source.kind !== 'custom') refuse('provider_connection_invalid', previous.id);
      const source = sourceFor(previous, definitions); const deployment = input.deployment ?? previous.deployment;
      if (deployment.kind === 'external' && (input.gatewayPlacement != null || input.claudeHelperModels != null)) refuse('provider_connection_invalid', previous.id);
      const changedMode = deployment.kind !== previous.deployment.kind;
      const candidate = { ...previous, ...(input.template ? { source: { kind: 'custom' as const, template: input.template } } : {}),
        ...(input.displayName ? { displayName: input.displayName, displayNameMode: 'custom' as const } : {}),
        ...(input.displayNameMode ? { displayNameMode: input.displayNameMode, ...(input.displayNameMode === 'automatic' ? { displayName: source?.definition.name ?? previous.displayName } : {}) } : {}),
        deployment: { kind: deployment.kind }, revision: previous.revision + 1, updatedAt: now };
      if (deployment.kind === 'managedLocal') {
        if (input.deployment?.kind === 'managedLocal' && (!source || !('managedRuntime' in source.definition) || !source.definition.managedRuntime)) refuse('provider_connection_invalid', previous.id);
        delete candidate.endpointOverrides; delete candidate.endpointOverridesByMachineId;
        if (input.deployment?.kind === 'managedLocal') candidate.purposeBindingDefaults = input.deployment.purposeBindingDefaults;
        if (input.gatewayPlacement !== undefined) { if (input.gatewayPlacement === null) delete candidate.gatewayPlacement; else candidate.gatewayPlacement = input.gatewayPlacement; }
        if (input.claudeHelperModels !== undefined) { if (input.claudeHelperModels === null) delete candidate.claudeHelperModels; else candidate.claudeHelperModels = input.claudeHelperModels; }
      } else { delete candidate.purposeBindingDefaults; delete candidate.gatewayPlacement; delete candidate.claudeHelperModels; }
      if (input.template) {
        const declared = new Set(input.template.endpointTemplates.map(endpoint => endpoint.id));
        if (candidate.endpointOverrides) candidate.endpointOverrides = candidate.endpointOverrides.filter(override => declared.has(override.endpointTemplateId));
        if (candidate.endpointOverridesByMachineId) candidate.endpointOverridesByMachineId = Object.fromEntries(
          Object.entries(candidate.endpointOverridesByMachineId).map(([id, overrides]) => [id, overrides.filter(override => declared.has(override.endpointTemplateId))]));
      }
      const connection = ProviderConnectionV1Schema.parse(candidate); replace(connection);
      if (input.template && source) {
        const nextSource = requireSource(connection);
        const securityChanged = (machineId?: string) => securityFingerprint(previous, source, machineId) !== securityFingerprint(connection, nextSource, machineId);
        settings = { ...settings,
          accountGrants: securityChanged() ? settings.accountGrants.filter(grant => grant.connectionId !== connection.id) : settings.accountGrants,
          machineGrants: settings.machineGrants.filter(grant => grant.connectionId !== connection.id || !securityChanged(grant.machineId)) };
      }
      if (input.deployment?.kind === 'managedLocal' && source && 'managedRuntime' in source.definition && source.definition.managedRuntime) {
        const identity = previous.source.kind === 'contribution' ? parseProviderContributionIdentityV1(previous.source.contributionKey)?.identity : null;
        if (!identity || resolveManagedPurposeBindingIntentsV1(connection, { implementationIdentity: identity,
          managedRuntime: resolveProviderManagedRuntimeDeclarationV1({ implementationIdentity: identity, managedRuntime: source.definition.managedRuntime }) }) === null) refuse('provider_connection_invalid', previous.id);
      }
      if (changedMode) { const bindings = { ...settings.secretBindingsByConnectionId }; delete bindings[connection.id];
        settings = { ...settings, secretBindingsByConnectionId: bindings, accountGrants: settings.accountGrants.filter(grant => grant.connectionId !== connection.id),
          machineGrants: settings.machineGrants.filter(grant => grant.connectionId !== connection.id) }; }
      return connection;
    };
    let output: unknown;
    let mutation = true;
    try {
      switch (request.actionId) {
        case 'providers.connections.describe': {
          mutation = false;
          const input = request.input;
          output = describeAccountProviderConnectionsV1(captured.catalog, definitions, input.connectionId);
          if (input.authoringPreview) {
            const preview = input.authoringPreview;
            const source = definitions.find(row => areProviderContributionKeysEqualV1(row.contributionKey, preview.contributionKey)) ?? refuse('provider_contribution_unavailable');
            const existing = preview.displayName === null ? settings.connections.find(connection => connection.role === 'default' && connection.source.kind === 'contribution'
              && areProviderContributionKeysEqualV1(connection.source.contributionKey, preview.contributionKey)) : undefined;
            const connection = existing ?? ProviderConnectionV1Schema.parse({ v: 1, id: preview.connectionId,
              source: { kind: 'contribution', contributionKey: canonicalizeProviderContributionKeyV1(preview.contributionKey) },
              role: preview.displayName === null ? 'default' : 'named', displayName: preview.displayName ?? source.definition.name,
              displayNameMode: preview.displayName === null ? 'automatic' : 'custom', revision: 0, createdAt: now, updatedAt: now,
              ...(preview.endpointOverrides ? { endpointOverrides: preview.endpointOverrides } : {}) });
            if (preview.selectedCandidateId) refuse('provider_machine_unavailable');
            const endpoints = accountEndpoints(connection, source).filter(endpoint => endpoint.ready && endpoint.baseUrl !== null).map(endpoint => ({ endpointTemplateId: endpoint.endpointTemplateId,
              protocol: endpoint.protocol, normalizedUrl: endpoint.baseUrl, locality: 'unknown', scope: 'account' }));
            const fingerprint = createProviderFingerprintV1('authoring-review', { connectionId: connection.id,
              contributionKey: preview.contributionKey, revision: connection.revision, security: securityFingerprint(connection, source) });
            output = { ...output as object, authoringPreview: { status: 'resolved', connectionId: connection.id,
              contributionKey: preview.contributionKey, created: !existing, candidateId: null, scope: 'account', machineId: null,
              endpoints, credential: source.definition.credential ? { slotId: 'apiKey', label: 'api_key', required: source.definition.credential.required } : null,
              fingerprint, revision: connection.revision, verification: 'declaration' } };
          }
          break;
        }
        case 'providers.models.list': {
          mutation = false;
          const connection = find(request.input.connectionId); const source = requireSource(connection);
          const listed = projectAccountProviderConnectionModelsV1({ catalog: captured.catalog, connection, source: source.definition });
          output = { status: 'success', connectionId: connection.id, connectionRevision: connection.revision,
            manualModelPolicy: source.definition.catalog.manualModelPolicy, modelLoadAction: 'machine_required', models: listed };
          break;
        }
        case 'providers.models.projection': {
          mutation = false;
          output = projectAccountProviderModelsV1({ catalog: captured.catalog, definitions,
            agent: await host.readAgentProviderRequirements?.(request.input.agentTargetKey) ?? null, request: request.input });
          break;
        }
        case 'providers.connections.create_contribution':
        case 'providers.connections.create_custom': {
          const input = request.input;
          const managedCreate = input.action === 'createContribution' && input.deployment?.kind === 'managedLocal';
          let retained: ProviderConnectionV1 | undefined;
          if (managedCreate && input.action === 'createContribution') {
            // Complete only an untouched interrupted authoring row; configured external sources
            // keep their identity. The captured catalog CAS owns recovery and concurrent creation.
            if (input.savedSecretId !== null || input.authoringReview) refuse('provider_connection_invalid', input.connectionId);
            const matchesSource = (connection: ProviderConnectionV1) => connection.source.kind === 'contribution'
              && areProviderContributionKeysEqualV1(connection.source.contributionKey, input.contributionKey)
              && connection.displayName === input.displayName;
            const untouched = (connection: ProviderConnectionV1) => matchesSource(connection)
              && connection.role === 'named' && connection.deployment.kind === 'external' && connection.revision === 0
              && !connection.endpointOverrides?.length && !Object.keys(connection.endpointOverridesByMachineId ?? {}).length
              && !Object.keys(connection.modelSettings ?? {}).length
              && !settings.secretBindingsByConnectionId[connection.id]
              && !settings.manualModelsByConnectionId[connection.id]?.length
              && !settings.accountGrants.some(grant => grant.connectionId === connection.id)
              && !settings.machineGrants.some(grant => grant.connectionId === connection.id);
            const exact = settings.connections.find(connection => connection.id === input.connectionId);
            if (exact) {
              const sameSlots = exact.deployment.kind === 'managedLocal' && matchesSource(exact)
                && JSON.stringify(canonicalizeFingerprintValue(exact.purposeBindingDefaults ?? {}))
                  === JSON.stringify(canonicalizeFingerprintValue(input.deployment?.kind === 'managedLocal' ? input.deployment.purposeBindingDefaults : {}));
              if (!untouched(exact) && !sameSlots) refuse('provider_connection_changed', exact.id);
              retained = exact;
            } else {
              const interrupted = settings.connections.filter(untouched);
              if (interrupted.length > 1) refuse('provider_connection_changed', input.connectionId);
              retained = interrupted[0];
            }
          }
          const prepared = retained ? { settings, connection: retained, created: false } : input.action === 'createContribution'
            ? prepareProviderConnectionCreationV1({ settings, connectionId: input.connectionId, savedSecretId: input.savedSecretId, now,
                source: { kind: 'contribution', contributionKey: input.contributionKey, displayName: input.displayName,
                  definition: (definitions.find(row => areProviderContributionKeysEqualV1(row.contributionKey, input.contributionKey)) ?? refuse('provider_contribution_unavailable')).definition },
                ...(input.authoringReview?.endpointOverrides ? { endpointOverrides: { values: input.authoringReview.endpointOverrides } } : {}) })
            : prepareProviderConnectionCreationV1({ settings, connectionId: input.connectionId, savedSecretId: input.savedSecretId, now,
                source: { kind: 'custom', template: input.template }, manualModels: input.manualModels });
          settings = prepared.settings;
          let { connection } = prepared;
          const { created } = prepared;
          if (managedCreate && !created && !retained) refuse('provider_connection_changed', connection.id);
          if (!created && !managedCreate) {
            mutation = false;
            output = { status: 'success', action: input.action, connection: describeAccountProviderConnectionV1(settings, connection, definitions), created };
            break;
          }
          if (input.action === 'createContribution' && input.authoringReview) {
            const fingerprint = createProviderFingerprintV1('authoring-review', { connectionId: connection.id,
              contributionKey: input.contributionKey, revision: connection.revision, security: securityFingerprint(connection, requireSource(connection)) });
            if (input.authoringReview.fingerprint !== fingerprint || input.authoringReview.revision !== connection.revision) refuse('provider_authorization_changed', connection.id);
          }
          if (managedCreate && input.action === 'createContribution' && connection.deployment.kind !== 'managedLocal') {
            connection = updateConnection({ action: 'update', connectionId: connection.id,
              expectedRevision: connection.revision, deployment: input.deployment });
          }
          if (input.enable) enable(connection, true);
          output = { status: 'success', action: input.action, connection: describeAccountProviderConnectionV1(settings, connection, definitions), created };
          break;
        }
        case 'providers.connections.update': {
          const connection = updateConnection(request.input);
          output = { status: 'success', action: request.input.action, connection: describeAccountProviderConnectionV1(settings, connection, definitions) }; break;
        }
        case 'providers.connections.endpoint.set': {
          const input = request.input; const previous = find(input.connectionId); requireRevision(previous, input.expectedRevision);
          const source = requireSource(previous);
          const template = source.definition.endpointTemplates.find(endpoint => endpoint.id === input.endpointTemplateId);
          if (!template) refuse('provider_connection_invalid', previous.id);
          const overrides = patchProviderEndpointOverrideV1(previous.endpointOverrides, input);
          if (JSON.stringify(overrides) === JSON.stringify(previous.endpointOverrides ?? [])) {
            mutation = false;
            output = { status: 'success', action: input.action, connection: describeAccountProviderConnectionV1(settings, previous, definitions) };
            break;
          }
          const connection = ProviderConnectionV1Schema.parse({ ...previous, endpointOverrides: overrides, revision: previous.revision + 1, updatedAt: now });
          resolveEffectiveProviderEndpointV1({ connection, template });
          replace(connection); output = { status: 'success', action: input.action, connection: describeAccountProviderConnectionV1(settings, connection, definitions) }; break;
        }
        case 'providers.connections.duplicate': {
          const input = request.input; const previous = find(input.connectionId); const source = requireSource(previous);
          const template = input.mode === 'asCustom' ? createProviderCustomCopyTemplateV1({
            connection: previous, definition: source.definition, displayName: input.displayName,
          }) : null;
          const connection = ProviderConnectionV1Schema.parse({ ...previous, id: input.newConnectionId, role: 'named', displayName: input.displayName,
            displayNameMode: 'custom', revision: 0, createdAt: now, updatedAt: now,
            ...(template ? { source: { kind: 'custom', template }, deployment: { kind: 'external' }, purposeBindingDefaults: undefined,
              gatewayPlacement: undefined, claudeHelperModels: undefined, endpointOverrides: undefined, endpointOverridesByMachineId: undefined } : {}) });
          settings = addProviderConnectionV1(settings, connection);
          const manual = settings.manualModelsByConnectionId[previous.id]; if (manual) settings = { ...settings, manualModelsByConnectionId: { ...settings.manualModelsByConnectionId, [connection.id]: manual } };
          const visibility = settings.modelPickerVisibilityByConnectionId?.[previous.id]; if (visibility !== undefined) settings = setProviderModelPickerVisibilityV1(settings, { connectionId: connection.id, shown: visibility });
          output = { status: 'success', action: input.action, connection: describeAccountProviderConnectionV1(settings, connection, definitions) }; break;
        }
        case 'providers.connections.delete': {
          find(request.input.connectionId); settings = deleteProviderConnectionV1(settings, request.input.connectionId, now);
          output = { status: 'success', action: request.input.action, deletedConnectionId: request.input.connectionId }; break;
        }
        case 'providers.connections.enabled.set': {
          const input = request.input; const connection = find(input.connectionId); enable(connection, input.enabled);
          if (!input.enabled && input.scope === 'connection') settings = { ...settings, machineGrants: settings.machineGrants.filter(grant => grant.connectionId !== connection.id) };
          output = { status: 'success', action: input.action, connection: describeAccountProviderConnectionV1(settings, connection, definitions) }; break;
        }
        case 'providers.connections.secrets.bind': {
          const input = request.input; const connection = find(input.connectionId);
          if (input.savedSecretId !== null) {
            if (connection.deployment.kind === 'managedLocal') refuse('provider_connection_invalid', connection.id);
            if (!requireSource(connection).definition.credential) refuse('provider_credential_transport_unavailable', connection.id);
          }
          settings = bindProviderConnectionSecretV1({ settings, connectionId: connection.id, slotId: input.credentialSlotId, savedSecretId: input.savedSecretId });
          output = { status: 'success', action: input.action, connection: describeAccountProviderConnectionV1(settings, connection, definitions) }; break;
        }
        case 'providers.models.manual.add':
        case 'providers.models.manual.remove': {
          const input = request.input; const connection = find(input.connectionId); requireRevision(connection, input.expectedConnectionRevision);
          if (requireSource(connection).definition.catalog.manualModelPolicy !== 'allowed') refuse('provider_connection_invalid', connection.id);
          settings = input.action === 'manualAdd' ? addOrUpdateProviderManualModelsV1(settings, { connectionId: connection.id, models: input.models, addedAt: now })
            : removeProviderManualModelV1(settings, { connectionId: connection.id, modelId: input.modelId });
          output = { status: 'success', action: input.action }; break;
        }
        case 'providers.models.source_visibility.set': {
          find(request.input.connectionId);
          settings = setProviderModelPickerVisibilityV1(settings, request.input); output = { status: 'updated' }; break;
        }
        case 'providers.models.visibility.set': {
          if (request.input.ref.providerConnectionId !== null) find(request.input.ref.providerConnectionId);
          settings = setProviderModelVisibilityV1(settings, request.input); output = { status: 'success', action: request.input.action }; break;
        }
        case 'providers.models.visibility.reset': {
          if (request.input.scope.kind === 'connection') find(request.input.scope.connectionId);
          settings = resetProviderModelVisibilityV1(settings, request.input); output = { status: 'success', action: request.input.action }; break;
        }
        case 'providers.models.visibility.bulk': {
          for (const change of request.input.changes) {
            if (change.ref.providerConnectionId !== null) find(change.ref.providerConnectionId);
            settings = setProviderModelVisibilityV1(settings, change);
          }
          output = { status: 'success', action: request.input.action }; break;
        }
        case 'providers.models.experimental.confirm': {
          const input = request.input;
          if (input.connectedAccountTarget || input.catalogSourceKey) {
            if (input.expectedConnectionRevision !== 0 || input.connectedAccountTarget
              && settings.connections.some(connection => connection.id === input.connectionId)) {
              refuse('provider_connection_changed', input.connectionId);
            }
          } else requireRevision(find(input.connectionId), input.expectedConnectionRevision);
          settings = setProviderExperimentalConfirmationV1(settings, {
            connectionId: input.connectionId, agentTargetKey: input.agentTargetKey, modelId: input.modelId,
            ...(input.connectedAccountTarget ? { connectedAccountTarget: input.connectedAccountTarget } : {}),
            ...(input.catalogSourceKey ? { catalogSourceKey: input.catalogSourceKey } : {}),
            compatibilityFingerprint: input.compatibilityFingerprint, confirmedAt: now,
          });
          output = { status: 'success', action: input.action }; break;
        }
        default: return { ok: false, errorCode: 'provider_account_action_unavailable', error: 'provider_account_action_unavailable' };
      }
      // Parse before outward writes: invalid semantic output must never accompany a committed mutation.
      const parsed = PROVIDER_ACTION_OUTPUT_SCHEMAS_V1[request.actionId].parse(output);
      if (!mutation) { host.assertCurrent(); return { ok: true, result: parsed }; }
      context.signal?.throwIfAborted(); host.assertCurrent();
      const receipt = await host.writeCatalog({ catalog: splitProviderSettingsV1(settings).catalog, expectedRevision: captured.revision });
      if (receipt.status !== 'updated') return { ok: false, errorCode: `provider_catalog_${receipt.status}`, error: `provider_catalog_${receipt.status}`, details: receipt };
      // A durable receipt survives Account retirement; projections are transport-owned best effort.
      return { ok: true, result: parsed };
    } catch (caught) {
      const error = ProviderErrorV1Schema.safeParse(caught);
      if (error.success) return { ok: false, errorCode: error.data.code, error: error.data.code, details: error.data };
      if (caught && typeof caught === 'object' && 'code' in caught) {
        const code = String(caught.code);
        if (['scope-retired', 'action_account_scope_changed', 'not_authenticated', 'server_scope_mismatch'].includes(code)) throw caught;
        const errorCode = code.startsWith('provider_catalog_') ? code : `provider_catalog_${code}`;
        return { ok: false, errorCode, error: errorCode, details: { status: code } };
      }
      if (caught instanceof TypeError || caught && typeof caught === 'object' && 'issues' in caught) {
        const invalid = createProviderErrorV1('provider_connection_invalid');
        return { ok: false, errorCode: invalid.code, error: invalid.code, details: invalid };
      }
      throw caught;
    }
  };
}
