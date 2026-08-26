import { lookup } from 'node:dns/promises';

import {
  normalizeProviderEndpointUrlSyntax,
  readOwnRecordValue,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import { resolveUrlConnectionIdentity } from '@/network/urlConnectionIdentity';

import {
  awaitWithinProviderOperation,
  ProviderOperationAbandonedError,
  type ProviderOperationLifetime,
} from '../operationLifetime';

import type {
  ProviderContributionRegistryView,
  ProviderEndpointDnsEvidence,
} from './types';
import { getProviderContribution } from './lookup';

export async function collectProviderConnectionDnsEvidence(input: Readonly<{
  connectionId: string;
  machineId: string;
  providerSettings: ProviderSettingsV1;
  registry: ProviderContributionRegistryView;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  /**
   * The already-started Provider operation budget. A public owner starts this
   * before registry/DNS work; this resolver only spends that same budget.
   */
  lifetime: ProviderOperationLifetime;
}>): Promise<ProviderEndpointDnsEvidence> {
  const connection = input.providerSettings.connections.find((candidate) => candidate.id === input.connectionId);
  if (!connection) return new Map();
  // Managed-local catalog dispatch receives its endpoint only after SVC09
  // starts the exact local run. Declaration URLs are not durable destinations
  // for that flow, so resolving them would spend the existing operation budget
  // on irrelevant external DNS before the canonical launch-local endpoint exists.
  if (connection.deployment.kind === 'managedLocal') return new Map();
  const urls = new Set<string>();
  for (const override of connection.endpointOverrides ?? []) urls.add(override.baseUrl);
  for (const override of readOwnRecordValue(connection.endpointOverridesByMachineId, input.machineId) ?? []) {
    urls.add(override.baseUrl);
  }
  if (connection.source.kind === 'custom') {
    for (const endpoint of connection.source.template.endpointTemplates) urls.add(endpoint.baseUrl);
  } else {
    const contribution = getProviderContribution(input.registry, connection.source.contributionKey);
    for (const endpoint of contribution?.definition.endpointTemplates ?? []) {
      if (endpoint.baseUrl) urls.add(endpoint.baseUrl);
      for (const candidate of endpoint.localUrlCandidates ?? []) urls.add(candidate);
    }
  }
  const resolveAddresses = input.resolveAddresses ?? (async (hostname: string) =>
    (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address));
  const evidence = new Map<string, readonly string[]>();
  await Promise.all([...urls].map(async (rawUrl) => {
    try {
      const normalizedUrl = normalizeProviderEndpointUrlSyntax(rawUrl).normalizedUrl;
      const lookup = resolveAddresses(
        resolveUrlConnectionIdentity(new URL(normalizedUrl).hostname).hostname,
      );
      const addresses = await awaitWithinProviderOperation(lookup, input.lifetime);
      evidence.set(normalizedUrl, Object.freeze([...addresses]));
    } catch (error) {
      // Abandonment is the operation's own decision and must reach the caller;
      // an ordinary resolver failure stays absent evidence, which the
      // authoritative resolver turns into a stable endpoint refusal.
      if (error instanceof ProviderOperationAbandonedError) throw error;
    }
  }));
  return evidence;
}
