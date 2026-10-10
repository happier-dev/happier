import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { ProviderSettingsLimitError, ProviderSettingsV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import { compareProviderCanonicalStringsV1 } from '@happier-dev/protocol/providers/canonicalOrderV1';
import { createProviderDiscoveryCandidateIdV1 } from '@happier-dev/protocol/providers/detection/v1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { createProviderFingerprintV1 } from '@happier-dev/protocol/providers/fingerprints';
import { areProviderContributionKeysEqualV1, canonicalizeProviderContributionKeyV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { ProviderConnectionV1, ProviderDiscoveryCandidateV1, ProviderEndpointOverrideV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import type { DaemonProviderContributionAuthoringPreviewV1 } from '@happier-dev/protocol/rpc/providers';

import { buildProviderDiscoveryEndpointOverrides } from '@/providers/discovery/bridge';
import {
  awaitWithinProviderOperation,
  createProviderOperationLifetime,
  type ProviderOperationLifetime,
} from '@/providers/operationLifetime';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import {
  getProviderContribution,
  resolveProviderContributionRegistryEntry,
} from '@/providers/registry/lookup';
import { prepareProviderConnectionCreationV1 } from '@happier-dev/protocol/providers/connections/creationV1';
import { errorForProviderResolution, type ProviderConnectionServiceContext } from './context';
import { setProviderConnectionGrant } from './grants';
import {
  ProviderConnectionValidationError,
  parseProviderError,
  readSettings,
  readSnapshotSettings,
  requireSavedSecretReferenceReady,
} from './settings';
import type {
  ProviderConnectionCreateInput,
  ProviderConnectionServiceDeps,
  ProviderConnectionServiceResult,
  ProviderConnectionServiceSnapshot,
  ProviderConnectionRegistryProjection,
  ProviderConnectionView,
} from './types';

type ProviderContributionAuthoringPreviewInput = Readonly<{
  machineId: string;
  connectionId: string;
  contributionKey: string;
  displayName: string | null;
  selectedCandidateId: string | null;
  endpointOverrides: readonly ProviderEndpointOverrideV1[];
}>;

type ProviderAuthoringCandidateSelection = Readonly<{
  candidateId: string | null;
  endpointOverrides: readonly ProviderEndpointOverrideV1[];
  endpointOverrideScope: 'account' | 'machine';
}>;

type PreparedProviderContributionAuthoringPreview = Readonly<{
  preview: DaemonProviderContributionAuthoringPreviewV1;
  selectedEndpointOverrides: readonly ProviderEndpointOverrideV1[];
  endpointOverrideScope: 'account' | 'machine';
}>;

function createConnectionMutation(
  settings: ProviderSettingsV1,
  input: ProviderConnectionCreateInput,
  registry: ProviderContributionRegistryView,
  now: number,
  endpointOverrides?: Readonly<{ values: readonly ProviderEndpointOverrideV1[]; machineId?: string }>,
) {
  const contribution = input.action === 'createContribution'
    ? resolveProviderContributionRegistryEntry(registry, input.contributionKey) : null;
  if (input.action === 'createContribution' && !contribution) throw createProviderErrorV1('provider_contribution_unavailable', {
    connectionId: input.connectionId, machineId: input.machineId,
  });
  return prepareProviderConnectionCreationV1({ settings, connectionId: input.connectionId,
    source: input.action === 'createCustom' ? { kind: 'custom', template: input.template }
      : { kind: 'contribution', contributionKey: contribution!.contributionKey,
        definition: contribution!.contribution.definition, displayName: input.displayName },
    savedSecretId: input.savedSecretId,
    ...(input.action === 'createCustom' ? { manualModels: input.manualModels ?? [] } : {}),
    endpointOverrides, now,
  });
}

function candidateSelections(input: Readonly<{
  request: ProviderContributionAuthoringPreviewInput;
  snapshot: ProviderConnectionServiceSnapshot;
  discoveryCandidates: readonly ProviderDiscoveryCandidateV1[];
}>): readonly ProviderAuthoringCandidateSelection[] {
  const resolved = resolveProviderContributionRegistryEntry(
    input.snapshot.registry,
    input.request.contributionKey,
  );
  if (!resolved) throw createProviderErrorV1('provider_contribution_unavailable', {
    connectionId: input.request.connectionId,
    machineId: input.request.machineId,
  });
  const contribution = resolved.contribution.definition;
  if (input.request.endpointOverrides.length > 0) {
    if (input.request.selectedCandidateId !== null) {
      throw new ProviderConnectionValidationError(
        'Explicit Provider endpoints and a discovery candidate are mutually exclusive',
      );
    }
    const declaredEndpointIds = new Set(contribution.endpointTemplates.map((endpoint) => endpoint.id));
    if (input.request.endpointOverrides.length !== declaredEndpointIds.size
      || input.request.endpointOverrides.some((override) =>
        !declaredEndpointIds.has(override.endpointTemplateId))) {
      throw new ProviderConnectionValidationError(
        'Explicit Provider authoring requires one override for every declared endpoint',
      );
    }
    return [{
      candidateId: null,
      endpointOverrides: input.request.endpointOverrides,
      endpointOverrideScope: 'account',
    }];
  }
  if (!contribution.discovery) {
    return [{
      candidateId: null,
      endpointOverrides: [],
      endpointOverrideScope: 'account' as const,
    }];
  }

  const discovered = input.discoveryCandidates.filter((candidate) =>
    candidate.machineId === input.request.machineId
      && areProviderContributionKeysEqualV1(candidate.contributionKey, resolved.contributionKey));
  const discoveredSelections = discovered.map((candidate): ProviderAuthoringCandidateSelection => {
    const candidateId = createProviderDiscoveryCandidateIdV1({
      machineId: candidate.machineId,
      contributionKey: resolved.contributionKey,
      endpointTemplateId: candidate.endpointTemplateId,
      normalizedEndpointUrl: candidate.normalizedEndpointUrl,
    });
    if (candidate.candidateId !== undefined && candidate.candidateId !== candidateId) {
      throw new ProviderConnectionValidationError('Provider discovery candidate identity does not match its daemon facts');
    }
    return {
      candidateId,
      endpointOverrides: buildProviderDiscoveryEndpointOverrides({
        contribution,
        endpointTemplateId: candidate.endpointTemplateId,
        normalizedEndpointUrl: candidate.normalizedEndpointUrl,
      }),
      endpointOverrideScope: 'machine',
    };
  });
  const availableSelections: readonly ProviderAuthoringCandidateSelection[] = discoveredSelections.length > 0
    ? discoveredSelections
    : (() => {
        const hasOnlySingleDefaults = contribution.endpointTemplates.every((endpoint) =>
          endpoint.baseUrl !== undefined || endpoint.localUrlCandidates?.length === 1);
        if (hasOnlySingleDefaults) {
          return [{
            candidateId: null,
            endpointOverrides: [],
            endpointOverrideScope: 'account' as const,
          }];
        }
        const discoveryEndpointId = contribution.discovery?.availabilityProbe.endpointTemplateId;
        const discoveryEndpoint = contribution.endpointTemplates.find((endpoint) =>
          endpoint.id === discoveryEndpointId);
        if (!discoveryEndpointId || !discoveryEndpoint?.localUrlCandidates) {
          throw new ProviderConnectionValidationError(
            'Ambiguous local Provider contribution has no canonical discovery endpoint selection',
          );
        }
        return discoveryEndpoint.localUrlCandidates.map((normalizedEndpointUrl) => ({
          candidateId: createProviderDiscoveryCandidateIdV1({
            machineId: input.request.machineId,
            contributionKey: resolved.contributionKey,
            endpointTemplateId: discoveryEndpointId,
            normalizedEndpointUrl,
          }),
          endpointOverrides: buildProviderDiscoveryEndpointOverrides({
            contribution,
            endpointTemplateId: discoveryEndpointId,
            normalizedEndpointUrl,
          }),
          endpointOverrideScope: 'machine' as const,
        }));
      })();
  const byId = new Map<string, ProviderAuthoringCandidateSelection>();
  for (const selection of availableSelections) {
    const identity = selection.candidateId ?? 'direct';
    if (!byId.has(identity)) byId.set(identity, selection);
  }
  return [...byId.values()].sort((left, right) => compareProviderCanonicalStringsV1(
    left.candidateId ?? '',
    right.candidateId ?? '',
  ));
}

async function currentAuthoringDiscoveryCandidates(input: Readonly<{
  deps: ProviderConnectionServiceDeps;
  snapshot: ProviderConnectionServiceSnapshot;
  machineId: string;
  connectionId: string;
}>): Promise<readonly ProviderDiscoveryCandidateV1[]> {
  if (!input.deps.featureGate.isEnabled('providers.localDiscovery') || !input.deps.discoveryCandidates) return [];
  try {
    return await input.deps.discoveryCandidates({
      machineId: input.machineId,
      registry: input.snapshot.registry,
      // Connection matching changes only the candidate action, never its identity
      // or endpoint facts, which are the sole inputs to authoring review.
      connections: [],
    });
  } catch (error) {
    const providerError = parseProviderError(error);
    if (providerError) throw providerError;
    throw createProviderErrorV1('provider_endpoint_unavailable', {
      connectionId: input.connectionId,
      machineId: input.machineId,
    });
  }
}

async function resolvedContributionAuthoringPreview(input: Readonly<{
  deps: ProviderConnectionServiceDeps;
  snapshot: ProviderConnectionServiceSnapshot;
  request: ProviderContributionAuthoringPreviewInput;
  selection: ProviderAuthoringCandidateSelection;
  lifetime: ProviderOperationLifetime;
}>): Promise<PreparedProviderContributionAuthoringPreview> {
  const now = input.deps.now();
  const createInput: ProviderConnectionCreateInput = {
    action: 'createContribution',
    machineId: input.request.machineId,
    connectionId: input.request.connectionId,
    contributionKey: input.request.contributionKey,
    displayName: input.request.displayName,
    savedSecretId: null,
    enable: false,
  };
  const mutation = createConnectionMutation(readSnapshotSettings(input.snapshot), createInput,
    input.snapshot.registry, now, { values: input.selection.endpointOverrides,
      ...(input.selection.endpointOverrideScope === 'machine' ? { machineId: input.request.machineId } : {}) });
  const previewRaw = mutation.settings;
  const dnsEvidence = await input.deps.collectDnsEvidence({
    providerSettings: previewRaw,
    connectionId: mutation.connection.id,
    machineId: input.request.machineId,
    registry: input.snapshot.registry,
    lifetime: input.lifetime,
  });
  const resolution = input.deps.resolveConnection({
    providerSettings: previewRaw,
    connectionId: mutation.connection.id,
    machineId: input.request.machineId,
    registry: input.snapshot.registry,
    dnsEvidence,
  });
  if (resolution.status !== 'resolved') throw errorForProviderResolution(resolution, input.request.machineId);
  if (resolution.record.deployment.kind !== 'external') {
    throw new ProviderConnectionValidationError(
      'Endpoint authoring preview is available only for externally deployed Provider connections',
    );
  }
  const source = resolution.record.source;
  if (source.kind !== 'contribution') {
    throw new ProviderConnectionValidationError('Contribution authoring resolved to a custom source');
  }
  const contribution = source.definition;
  const credential = contribution.credential
    ? { slotId: 'apiKey' as const, label: 'api_key' as const, required: contribution.credential.required }
    : null;
  const machineId = resolution.record.scope === 'machine' ? input.request.machineId : null;
  const endpoints = resolution.record.endpoints.map((endpoint) => ({
    endpointTemplateId: endpoint.endpointTemplateId,
    protocol: endpoint.protocol,
    normalizedUrl: endpoint.normalizedUrl,
    locality: endpoint.locality,
    scope: endpoint.endpointScope,
  }));
  const contributionKey = canonicalizeProviderContributionKeyV1(
    source.contributionKey,
  );
  const fingerprint = createProviderFingerprintV1('authoring-review', {
    candidateId: input.selection.candidateId,
    connectionId: mutation.connection.id,
    contributionKey,
    created: mutation.created,
    scope: resolution.record.scope,
    machineId,
    endpoints,
    credential,
    revision: mutation.connection.revision,
    connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
    endpointSetFingerprint: resolution.record.endpointSetFingerprint,
  });
  return {
    preview: {
      status: 'resolved',
      connectionId: mutation.connection.id,
      contributionKey,
      created: mutation.created,
      candidateId: input.selection.candidateId,
      scope: resolution.record.scope,
      machineId,
      endpoints,
      credential,
      fingerprint,
      revision: mutation.connection.revision,
    },
    selectedEndpointOverrides: input.selection.endpointOverrides,
    endpointOverrideScope: input.selection.endpointOverrideScope,
  };
}

async function prepareContributionAuthoringPreview(input: Readonly<{
  deps: ProviderConnectionServiceDeps;
  snapshot: ProviderConnectionServiceSnapshot;
  request: ProviderContributionAuthoringPreviewInput;
  discoveryCandidates: readonly ProviderDiscoveryCandidateV1[];
  lifetime: ProviderOperationLifetime;
}>): Promise<PreparedProviderContributionAuthoringPreview> {
  const selections = candidateSelections({
    request: input.request,
    snapshot: input.snapshot,
    discoveryCandidates: input.discoveryCandidates,
  });
  if (selections.length === 0 || selections.length > 32) {
    throw new ProviderConnectionValidationError('Provider authoring candidate count is outside the supported bound');
  }
  const selected = input.request.selectedCandidateId === null
    ? selections.length === 1 ? selections[0] : null
    : selections.find((candidate) => candidate.candidateId === input.request.selectedCandidateId) ?? null;
  if (input.request.selectedCandidateId !== null && !selected) {
    throw createProviderErrorV1('provider_authorization_changed', {
      connectionId: input.request.connectionId,
      machineId: input.request.machineId,
    });
  }
  if (selected) {
    return await resolvedContributionAuthoringPreview({
      deps: input.deps,
      snapshot: input.snapshot,
      request: input.request,
      selection: selected,
      lifetime: input.lifetime,
    });
  }
  const preparedCandidates = await Promise.all(selections.map((selection) =>
    resolvedContributionAuthoringPreview({
      deps: input.deps,
      snapshot: input.snapshot,
      request: input.request,
      selection,
      lifetime: input.lifetime,
    })));
  const candidates = preparedCandidates.map((prepared) => {
    if (prepared.preview.status !== 'resolved' || prepared.preview.candidateId === null) {
      throw new ProviderConnectionValidationError('Selectable Provider authoring candidate did not resolve exactly');
    }
    return {
      candidateId: prepared.preview.candidateId,
      scope: prepared.preview.scope,
      machineId: prepared.preview.machineId,
      endpoints: prepared.preview.endpoints,
    };
  });
  const first = preparedCandidates[0]!;
  return {
    preview: {
      status: 'selection_required',
      connectionId: first.preview.connectionId,
      contributionKey: first.preview.contributionKey,
      created: first.preview.created,
      credential: first.preview.credential,
      candidates,
    },
    selectedEndpointOverrides: [],
    endpointOverrideScope: 'account',
  };
}

/** Runtime credential readiness is admission evidence, not Account configuration semantics. */
function validateCreatedConnectionSecret(
  input: ProviderConnectionCreateInput,
  connection: ProviderConnectionV1,
  snapshot: ProviderConnectionServiceSnapshot,
) {
  const credential = connection.source.kind === 'contribution'
    ? getProviderContribution(snapshot.registry, connection.source.contributionKey)?.definition.credential
    : connection.source.template.credential;
  if (input.enable && credential?.required === true && input.savedSecretId === null) {
    throw createProviderErrorV1('provider_secret_missing', { connectionId: connection.id, machineId: input.machineId });
  }
  if (input.savedSecretId !== null) requireSavedSecretReferenceReady({
    rawAccountSettings: snapshot.rawAccountSettings, savedSecretId: input.savedSecretId,
    savedSecretResources: snapshot.savedSecretResources, savedSecretCatalogState: snapshot.savedSecretCatalogState,
    connectionId: connection.id, machineId: input.machineId, preparedSavedSecret: input.preparedSavedSecret,
  });
}

export function createProviderAuthoringOperations(context: ProviderConnectionServiceContext) {
  const { deps, featureError, assertMachine, describe } = context;

  async function previewCreateContribution(input: Readonly<{
    machineId: string;
    connectionId: string;
    contributionKey: string;
    displayName: string | null;
    selectedCandidateId?: string | null;
    endpointOverrides?: readonly ProviderEndpointOverrideV1[];
  }>): Promise<ProviderConnectionServiceResult<Readonly<{
    connectionId: string;
    created: boolean;
    authoringPreview: DaemonProviderContributionAuthoringPreviewV1;
  }>>> {
    if (!deps.featureGate.isEnabled('providers')) return { status: 'error', error: featureError(input.connectionId) };
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };
    const lifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    });
    const snapshot = await deps.loadSnapshot();
    const discoveryCandidates = await currentAuthoringDiscoveryCandidates({
      deps, snapshot, machineId: input.machineId, connectionId: input.connectionId,
    });
    const prepared = await prepareContributionAuthoringPreview({
      deps,
      snapshot,
      request: {
        machineId: input.machineId,
        connectionId: input.connectionId,
        contributionKey: input.contributionKey,
        displayName: input.displayName,
        selectedCandidateId: input.selectedCandidateId ?? null,
        endpointOverrides: input.endpointOverrides ?? [],
      },
      discoveryCandidates,
      lifetime,
    });
    return {
      status: 'success',
      connectionId: prepared.preview.connectionId,
      created: prepared.preview.created,
      authoringPreview: prepared.preview,
    };
  }

  async function create(input: ProviderConnectionCreateInput): Promise<ProviderConnectionServiceResult<Readonly<{
    connection: ProviderConnectionView;
    created: boolean;
  }>>> {
    if (!deps.featureGate.isEnabled('providers')) return { status: 'error', error: featureError(input.connectionId) };
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };
    const lifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    });
    try {
      const snapshot = await deps.loadSnapshot();
      const registryProjection = {
        registry: snapshot.registry,
        ...(snapshot.registryGeneration ? { generation: snapshot.registryGeneration } : {}),
      };
      let reviewedEndpointOverrides: readonly ProviderEndpointOverrideV1[] = [];
      let reviewedEndpointOverrideScope: 'account' | 'machine' = 'account';
      let hasAuthoringReview = false;
      if (input.action === 'createContribution' && input.authoringReview) {
        const discoveryCandidates = await currentAuthoringDiscoveryCandidates({
          deps, snapshot, machineId: input.machineId, connectionId: input.connectionId,
        });
        const reviewed = await prepareContributionAuthoringPreview({
          deps,
          snapshot,
          request: {
            machineId: input.machineId,
            connectionId: input.connectionId,
            contributionKey: input.contributionKey,
            displayName: input.displayName,
            selectedCandidateId: input.authoringReview.candidateId,
            endpointOverrides: input.authoringReview.endpointOverrides ?? [],
          },
          discoveryCandidates,
          lifetime,
        });
        if (reviewed.preview.status !== 'resolved'
          || reviewed.preview.fingerprint !== input.authoringReview.fingerprint
          || reviewed.preview.revision !== input.authoringReview.revision
          || reviewed.preview.candidateId !== input.authoringReview.candidateId) {
          throw createProviderErrorV1('provider_authorization_changed', {
            connectionId: input.connectionId,
            machineId: input.machineId,
          });
        }
        hasAuthoringReview = true;
        reviewedEndpointOverrides = reviewed.selectedEndpointOverrides;
        reviewedEndpointOverrideScope = reviewed.endpointOverrideScope;
      }
      const createMutation = (
        settings: ProviderSettingsV1,
        now: number,
      ) => createConnectionMutation(settings, input, snapshot.registry, now, {
        values: reviewedEndpointOverrides,
        ...(reviewedEndpointOverrideScope === 'machine' ? { machineId: input.machineId } : {}),
      });
      if (input.preparedSavedSecret && input.savedSecretId !== input.preparedSavedSecret.id) {
        throw new ProviderConnectionValidationError('The prepared SavedSecret must be the exact bound secret');
      }
      const initialMutation = createMutation(readSnapshotSettings(snapshot), deps.now());
      if (!initialMutation.created) {
        const described = await describe({
          machineId: input.machineId,
          connectionId: initialMutation.connection.id,
          registryProjection,
          lifetime,
        });
        if (described.status === 'error') return described;
        const connection = described.connections[0];
        return connection
          ? { status: 'success', connection, created: false }
          : { status: 'error', error: createProviderErrorV1('provider_connection_not_found', {
              connectionId: initialMutation.connection.id,
              machineId: input.machineId,
            }) };
      }
      const preview = createMutation(readSnapshotSettings(snapshot), deps.now());
      validateCreatedConnectionSecret(input, preview.connection, snapshot);
      const previewRaw = preview.settings;
      const dnsEvidence = input.enable
        ? await deps.collectDnsEvidence({
            providerSettings: previewRaw, connectionId: preview.connection.id,
            machineId: input.machineId, registry: snapshot.registry,
            lifetime,
          })
        : new Map();
      const previewResolution = input.enable
        ? deps.resolveConnection({
            providerSettings: previewRaw, connectionId: preview.connection.id,
            machineId: input.machineId, registry: snapshot.registry, dnsEvidence,
          })
        : null;
      if (previewResolution && previewResolution.status !== 'resolved') {
        throw errorForProviderResolution(previewResolution, input.machineId);
      }
      let persistedConnectionId: string | null = null;
      let created = preview.created;
      await deps.updateProviderSettings((providerSettings) => {
        const mutation = createMutation(readSettings(providerSettings), deps.now());
        persistedConnectionId = mutation.connection.id;
        created = mutation.created;
        if (!mutation.created) {
          if (hasAuthoringReview) {
            throw createProviderErrorV1('provider_authorization_changed', {
              connectionId: mutation.connection.id,
              machineId: input.machineId,
            });
          }
          return providerSettings;
        }
        validateCreatedConnectionSecret(input, mutation.connection, snapshot);
        let next = mutation.settings;
        if (input.enable) {
          const candidateRaw = next;
          const resolution = deps.resolveConnection({
            providerSettings: candidateRaw, connectionId: mutation.connection.id,
            machineId: input.machineId, registry: snapshot.registry, dnsEvidence,
          });
          if (resolution.status !== 'resolved') throw errorForProviderResolution(resolution, input.machineId);
          if (!previewResolution || previewResolution.status !== 'resolved'
            || resolution.record.connectionSecurityFingerprint !== previewResolution.record.connectionSecurityFingerprint
            || resolution.record.endpointSetFingerprint !== previewResolution.record.endpointSetFingerprint) {
            throw createProviderErrorV1('provider_authorization_changed', {
              connectionId: mutation.connection.id, machineId: input.machineId,
            });
          }
          next = setProviderConnectionGrant({
            settings: next,
            connectionId: mutation.connection.id,
            machineId: input.machineId,
            scope: resolution.record.scope,
            enabled: true,
            connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
            endpointSetFingerprint: resolution.record.endpointSetFingerprint,
            now: deps.now(),
          });
        }
        return next;
      }, { preparedSavedSecret: input.preparedSavedSecret });
      if (!persistedConnectionId) throw new TypeError('Provider connection mutation did not commit');
      if (created && input.enable && deps.refreshOnEnable) {
        await deps.refreshOnEnable(
          { connectionId: persistedConnectionId, machineId: input.machineId },
          'enable',
        ).catch(() => undefined);
      }
      const described = await describe({
        machineId: input.machineId,
        connectionId: persistedConnectionId,
        registryProjection,
        lifetime,
      });
      if (described.status === 'error') return described;
      const connection = described.connections[0];
      return connection
        ? { status: 'success', connection, created }
        : { status: 'error', error: createProviderErrorV1('provider_connection_not_found', {
            connectionId: persistedConnectionId, machineId: input.machineId,
          }) };
    } catch (error) {
      const providerError = parseProviderError(error);
      if (providerError) return { status: 'error', error: providerError };
      if (error instanceof ProviderSettingsLimitError) {
        return { status: 'error', error: createProviderErrorV1('provider_settings_limit_exceeded', {
          connectionId: input.connectionId, machineId: input.machineId,
        }) };
      }
      throw error;
    }
  }

  async function setEndpointOverride(input: Readonly<{
    action: 'setEndpointOverride'; machineId: string; connectionId: string; expectedRevision: number;
    scope: 'account' | 'machine'; endpointTemplateId: string; baseUrl: string | null;
  }>): Promise<ProviderConnectionServiceResult<ProviderConnectionView>> {
    if (!deps.featureGate.isEnabled('providers')) return { status: 'error', error: featureError(input.connectionId) };
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };
    if (input.scope !== 'machine') return { status: 'error', error: createProviderErrorV1('provider_connection_invalid', {
      connectionId: input.connectionId, machineId: input.machineId,
    }) };
    const lifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    });
    const snapshot = await deps.loadSnapshot();
    const registryProjection = {
      registry: snapshot.registry,
      ...(snapshot.registryGeneration ? { generation: snapshot.registryGeneration } : {}),
    };
    let conflict = false;
    await deps.updateProviderSettings((providerSettings) => {
      const settings = readSettings(providerSettings);
      const current = settings.connections.find((entry) => entry.id === input.connectionId);
      if (!current) throw createProviderErrorV1('provider_connection_not_found', { connectionId: input.connectionId, machineId: input.machineId });
      if (current.revision !== input.expectedRevision) {
        conflict = true;
        return providerSettings;
      }
      const endpointIds = new Set(current.source.kind === 'custom'
        ? current.source.template.endpointTemplates.map((endpoint) => endpoint.id)
        : getProviderContribution(snapshot.registry, current.source.contributionKey)
            ?.definition.endpointTemplates.map((endpoint) => endpoint.id) ?? []);
      if (!endpointIds.has(input.endpointTemplateId)) {
        throw new ProviderConnectionValidationError('Provider endpoint override references an undeclared endpoint');
      }
      const upsert = (values: readonly Readonly<{ endpointTemplateId: string; baseUrl: string }>[] | undefined) => {
        const next = (values ?? []).filter((entry) => entry.endpointTemplateId !== input.endpointTemplateId);
        if (input.baseUrl !== null) next.push({ endpointTemplateId: input.endpointTemplateId, baseUrl: input.baseUrl });
        return next.sort((a, b) => compareProviderCanonicalStringsV1(a.endpointTemplateId, b.endpointTemplateId));
      };
      const endpointOverridesByMachineId = { ...(current.endpointOverridesByMachineId ?? {}) };
      const next = upsert(endpointOverridesByMachineId[input.machineId]);
      if (next.length === 0) delete endpointOverridesByMachineId[input.machineId];
      else endpointOverridesByMachineId[input.machineId] = next;
      const candidate = ProviderConnectionV1Schema.parse({
        ...current,
        ...(Object.keys(endpointOverridesByMachineId).length === 0
          ? { endpointOverridesByMachineId: undefined } : { endpointOverridesByMachineId }),
        revision: current.revision + 1,
        updatedAt: deps.now(),
      });
      return ProviderSettingsV1Schema.parse({
        ...settings,
        connections: settings.connections.map((entry) => entry.id === input.connectionId ? candidate : entry),
      });
    });
    if (conflict) return { status: 'error', error: createProviderErrorV1('provider_connection_changed', { connectionId: input.connectionId, machineId: input.machineId }) };
    return describeOne(context, input.machineId, input.connectionId, { registryProjection, lifetime });
  }

  return Object.freeze({ previewCreateContribution, create, setEndpointOverride });
}

async function describeOne(
  context: ProviderConnectionServiceContext,
  machineId: string,
  connectionId: string,
  operation: Readonly<{
    registryProjection: ProviderConnectionRegistryProjection;
    lifetime: ProviderOperationLifetime;
  }>,
): Promise<ProviderConnectionServiceResult<ProviderConnectionView>> {
  const described = await context.describe({ machineId, connectionId, ...operation });
  if (described.status === 'error') return described;
  const view = described.connections[0];
  return view
    ? { status: 'success', ...view }
    : { status: 'error', error: createProviderErrorV1('provider_connection_not_found', { connectionId, machineId }) };
}
