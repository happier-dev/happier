import type { ProviderContributionV1 } from '../contributions/v1.js';
import { canonicalizeProviderContributionKeyV1 } from '../contributionIdentityV1.js';
import { compareProviderCanonicalStringsV1 } from '../canonicalOrderV1.js';
import { createProviderErrorV1 } from '../errors.js';
import type { ProviderSettingsV1 } from '../settings/v1.js';
import { addProviderConnectionV1, ensureDefaultProviderConnectionV1, bindProviderConnectionSecretV1,
  addOrUpdateProviderManualModelsV1 } from '../settings/operationsV1.js';
import { ProviderConnectionV1Schema, type ProviderConnectionV1, type ProviderEndpointOverrideV1 } from './v1.js';
import { CustomProviderTemplateV1Schema, type CustomProviderTemplateV1 } from './customTemplateV1.js';

/** Shared creation semantics; runtime observations and grant evidence stay with their callers. */
export function prepareProviderConnectionCreationV1(input: Readonly<{
  settings: ProviderSettingsV1;
  connectionId: string;
  source: Readonly<{ kind: 'contribution'; contributionKey: string; definition: ProviderContributionV1; displayName: string | null }>
    | Readonly<{ kind: 'custom'; template: CustomProviderTemplateV1 }>;
  savedSecretId: string | null;
  manualModels?: readonly Readonly<{ id: string; name?: string }>[];
  endpointOverrides?: Readonly<{ values: readonly ProviderEndpointOverrideV1[]; machineId?: string }>;
  now: number;
}>): Readonly<{ settings: ProviderSettingsV1; connection: ProviderConnectionV1; created: boolean }> {
  let settings = input.settings;
  let connection: ProviderConnectionV1;
  const source = input.source;
  if (source.kind === 'contribution' && source.displayName === null) {
    const result = ensureDefaultProviderConnectionV1(settings, { contributionKey: source.contributionKey,
      allocatedConnectionId: input.connectionId, providerName: source.definition.name, now: input.now });
    settings = result.settings;
    connection = result.connection;
    if (!result.changed) return { settings, connection, created: false };
  } else {
    const template = source.kind === 'custom' ? CustomProviderTemplateV1Schema.parse(source.template) : null;
    connection = ProviderConnectionV1Schema.parse({ v: 1, id: input.connectionId,
      source: source.kind === 'contribution' ? { kind: 'contribution', contributionKey: canonicalizeProviderContributionKeyV1(source.contributionKey) }
        : { kind: 'custom', template },
      role: 'named', displayName: source.kind === 'contribution' ? source.displayName : template?.name,
      displayNameMode: 'custom', revision: 0, createdAt: input.now, updatedAt: input.now });
    settings = addProviderConnectionV1(settings, connection);
  }
  const definition = source.kind === 'contribution' ? source.definition : source.template;
  if (input.endpointOverrides?.values.length) {
    const values = [...input.endpointOverrides.values].sort((left, right) =>
      compareProviderCanonicalStringsV1(left.endpointTemplateId, right.endpointTemplateId));
    const declared = new Set(definition.endpointTemplates.map(endpoint => endpoint.id));
    if (values.some(value => !declared.has(value.endpointTemplateId))) {
      throw createProviderErrorV1('provider_connection_invalid', { connectionId: connection.id });
    }
    connection = ProviderConnectionV1Schema.parse({ ...connection,
      ...(input.endpointOverrides.machineId ? { endpointOverridesByMachineId: { [input.endpointOverrides.machineId]: values }, revision: 1 }
        : { endpointOverrides: values }) });
    settings = { ...settings, connections: settings.connections.map(previous => previous.id === connection.id ? connection : previous) };
  }
  if (input.savedSecretId !== null) {
    if (!definition.credential) throw createProviderErrorV1('provider_credential_transport_unavailable', { connectionId: connection.id });
    settings = bindProviderConnectionSecretV1({ settings, connectionId: connection.id, slotId: 'apiKey', savedSecretId: input.savedSecretId });
  }
  if (input.manualModels?.length) {
    if (definition.catalog.manualModelPolicy === 'catalog-only') throw createProviderErrorV1('provider_connection_invalid', { connectionId: connection.id });
    settings = addOrUpdateProviderManualModelsV1(settings, { connectionId: connection.id, models: input.manualModels, addedAt: input.now });
  }
  return { settings, connection, created: true };
}
