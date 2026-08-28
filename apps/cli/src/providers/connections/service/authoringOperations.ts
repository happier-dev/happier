import {
  CustomProviderTemplateV1Schema,
  PROVIDER_ENDPOINT_SAFETY_LIMITS,
  ProviderConnectionV1Schema,
  ProviderSettingsLimitError,
  ProviderSettingsV1Schema,
  areProviderContributionKeysEqualV1,
  canonicalizeProviderContributionKeyV1,
  compareProviderCanonicalStringsV1,
  createProviderDiscoveryCandidateIdV1,
  createProviderErrorV1,
  createProviderFingerprintV1,
  isBundledProviderCatalogParserV1,
  readOwnRecordValue,
  type ProviderConnectionV1,
  type ProviderDiscoveryCandidateV1,
  type ProviderEndpointOverrideV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';
import type {
  DaemonProviderConnectionMutationRequestV1,
  DaemonProviderContributionAuthoringPreviewV1,
} from '@happier-dev/protocol/rpc';

import { buildProviderDiscoveryEndpointOverrides } from '@/providers/discovery/bridge';
import {
  createProviderOperationLifetime,
  type ProviderOperationLifetime,
} from '@/providers/operationLifetime';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import {
  getProviderContribution,
  resolveProviderContributionRegistryEntry,
} from '@/providers/registry/lookup';
import {
  addCustomProviderConnection,
  addProviderContributionConnection,
  deleteProviderConnectionV1,
} from './authoring';
import { errorForProviderResolution, type ProviderConnectionServiceContext } from './context';
import { bindProviderConnectionSecret, setProviderConnectionGrant } from './grants';
import { addInitialProviderManualModels } from './models';
import {
  ProviderConnectionValidationError,
  addPreparedSavedSecret,
  parseProviderError,
  readSettings,
  replaceSettings,
  savedSecretExists,
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

type ProviderConnectionUpdateInput = Readonly<{
  action: 'update';
  machineId: string;
  connectionId: string;
  expectedRevision: number;
  displayName?: string;
  displayNameMode?: 'automatic' | 'custom';
  deployment?: Extract<
    DaemonProviderConnectionMutationRequestV1,
    { action: 'update' }
  >['deployment'];
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
): Readonly<{ settings: ProviderSettingsV1; connection: ProviderConnectionV1; created: boolean }> {
  if (input.action === 'createContribution') {
    const resolved = resolveProviderContributionRegistryEntry(registry, input.contributionKey);
    if (!resolved) throw createProviderErrorV1('provider_contribution_unavailable', {
      connectionId: input.connectionId, machineId: input.machineId,
    });
    return addProviderContributionConnection({
      settings,
      contributionKey: resolved.contributionKey,
      contributionName: resolved.contribution.definition.name,
      connectionId: input.connectionId,
      displayName: input.displayName,
      now,
    });
  }
  const template = CustomProviderTemplateV1Schema.parse(input.template);
  if (template.catalog.manualModelPolicy === 'catalog-only' && (input.manualModels?.length ?? 0) > 0) {
    throw createProviderErrorV1('provider_connection_invalid', {
      connectionId: input.connectionId, machineId: input.machineId,
    });
  }
  const result = addCustomProviderConnection({ settings, connectionId: input.connectionId, template, now });
  return {
    ...result,
    settings: addInitialProviderManualModels({
      settings: result.settings,
      connectionId: result.connection.id,
      models: input.manualModels ?? [],
      addedAt: now,
    }),
    created: true,
  };
}

function applyCreatedEndpointOverrides(input: Readonly<{
  mutation: ReturnType<typeof createConnectionMutation>;
  machineId: string;
  endpointOverrides: readonly ProviderEndpointOverrideV1[];
  scope: 'account' | 'machine';
  now: number;
}>): ReturnType<typeof createConnectionMutation> {
  if (!input.mutation.created || input.endpointOverrides.length === 0) return input.mutation;
  const endpointOverrides = [...input.endpointOverrides]
    .sort((left, right) => compareProviderCanonicalStringsV1(
      left.endpointTemplateId,
      right.endpointTemplateId,
    ));
  const connection = ProviderConnectionV1Schema.parse({
    ...input.mutation.connection,
    ...(input.scope === 'account'
      ? { endpointOverrides }
      : {
          endpointOverridesByMachineId: {
            ...(input.mutation.connection.endpointOverridesByMachineId ?? {}),
            [input.machineId]: endpointOverrides,
          },
        }),
    revision: input.mutation.connection.revision + 1,
    updatedAt: input.now,
  });
  return {
    ...input.mutation,
    connection,
    settings: ProviderSettingsV1Schema.parse({
      ...input.mutation.settings,
      connections: input.mutation.settings.connections.map((entry) =>
        entry.id === connection.id ? connection : entry),
    }),
  };
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
  const mutation = applyCreatedEndpointOverrides({
    mutation: createConnectionMutation(
      readSettings(input.snapshot.rawAccountSettings),
      createInput,
      input.snapshot.registry,
      now,
    ),
    machineId: input.request.machineId,
    endpointOverrides: input.selection.endpointOverrides,
    scope: input.selection.endpointOverrideScope,
    now,
  });
  const previewRaw = replaceSettings(input.snapshot.rawAccountSettings, mutation.settings);
  const dnsEvidence = await input.deps.collectDnsEvidence({
    accountSettings: previewRaw,
    connectionId: mutation.connection.id,
    machineId: input.request.machineId,
    registry: input.snapshot.registry,
    lifetime: input.lifetime,
  });
  const resolution = input.deps.resolveConnection({
    accountSettings: previewRaw,
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

function validateConnectionCredentialTransport(
  input: ProviderConnectionCreateInput,
  connection: ProviderConnectionV1,
  registry: ProviderContributionRegistryView,
) {
  const credential = connection.source.kind === 'contribution'
    ? getProviderContribution(registry, connection.source.contributionKey)?.definition.credential
    : connection.source.template.credential;
  if (credential === undefined && input.savedSecretId !== null) {
    throw createProviderErrorV1('provider_credential_transport_unavailable', { connectionId: connection.id, machineId: input.machineId });
  }
  return credential;
}

function bindCreatedConnectionSecret(
  settings: ProviderSettingsV1,
  input: ProviderConnectionCreateInput,
  connection: ProviderConnectionV1,
  raw: Readonly<Record<string, unknown>>,
  registry: ProviderContributionRegistryView,
): ProviderSettingsV1 {
  const credential = validateConnectionCredentialTransport(input, connection, registry);
  if (input.enable && credential?.required === true && input.savedSecretId === null) {
    throw createProviderErrorV1('provider_secret_missing', { connectionId: connection.id, machineId: input.machineId });
  }
  if (input.savedSecretId !== null && !savedSecretExists(raw, input.savedSecretId)) {
    throw createProviderErrorV1('provider_secret_missing', { connectionId: connection.id, machineId: input.machineId });
  }
  return input.savedSecretId === null
    ? settings
    : bindProviderConnectionSecret({
        settings, connectionId: connection.id, slotId: 'apiKey', savedSecretId: input.savedSecretId,
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
      ) => applyCreatedEndpointOverrides({
        mutation: createConnectionMutation(settings, input, snapshot.registry, now),
        machineId: input.machineId,
        endpointOverrides: reviewedEndpointOverrides,
        scope: reviewedEndpointOverrideScope,
        now,
      });
      if (input.preparedSavedSecret && input.savedSecretId !== input.preparedSavedSecret.id) {
        throw new ProviderConnectionValidationError('The prepared SavedSecret must be the exact bound secret');
      }
      const initialMutation = createMutation(readSettings(snapshot.rawAccountSettings), deps.now());
      validateConnectionCredentialTransport(input, initialMutation.connection, snapshot.registry);
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
      const previewBase = addPreparedSavedSecret(snapshot.rawAccountSettings, input.preparedSavedSecret);
      const preview = createMutation(readSettings(previewBase), deps.now());
      const previewSettings = bindCreatedConnectionSecret(preview.settings, input, preview.connection, previewBase, snapshot.registry);
      const previewRaw = replaceSettings(previewBase, previewSettings);
      const dnsEvidence = input.enable
        ? await deps.collectDnsEvidence({
            accountSettings: previewRaw, connectionId: preview.connection.id,
            machineId: input.machineId, registry: snapshot.registry,
            lifetime,
          })
        : new Map();
      const previewResolution = input.enable
        ? deps.resolveConnection({
            accountSettings: previewRaw, connectionId: preview.connection.id,
            machineId: input.machineId, registry: snapshot.registry, dnsEvidence,
          })
        : null;
      if (previewResolution && previewResolution.status !== 'resolved') {
        throw errorForProviderResolution(previewResolution, input.machineId);
      }
      let persistedConnectionId: string | null = null;
      let created = preview.created;
      await deps.updateAccountSettings((raw) => {
        const mutation = createMutation(readSettings(raw), deps.now());
        persistedConnectionId = mutation.connection.id;
        created = mutation.created;
        if (!mutation.created) {
          if (hasAuthoringReview) {
            throw createProviderErrorV1('provider_authorization_changed', {
              connectionId: mutation.connection.id,
              machineId: input.machineId,
            });
          }
          return { ...raw };
        }
        const rawWithPreparedSecret = addPreparedSavedSecret(raw, input.preparedSavedSecret);
        let next = bindCreatedConnectionSecret(mutation.settings, input, mutation.connection, rawWithPreparedSecret, snapshot.registry);
        if (input.enable) {
          const candidateRaw = replaceSettings(rawWithPreparedSecret, next);
          const resolution = deps.resolveConnection({
            accountSettings: candidateRaw, connectionId: mutation.connection.id,
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
        return replaceSettings(rawWithPreparedSecret, next);
      });
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

  async function deleteConnection(input: Readonly<{
    action: 'delete'; machineId: string; connectionId: string;
  }>): Promise<ProviderConnectionServiceResult<Readonly<{ connectionId: string }>>> {
    if (!deps.featureGate.isEnabled('providers')) return { status: 'error', error: featureError(input.connectionId) };
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };
    await deps.updateAccountSettings((raw) => replaceSettings(
      raw,
      deleteProviderConnectionV1(readSettings(raw), input.connectionId, deps.now()),
    ));
    return { status: 'success', connectionId: input.connectionId };
  }

  async function update(
    input: ProviderConnectionUpdateInput,
  ): Promise<ProviderConnectionServiceResult<ProviderConnectionView>> {
    if (!deps.featureGate.isEnabled('providers')) return { status: 'error', error: featureError(input.connectionId) };
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };
    const lifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    });
    const snapshot = await deps.loadSnapshot();
    const registryProjection = {
      registry: snapshot.registry,
      ...(snapshot.registryGeneration ? { generation: snapshot.registryGeneration } : {}),
    };
    const buildUpdate = (
      settings: ProviderSettingsV1,
      current: ProviderConnectionV1,
    ): Readonly<{
      candidate: ProviderConnectionV1;
      settings: ProviderSettingsV1;
    }> => {
      const source = current.source.kind === 'contribution'
        ? getProviderContribution(
            snapshot.registry,
            current.source.contributionKey,
          )
        : null;
      const displayNameMode =
        input.displayNameMode ?? current.displayNameMode;
      const deployment = input.deployment;
      const deploymentChanged =
        deployment !== undefined
        && deployment.kind !== current.deployment.kind;
      const candidate = ProviderConnectionV1Schema.parse({
        ...current,
        displayName: displayNameMode === 'automatic'
          ? source?.definition.name ?? current.displayName
          : input.displayName ?? current.displayName,
        displayNameMode,
        ...(deployment?.kind === 'managedLocal'
          ? {
              deployment: { kind: 'managedLocal' as const },
              purposeBindingDefaults:
                deployment.purposeBindingDefaults,
              endpointOverrides: undefined,
              endpointOverridesByMachineId: undefined,
            }
          : deployment?.kind === 'external'
            ? {
                deployment: { kind: 'external' as const },
                purposeBindingDefaults: undefined,
              }
            : {}),
        revision: current.revision + 1,
        updatedAt: deps.now(),
      });
      const secretBindingsByConnectionId = {
        ...settings.secretBindingsByConnectionId,
      };
      if (candidate.deployment.kind === 'managedLocal') {
        delete secretBindingsByConnectionId[current.id];
      }
      return {
        candidate,
        settings: ProviderSettingsV1Schema.parse({
          ...settings,
          connections: settings.connections.map((entry) =>
            entry.id === input.connectionId ? candidate : entry),
          ...(candidate.deployment.kind === 'managedLocal'
            ? { secretBindingsByConnectionId }
            : {}),
          ...(deploymentChanged
            ? {
                accountGrants: settings.accountGrants.filter((grant) =>
                  grant.connectionId !== current.id),
                machineGrants: settings.machineGrants.filter((grant) =>
                  grant.connectionId !== current.id),
              }
            : {}),
        }),
      };
    };
    const requireValidDeployment = (
      accountSettings: Readonly<Record<string, unknown>>,
      dnsEvidence: Awaited<
        ReturnType<ProviderConnectionServiceDeps['collectDnsEvidence']>
      >,
    ): void => {
      if (input.deployment?.kind !== 'managedLocal') return;
      const resolution = deps.resolveConnection({
        accountSettings,
        connectionId: input.connectionId,
        machineId: input.machineId,
        registry: snapshot.registry,
        dnsEvidence,
      });
      if (
        resolution.status !== 'resolved'
        || resolution.record.deployment.kind !== input.deployment.kind
      ) {
        throw createProviderErrorV1('provider_connection_invalid', {
          connectionId: input.connectionId,
          machineId: input.machineId,
        });
      }
    };
    let deploymentDnsEvidence:
      Awaited<
        ReturnType<ProviderConnectionServiceDeps['collectDnsEvidence']>
      > = new Map();
    if (input.deployment?.kind === 'managedLocal') {
      const previewSettings = readSettings(snapshot.rawAccountSettings);
      const previewCurrent = previewSettings.connections.find((entry) =>
        entry.id === input.connectionId);
      if (previewCurrent?.revision === input.expectedRevision) {
        const preview = buildUpdate(previewSettings, previewCurrent);
        const previewRaw = replaceSettings(
          snapshot.rawAccountSettings,
          preview.settings,
        );
        deploymentDnsEvidence = await deps.collectDnsEvidence({
          accountSettings: previewRaw,
          connectionId: input.connectionId,
          machineId: input.machineId,
          registry: snapshot.registry,
          lifetime,
        });
        requireValidDeployment(previewRaw, deploymentDnsEvidence);
      }
    }
    let conflict = false;
    await deps.updateAccountSettings((raw) => {
      const settings = readSettings(raw);
      const current = settings.connections.find((entry) => entry.id === input.connectionId);
      if (!current) throw createProviderErrorV1('provider_connection_not_found', { connectionId: input.connectionId, machineId: input.machineId });
      if (current.revision !== input.expectedRevision) {
        conflict = true;
        return raw;
      }
      const updated = buildUpdate(settings, current);
      const nextRaw = replaceSettings(raw, updated.settings);
      requireValidDeployment(nextRaw, deploymentDnsEvidence);
      return nextRaw;
    });
    if (conflict) return { status: 'error', error: createProviderErrorV1('provider_connection_changed', { connectionId: input.connectionId, machineId: input.machineId }) };
    return describeOne(context, input.machineId, input.connectionId, { registryProjection, lifetime });
  }

  async function setEndpointOverride(input: Readonly<{
    action: 'setEndpointOverride'; machineId: string; connectionId: string; expectedRevision: number;
    scope: 'account' | 'machine'; endpointTemplateId: string; baseUrl: string | null;
  }>): Promise<ProviderConnectionServiceResult<ProviderConnectionView>> {
    if (!deps.featureGate.isEnabled('providers')) return { status: 'error', error: featureError(input.connectionId) };
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };
    const lifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    });
    const snapshot = await deps.loadSnapshot();
    const registryProjection = {
      registry: snapshot.registry,
      ...(snapshot.registryGeneration ? { generation: snapshot.registryGeneration } : {}),
    };
    let conflict = false;
    await deps.updateAccountSettings((raw) => {
      const settings = readSettings(raw);
      const current = settings.connections.find((entry) => entry.id === input.connectionId);
      if (!current) throw createProviderErrorV1('provider_connection_not_found', { connectionId: input.connectionId, machineId: input.machineId });
      if (current.revision !== input.expectedRevision) {
        conflict = true;
        return raw;
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
      if (input.scope === 'machine') {
        const next = upsert(endpointOverridesByMachineId[input.machineId]);
        if (next.length === 0) delete endpointOverridesByMachineId[input.machineId];
        else endpointOverridesByMachineId[input.machineId] = next;
      }
      const accountEndpointOverrides = input.scope === 'account' ? upsert(current.endpointOverrides) : current.endpointOverrides;
      const candidate = ProviderConnectionV1Schema.parse({
        ...current,
        ...(input.scope === 'account'
          ? accountEndpointOverrides?.length === 0 ? { endpointOverrides: undefined } : { endpointOverrides: accountEndpointOverrides }
          : {}),
        ...(input.scope === 'machine'
          ? Object.keys(endpointOverridesByMachineId).length === 0
            ? { endpointOverridesByMachineId: undefined }
            : { endpointOverridesByMachineId }
          : {}),
        revision: current.revision + 1,
        updatedAt: deps.now(),
      });
      return replaceSettings(raw, ProviderSettingsV1Schema.parse({
        ...settings,
        connections: settings.connections.map((entry) => entry.id === input.connectionId ? candidate : entry),
      }));
    });
    if (conflict) return { status: 'error', error: createProviderErrorV1('provider_connection_changed', { connectionId: input.connectionId, machineId: input.machineId }) };
    return describeOne(context, input.machineId, input.connectionId, { registryProjection, lifetime });
  }

  async function duplicate(input: Readonly<{
    action: 'duplicate'; machineId: string; connectionId: string; newConnectionId: string;
    displayName: string; mode: 'sameSource' | 'asCustom';
  }>): Promise<ProviderConnectionServiceResult<ProviderConnectionView>> {
    if (!deps.featureGate.isEnabled('providers')) return { status: 'error', error: featureError(input.connectionId) };
    const machineError = assertMachine(input.machineId, input.connectionId);
    if (machineError) return { status: 'error', error: machineError };
    const lifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    });
    const snapshot = await deps.loadSnapshot();
    const registryProjection = {
      registry: snapshot.registry,
      ...(snapshot.registryGeneration ? { generation: snapshot.registryGeneration } : {}),
    };
    await deps.updateAccountSettings((raw) => {
      const settings = readSettings(raw);
      const sourceConnection = settings.connections.find((entry) => entry.id === input.connectionId);
      if (!sourceConnection) throw createProviderErrorV1('provider_connection_not_found', { connectionId: input.connectionId, machineId: input.machineId });
      if (settings.connections.some((entry) => entry.id === input.newConnectionId)
        || settings.connectionTombstones.some((entry) => entry.id === input.newConnectionId)) {
        throw new ProviderConnectionValidationError('Allocated duplicate provider connection id is already used');
      }
      let source = sourceConnection.source;
      if (input.mode === 'asCustom') {
        if (sourceConnection.source.kind === 'custom') {
          source = { kind: 'custom', template: { ...sourceConnection.source.template, name: input.displayName } };
        } else {
          const contribution = getProviderContribution(snapshot.registry, sourceConnection.source.contributionKey);
          if (!contribution) throw createProviderErrorV1('provider_contribution_unavailable', { connectionId: input.connectionId, machineId: input.machineId });
          const transports = (contribution.definition.credential?.transports ?? []).flatMap((transport) => {
            if (transport.destination.kind !== 'httpHeader'
              || (transport.destination.format !== 'raw' && transport.destination.format !== 'bearer')) return [];
            const uses = transport.uses.filter((use): use is 'probe' | 'runtime' => use === 'probe' || use === 'runtime');
            return uses.length === 0 ? [] : [{ ...transport, uses, destination: transport.destination }];
          });
          if (contribution.definition.credential && transports.length === 0) {
            throw createProviderErrorV1('provider_credential_transport_unavailable', { connectionId: input.connectionId, machineId: input.machineId });
          }
          const endpointOverrides = new Map((sourceConnection.endpointOverrides ?? [])
            .map((entry) => [entry.endpointTemplateId, entry.baseUrl]));
          const endpointTemplates = contribution.definition.endpointTemplates.map((endpoint) => {
            const baseUrl = endpointOverrides.get(endpoint.id) ?? endpoint.baseUrl
              ?? (endpoint.localUrlCandidates?.length === 1 ? endpoint.localUrlCandidates[0] : null);
            if (!baseUrl) throw new ProviderConnectionValidationError('Duplicate-as-custom requires one concrete URL per endpoint');
            return {
              id: endpoint.id, protocol: endpoint.protocol, baseUrl,
              ...(endpoint.publicHeaders ? { publicHeaders: endpoint.publicHeaders } : {}),
              capabilities: {
                streaming: 'unknown' as const, toolRoundTrips: 'unknown' as const,
                statefulResponses: 'unknown' as const, reasoningControls: 'unknown' as const,
              },
            };
          });
          const contributionCatalog = contribution.definition.catalog;
          const contributionProbes = 'probes' in contributionCatalog ? contributionCatalog.probes : [];
          for (const probe of contributionProbes) {
            // A custom template has no plugin behind it, so only a catalog
            // format the host bundles can ever serve its probes. Copying a
            // contributed format id would persist a probe nothing can run and
            // silently leave the copy without a catalog.
            if (!isBundledProviderCatalogParserV1(probe.parser)) {
              throw new ProviderConnectionValidationError(
                'Duplicate-as-custom requires a bundled catalog format for every probe',
              );
            }
          }
          const catalog = contributionProbes.length > 0
            ? { source: 'probe' as const, manualModelPolicy: contributionCatalog.manualModelPolicy, probes: contributionProbes }
            : { source: 'manual' as const, manualModelPolicy: 'allowed' as const };
          source = { kind: 'custom', template: CustomProviderTemplateV1Schema.parse({
            v: 1, name: input.displayName, endpointTemplates,
            ...(contribution.definition.credential ? { credential: { ...contribution.definition.credential, transports } } : {}),
            catalog,
          }) };
        }
      }
      const connection = ProviderConnectionV1Schema.parse({
        v: 1, id: input.newConnectionId, source, role: 'named',
        displayName: input.displayName, displayNameMode: 'custom', revision: 0,
        createdAt: deps.now(), updatedAt: deps.now(),
        ...(input.mode === 'sameSource' && sourceConnection.endpointOverrides
          ? { endpointOverrides: sourceConnection.endpointOverrides }
          : {}),
      });
      const copiedManualModels = readOwnRecordValue(settings.manualModelsByConnectionId, input.connectionId);
      return replaceSettings(raw, ProviderSettingsV1Schema.parse({
        ...settings,
        connections: [...settings.connections, connection],
        ...(copiedManualModels ? { manualModelsByConnectionId: {
          ...settings.manualModelsByConnectionId,
          [input.newConnectionId]: copiedManualModels,
        } } : {}),
      }));
    });
    return describeOne(context, input.machineId, input.newConnectionId, { registryProjection, lifetime });
  }

  return Object.freeze({ previewCreateContribution, create, delete: deleteConnection, update, setEndpointOverride, duplicate });
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
