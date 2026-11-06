import { lookup } from 'node:dns/promises';

import { assessProviderEndpoint, normalizeProviderEndpointUrlSyntax } from '@happier-dev/protocol/providers/safety/url';
import type { ProviderEndpointTemplateV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import { isProviderDestinationGrantFingerprintV2 } from '@happier-dev/protocol/providers/fingerprints';

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
import { resolveEffectiveProviderEndpointV1 } from '@happier-dev/protocol/providers/connections/v1';

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
  const accountGrant = input.providerSettings.accountGrants.find(grant => grant.connectionId === connection.id);
  const machineGrant = input.providerSettings.machineGrants.find(grant =>
    grant.connectionId === connection.id && grant.machineId === input.machineId);
  // Destination consent retains its deliberate scope without DNS. Actual
  // daemon HTTP requests still resolve and assess each destination themselves.
  if ([machineGrant, accountGrant].some(grant => grant && isProviderDestinationGrantFingerprintV2(grant.connectionSecurityFingerprint))) return [];
  const accountEnabled = accountGrant !== undefined;
  const machineEnabled = machineGrant !== undefined;
  const rawUrls = new Set<string>();
  const templates: readonly ProviderEndpointTemplateV1[] = connection.source.kind === 'custom' ? connection.source.template.endpointTemplates
    : getProviderContribution(input.registry, connection.source.contributionKey)?.definition.endpointTemplates ?? [];
  for (const template of templates) {
    try {
      const effective = resolveEffectiveProviderEndpointV1({ connection, template, machineId: input.machineId });
      if (effective.ready && effective.baseUrl) {
        // Public Account consent does not depend on this daemon's DNS: the
        // Agent may resolve through a proxy. Keep Machine overrides/locality
        // discovery intact; the HTTP client assesses every actual destination.
        if (accountEnabled && !machineEnabled && effective.machineOverrideBaseUrl === null && effective.machineOverridePublicHeaders === null
          && new URL(effective.baseUrl).protocol === 'https:'
          && assessProviderEndpoint(effective.baseUrl, { purpose: 'configuration' }).scope === 'account') continue;
        rawUrls.add(effective.baseUrl);
      }
      else if (effective.reason === 'local_candidate_required') {
        for (const candidate of 'localUrlCandidates' in template ? template.localUrlCandidates ?? [] : []) rawUrls.add(candidate);
      }
    } catch {
      // Family and public-policy admission precedes DNS; resolution reports the typed refusal.
      return [];
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
    isCurrent?: () => boolean,
  ) => Promise<T>;
  isCurrent?: () => boolean;
  lifetime: ProviderOperationLifetime;
  /** Bulk presentation admits each source as its hosts settle and retains
   * source-scoped failures. Without this consumer, DNS admission fails closed. */
  onConnectionResolved?: (connectionId: string, result: Readonly<{
    evidence: ProviderEndpointDnsEvidence;
    error?: ProviderOperationAbandonedError | ProviderProbeAdmissionCapacityError;
  }>) => void;
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
  const errorsByHostname = new Map<string, ProviderOperationAbandonedError | ProviderProbeAdmissionCapacityError>();
  const evidenceByConnectionId = new Map<string, ProviderEndpointDnsEvidence>();
  const pendingHostsByConnectionId = new Map<string, Set<string>>();
  const connectionsByHostname = new Map<string, Set<string>>();
  const publishConnection = (connectionId: string) => {
    const urls = urlsByConnectionId.get(connectionId) ?? [];
    const error = urls.map(url => errorsByHostname.get(url.hostname)).find(error => error !== undefined);
    const evidence = new Map<string, readonly string[]>();
    for (const url of urls) {
      const addresses = addressesByHostname.get(url.hostname);
      if (addresses) evidence.set(url.normalizedUrl, addresses);
    }
    evidenceByConnectionId.set(connectionId, evidence);
    input.onConnectionResolved?.(connectionId, { evidence, ...(error ? { error } : {}) });
  };
  for (const [connectionId, urls] of urlsByConnectionId) {
    const pendingHosts = new Set(urls.map(url => url.hostname));
    pendingHostsByConnectionId.set(connectionId, pendingHosts);
    for (const hostname of pendingHosts) {
      const connections = connectionsByHostname.get(hostname) ?? new Set<string>();
      connections.add(connectionId);
      connectionsByHostname.set(hostname, connections);
    }
    if (pendingHosts.size === 0) publishConnection(connectionId);
  }
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
      try {
        await awaitWithinProviderOperation(Promise.resolve(), input.lifetime);
        const resolveOne = () => awaitWithinProviderOperation(
          resolveAddresses(hostname),
          input.lifetime,
        );
        const addresses = input.admitResolution
          ? await input.admitResolution(resolveOne, input.lifetime, input.isCurrent)
          : await resolveOne();
        addressesByHostname.set(hostname, Object.freeze([...addresses]));
      } catch (error) {
        if (
          error instanceof ProviderOperationAbandonedError
          || error instanceof ProviderProbeAdmissionCapacityError
        ) {
          if (!input.onConnectionResolved || input.lifetime.signal?.aborted) throw error;
          errorsByHostname.set(hostname, error);
        }
        // Ordinary lookup failure remains absent evidence; the authoritative
        // connection resolver turns that into its typed endpoint refusal.
      }
      for (const connectionId of connectionsByHostname.get(hostname) ?? []) {
        const pendingHosts = pendingHostsByConnectionId.get(connectionId)!;
        pendingHosts.delete(hostname);
        if (pendingHosts.size === 0) publishConnection(connectionId);
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
    isCurrent?: () => boolean,
  ) => Promise<T>;
  isCurrent?: () => boolean;
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
    ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
    lifetime: input.lifetime,
  });
  return evidenceByConnectionId.get(input.connectionId) ?? new Map();
}
