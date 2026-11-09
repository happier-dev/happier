import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import {
  resolveAcpPlatformFitV1,
  type AcpPlatformFitV1,
} from '@happier-dev/protocol/acp/catalog/registry/acpPlatformFitV1';
import {
  HAPPIER_PICKS_SOURCE_ID,
  type AcpRegistryAgentV1,
  type RegistryAgentDistributionV1,
  type RegistryItemProblemV1,
} from '@happier-dev/protocol/registries';
import type { RegistryCatalogItemSummary as RegistryItemSummaryV1 } from '@/registries/registryBrandMark';

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveBuiltInAgentForRegistryId } from '@/agents/registry/resolveBuiltInAgentForRegistryId';

/** A machine as the Add details judge fit: its raw platform/arch facts, name and presence. */
export type AgentAddMachine = Readonly<{
  machineId: string;
  name: string;
  platform: string | null;
  arch: string | null;
  offline: boolean;
}>;

/** The one status a catalog row carries in its where column (lab aa L, F2). */
export type AgentAddRowStatus =
  | Readonly<{ kind: 'builtIn'; entry: ResolvedAgentCatalogEntry }>
  | Readonly<{ kind: 'added'; definitionId: string }>
  | Readonly<{
      kind: 'cantRun';
      machineName: string;
      fit: Extract<AcpPlatformFitV1, { kind: 'cant_run' }>;
    }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'problem'; problem: RegistryItemProblemV1 }>;

export type AgentAddRow = Readonly<{
  key: string;
  summary: RegistryItemSummaryV1;
  pick: boolean;
  status: AgentAddRowStatus | null;
}>;

export type AgentAddGroup = Readonly<{
  key: string;
  sourceId: string;
  pick: boolean;
  itemKeys: readonly string[];
}>;

export const agentAddRowKey = (
  summary: Pick<RegistryItemSummaryV1, 'sourceId' | 'itemId'>,
) => `${summary.sourceId}|${summary.itemId}`;

/** The Account definition an earlier add of this registry item wrote (its id survives Update). */
export function findAddedAgentDefinition(
  definitions: readonly AcpBackendDefinitionV1[],
  pointer: Readonly<{ sourceId: string; itemId: string }>,
): AcpBackendDefinitionV1 | null {
  return (
    definitions.find(
      (definition) =>
        definition.origin?.kind === 'registry' &&
        definition.origin.provenance.sourceId === pointer.sourceId &&
        definition.origin.provenance.itemId === pointer.itemId,
    ) ?? null
  );
}

export type AgentMachineFit = Readonly<{
  machine: AgentAddMachine;
  fit: AcpPlatformFitV1;
}>;

/** Fit of a registry agent on every machine, from published platform facts (offline machines included). */
export function resolveAgentMachineFits(
  distributions: AcpRegistryAgentV1['distributions'] | RegistryAgentDistributionV1,
  machines: readonly AgentAddMachine[],
): readonly AgentMachineFit[] {
  return machines.map((machine) => ({
    machine,
    fit: resolveAcpPlatformFitV1(distributions, {
      platform: machine.platform,
      arch: machine.arch,
    }),
  }));
}

/**
 * The machines column's lines: machines a build can't run on for the same stated reason are one line ("14 machines ·
 * goose's download for this system isn't a format Happier can unpack"), placed at the first one; a machine that can
 * run it, or can't for a reason of its own, keeps its own line. `lineOf` is the reason as the page says it.
 */
const NAMED_MACHINE_ROWS = 3;

export function groupAgentMachineFits(
  fits: readonly AgentMachineFit[],
  lineOf: (fit: AgentMachineFit) => string,
): readonly Readonly<{ key: string; machines: readonly AgentMachineFit[] }>[] {
  const lines: { key: string; machines: AgentMachineFit[] }[] = [];
  const byReason = new Map<string, { key: string; machines: AgentMachineFit[] }>();
  for (const entry of fits) {
    const reason = `${entry.fit.kind}\u0000${entry.machine.offline ? 'away' : 'online'}\u0000${lineOf(entry)}`;
    const line = byReason.get(reason);
    if (line) { line.machines.push(entry); continue; }
    const created = { key: entry.machine.machineId, machines: [entry] };
    byReason.set(reason, created);
    lines.push(created);
  }
  // Names help only while they can be read: a handful of runnable Machines stay named, a fleet folds to its count.
  return lines.flatMap(line => line.machines[0]!.fit.kind !== 'cant_run' && line.machines.length <= NAMED_MACHINE_ROWS
    ? line.machines.map(entry => ({ key: entry.machine.machineId, machines: [entry] })) : [line]);
}

