import * as React from 'react';
import type { MemorySearchScope } from '@happier-dev/protocol/memory/memorySearch';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { fetchDaemonMemoryDocumentSummary, type MemoryDocumentSummary } from '@/sync/domains/memory/fetchDaemonMemoryStatus';
import { useMemorySearchProvider } from '@/sync/domains/memory/useMemorySearchProvider';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

import type { MemoryDocumentSource } from './useMemoryDocument';

const UNAVAILABLE: MemoryDocumentSummary = { state: 'unavailable' };
const NOT_IN_USE: MemoryDocumentSummary = { state: 'unavailable', cause: { reason: 'not_in_use' } };
const NO_MACHINE_CHOSEN: MemoryDocumentSummary = { state: 'unavailable', cause: { reason: 'machine_not_chosen' } };
const DOCUMENTS = ['documents'] as const;
const GLOBAL_SCOPE = { type: 'global' } as const;

/** One cancellable read of the existing daemon admission owner, not a retained preparation. */
export function useMemoryDocumentSummary(params: Readonly<{
  source: MemoryDocumentSource;
  serverId: string;
  scope?: MemorySearchScope;
  /** Existing context rows changing invalidate the read even when the document revision does not. */
  preparationBasis?: string;
  enabled?: boolean;
  /**
   * False when this document's context entry is switched off. The daemon indexes only documents in use, so
   * there are no counts to read: nothing is asked of any Machine and the summary says so.
   */
  inUse?: boolean;
}>): MemoryDocumentSummary {
  const { source, serverId } = params;
  const view = source.view;
  const scope = params.scope ?? GLOBAL_SCOPE;
  const scopeKey = JSON.stringify(scope);
  const stableScope = React.useMemo(() => scope, [scopeKey]);
  const sessionId = stableScope.type === 'session' ? stableScope.sessionId : null;
  const originAccount = useActiveServerAccountScope(serverId);
  const custody = source.draftCustody;
  // A Session id belongs to its origin Home, even when its prepared document is foreign.
  // A document page instead uses the Account admitted by its qualified read.
  const account = sessionId ? originAccount : custody?.scope;
  const readable = params.enabled !== false && source.status === 'ready' && !source.stale && view !== null;
  const inUse = params.inUse !== false;
  const enabled = readable && inUse;
  const provider = useMemorySearchProvider({ kind: 'exact', serverId: account?.serverId ?? serverId },
    { enabled, corpora: DOCUMENTS, scope: stableScope });
  const target = provider.daemonTarget;
  const selectedTarget = provider.selectedDaemonTarget;
  // A chosen Machine that cannot answer is reported as itself; no choice for this Home is a different state.
  const machineChoiceNeeded = provider.machineChoiceNeeded === true;
  const unavailableMachine = React.useMemo<MemoryDocumentSummary>(() => machineChoiceNeeded
    ? NO_MACHINE_CHOSEN
    : selectedTarget && account && areServerProfileIdentifiersEquivalent(selectedTarget.serverId, account.serverId)
      ? { state: 'unavailable', cause: { reason: 'machine_unavailable', target: selectedTarget } }
      : UNAVAILABLE, [account, machineChoiceNeeded, selectedTarget]);
  // An admitted status operation follows its caller's lifetime and may not answer.
  // Unknown counts are unavailable now, not a promise that a loading row will finish.
  // Keep that same read alive so a late answer can still supply the counts.
  const awaitingStatus = React.useMemo<MemoryDocumentSummary>(() => target
    ? { state: 'unavailable', cause: { reason: 'status_pending', target } }
    : UNAVAILABLE, [target]);
  const key = JSON.stringify([account?.serverId, account?.accountId, target?.serverId, target?.machineId,
    custody?.key, custody?.scope.serverId, custody?.scope.accountId,
    view?.ref.kind, view?.ref.serverId, view?.ref.artifactId,
    view?.revision.headerVersion, view?.revision.bodyVersion,
    scopeKey, params.preparationBasis, source.status, source.stale]);
  // The read follows semantic identity, while equal replacement objects provide
  // the current operands without canceling and reissuing that same request.
  const readInputs = React.useRef({ account, awaitingStatus, custody, stableScope, target, view });
  readInputs.current = { account, awaitingStatus, custody, stableScope, target, view };
  const custodyCurrent = custody?.isCurrent() === true;
  const [loaded, setLoaded] = React.useState<Readonly<{ key: string; summary: MemoryDocumentSummary }> | null>(null);
  const countsKey = JSON.stringify([account?.serverId, account?.accountId, target?.serverId, target?.machineId, custody?.key,
    custody?.scope.serverId, custody?.scope.accountId, view?.ref.kind, view?.ref.serverId,
    view?.ref.artifactId, scopeKey, params.preparationBasis]);
  const lastKnownCounts = React.useRef<Readonly<{
    key: string; isCurrent: () => boolean; summary: Extract<MemoryDocumentSummary, { state: 'ready' }>;
  }> | null>(null);
  React.useEffect(() => {
    if (readable && custody?.isCurrent() && loaded?.key === key && loaded.summary.state === 'ready') {
      lastKnownCounts.current = { key: countsKey, isCurrent: custody.isCurrent, summary: loaded.summary };
    }
  }, [countsKey, custody?.isCurrent, custodyCurrent, key, loaded, readable]);
  // The producer's currentness predicate changes when the admitted lifetime is
  // replaced, even if the same Account and document are admitted again.
  React.useEffect(() => {
    const { account, awaitingStatus, custody, stableScope, target, view } = readInputs.current;
    if (!enabled || !view || !target || !account || custody?.isCurrent() !== true) return;
    const controller = new AbortController();
    setLoaded({ key, summary: awaitingStatus });
    void fetchDaemonMemoryDocumentSummary({ ...target, accountId: account.accountId,
      ref: view.ref, revision: view.revision, signal: controller.signal,
      scope: stableScope,
    }).then(summary => {
      if (!controller.signal.aborted && custody.isCurrent()) setLoaded({ key, summary: summary.state === 'pending'
        ? { state: 'unavailable', cause: { reason: 'coverage_pending', target } }
        : summary });
    }).catch((error: unknown) => {
      const errorCode = readRpcErrorCode(error);
      if (!controller.signal.aborted && custody.isCurrent()) setLoaded({ key, summary: { state: 'unavailable', cause: {
        reason: 'status_failed', target, ...(errorCode ? { errorCode } : {}),
      } } });
    });
    return () => controller.abort();
  }, [custody?.isCurrent, custodyCurrent, enabled, key]);
  if (!readable || !account || !custodyCurrent) return UNAVAILABLE;
  if (!inUse) return NOT_IN_USE;
  if (!target) return unavailableMachine;
  const summary = loaded?.key === key ? loaded.summary : awaitingStatus;
  const pending = summary.state === 'pending' || summary.state === 'unavailable'
    && (summary.cause?.reason === 'status_pending' || summary.cause?.reason === 'coverage_pending');
  return pending && lastKnownCounts.current?.key === countsKey && lastKnownCounts.current.isCurrent()
    ? lastKnownCounts.current.summary : summary;
}
