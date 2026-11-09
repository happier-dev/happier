import type {
  ProviderBrokerSourceApplicationBindingV1,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type {
  TeamCredentialProviderModelCatalogEntryV1,
} from '@happier-dev/protocol/teams';

/** Source observations have no consuming Agent or recipient selection. */
export type TeamCredentialSourceCatalogRow = Omit<TeamCredentialProviderModelCatalogEntryV1, 'application' | 'selection'> & Readonly<{
  application: ProviderBrokerSourceApplicationBindingV1;
  selection?: TeamCredentialProviderModelCatalogEntryV1['selection'];
}>;

export type TeamCredentialModelCatalogResolver<TApplication extends ProviderBrokerSourceApplicationBindingV1 = ProviderBrokerSourceApplicationBindingV1> = Readonly<{
  resourceId: string;
  resourceRevision: number;
  sourceRevision: string;
  application: TApplication;
  rows: readonly TeamCredentialSourceCatalogRow[];
  resolveCanonicalModelId(requestedModelId: string): string | null;
}>;

export type TeamCredentialExternalModelCatalog = Readonly<{
  applications: readonly ProviderBrokerSourceApplicationBindingV1[];
  models: readonly Readonly<{ id: string; name?: string }>[];
  resolveCanonicalModelId(requestedModelId: string): string | null;
}>;

export function isSameTeamCredentialBrokerApplication(
  left: ProviderBrokerSourceApplicationBindingV1,
  right: ProviderBrokerSourceApplicationBindingV1,
): boolean {
  return left.agentTargetKey === right.agentTargetKey
    && left.implementationIdentity.pluginId === right.implementationIdentity.pluginId
    && left.implementationIdentity.localId === right.implementationIdentity.localId
    && left.endpointTemplateId === right.endpointTemplateId
    && left.protocol === right.protocol;
}

function applicationKey(application: ProviderBrokerSourceApplicationBindingV1): string {
  return [
    application.agentTargetKey,
    application.implementationIdentity.pluginId,
    application.implementationIdentity.localId,
    application.endpointTemplateId,
    application.protocol,
  ].join('\0');
}

/**
 * Projects the protocol-neutral external model endpoint from exact current
 * application catalogs. Canonical ids identify models; presentation labels may
 * differ by protocol. Every published alias participates in ambiguity checks.
 * No application is selected as a default for later inference.
 */
export function createTeamCredentialExternalModelCatalog(
  catalogs: readonly TeamCredentialModelCatalogResolver[],
): TeamCredentialExternalModelCatalog | null {
  if (catalogs.length === 0) return null;
  const applicationsByKey = new Map<string, ProviderBrokerSourceApplicationBindingV1>();
  const descriptorById = new Map<string, TeamCredentialProviderModelCatalogEntryV1['descriptor']>();
  const candidatesBySpelling = new Map<string, Set<string>>();
  for (const catalog of catalogs) {
    applicationsByKey.set(applicationKey(catalog.application), catalog.application);
    for (const row of catalog.rows) {
      const modelId = row.descriptor.id;
      if (!descriptorById.has(modelId)) descriptorById.set(modelId, row.descriptor);
      for (const spelling of [modelId, ...(row.descriptor.aliases ?? [])]) {
        const candidates = candidatesBySpelling.get(spelling) ?? new Set<string>();
        candidates.add(modelId);
        candidatesBySpelling.set(spelling, candidates);
      }
    }
  }
  const retained = [...descriptorById.values()];
  if (retained.length === 0) return null;
  return Object.freeze({
    applications: Object.freeze([...applicationsByKey.values()]),
    models: Object.freeze(retained.map((descriptor) => Object.freeze({
      id: descriptor.id,
      ...(descriptor.name === undefined ? {} : { name: descriptor.name }),
    }))),
    resolveCanonicalModelId(requestedModelId) {
      const candidates = candidatesBySpelling.get(requestedModelId);
      if (!candidates || candidates.size !== 1) return null;
      return candidates.values().next().value ?? null;
    },
  });
}

/**
 * Binds request-model resolution to one exact current resource/source catalog.
 * Every published spelling participates in collision detection, including a
 * spelling that is canonical for one row and an alias for another. Unknown,
 * ambiguous, stale, mixed-source, and wrong-application catalogs fail closed.
 */
export function createTeamCredentialModelCatalogResolver<TApplication extends ProviderBrokerSourceApplicationBindingV1>(input: Readonly<{
  resourceId: string;
  resourceRevision: number;
  application: TApplication;
  rows: readonly TeamCredentialSourceCatalogRow[];
}>): TeamCredentialModelCatalogResolver<TApplication> | null {
  if (input.rows.length === 0) return null;
  const sourceRevisions = new Set<string>();
  const candidatesBySpelling = new Map<string, Set<string>>();
  const rows: TeamCredentialSourceCatalogRow[] = [];
  for (const row of input.rows) {
    if (
      row.availability !== 'available'
      || row.selection && (row.selection.resourceId !== input.resourceId
        || row.selection.expectedResourceRevision !== input.resourceRevision
        || row.selection.modelId !== row.descriptor.id)
      || !isSameTeamCredentialBrokerApplication(row.application, input.application)
    ) return null;
    sourceRevisions.add(row.sourceRevision);
    rows.push(Object.freeze({
      ...row,
      ...(row.selection ? { selection: Object.freeze({ ...row.selection }) } : {}),
      descriptor: Object.freeze({
        ...row.descriptor,
        ...(row.descriptor.aliases
          ? { aliases: [...row.descriptor.aliases] }
          : {}),
      }),
      application: Object.freeze({
        ...row.application,
        implementationIdentity: Object.freeze({
          ...row.application.implementationIdentity,
        }),
      }),
    }));
    for (const spelling of [row.descriptor.id, ...(row.descriptor.aliases ?? [])]) {
      const targets = candidatesBySpelling.get(spelling) ?? new Set<string>();
      targets.add(row.descriptor.id);
      candidatesBySpelling.set(spelling, targets);
    }
  }
  if (sourceRevisions.size !== 1) return null;
  const [sourceRevision] = sourceRevisions;
  if (!sourceRevision) return null;
  return Object.freeze({
    resourceId: input.resourceId,
    resourceRevision: input.resourceRevision,
    sourceRevision,
    application: Object.freeze({
      ...input.application,
      implementationIdentity: Object.freeze({
        ...input.application.implementationIdentity,
      }),
    }),
    rows: Object.freeze(rows),
    resolveCanonicalModelId(requestedModelId) {
      const targets = candidatesBySpelling.get(requestedModelId);
      if (!targets || targets.size !== 1) return null;
      return targets.values().next().value ?? null;
    },
  });
}
