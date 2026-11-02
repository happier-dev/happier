import { z } from 'zod/mini';
import { MachineReachabilityPostureV1Schema, MachineReachabilityObservationV1Schema,
  type MachineReachabilityPostureV1, type MachineReachabilityObservationV1 } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { AccessProviderSelectionV1Schema, accessProviderRefsEqualV1,
  type AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { readMachineMetadataFieldV1, readMachineMetadataSnapshotV1, type MachineMetadataFieldDefinitionV1,
  type MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { createReachabilityProviderHost } from './reachabilityProviderHost';

/** Typed observation refusal; the host phase owns whether effects preceded it. */
export class SelectedProfileRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}

export const reachabilityPostureField: MachineMetadataFieldDefinitionV1<MachineReachabilityPostureV1 | null> = {
  field: 'reachabilityPosture', storedSchema: z.nullable(MachineReachabilityPostureV1Schema),
  defaultValue: () => null, equal: sameStrictJsonValue,
};
export const accessProviderSelectionsField: MachineMetadataFieldDefinitionV1<AccessProviderSelectionV1[]> = {
  field: 'accessProviderSelections', storedSchema: z.array(AccessProviderSelectionV1Schema),
  defaultValue: () => [], equal: sameStrictJsonValue,
};
const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** The existing daemon field supplies history; no separate producer cache exists. */
export function projectMachineReachabilityObservation(previous: MachineReachabilityObservationV1 | undefined,
  candidate: MachineReachabilityObservationV1): MachineReachabilityObservationV1 {
  const ingress = candidate.ingress.map(capability => {
    const prior = previous?.ingress.find(entry => accessProviderRefsEqualV1(entry.provider, capability.provider));
    const { revision: _revision, ...facts } = capability;
    if (prior) {
      const { revision: _priorRevision, ...priorFacts } = prior;
      if (sameStrictJsonValue(priorFacts, facts)) return prior;
    }
    return { ...facts, revision: prior ? prior.revision + 1 : 0,
      inboundPorts: prior && sameStrictJsonValue(prior.inboundPorts, facts.inboundPorts) ? prior.inboundPorts : facts.inboundPorts,
      ...(facts.https ? { https: prior?.https && sameStrictJsonValue(prior.https, facts.https) ? prior.https : facts.https } : {}),
    };
  });
  const privateNetworks = candidate.privateNetworks.map(network => {
    const prior = previous?.privateNetworks.find(entry => accessProviderRefsEqualV1(entry.provider, network.provider));
    if (!prior) return network;
    if (sameStrictJsonValue(prior, network)) return prior;
    return { ...network,
      addresses: sameStrictJsonValue(prior.addresses, network.addresses) ? prior.addresses : network.addresses,
      sourceRanges: sameStrictJsonValue(prior.sourceRanges, network.sourceRanges) ? prior.sourceRanges : network.sourceRanges,
    };
  });
  const managementProviders = candidate.management.providers.map(provider => {
    const prior = previous?.management.providers.find(entry => accessProviderRefsEqualV1(entry.provider, provider.provider));
    return prior && sameStrictJsonValue(prior, provider) ? prior : provider;
  });
  const management = { ...candidate.management,
    providers: previous && sameStrictJsonValue(previous.management.providers, managementProviders)
      ? previous.management.providers : managementProviders,
  };
  const { revision: _candidateRevision, ...facts } = { ...candidate, ingress, privateNetworks, management };
  if (previous) {
    const { revision: _previousRevision, ...priorFacts } = previous;
    if (sameStrictJsonValue(priorFacts, facts)) return previous;
  }
  return { ...facts, revision: previous ? previous.revision + 1 : 0,
    management: previous && sameStrictJsonValue(previous.management, facts.management) ? previous.management : facts.management,
    privateNetworks: previous && sameStrictJsonValue(previous.privateNetworks, privateNetworks) ? previous.privateNetworks : privateNetworks,
    ingress: previous && sameStrictJsonValue(previous.ingress, ingress) ? previous.ingress : ingress,
  };
}

export async function readMachineReachabilityMetadata(port: MachineMetadataFieldPortV1) {
  const snapshot = await readMachineMetadataSnapshotV1(port);
  if (snapshot.status !== 'ready') return refuse(`machine_metadata_${snapshot.status}`);
  const posture = readMachineMetadataFieldV1(snapshot.metadata, reachabilityPostureField);
  const selections = readMachineMetadataFieldV1(snapshot.metadata, accessProviderSelectionsField);
  if (posture.status !== 'ready' || selections.status !== 'ready') return refuse('machine_reachability_metadata_invalid');
  return { metadataVersion: snapshot.metadataVersion, posture: posture.policy, selections: selections.policy };
}

/** Native membership remains a demanded fact; missing metadata invents no SSH state. */
export async function observeMachineReachability(input: Readonly<{
  state: Awaited<ReturnType<typeof readMachineReachabilityMetadata>>;
  providers: ReturnType<typeof createReachabilityProviderHost>;
  additionalSelection?: AccessProviderSelectionV1;
  isCurrent(): Promise<boolean>;
}>): Promise<MachineReachabilityObservationV1> {
  if (!await input.isCurrent()) return refuse('approval_stale');
  const management = input.state.posture?.management.providers ?? [];
  const priorDemand = [...input.state.selections, ...management];
  const additional = input.additionalSelection;
  const retainedDemand = additional && 'kind' in additional.provider ? priorDemand.filter(selection =>
    !accessProviderRefsEqualV1(selection.provider, additional.provider)) : priorDemand;
  const demanded = [...retainedDemand,
    ...(input.additionalSelection ? [input.additionalSelection] : [])]
    .filter((selection, index, all) => all.findIndex(candidate => sameStrictJsonValue(candidate, selection)) === index);
  const observed = await Promise.all(demanded.map(async selection => {
    const selected = input.providers.resolve(selection);
    const networkRequired = input.state.selections.some(candidate => sameStrictJsonValue(candidate, selection))
      || !!input.additionalSelection && sameStrictJsonValue(input.additionalSelection, selection)
      || selected.ok && selected.definition.capabilities.includes('privateNetwork');
    if (!selected.ok) return { selection, networkRequired, state: 'unavailable' as const, code: selected.errorCode };
    const outcome = await input.providers.invoke(selected.selection, 'inspect');
    if (!outcome.ok) {
      if (outcome.errorCode === 'plugin_exec_termination_incomplete') throw new PluginError({
        code: outcome.errorCode, message: 'Native process termination is incomplete', retryable: false,
      });
      if (input.additionalSelection && sameStrictJsonValue(input.additionalSelection, selection)) return refuse(outcome.errorCode);
      return { selection, networkRequired, state: 'unavailable' as const, code: outcome.errorCode };
    }
    if (outcome.result.kind === 'refused' && input.additionalSelection
      && sameStrictJsonValue(input.additionalSelection, selection)) throw new SelectedProfileRefusal(outcome.result.code);
    if (outcome.result.kind !== 'confirmed') return { selection, networkRequired, state: 'unknown' as const, code: outcome.result.code };
    const network = outcome.result.facts.privateNetwork;
    if (network && !accessProviderRefsEqualV1(network.provider, selected.selection.provider)) {
      return { selection, networkRequired, state: 'unknown' as const, code: 'invalid_action_output' };
    }
    return { selection, networkRequired, state: outcome.result.facts.state, ...(network ? { network } : {}) };
  }));
  if (!await input.isCurrent()) return refuse('approval_stale');
  const ingress: MachineReachabilityObservationV1['ingress'] = [];
  const ingressSelection = input.state.posture?.defaultServiceIngress;
  if (ingressSelection?.kind === 'provider') {
    const selected = input.providers.resolve(ingressSelection.selection, 'domainRoute');
    // Native Machine availability is demanded only for the selected default.
    // Plugin Domain roles retain their existing parent/occurrence owner.
    const native = selected.ok && selected.kind === 'builtin' ? await input.providers.invoke(selected.selection, 'inspect') : undefined;
    const outcome = native?.ok ? native.result : undefined;
    const code = native && !native.ok ? native.errorCode : outcome && outcome.kind !== 'confirmed' ? outcome.code : undefined;
    const state: MachineReachabilityObservationV1['ingress'][number]['state'] = !native ? 'unknown'
      : !native.ok ? 'unavailable' : outcome?.kind === 'confirmed'
        ? outcome.facts.state === 'stopped' ? 'needsSetup' : outcome.facts.state
        : code === 'needs_setup' ? 'needsSetup' : code === 'foreign_effect_conflict' ? 'conflict' : 'unavailable';
    const https = native ? outcome?.kind === 'confirmed' ? outcome.facts.ingress?.https : undefined : selected.ok ? selected.definition.https : undefined;
    if (selected.ok) ingress.push({ revision: 0,
      provider: selected.selection.provider, exposure: selected.definition.exposure,
      inboundPorts: selected.definition.inboundPorts,
      ...(https ? { https } : {}),
      // Availability is the native owner's fact, never proof of any Domain's route or health.
      state, ...(code ? { code } : {}), remedies: state === 'ready' ? [] : state === 'needsSetup' ? ['configure'] : ['inspect'],
    });
  }
  return MachineReachabilityObservationV1Schema.parse({ revision: 0,
    management: { daemon: 'ready', publicSsh: 'unknown', providers: management.map(selection => {
      const fact = observed.find(entry => sameStrictJsonValue(entry.selection, selection));
      return { provider: selection.provider, state: fact?.state ?? 'unknown', ...(fact && 'code' in fact ? { code: fact.code } : {}) };
    }) },
    // In a non-ready row, empty arrays carry no evidence, not an assertion
    // that the selected native network has no addresses or source ranges.
    privateNetworks: observed.flatMap(entry => 'network' in entry && entry.network ? [entry.network]
      : entry.networkRequired ? [{ provider: entry.selection.provider, networkIdentity: null, displayName: null,
        dnsName: null, addresses: [], interfaceName: null, sourceRanges: [], magicDnsEnabled: null,
        state: entry.state === 'ready' || entry.state === 'stopped' ? 'unknown' : entry.state,
      }] : []),
    ingress,
  });
}
