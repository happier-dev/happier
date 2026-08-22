import {
  ProviderDiscoveryCandidateV1Schema,
  ProviderConnectionIdSchema,
  areProviderContributionKeysEqualV1,
  createProviderDiscoveryCandidateIdV1,
  normalizeProviderEndpointUrlSyntax,
  type ProviderDiscoveryCandidateV1,
} from '@happier-dev/protocol';

import type { NormalizedLocalServiceInventorySnapshot } from '@/daemon/local/services/inventory/scanner';
import type { ProviderContributionRegistryView } from '@/providers/registry';

export type ProviderDiscoveryConnectionEndpointView = Readonly<{
  endpointTemplateId: string;
  baseUrl: string;
}>;

export type ProviderDiscoveryConnectionView = Readonly<{
  connectionId: string;
  contributionKey: string | null;
  role: 'default' | 'named';
  deployment: Readonly<{ kind: 'external' | 'managedLocal' }>;
  endpoints: readonly ProviderDiscoveryConnectionEndpointView[];
}>;

type CommandTokens = Readonly<{ executableBasename: string; argv: readonly string[] }>;

function tokenizeCommand(command: string): readonly string[] {
  if (command.length === 0 || command.length > 4_096) return [];
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character ?? '')) {
      if (current) {
        tokens.push(current);
        current = '';
        if (tokens.length >= 128) return tokens;
      }
      continue;
    }
    current += character;
  }
  if (current && tokens.length < 128) tokens.push(current);
  return tokens;
}

function commandTokens(command: string): CommandTokens | null {
  const tokens = tokenizeCommand(command);
  const executable = tokens[0];
  if (!executable) return null;
  const basename = executable.split(/[\\/]/u).at(-1);
  if (!basename) return null;
  return { executableBasename: basename.toLowerCase(), argv: tokens.slice(1) };
}

function matchesArgv(
  argv: readonly string[],
  rule: Readonly<{ mode: 'containsAll' | 'orderedSubsequence'; tokens: readonly string[] }> | undefined,
): boolean {
  if (!rule) return true;
  if (rule.mode === 'containsAll') return rule.tokens.every((token) => argv.includes(token));
  let cursor = 0;
  for (const token of argv) {
    if (token === rule.tokens[cursor]) cursor += 1;
    if (cursor === rule.tokens.length) return true;
  }
  return false;
}

function buildCandidateUrl(input: Readonly<{
  declaredUrl: string;
  observedHost: string;
  observedAddressKind: 'loopback' | 'wildcard' | 'lan' | 'unknown';
  observedPort: number;
}>): string | null {
  try {
    const url = new URL(input.declaredUrl);
    if (input.observedAddressKind !== 'wildcard') {
      url.hostname = input.observedHost.includes(':') ? `[${input.observedHost.replace(/^\[|\]$/gu, '')}]` : input.observedHost;
    }
    url.port = String(input.observedPort);
    return normalizeProviderEndpointUrlSyntax(url.toString(), { allowQuery: false }).normalizedUrl;
  } catch {
    return null;
  }
}

function connectionState(input: Readonly<{
  contributionKey: string;
  endpointTemplateId: string;
  normalizedEndpointUrl: string;
  connections: readonly ProviderDiscoveryConnectionView[];
}>): ProviderDiscoveryCandidateV1['connection'] {
  const sameContribution = input.connections.filter((connection) =>
    connection.deployment.kind === 'external'
    && connection.contributionKey !== null
    && areProviderContributionKeysEqualV1(connection.contributionKey, input.contributionKey));
  const exact = sameContribution.find((connection) => connection.endpoints.some((endpoint) =>
    endpoint.endpointTemplateId === input.endpointTemplateId
      && endpoint.baseUrl === input.normalizedEndpointUrl));
  if (exact) return { status: 'matched', connectionId: ProviderConnectionIdSchema.parse(exact.connectionId) };
  return sameContribution.some((connection) => connection.role === 'default')
    ? { status: 'requires_named_connection' }
    : { status: 'enable_default' };
}

export function projectProviderDiscoveryCandidates(input: Readonly<{
  snapshot: NormalizedLocalServiceInventorySnapshot;
  registry: ProviderContributionRegistryView;
  connections?: readonly ProviderDiscoveryConnectionView[];
}>): readonly ProviderDiscoveryCandidateV1[] {
  const connections = input.connections ?? [];
  const candidates: ProviderDiscoveryCandidateV1[] = [];
  for (const [contributionKey, contribution] of input.registry.providersByContributionKey) {
    const discovery = contribution.definition.discovery;
    if (!discovery) continue;
    const endpointTemplate = contribution.definition.endpointTemplates.find(
      (endpoint) => endpoint.id === discovery.availabilityProbe.endpointTemplateId,
    );
    const declaredUrl = endpointTemplate?.localUrlCandidates?.[0];
    if (!endpointTemplate || !declaredUrl) continue;
    const executableBasenames = new Set(discovery.listener.executableBasenames.map((entry) => entry.toLowerCase()));
    for (const entry of input.snapshot.entries) {
      if (entry.state !== 'listening') continue;
      const process = entry.provenance?.process;
      let evidence: ProviderDiscoveryCandidateV1['evidence'] | null = null;
      if (process) {
        const command = commandTokens(process.command);
        if (!command || !executableBasenames.has(command.executableBasename)
          || !matchesArgv(command.argv, discovery.listener.argvMatch)) {
          continue;
        }
        evidence = { kind: 'attributed_listener' };
      } else if (discovery.listener.defaultPorts.includes(entry.port)) {
        evidence = { kind: 'default_port_hint' };
      }
      if (!evidence) continue;
      const normalizedEndpointUrl = buildCandidateUrl({
        declaredUrl,
        observedHost: entry.address.host,
        observedAddressKind: entry.address.kind,
        observedPort: entry.port,
      });
      if (!normalizedEndpointUrl) continue;
      candidates.push(ProviderDiscoveryCandidateV1Schema.parse({
        v: 1,
        machineId: input.snapshot.machineId,
        contributionKey,
        providerName: contribution.definition.name,
        endpointTemplateId: endpointTemplate.id,
        normalizedEndpointUrl,
        candidateId: createProviderDiscoveryCandidateIdV1({
          machineId: input.snapshot.machineId,
          contributionKey,
          endpointTemplateId: endpointTemplate.id,
          normalizedEndpointUrl,
        }),
        evidence,
        ownership: 'adopted',
        connection: connectionState({
          contributionKey,
          endpointTemplateId: endpointTemplate.id,
          normalizedEndpointUrl,
          connections,
        }),
      }));
    }
  }
  const byIdentity = new Map<string, ProviderDiscoveryCandidateV1>();
  for (const candidate of candidates) {
    const identity = JSON.stringify([
      candidate.machineId,
      candidate.contributionKey,
      candidate.normalizedEndpointUrl,
    ]);
    const previous = byIdentity.get(identity);
    if (!previous || (previous.evidence.kind === 'default_port_hint'
      && candidate.evidence.kind === 'attributed_listener')) {
      byIdentity.set(identity, candidate);
    }
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.providerName.localeCompare(right.providerName)
      || left.normalizedEndpointUrl.localeCompare(right.normalizedEndpointUrl)
      || left.contributionKey.localeCompare(right.contributionKey));
}
