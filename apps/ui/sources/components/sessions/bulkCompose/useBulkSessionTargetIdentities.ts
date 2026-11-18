import * as React from 'react';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';

import { getStorage } from '@/sync/domains/state/storageStore';
import { selectSessionDisplayNameSource } from '@/sync/store/hooks';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { buildBackendTargetKeyV2, BackendTargetRefV2Schema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { normalizeAgentCatalogId } from '@/agents/backendCatalog/agentCatalogProjection';
import { useAgentCatalogIdentities } from '@/agents/registry/useSessionAgentCatalogIdentity';

/**
 * The display name of each frozen target, for the To list. One narrow selector over the target ids only, so a
 * streaming target never renders the composer (P03 ruling 18:22Z: no whole Session subscriptions).
 */
export function useBulkSessionTargetNames(
  targets: readonly ActionSessionAddressV1[],
): readonly string[] {
  const store = getStorage();
  const selector = React.useMemo(() => {
    let previous: readonly string[] = [];
    return (state: ReturnType<typeof store.getState>) => {
      const names = targets.map((target) => {
        // The sidebar row when held, else the hydrated record: the one display-name source every surface reads.
        const source = selectSessionDisplayNameSource(state, target.sessionId, target.serverId);
        return source ? getSessionName(source, target.serverId) : target.sessionId;
      });
      previous = retainDeep(previous, names);
      return previous;
    };
  }, [store, targets]);
  return store(selector, {
    sessions: targets.map((target) => target.sessionId),
    sessionListRowsByServerId: [...new Set(targets.map((target) => target.serverId))],
  });
}

/**
 * Each target's Machine name, for the To list's "Codex · devbox". One selector over the targets' Machines only:
 * presence heartbeats re-run it, and the retained result keeps the composer from rendering.
 */
export function useBulkSessionMachineLabels(
  machines: readonly Readonly<{ serverId: string; machineId: string | null }>[],
): readonly (string | null)[] {
  const store = getStorage();
  const selector = React.useMemo(() => {
    let previous: readonly (string | null)[] = [];
    return (state: ReturnType<typeof store.getState>) => {
      const labels = machines.map(({ serverId, machineId }) =>
        machineId ? getSettledMachineDisplayName(resolveServerScopedMachine(state, serverId, machineId)) : null);
      previous = retainDeep(previous, labels);
      return previous;
    };
  }, [store, machines]);
  return store(selector, { machines: true, machineListByServerId: true, profileScope: true });
}

/** The id the Machine-scoped Agent catalog knows a target's Agent by (bundled, installed or contributed). */
export function resolveBulkTargetCatalogAgentId(agentTarget: AgentExecutionTargetV1 | null | undefined): string | null {
  if (!agentTarget) return null;
  const id = normalizeAgentCatalogId(buildBackendTargetKeyV2(agentTarget));
  return id.length > 0 ? id : null;
}

const NO_AGENT_IDS: readonly string[] = Object.freeze([]);

/**
 * Each target Agent's title from the Machine-scoped catalog (the same identities Session chrome and the
 * Discussion participant picker draw), so installed and contributed Agents keep their own names.
 */
export function useBulkSessionAgentTitles(
  targets: readonly Readonly<{ agentId: string | null; machineId: string | null }>[],
  serverId: string | null,
): ReadonlyMap<string, string> {
  const key = JSON.stringify(targets);
  // `key` stands for the targets' contents, so a new equal array keeps the catalog request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const request = React.useMemo(() => {
    const agentIds = [...new Set(targets.flatMap((target) => (target.agentId ? [target.agentId] : [])))];
    const byMachine = new Map<string, Set<string>>();
    for (const target of targets) {
      if (!target.agentId || !target.machineId) continue;
      const ids = byMachine.get(target.machineId) ?? new Set<string>();
      ids.add(target.agentId);
      byMachine.set(target.machineId, ids);
    }
    return {
      agentIds: agentIds.length > 0 ? agentIds : NO_AGENT_IDS,
      machines: [...byMachine].map(([machineId, ids]) => ({ machineId, agentIds: [...ids] })),
    };
  }, [key]);
  const identities = useAgentCatalogIdentities({
    agentIds: request.agentIds,
    machineId: null,
    serverId,
    machines: request.machines,
  });
  return React.useMemo(() => {
    const titles = new Map<string, string>();
    for (const identity of identities) {
      // Session chrome's rule: a backend-addressable identity names the Agent; configured instances never pick one.
      if (!BackendTargetRefV2Schema.safeParse({ kind: 'backend', backendId: identity.entry.agentId }).success) continue;
      if (!titles.has(identity.entry.agentId)) titles.set(identity.entry.agentId, identity.entry.title);
    }
    return titles;
  }, [identities]);
}
