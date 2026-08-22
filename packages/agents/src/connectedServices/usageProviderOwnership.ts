import { readBundledAgentFact } from '../definitions/generatedFacts.js';
import { AGENTS_CORE } from '../manifest.js';

/**
 * Whether a provider-account usage record's `providerId` may be attributed to
 * connected service `serviceId`.
 *
 * A provider owns a service when it IS that service, or when it is a bundled
 * Agent whose manifest declares the service in `connectedServices`.
 *
 * The bundled scope is deliberate and load-bearing. This is the ownership rule
 * guarding account-scoped usage history, and neither the daemon nor the server
 * has authority over which connected services an externally installed Agent
 * consumes — no bundled fact means "not established here", never "trusted".
 * Reading through {@link readBundledAgentFact} keeps that scope explicit for an
 * open Agent id instead of indexing a bundled record as if it were total.
 *
 * Single owner for both writers: the daemon rejects incompatible attributions
 * before uploading, and the server re-decides the same rule at its legacy
 * ingress. They must not drift.
 */
export function isConnectedServiceUsageProviderCompatible(params: Readonly<{
  providerId: string;
  serviceId: string;
}>): boolean {
  const providerId = params.providerId.trim();
  const serviceId = params.serviceId.trim();
  if (!providerId || !serviceId) return false;
  if (providerId === serviceId) return true;

  const agentCore = readBundledAgentFact(AGENTS_CORE, providerId);
  const supportedServiceIds: ReadonlyArray<string> =
    agentCore?.connectedServices?.supportedServiceIds ?? [];
  return supportedServiceIds.includes(serviceId);
}
