import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { MachineGuardLadderV1 } from '@happier-dev/protocol/machines/guard/guardViewV1';
import {
  MachineProcessesActionResultV1Schema,
  MachineProcessesCleanUpResultV1Schema,
  type MachineProcessesActionResultV1,
  type MachineProcessesCheckResultV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import {
  PileApplyResultStoredV1Schema,
  type PileApplyResultV1,
  type TrashEntryV1,
  type StorageReasonV1,
} from '@happier-dev/protocol/storage/storageV1';
import type { MachineGuardActivityRowV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { storageVerdictStartsTicked } from '@/sync/domains/machines/storage/storageVerdictSelection';
import { isStorageTrashReceiptSettled, storageTrashReceiptBytes, type StorageTrashReceipt } from '@/sync/domains/machines/storage/trashReceipt';

import type {
  ResourceProposalItem,
  ResourceProposalModel,
  ResourceProposalVerdict,
} from './readResourceProposalApproval';

/** What the owner's safe check Action says about one item right now (AGW-7). */
export type ResourceProposalItemFacts = Readonly<{
  key: string;
  status: 'present' | 'gone' | 'refused';
  verdict: ResourceProposalVerdict;
  reason: StorageReasonV1 | null;
  /** The current expectation; approval submits it in place of the proposal's. */
  expect: unknown;
  /** What removing it gives back (counted once), or the memory it holds. */
  bytes: number | null;
  /** On disk when that is more than it gives back ("7.1 GB of 9.8 GB on disk"). */
  onDiskBytes: number | null;
  loses: readonly StorageReasonV1[];
  /** The canonical planner's reason this proposed session is kept, not a proposal-side heuristic. */
  keptByGuard?: MachineGuardLadderV1['excluded'][number];
  /**
   * Processes: what the same check saw of the work and its owner, for naming the row. Display only;
   * the key, operand and approval never read it. Absent for an older daemon or a gone/refused target.
   */
  process?: Readonly<Pick<MachineProcessesCheckResultV1['checks'][number], 'row' | 'owner' | 'level'>>;
  /** Reviewed identity/ownership facts changed, or the item is gone/refused; verdict alone is guidance. */
  changed: boolean;
}>;

export type ResourceProposalCheck =
  | Readonly<{
      kind: 'checking';
      previous: ReadonlyMap<string, ResourceProposalItemFacts> | null;
    }>
  | Readonly<{
      kind: 'ready';
      facts: ReadonlyMap<string, ResourceProposalItemFacts>;
      checkedAt: number;
      /** The person asked to check again and is looking at the refreshed facts. */
      acknowledged: boolean;
    }>
  | Readonly<{ kind: 'unavailable' }>;

export type ResourceProposalRow = Readonly<{
  item: ResourceProposalItem;
  facts: ResourceProposalItemFacts | null;
  verdict: ResourceProposalVerdict;
  reason: StorageReasonV1 | null;
  /** Forbidden, gone or refused items have no checkbox and never join. */
  selectable: boolean;
  /** A Keep item is tickable once the person has read what is lost (R42.1). */
  needsConfirm: boolean;
  selected: boolean;
}>;

export type ResourceProposalSelection = ReadonlySet<string>;

function selectableVerdict(verdict: ResourceProposalVerdict): boolean {
  return verdict === 'safe' || verdict === 'caution' || verdict === 'keep';
}

/** Safe items start ticked, Caution and Keep unticked: a default selection, the person's to change. */
export function initialResourceProposalSelection(
  model: ResourceProposalModel,
  facts?: ReadonlyMap<string, ResourceProposalItemFacts>,
): ResourceProposalSelection {
  return new Set(
    model.items
      .filter((item) => {
        const current = facts?.get(item.key);
        return (facts === undefined || current?.status === 'present')
          && storageVerdictStartsTicked(current?.verdict ?? item.claimedVerdict);
      })
      .map((item) => item.key),
  );
}

export function readResourceProposalCheckFacts(
  check: ResourceProposalCheck,
): ReadonlyMap<string, ResourceProposalItemFacts> | null {
  if (check.kind === 'ready') return check.facts;
  if (check.kind === 'checking') return check.previous;
  return null;
}

export function describeResourceProposalRows(
  model: ResourceProposalModel,
  check: ResourceProposalCheck,
  selection: ResourceProposalSelection,
  confirmedKeep: ReadonlySet<string>,
): readonly ResourceProposalRow[] {
  const facts = readResourceProposalCheckFacts(check);
  return model.items.map((item) => {
    const current = facts?.get(item.key) ?? null;
    const verdict = current?.verdict ?? item.claimedVerdict;
    const selectable =
      (current?.status ?? 'present') === 'present' &&
      selectableVerdict(verdict);
    const needsConfirm =
      selectable && verdict === 'keep' && !confirmedKeep.has(item.key);
    return {
      item,
      facts: current,
      verdict,
      reason: current?.reason ?? item.reason,
      selectable,
      needsConfirm,
      selected: selectable && !needsConfirm && selection.has(item.key),
    };
  });
}

export function resourceProposalSelectAllState(
  rows: readonly ResourceProposalRow[],
): 'checked' | 'unchecked' | 'mixed' {
  const open = rows.filter((row) => row.selectable && !row.needsConfirm);
  const selected = open.filter((row) => row.selected).length;
  if (selected === 0) return 'unchecked';
  return selected === open.length ? 'checked' : 'mixed';
}

/** Select all, or clear when everything tickable is already ticked; Keep items still need their confirm. */
export function toggleResourceProposalSelectAll(
  rows: readonly ResourceProposalRow[],
): ResourceProposalSelection {
  const open = rows.filter((row) => row.selectable && !row.needsConfirm);
  return resourceProposalSelectAllState(rows) === 'checked'
    ? new Set()
    : new Set(open.map((row) => row.item.key));
}

export function selectAllSafeResourceProposal(
  rows: readonly ResourceProposalRow[],
): ResourceProposalSelection {
  return new Set(
    rows
      .filter((row) => row.selectable && storageVerdictStartsTicked(row.verdict))
      .map((row) => row.item.key),
  );
}

export function resourceProposalSelectedBytes(
  rows: readonly ResourceProposalRow[],
): number {
  return rows.reduce(
    (sum, row) => sum + (row.selected ? (row.facts?.bytes ?? 0) : 0),
    0,
  );
}

/** Facts differ from the claim and the person has not checked again since: not approvable. */
export function isResourceProposalStale(check: ResourceProposalCheck): boolean {
  return (
    check.kind === 'ready' &&
    !check.acknowledged &&
    [...check.facts.values()].some((fact) => fact.changed)
  );
}

export function resourceProposalChangedCount(
  check: ResourceProposalCheck,
): number {
  const facts = readResourceProposalCheckFacts(check);
  return facts ? [...facts.values()].filter((fact) => fact.changed).length : 0;
}

function refreshed(
  row: ResourceProposalRow,
): Readonly<Record<string, unknown>> {
  return row.facts && row.facts.expect !== undefined
    ? { ...row.item.operand, expect: row.facts.expect }
    : row.item.operand;
}

/**
 * The approval's narrowing operand (AGW-5): the kept items, each with its refreshed expectation, and
 * `emptyAfter` dropped when the person chose to keep Undo. Never adds anything; `null` at zero.
 */
export function buildResourceProposalNarrowedInput(
  model: ResourceProposalModel,
  rows: readonly ResourceProposalRow[],
  options: Readonly<{ keepUndo?: boolean }> = {},
): Readonly<Record<string, unknown>> | null {
  const kept = rows.filter((row) => row.selected).map(refreshed);
  if (kept.length === 0) return null;
  const path = model.kind === 'storage' ? 'items' : model.actionId === 'machines.processes.leftBehind.cleanUp' ? 'refs' : 'targets';
  const next: Record<string, unknown> = { ...model.args, [path]: path === 'refs' ? kept.map(item => item.ref) : kept };
  if (model.emptyAfter && options.keepUndo) next.emptyAfter = false;
  return next;
}

export type ResourceProposalDeclineInput = Readonly<{
  machineId: string;
  serverId?: string;
  items: readonly Readonly<{ ref: unknown; expect: string }>[];
}>;

/**
 * What the person turned down, remembered through `machines.storage.suggestions.decline` (STO-31):
 * every item on Not now, original minus narrowed on a subset approval. Storage proposals only.
 */
export function resolveResourceProposalDeclines(
  model: ResourceProposalModel | null,
  decision: 'approve' | 'reject' | 'cancel',
  narrowedInput: unknown,
  declined?: readonly Readonly<Record<string, unknown>>[],
): ResourceProposalDeclineInput | null {
  if (!model || model.kind !== 'storage' || decision === 'cancel') return null;
  let items: readonly Readonly<Record<string, unknown>>[];
  if (declined) {
    items = declined;
  } else if (decision === 'reject') {
    items = model.items.map((item) => item.operand);
  } else {
    const keptItems =
      narrowedInput &&
      typeof narrowedInput === 'object' &&
      'items' in narrowedInput &&
      Array.isArray(narrowedInput.items)
        ? (narrowedInput.items as readonly Readonly<Record<string, unknown>>[])
        : null;
    if (!keptItems) return null;
    const kept = new Set(keptItems.map((item) => readItemId(item.ref)));
    items = model.items
      .filter((item) => !kept.has(item.key))
      .map((item) => item.operand);
  }
  const out = items.flatMap((item) =>
    typeof item.expect === 'string'
      ? [{ ref: item.ref, expect: item.expect }]
      : [],
  );
  return out.length === 0
    ? null
    : {
        machineId: model.machineId,
        ...(model.serverId ? { serverId: model.serverId } : {}),
        items: out,
      };
}

function readItemId(ref: unknown): string | null {
  return ref &&
    typeof ref === 'object' &&
    'itemId' in ref &&
    typeof ref.itemId === 'string'
    ? ref.itemId
    : null;
}

/** The turned-down rows as decline operands, with the facts the person was looking at. */
export function resourceProposalDeclinedOperands(
  rows: readonly ResourceProposalRow[],
  decision: 'approve' | 'reject',
): readonly Readonly<Record<string, unknown>>[] {
  return rows
    .filter((row) => decision === 'reject' || !row.selected)
    .filter((row) => (row.facts?.status ?? 'present') === 'present')
    .map(refreshed);
}

// ── Display state (A7): approval lifecycle plus canonical Trash/Activity receipts ──

export type ResourceProposalDisplay =
  | Readonly<{ kind: 'ask'; stale: boolean; checking: boolean }>
  | Readonly<{ kind: 'executing'; count: number; bytes: number }>
  | Readonly<{ kind: 'trashed'; result: PileApplyResultV1; receipt?: ResourceProposalTrashReceipt }>
  | Readonly<{ kind: 'emptied'; count: number; freedBytes: number; result?: PileApplyResultV1 }>
  | Readonly<{ kind: 'stopped'; result: MachineProcessesActionResultV1 }>
  | Readonly<{ kind: 'declined' }>
  /** Undo put every moved item back; nothing was removed. The settled result stays: skipped operands are still unresolved work. */
  | Readonly<{ kind: 'restored'; result: PileApplyResultV1 }>
  | Readonly<{ kind: 'failed'; error: string | null }>;

function readExecutionResult<T>(
  raw: unknown,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): T | null {
  const direct = parse(raw);
  if (direct.success) return direct.data;
  if (raw && typeof raw === 'object' && 'result' in raw) {
    const nested = parse(raw.result);
    if (nested.success) return nested.data;
  }
  return null;
}

export function readResourceProposalPileResult(raw: unknown): PileApplyResultV1 | null {
  return readExecutionResult(raw, value => PileApplyResultStoredV1Schema.safeParse(value));
}

export type ResourceProposalTrashReceipt =
  | Readonly<{ kind: 'checking' }>
  | Readonly<{ kind: 'unavailable' }>
  | (Readonly<{ kind: 'ready' }> & StorageTrashReceipt<TrashEntryV1>);

/** Missing manifests are not proof of deletion: only the Trash owner's settled Activity receipts are. */
export function deriveResourceProposalTrashReceipt(result: PileApplyResultV1, entries: readonly TrashEntryV1[],
  activity: readonly MachineGuardActivityRowV1[]): ResourceProposalTrashReceipt {
  const ids = result.trashEntryIds ? new Set(result.trashEntryIds) : null;
  const remaining = entries.filter(entry => entry.batchId === result.batchId && (!ids || ids.has(entry.entryId)));
  const present = new Set(remaining.map(entry => entry.entryId));
  const movedCount = result.outcomes.filter(outcome => outcome.status === 'moved').length;
  let deletedCount = ids ? Math.max(0, movedCount - ids.size) : 0;
  let restoredCount = 0;
  let freedBytes = result.freedBytes;
  // trashStore owns these durable ids; Activity projects restored move receipts with undoneAt.
  for (const entryId of ids ?? []) {
    if (present.has(entryId)) continue;
    const emptied = activity.find(row => row.id === `${entryId}-trash_emptied` && row.kind === 'trash_emptied'
      && row.outcome === 'done' && row.freedBytes !== undefined);
    const moved = activity.find(row => row.id === `${entryId}-trash_moved` && row.kind === 'trash_moved'
      && row.outcome === 'done' && row.undoneAt !== undefined);
    if (emptied && !moved) { deletedCount += 1; freedBytes += emptied.freedBytes!; }
    else if (moved && !emptied) restoredCount += 1;
  }
  return { kind: 'ready', remaining, deletedCount, restoredCount,
    unknownCount: Math.max(0, movedCount - remaining.length - deletedCount - restoredCount), freedBytes };
}

export function resourceProposalDisplayWithTrashReceipt(result: PileApplyResultV1,
  receipt: ResourceProposalTrashReceipt): ResourceProposalDisplay {
  if (receipt.kind === 'ready' && isStorageTrashReceiptSettled(receipt)) {
    if (receipt.deletedCount > 0 && receipt.restoredCount === 0) return {
      kind: 'emptied', count: receipt.deletedCount, freedBytes: receipt.freedBytes, result,
    };
    if (receipt.restoredCount > 0 && receipt.deletedCount === 0) return { kind: 'restored', result };
  }
  return { kind: 'trashed', result, receipt };
}

/** Per-entry allocations can overlap; only the unchanged full receipt proves their union. */
export function resourceProposalTrashBytes(result: PileApplyResultV1,
  receipt: Extract<ResourceProposalTrashReceipt, { kind: 'ready' }>): number | null {
  return storageTrashReceiptBytes(result, receipt);
}

/** Items the approval actually carried into execution: the person's narrowed set, else the request. */
export function resourceProposalApprovedKeys(
  approval: ApprovalRequest,
  model: ResourceProposalModel,
): ReadonlySet<string> {
  const narrowed =
    approval.v === 2 && approval.decision?.kind === 'approve'
      ? approval.decision.narrowedInput
      : undefined;
  const path = model.kind === 'storage' ? 'items' : model.actionId === 'machines.processes.leftBehind.cleanUp' ? 'refs' : 'targets';
  if (narrowed && typeof narrowed === 'object' && !Array.isArray(narrowed)) {
    const list = (narrowed as Record<string, unknown>)[path];
    if (Array.isArray(list)) {
      return new Set(
        list.flatMap((entry) => {
          if (path === 'refs') return typeof entry === 'string' ? [entry] : [];
          if (!entry || typeof entry !== 'object') return [];
          const record = entry as Record<string, unknown>;
          const key =
            model.kind === 'storage'
              ? readItemId(record.ref)
              : typeof record.ref === 'string'
                ? record.ref
                : null;
          return key ? [key] : [];
        }),
      );
    }
  }
  return new Set(model.items.map((item) => item.key));
}

export function deriveResourceProposalDisplay(
  approval: ApprovalRequest,
  model: ResourceProposalModel,
  check: ResourceProposalCheck,
): ResourceProposalDisplay {
  switch (approval.status) {
    case 'open':
      return {
        kind: 'ask',
        stale: isResourceProposalStale(check),
        checking: check.kind === 'checking',
      };
    case 'approved':
    case 'executing': {
      const keys = resourceProposalApprovedKeys(approval, model);
      const facts = readResourceProposalCheckFacts(check);
      const bytes = [...keys].reduce(
        (sum, key) => sum + (facts?.get(key)?.bytes ?? 0),
        0,
      );
      return { kind: 'executing', count: keys.size, bytes };
    }
    case 'executed': {
      if (model.kind === 'processes') {
        const result = readResourceProposalProcessResult(model, approval.execution?.result);
        return result
          ? { kind: 'stopped', result }
          : { kind: 'failed', error: null };
      }
      const result = readResourceProposalPileResult(approval.execution?.result);
      if (!result) return { kind: 'failed', error: null };
      // "Freed" only when it is true: deleted outright, or the Trash was emptied (R25).
      if (
        result.mode === 'delete' ||
        (result.inTrashBytes === 0 && result.freedBytes > 0)
      ) {
        const acted = result.outcomes.filter(
          (outcome) =>
            outcome.status === 'deleted' || outcome.status === 'moved',
        ).length;
        return { kind: 'emptied', count: acted, freedBytes: result.freedBytes, result };
      }
      return { kind: 'trashed', result };
    }
    case 'rejected':
    case 'canceled':
      return { kind: 'declined' };
    case 'failed':
      return {
        kind: 'failed',
        error:
          approval.execution?.error ?? approval.execution?.errorCode ?? null,
      };
    default:
      return { kind: 'failed', error: null };
  }
}

/** Cleanup reports ended/skipped sets; adapt them once to the shared process receipt's outcomes. */
export function readResourceProposalProcessResult(model: ResourceProposalModel, raw: unknown): MachineProcessesActionResultV1 | null {
  if (model.actionId !== 'machines.processes.leftBehind.cleanUp') {
    return readExecutionResult(raw, value => MachineProcessesActionResultV1Schema.safeParse(value));
  }
  const result = readExecutionResult(raw, value => MachineProcessesCleanUpResultV1Schema.safeParse(value));
  return result ? {
    status: result.skipped.length > 0 ? 'partial' : 'ended',
    outcomes: [
      ...result.ended.map(item => ({ ref: item.ref, outcome: 'ended' as const, freedBytes: item.freedBytes })),
      ...result.skipped.map(item => ({ ref: item.ref, outcome: 'refused' as const, reasonCode: item.reason })),
    ],
  } : null;
}

/** Per-item outcome of a settled run: moved or ended, skipped with its reason, or not attempted. */
export type ResourceProposalOutcome = Readonly<{
  status: 'done' | 'skipped' | 'not_approved';
  reasonCode: string | null;
}>;

export function resolveResourceProposalOutcomes(
  display: ResourceProposalDisplay,
  approvedKeys: ReadonlySet<string>,
): ReadonlyMap<string, ResourceProposalOutcome> | null {
  const storageResult = display.kind === 'trashed' || display.kind === 'emptied' || display.kind === 'restored' ? display.result : null;
  if (storageResult) {
    return new Map(
      storageResult.outcomes.map((outcome) => [
        outcome.itemId,
        {
          status:
            outcome.status === 'moved' || outcome.status === 'deleted'
              ? ('done' as const)
              : ('skipped' as const),
          reasonCode: outcome.reason?.code ?? null,
        },
      ]),
    );
  }
  if (display.kind === 'stopped') {
    return new Map(
      display.result.outcomes.map((outcome) => [
        outcome.ref,
        {
          status:
            outcome.outcome === 'ended' || outcome.outcome === 'gone_before'
              ? ('done' as const)
              : ('skipped' as const),
          reasonCode: outcome.reasonCode ?? null,
        },
      ]),
    );
  }
  if (display.kind === 'emptied') {
    return new Map(
      [...approvedKeys].map((key) => [
        key,
        { status: 'done' as const, reasonCode: null },
      ]),
    );
  }
  return null;
}

/**
 * The guard planner's kept rows for a stop proposal (AGW-9): joined to the proposal's targets by the
 * census process identity both carry, so one process is never listed as both proposed and kept.
 */
export function selectGuardKeptForProposal<T extends Readonly<{ ref: string; processRef?: string }>>(
  excluded: readonly T[],
  proposedRefs: ReadonlySet<string>,
): readonly T[] {
  return excluded.filter((entry) => !entry.processRef || !proposedRefs.has(entry.processRef));
}
