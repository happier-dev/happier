import { lookup } from 'node:dns/promises';

import {
  normalizeProviderEndpointUrlSyntax,
  readOwnRecordValue,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import { resolveUrlConnectionIdentity } from '@/network/urlConnectionIdentity';

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
}>): Promise<ProviderEndpointDnsEvidence> {
  const connection = input.providerSettings.connections.find((candidate) => candidate.id === input.connectionId);
  if (!connection) return new Map();
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
      const addresses = await resolveAddresses(
        resolveUrlConnectionIdentity(new URL(normalizedUrl).hostname).hostname,
      );
      evidence.set(normalizedUrl, Object.freeze([...addresses]));
    } catch {
      // The authoritative resolver turns absent DNS evidence into a stable endpoint refusal.
    }
  }));
  return evidence;
}
