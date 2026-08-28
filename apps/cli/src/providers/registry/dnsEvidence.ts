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
import {
  PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS,
  ProviderProbeAdmissionCapacityError,
} from '../probe/scheduler';

import type {
  ProviderContributionRegistryView,
  ProviderEndpointDnsEvidence,
} from './types';
import { getProviderContribution } from './lookup';

type ProviderConnectionEndpointUrl = Readonly<{
  normalizedUrl: string;
  hostname: string;
}>;

function collectProviderConnectionEndpointUrls(input: Readonly<{
  connectionId: string;
  machineId: string;
  providerSettings: ProviderSettingsV1;
  registry: ProviderContributionRegistryView;
}>): readonly ProviderConnectionEndpointUrl[] {
  const connection = input.providerSettings.connections.find((candidate) => candidate.id === input.connectionId);
  if (!connection || connection.deployment.kind === 'managedLocal') return [];
  const rawUrls = new Set<string>();
  for (const override of connection.endpointOverrides ?? []) rawUrls.add(override.baseUrl);
  for (const override of readOwnRecordValue(connection.endpointOverridesByMachineId, input.machineId) ?? []) {
    rawUrls.add(override.baseUrl);
  }
  if (connection.source.kind === 'custom') {
    for (const endpoint of connection.source.template.endpointTemplates) rawUrls.add(endpoint.baseUrl);
  } else {
    const contribution = getProviderContribution(input.registry, connection.source.contributionKey);
    for (const endpoint of contribution?.definition.endpointTemplates ?? []) {
      if (endpoint.baseUrl) rawUrls.add(endpoint.baseUrl);
      for (const candidate of endpoint.localUrlCandidates ?? []) rawUrls.add(candidate);
    }
  }
  const urls: ProviderConnectionEndpointUrl[] = [];
  for (const rawUrl of rawUrls) {
    try {
      const normalizedUrl = normalizeProviderEndpointUrlSyntax(rawUrl).normalizedUrl;
      urls.push(Object.freeze({
        normalizedUrl,
        hostname: resolveUrlConnectionIdentity(new URL(normalizedUrl).hostname).hostname,
      }));
    } catch {
      // Syntax/currentness belongs to canonical connection resolution. Invalid
      // URLs simply have no DNS evidence and are refused there.
    }
  }
  return Object.freeze(urls);
}

/**
 * Resolves one immutable Provider operation's connection set by unique host.
 *
 * This is a request-local admission context, not a DNS cache: evidence is
 * fresh for every operation and is discarded with its operation scope. The
 * Callers with a shared runtime provide its canonical admission function; the
 * small worker set then streams unique hosts through that one global owner
 * without constructing an unbounded local promise queue.
 */
export async function collectProviderConnectionsDnsEvidence(input: Readonly<{
  connectionIds: readonly string[];
  machineId: string;
  providerSettings: ProviderSettingsV1;
  registry: ProviderContributionRegistryView;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  admitResolution?: <T>(
    operation: () => Promise<T>,
    lifetime: ProviderOperationLifetime,
  ) => Promise<T>;
  lifetime: ProviderOperationLifetime;
}>): Promise<ReadonlyMap<string, ProviderEndpointDnsEvidence>> {
  const urlsByConnectionId = new Map<string, readonly ProviderConnectionEndpointUrl[]>();
  const hostnamesToResolve = new Set<string>();
  for (const connectionId of input.connectionIds) {
    const urls = collectProviderConnectionEndpointUrls({
      connectionId,
      machineId: input.machineId,
      providerSettings: input.providerSettings,
      registry: input.registry,
    });
    urlsByConnectionId.set(connectionId, urls);
    for (const url of urls) hostnamesToResolve.add(url.hostname);
  }

  const resolveAddresses = input.resolveAddresses ?? (async (hostname: string) =>
    (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address));
  const addressesByHostname = new Map<string, readonly string[]>();
  const hostnames = [...hostnamesToResolve];
  let nextHostnameIndex = 0;
  const resolveWorker = async (): Promise<void> => {
    while (true) {
      // Reserve the hostname synchronously. Every worker may resume together
      // after the lifetime check below, so advancing the shared cursor after
      // that yield can otherwise run workers past the end of the collection.
      const hostnameIndex = nextHostnameIndex;
      if (hostnameIndex >= hostnames.length) return;
      nextHostnameIndex += 1;
      const hostname = hostnames[hostnameIndex]!;
      // Refuse before invoking the resolver, not only while awaiting it. This
      // keeps cancellation from feeding more unabortable libuv work.
      await awaitWithinProviderOperation(Promise.resolve(), input.lifetime);
      try {
        const resolveOne = () => awaitWithinProviderOperation(
          resolveAddresses(hostname),
          input.lifetime,
        );
        const addresses = input.admitResolution
          ? await input.admitResolution(resolveOne, input.lifetime)
          : await resolveOne();
        addressesByHostname.set(hostname, Object.freeze([...addresses]));
      } catch (error) {
        if (
          error instanceof ProviderOperationAbandonedError
          || error instanceof ProviderProbeAdmissionCapacityError
        ) throw error;
        // Ordinary lookup failure remains absent evidence; the authoritative
        // connection resolver turns that into its typed endpoint refusal.
      }
    }
  };
  await Promise.all(Array.from(
    {
      length: Math.min(
        PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS,
        hostnames.length,
      ),
    },
    () => resolveWorker(),
  ));

  const evidenceByConnectionId = new Map<string, ProviderEndpointDnsEvidence>();
  for (const [connectionId, urls] of urlsByConnectionId) {
    const evidence = new Map<string, readonly string[]>();
    for (const url of urls) {
      const addresses = addressesByHostname.get(url.hostname);
      if (addresses) evidence.set(url.normalizedUrl, addresses);
    }
    evidenceByConnectionId.set(connectionId, evidence);
  }
  return evidenceByConnectionId;
}

export async function collectProviderConnectionDnsEvidence(input: Readonly<{
  connectionId: string;
  machineId: string;
  providerSettings: ProviderSettingsV1;
  registry: ProviderContributionRegistryView;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  admitResolution?: <T>(
    operation: () => Promise<T>,
    lifetime: ProviderOperationLifetime,
  ) => Promise<T>;
  /**
   * The already-started Provider operation budget. A public owner starts this
   * before registry/DNS work; this resolver only spends that same budget.
   */
  lifetime: ProviderOperationLifetime;
}>): Promise<ProviderEndpointDnsEvidence> {
  const evidenceByConnectionId = await collectProviderConnectionsDnsEvidence({
    connectionIds: [input.connectionId],
    machineId: input.machineId,
    providerSettings: input.providerSettings,
    registry: input.registry,
    ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
    ...(input.admitResolution ? { admitResolution: input.admitResolution } : {}),
    lifetime: input.lifetime,
  });
  return evidenceByConnectionId.get(input.connectionId) ?? new Map();
}