/**
 * The fit summary a row speaks: silent when a machine can run it (or there are no machines), "Unknown" when none can
 * and one hasn't published its platform, else "Can't run here" with the first machine's reason. Never assumed fit.
 */
export function summarizeAgentFit(
  fits: readonly AgentMachineFit[],
): AgentAddRowStatus | null {
  if (fits.length === 0 || fits.some(({ fit }) => fit.kind === 'can_run'))
    return null;
  if (fits.some(({ fit }) => fit.kind === 'unknown'))
    return { kind: 'unknown' };
  const first = fits.find(
    (
      entry,
    ): entry is AgentMachineFit & {
      fit: Extract<AcpPlatformFitV1, { kind: 'cant_run' }>;
    } => entry.fit.kind === 'cant_run',
  );
  return first
    ? { kind: 'cantRun', machineName: first.machine.name, fit: first.fit }
    : null;
}

/**
 * The Add an agent catalog as rows: Happier picks first as their own group, then each source in the order the
 * registries answered, each keeping its registry's order. One status per row, first match wins: the registry's own
 * problem, Built into Happier (by `acpRegistryIds`, never an id table), Added (a definition from this item), then fit
 * from the list's selected-distribution platform facts, without a detail fetch.
 */
export function buildAgentAddRows(
  input: Readonly<{
    items: readonly RegistryItemSummaryV1[];
    catalogEntries: readonly ResolvedAgentCatalogEntry[];
    definitions: readonly AcpBackendDefinitionV1[];
    machines: readonly AgentAddMachine[];
  }>,
): Readonly<{
  rows: readonly AgentAddRow[];
  groups: readonly AgentAddGroup[];
}> {
  const rows = input.items.map((summary): AgentAddRow => {
    const key = agentAddRowKey(summary);
    const pick =
      summary.sourceId === HAPPIER_PICKS_SOURCE_ID ||
      summary.flags?.pick === true;
    return { key, summary, pick, status: rowStatus(summary, input) };
  });
  const groups = new Map<
    string,
    { key: string; sourceId: string; pick: boolean; itemKeys: string[] }
  >();
  const picks = {
    key: 'picks',
    sourceId: HAPPIER_PICKS_SOURCE_ID,
    pick: true,
    itemKeys: [] as string[],
  };
  for (const row of rows) {
    if (row.pick) {
      picks.itemKeys.push(row.key);
      continue;
    }
    let group = groups.get(row.summary.sourceId);
    if (!group) {
      group = {
        key: `source:${row.summary.sourceId}`,
        sourceId: row.summary.sourceId,
        pick: false,
        itemKeys: [],
      };
      groups.set(row.summary.sourceId, group);
    }
    group.itemKeys.push(row.key);
  }
  return {
    rows,
    groups: [...(picks.itemKeys.length > 0 ? [picks] : []), ...groups.values()],
  };
}

function rowStatus(
  summary: RegistryItemSummaryV1,
  input: Parameters<typeof buildAgentAddRows>[0],
): AgentAddRowStatus | null {
  if (summary.problem) return { kind: 'problem', problem: summary.problem };
  if (summary.kind === 'agent') {
    const entry = resolveBuiltInAgentForRegistryId(
      input.catalogEntries,
      summary.itemId,
    );
    if (entry) return { kind: 'builtIn', entry };
  }
  const added = findAddedAgentDefinition(input.definitions, summary);
  if (added) return { kind: 'added', definitionId: added.id };
  const distributions = summary.agentDistribution;
  return distributions
    ? summarizeAgentFit(resolveAgentMachineFits(distributions, input.machines))
    : null;
}

/** A publisher as a name: registries sometimes append a contact address ("Augment Code <support@…>"). */
export function publisherName(name: string | undefined): string | undefined {
  return name?.replace(/\s*<[^>]*>\s*/g, ' ').trim() || undefined;
}
