import type { ProviderActionRequestV1 } from '../providerActionsV1.js';
import { canonicalizeProviderContributionKeyV1 } from '../contributionIdentityV1.js';
import type { ProviderConnectionsCatalogV1 } from './connectionRowsV1.js';

/** Undefined selects the inventory; an empty selection requires no plugin declarations. */
export function readAccountProviderDeclarationDemandV1(
  request: ProviderActionRequestV1,
  catalog: ProviderConnectionsCatalogV1,
): readonly string[] | undefined {
  if (request.actionId === 'providers.connections.describe' || request.actionId === 'providers.models.projection') return undefined;
  if (request.actionId === 'providers.connections.create_contribution') {
    return [canonicalizeProviderContributionKeyV1(request.input.contributionKey)];
  }
  if (request.actionId === 'providers.connections.create_custom' || request.actionId === 'providers.connections.delete') return [];
  const needsSource = request.actionId.startsWith('providers.connections.') || request.actionId === 'providers.models.list'
    || request.actionId === 'providers.models.manual.add' || request.actionId === 'providers.models.manual.remove';
  if (!needsSource || !('connectionId' in request.input)) return [];
  const connectionId = request.input.connectionId;
  const connection = catalog.connections.find(connection => connection.id === connectionId);
  return connection?.source.kind === 'contribution'
    ? [canonicalizeProviderContributionKeyV1(connection.source.contributionKey)] : [];
}
