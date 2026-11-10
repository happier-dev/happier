import * as React from 'react';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { PileApplyResultV1, TrashEntryV1 } from '@happier-dev/protocol/storage/storageV1';

import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resolveApprovalReplayRoute } from '@/sync/ops/actions/approvalReplayRoute';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { executeMachineProcessesActionV1 } from '@/sync/domains/machines/processes/machineProcessesActions';
import { fetchMachineGuardViewViaAction } from '@/sync/domains/machines/guard/machineGuardRpc';
import { useTrashReceiptSources } from '@/sync/domains/machines/storage/useTrashReceiptSources';
import type { StoragePileBar } from '@/components/machines/storage/storagePileModel';
import { checkMachineStorageItemsViaAction } from '@/sync/domains/machines/storage/machineRpc';
import { MachineProcessesCheckResultV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import {
  readResourceProposalApproval,
  type ResourceProposalModel,
} from './readResourceProposalApproval';
import { runResourceProposalFromUi, startResourceProposalProcessAgain, type ResourceProposalLocalRun } from './resourceProposalRecovery';
import { useResourceProposalTrashActions, type ResourceProposalRestoreOutcomes } from './useResourceProposalTrashActions';
import {
  buildResourceProposalNarrowedInput,
  resourceProposalApprovedKeys,
  resolveResourceProposalOutcomes,
  deriveResourceProposalDisplay,
  describeResourceProposalRows,
  initialResourceProposalSelection,
  resourceProposalDeclinedOperands,
  resourceProposalSelectedBytes,
  selectAllSafeResourceProposal,
  toggleResourceProposalSelectAll,
  readResourceProposalPileResult,
  deriveResourceProposalTrashReceipt,
  resourceProposalDisplayWithTrashReceipt,
  resourceProposalTrashBytes,
  type ResourceProposalTrashReceipt,
  type ResourceProposalCheck,
  type ResourceProposalDisplay,
  type ResourceProposalItemFacts,
  type ResourceProposalOutcome,
  type ResourceProposalRow,
} from './resourceProposalPresentation';

/** The decision operands the card hands to the one approval decision handler. */
export type ResourceProposalDecisionOptions = Readonly<{
  narrowedInput?: unknown;
  /** Items the person turned down, remembered by the storage owner after the decision lands. */
  declinedItems?: readonly Readonly<Record<string, unknown>>[];
}>;

export type ResourceProposalController = Readonly<{
  model: ResourceProposalModel;
  rows: readonly ResourceProposalRow[];
  check: ResourceProposalCheck;
  display: ResourceProposalDisplay;
  /** The items the approval actually carried into execution (the person's narrowed set). */
  approvedKeys: ReadonlySet<string>;
  selectedCount: number;
  selectedBytes: number;
  /** Approval stays withheld at zero, while the first check runs, and while the facts are stale. */
  approveWithheld: boolean;
  toggle: (key: string) => void;
  confirmKeep: (key: string) => void;
  toggleAll: () => void;
  selectAllSafe: () => void;
  checkAgain: () => void;
  decisionOptions: (
    decision: 'approve' | 'reject',
    choice?: Readonly<{ keepUndo?: boolean }>,
  ) => ResourceProposalDecisionOptions;
  emptyNow: (() => Promise<boolean>) | null;
  undo: (() => Promise<boolean>) | null;
  /** Already checked remaining Trash entries, for naming a refused restore without another read. */
  restoreEntries: readonly TrashEntryV1[];
  restoreOutcomes: ResourceProposalRestoreOutcomes;
  putBackBeside: ((entryId: string) => Promise<boolean>) | null;
  /** The declined request is shown again for a UI run; the request itself stays rejected. */
  reopened: boolean;
  /** Declined: show the items again (re-checked), without changing the rejected request. */
  reopen: (() => void) | null;
  /** Reopened: run the same Action from the UI as a new invocation. */
  runFromUi: (() => Promise<boolean>) | null;
  /** After a run: invoke the Action again for one skipped item. */
  retryItem: ((key: string) => Promise<boolean>) | null;
  retried: ReadonlyMap<string, ResourceProposalOutcome>;
  /** After a stop: the process owner's Start again. */
  startAgain: ((key: string) => Promise<boolean>) | null;
  startedAgain: ReadonlySet<string>;
  /** One receipt per retry that moved something: its own batch, with Undo and Empty now. */
  retryReceipts: readonly ResourceProposalRetryReceipt[];
}>;

type CheckClients = Readonly<{
  serverId: string | null;
  signal: AbortSignal;
}>;

async function checkStorage(
  model: ResourceProposalModel,
  clients: CheckClients,
): Promise<ReadonlyMap<string, ResourceProposalItemFacts> | null> {
  // The check takes the served references (item id + path); the daemon resolves identity afresh.
  const refs = model.items.map((item) => ({ itemId: item.key, path: item.path }));
  const result = await checkMachineStorageItemsViaAction({
    machineId: model.machineId,
    ...(clients.serverId ? { serverId: clients.serverId } : {}),
    refs,
    signal: clients.signal,
  });
  if (!result.ok) return null;
  const facts = new Map<string, ResourceProposalItemFacts>();
  for (const item of result.value.items) {
    const claim = model.items.find(
      (candidate) => candidate.key === item.ref.itemId,
    );
    if (!claim) continue;
    facts.set(claim.key, {
      key: claim.key,
      status: 'present',
      verdict: item.verdict,
      reason: item.reason,
      expect: item.expect,
      bytes: item.size.freesBytes,
      onDiskBytes:
        item.size.allocatedBytes > item.size.freesBytes
          ? item.size.allocatedBytes
          : null,
      loses: item.loses ?? [],
      // Verdict is current guidance; only changed review facts require another check (R41).
      changed: item.expect !== claim.operand.expect,
    });
  }
  for (const staying of result.value.staying) {
    const claim = model.items.find(
      (candidate) => candidate.key === staying.item.itemId,
    );
    if (!claim || facts.has(claim.key)) continue;
    facts.set(claim.key, {
      key: claim.key,
      status: staying.reason.code === 'missing' ? 'gone' : 'refused',
      verdict: claim.claimedVerdict,
      reason: staying.reason,
      expect: claim.operand.expect,
      bytes: null,
      onDiskBytes: null,
      loses: [],
      changed: true,
    });
  }
  for (const claim of model.items) {
    if (facts.has(claim.key)) continue;
    facts.set(claim.key, {
      key: claim.key,
      status: 'gone',
      verdict: claim.claimedVerdict,
      reason: null,
      expect: claim.operand.expect,
      bytes: null,
      onDiskBytes: null,
      loses: [],
      changed: true,
    });
  }
  return facts;
}

async function checkProcesses(
  model: ResourceProposalModel,
  clients: CheckClients,
): Promise<ReadonlyMap<string, ResourceProposalItemFacts> | null> {
  if (!clients.serverId) return null;
  const account = await captureLazyActionAccountContext(
    clients.serverId,
    clients.signal,
  );
  try {
    const outcome = await executeMachineProcessesActionV1(
      'machines.processes.check',
      {
        machineId: model.machineId,
        serverId: clients.serverId,
        refs: model.items.map((item) => item.key),
      },
      {
        serverId: clients.serverId,
        expectedAccountId: account.accountId,
        signal: clients.signal,
      },
    );
    if (!outcome.ok) return null;
    const parsed = MachineProcessesCheckResultV1Schema.safeParse(
      outcome.result,
    );
    if (!parsed.success) return null;
    const guard = await fetchMachineGuardViewViaAction({
      machineId: model.machineId, serverId: clients.serverId,
      expectedAccountId: account.accountId, signal: clients.signal,
    });
    if (!guard.ok) return null;
    const facts = new Map<string, ResourceProposalItemFacts>();
    for (const claim of model.items) {
      const check = parsed.data.checks.find(
        (candidate) => candidate.ref === claim.key,
      );
      const claimedLevel = model.actionId === 'machines.processes.leftBehind.cleanUp' ? 'left_behind' : (
        claim.operand.expect as { level?: unknown } | undefined
      )?.level;
      const present = Boolean(check?.present && check.identityEqual);
      const keptByGuard = guard.value.ladder.excluded.find(entry =>
        entry.kind === 'session' && entry.processRef === claim.key);
      facts.set(claim.key, {
        key: claim.key,
        status: present ? 'present' : 'gone',
        verdict:
          keptByGuard ? 'keep' : check?.level === 'proven' || check?.level === 'left_behind'
            ? 'safe'
            : check?.level === 'likely'
              ? 'caution'
              : claim.claimedVerdict,
        reason: null,
        expect: model.actionId === 'machines.processes.leftBehind.cleanUp' ? undefined : check?.level
          ? {
              level: check.level,
              ...(check.owner ? { owner: check.owner } : {}),
            }
          : claim.operand.expect,
        bytes: check?.memoryBytes ?? null,
        onDiskBytes: null,
        loses: [],
        ...(keptByGuard ? { keptByGuard } : {}),
        ...(check && present ? { process: { row: check.row, owner: check.owner, level: check.level } } : {}),
        changed: !present || check?.level !== claimedLevel,
      });
    }
    return facts;
  } finally {
    account.dispose();
  }
}

/**
 * The proposal card's state (plan 60 AGW-6/7/8): one batched safe check on view and on Check again
 * (no timer), the card-local ticks that become the approval's narrowing operand (never pile
 * membership), and the receipt's ways back. No persisted state of its own.
 */
export function useResourceProposalCheck(
  approval: ApprovalRequest | null,
  serverIdHint: string | null,
  artifactId?: string,
): ResourceProposalController | null {
  const model = React.useMemo(
    () => (approval ? readResourceProposalApproval(approval) : null),
    [approval],
  );
  const serverProfilesGeneration = useServerProfilesGeneration();
  // The creator's local profile id is immutable history, not this client's
  // route. Checks and decisions share the approval's captured Home authority.
  const serverId = React.useMemo(() => approval?.v === 2
    ? resolveApprovalReplayRoute(approval)?.serverId ?? null
    : model?.serverId ?? serverIdHint,
  [approval, model?.serverId, serverIdHint, serverProfilesGeneration]);
  const isOpen = approval?.status === 'open';
  const [check, setCheck] = React.useState<ResourceProposalCheck>(
    () =>
      ({
        kind: isOpen ? 'checking' : 'unavailable',
        previous: null,
      }) as ResourceProposalCheck,
  );
  const [selection, setSelection] = React.useState<ReadonlySet<string>>(() =>
    model ? initialResourceProposalSelection(model) : new Set(),
  );
  // The person's own ticks, by item key. Current facts and approval refreshes re-derive the defaults;
  // they never overwrite what the person chose (an untick made while the check ran survives it).
  const explicitRef = React.useRef<{ approvalId: string | null; choices: Map<string, boolean> }>({
    approvalId: artifactId ?? null,
    choices: new Map(),
  });
  const withExplicitChoices = React.useCallback(
    (defaults: ReadonlySet<string>): ReadonlySet<string> => {
      if (!model) return defaults;
      const selected = new Set(defaults);
      for (const item of model.items) {
        const choice = explicitRef.current.choices.get(item.key);
        if (choice === true) selected.add(item.key);
        else if (choice === false) selected.delete(item.key);
      }
      return selected;
    },
    [model],
  );
  const [confirmedKeep, setConfirmedKeep] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [reopened, setReopened] = React.useState(false);
  const [localRun, setLocalRun] = React.useState<ResourceProposalLocalRun | null>(null);
  const localRunRef = React.useRef(localRun);
  localRunRef.current = localRun;
  const [retried, setRetried] = React.useState<ReadonlyMap<string, ResourceProposalOutcome>>(() => new Map());
  const [localRetryReceipts, setRetryReceipts] = React.useState<readonly RetryReceiptState[]>([]);
  const storedRetryResults = approval?.v === 2 ? approval.storageRetryResults : undefined;
  const retryReceipts = React.useMemo(() => [...new Map([
    ...(storedRetryResults ?? []).map(result => [result.batchId, { result }] as const),
    ...localRetryReceipts.map(receipt => [receipt.result.batchId, receipt] as const),
  ]).values()], [storedRetryResults, localRetryReceipts]);
  const retriedOutcomes = React.useMemo(() => {
    const outcomes = new Map(retried);
    for (const receipt of retryReceipts) {
      for (const [key, value] of readRetriedOutcomes({ kind: 'trashed', result: receipt.result },
        new Set(receipt.result.outcomes.map(outcome => outcome.itemId)))) outcomes.set(key, value);
    }
    return outcomes;
  }, [retried, retryReceipts]);
  const [startedAgain, setStartedAgain] = React.useState<ReadonlySet<string>>(() => new Set());
  const runRef = React.useRef<AbortController | null>(null);
  const pileResult = React.useMemo(() => model?.kind === 'storage' && approval?.status === 'executed'
    ? readResourceProposalPileResult(approval.execution?.result) : null,
  [model?.kind, approval?.status, approval?.execution?.result]);
  const receiptResults = React.useMemo(() => [
    ...(localRun?.kind === 'trashed' ? [localRun.result] : pileResult ? [pileResult] : []),
    ...retryReceipts.map(receipt => receipt.result),
  ].filter(result => result.mode === 'trash'), [localRun, pileResult, retryReceipts]);
  const receiptScope = React.useMemo(() => model?.kind === 'storage' && receiptResults.length > 0 && serverId
    ? { machineId: model.machineId, serverId,
      expectedAccountId: approval?.v === 2 ? approval.executionOriginV1.accountId : undefined } : null,
  [model?.kind, model?.machineId, receiptResults.length, serverId, approval?.v, approval?.v === 2 ? approval.executionOriginV1.accountId : null]);
  const receiptSources = useTrashReceiptSources(receiptScope, approval);
  const [trashReceipts, setTrashReceipts] = React.useState<ReadonlyMap<string, ResourceProposalTrashReceipt>>(() => new Map());
  const trashActions = useResourceProposalTrashActions(receiptSources.scope, trashReceipts, setTrashReceipts);
  React.useEffect(() => {
    if (!model || receiptResults.length === 0) return;
    // Reopening refreshes the approval snapshot: retry failed reads, not settled outcomes.
    // A retry also adds its own receipt without overwriting earlier settled batches.
    const pendingResults = receiptResults.filter(result => !trashReceipts.has(result.batchId)
      || trashReceipts.get(result.batchId)?.kind === 'checking'
      || trashReceipts.get(result.batchId)?.kind === 'unavailable');
    if (pendingResults.length === 0) return;
    if (receiptScope && !receiptSources.unavailable && !receiptSources.ready) {
      const missing = pendingResults.filter(result => !trashReceipts.has(result.batchId));
      if (missing.length) setTrashReceipts(current => new Map([...current,
        ...missing.map(result => [result.batchId, { kind: 'checking' } as ResourceProposalTrashReceipt] as const)]));
      return;
    }
    const { entries, activity } = receiptSources;
    setTrashReceipts(current => new Map([...current, ...pendingResults.map(result => [result.batchId,
      receiptScope && !receiptSources.unavailable && entries && activity
        ? deriveResourceProposalTrashReceipt(result, entries, activity)
        : { kind: 'unavailable' } as ResourceProposalTrashReceipt] as const)]));
  }, [model?.machineId, serverId, receiptResults, receiptScope, receiptSources.ready,
    receiptSources.unavailable, receiptSources.entries, receiptSources.activity]);

  const runCheck = React.useCallback(
    (acknowledged: boolean) => {
      if (!model) return;
      runRef.current?.abort();
      const controller = new AbortController();
      runRef.current = controller;
      const previousFacts = new Map(rowsRef.current.map(row => [row.item.key, row.facts]));
      setCheck((previous) => ({
        kind: 'checking',
        previous:
          previous.kind === 'ready'
            ? previous.facts
            : previous.kind === 'checking'
              ? previous.previous
              : null,
      }));
      const read = model.kind === 'storage' ? checkStorage : checkProcesses;
      void read(model, { serverId, signal: controller.signal }).then(
        (facts) => {
          if (controller.signal.aborted) return;
          setCheck(
            facts
              ? { kind: 'ready', facts, checkedAt: Date.now(), acknowledged }
              : { kind: 'unavailable' },
          );
          if (facts) {
            // Confirmation names a current loss. A different owner/work state needs fresh consent.
            setConfirmedKeep(current => new Set([...current].filter(key => {
              const before = previousFacts.get(key);
              const after = facts.get(key);
              if (!before || !after || after.status !== 'present' || after.verdict !== 'keep') return false;
              return before.verdict === after.verdict
                && JSON.stringify(before.expect) === JSON.stringify(after.expect)
                && JSON.stringify(before.reason) === JSON.stringify(after.reason)
                && JSON.stringify(before.loses) === JSON.stringify(after.loses)
                && before.keptByGuard?.ref === after.keptByGuard?.ref
                && before.keptByGuard?.label === after.keptByGuard?.label
                && before.keptByGuard?.reason === after.keptByGuard?.reason;
            })));
            // A changed item keeps its tick only while it is still something the person can approve.
            setSelection(
              (current) => {
                // Current facts own the first defaults, including when an agent's Safe
                // claim became Caution. Explicit rechecks preserve the person's choices.
                const selected = !acknowledged
                  ? [...withExplicitChoices(initialResourceProposalSelection(model, facts))]
                  : [...current];
                return new Set(
                  selected.filter((key) => {
                    const fact = facts.get(key);
                    return (
                      !fact ||
                      (fact.status === 'present' &&
                        fact.verdict !== 'forbidden' &&
                        fact.verdict !== 'check')
                    );
                  }),
                );
              },
            );
          }
        },
        () => {
          if (!controller.signal.aborted) setCheck({ kind: 'unavailable' });
        },
      );
    },
    [model, serverId, withExplicitChoices],
  );

  React.useEffect(() => {
    if (isOpen) {
      const approvalId = artifactId ?? null;
      if (explicitRef.current.approvalId !== approvalId) explicitRef.current = { approvalId, choices: new Map() };
      setSelection(model ? withExplicitChoices(initialResourceProposalSelection(model)) : new Set());
      setConfirmedKeep(new Set());
      runCheck(false);
    }
    return () => runRef.current?.abort();
  }, [isOpen, artifactId, model, runCheck, withExplicitChoices]);

  const rows = React.useMemo(
    () =>
      model
        ? describeResourceProposalRows(model, check, selection, confirmedKeep)
        : [],
    [check, confirmedKeep, model, selection],
  );
  const selectionRef = React.useRef(selection);
  selectionRef.current = selection;
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  /** Every selection the person makes goes through here, so each row's explicit choice is remembered. */
  const chooseSelection = React.useCallback((next: ReadonlySet<string>, keys: readonly string[]) => {
    for (const key of keys) explicitRef.current.choices.set(key, next.has(key));
    setSelection(next);
  }, []);
  const toggle = React.useCallback((key: string) => {
    const next = new Set(selectionRef.current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selectionRef.current = next;
    chooseSelection(next, [key]);
  }, [chooseSelection]);
  const confirmKeep = React.useCallback((key: string) => {
    setConfirmedKeep((current) => new Set(current).add(key));
    const next = new Set(selectionRef.current).add(key);
    selectionRef.current = next;
    chooseSelection(next, [key]);
  }, [chooseSelection]);
  const toggleAll = React.useCallback(
    () => chooseSelection(toggleResourceProposalSelectAll(rowsRef.current),
      rowsRef.current.filter((row) => row.selectable && !row.needsConfirm).map((row) => row.item.key)),
    [chooseSelection],
  );
  const selectAllSafe = React.useCallback(
    () => chooseSelection(selectAllSafeResourceProposal(rowsRef.current),
      rowsRef.current.filter((row) => row.selectable).map((row) => row.item.key)),
    [chooseSelection],
  );
  const checkAgain = React.useCallback(() => runCheck(true), [runCheck]);
  const decisionOptions = React.useCallback(
    (
      decision: 'approve' | 'reject',
      choice?: Readonly<{ keepUndo?: boolean }>,
    ): ResourceProposalDecisionOptions => {
      if (!model) return {};
      const declinedItems =
        model.kind === 'storage'
          ? resourceProposalDeclinedOperands(rowsRef.current, decision)
          : undefined;
      if (decision === 'reject') return { declinedItems };
      const narrowedInput = buildResourceProposalNarrowedInput(
        model,
        rowsRef.current,
        choice,
      );
      return { ...(narrowedInput ? { narrowedInput } : {}), declinedItems };
    },
    [model],
  );

  if (!approval || !model) return null;
  const settledDeclined = approval.status === 'rejected' || approval.status === 'canceled';
  let display: ResourceProposalDisplay;
  if (localRun?.kind === 'trashed') display = localRun.result.mode === 'delete'
    ? { kind: 'emptied', count: localRun.result.outcomes.filter(outcome => outcome.status === 'deleted').length,
      freedBytes: localRun.result.freedBytes, result: localRun.result }
    : { kind: 'trashed', result: localRun.result };
  else if (localRun?.kind === 'stopped') display = { kind: 'stopped', result: localRun.result };
  // Reopen (AGW-8): the declined request stays rejected; the person reviews it again and runs it here.
  else if (reopened && settledDeclined) display = { kind: 'ask', stale: false, checking: check.kind === 'checking' };
  else display = deriveResourceProposalDisplay(approval, model, check);
  if (display.kind === 'trashed') display = resourceProposalDisplayWithTrashReceipt(display.result,
    trashReceipts.get(display.result.batchId) ?? { kind: 'checking' });
  const selectedCount = rows.filter((row) => row.selected).length;
  const approvedKeys = localRun ? new Set(rows.filter((row) => row.selected).map((row) => row.item.key)) : resourceProposalApprovedKeys(approval, model);
  const retryKeys = new Set([...(resolveResourceProposalOutcomes(display, approvedKeys) ?? [])]
    .filter(([key, outcome]) => (retriedOutcomes.get(key) ?? outcome).status === 'skipped')
    .map(([key]) => key));
  const stale = display.kind === 'ask' && display.stale;
  const approveWithheld = selectedCount === 0 || stale || check.kind !== 'ready';
  const runFromUi = async (keys: ReadonlySet<string> | null): Promise<boolean> => {
    let selectedRows = rowsRef.current.filter((row) => row.selected);
    if (keys) {
      const retryModel = { ...model, items: model.items.filter(item => keys.has(item.key) && retryKeys.has(item.key)) };
      if (retryModel.items.length === 0) return false;
      runRef.current?.abort();
      const controller = new AbortController();
      runRef.current = controller;
      // A settled receipt has no live check on remount (Delete now has no claimed verdict).
      // Refresh only the selected original operands before narrowing a new UI Action invocation.
      const read = model.kind === 'storage' ? checkStorage : checkProcesses;
      const facts = await read(retryModel, { serverId, signal: controller.signal }).catch(() => null);
      if (!facts || controller.signal.aborted) return false;
      selectedRows = describeResourceProposalRows(retryModel,
        { kind: 'ready', facts, checkedAt: Date.now(), acknowledged: true }, keys, confirmedKeep)
        .filter(row => row.selectable);
    }
    const input = buildResourceProposalNarrowedInput(model, selectedRows.map((row) => ({ ...row, selected: true })));
    if (!input) return false;
    const outcome = await runResourceProposalFromUi(model, input, serverId,
      keys && localRunRef.current === null && artifactId && approval.v === 2 && approval.status === 'executed'
        ? { artifactId, approval } : undefined);
    if (!outcome) return false;
    if (keys && localRunRef.current === null) {
      // A retried item reports beside the original receipt; the receipt's totals stay the real ones.
      setRetried((current) => new Map([...current, ...readRetriedOutcomes(outcome, keys)]));
      // Its own receipt, from that retry's settled result (its own Trash batch, Undo and Empty now).
      if (outcome.kind === 'trashed' && outcome.result.mode === 'trash') setRetryReceipts((current) => [...current, { result: outcome.result }]);
      return true;
    }
    setLocalRun(outcome);
    return true;
  };
  const endedKeys = display.kind === 'stopped'
    ? display.result.outcomes.filter((outcome) => outcome.outcome === 'ended').map((outcome) => outcome.ref) : [];
  return {
    model,
    approvedKeys,
    rows,
    check,
    display,
    selectedCount,
    selectedBytes: resourceProposalSelectedBytes(rows),
    approveWithheld,
    toggle,
    confirmKeep,
    toggleAll,
    selectAllSafe,
    checkAgain,
    decisionOptions,
    reopened: reopened && settledDeclined && !localRun,
    reopen: settledDeclined && !reopened ? () => { setReopened(true); runCheck(true); } : null,
    runFromUi: reopened && settledDeclined && !localRun && !approveWithheld ? () => runFromUi(null) : null,
    retryItem: retryKeys.size > 0
      ? (key: string) => runFromUi(new Set([key])) : null,
    retried: retriedOutcomes,
    startAgain: model.actionId === 'machines.processes.stop' && endedKeys.length > 0 && serverId
      ? async (key: string) => {
          const started = await startResourceProposalProcessAgain(model.machineId, key, serverId);
          if (started) setStartedAgain((current) => new Set(current).add(key));
          return started;
        }
      : null,
    startedAgain,
    retryReceipts: retryReceipts.map((receipt): ResourceProposalRetryReceipt => {
      const current = trashReceipts.get(receipt.result.batchId);
      const display = resourceProposalDisplayWithTrashReceipt(receipt.result, current ?? { kind: 'checking' });
      const acted = receipt.result.outcomes.filter((outcome) => outcome.status === 'moved' || outcome.status === 'deleted').length;
      return {
        batchId: receipt.result.batchId,
        restored: display.kind === 'restored',
        bar: display.kind === 'emptied'
          ? { kind: 'freed', count: display.count, freedBytes: display.freedBytes }
          : current?.kind === 'ready' && current.remaining.length > 0
          ? { kind: 'held', batchId: receipt.result.batchId, count: current.remaining.length,
            inTrashBytes: resourceProposalTrashBytes(receipt.result, current),
            notActed: receipt.result.outcomes.length - acted, emptiesAt: null }
          : { kind: 'hidden' },
        ...trashActions.forResult(receipt.result),
      };
    }),
    ...(display.kind === 'trashed' ? trashActions.forResult(display.result) : { undo: null, emptyNow: null, putBackBeside: null, restoreEntries: [] }),
    restoreOutcomes: trashActions.restoreOutcomes,
  };
}

function readRetriedOutcomes(run: ResourceProposalLocalRun, keys: ReadonlySet<string>): Map<string, ResourceProposalOutcome> {
  const out = new Map<string, ResourceProposalOutcome>();
  if (run.kind === 'trashed') {
    for (const outcome of run.result.outcomes) {
      if (!keys.has(outcome.itemId)) continue;
      out.set(outcome.itemId, { status: outcome.status === 'moved' || outcome.status === 'deleted' ? 'done' : 'skipped', reasonCode: outcome.reason?.code ?? null });
    }
  } else {
    for (const outcome of run.result.outcomes) {
      if (!keys.has(outcome.ref)) continue;
      out.set(outcome.ref, { status: outcome.outcome === 'ended' || outcome.outcome === 'gone_before' ? 'done' : 'skipped', reasonCode: outcome.reasonCode ?? null });
    }
  }
  return out;
}

type RetryReceiptState = Readonly<{ result: PileApplyResultV1 }>;

export type ResourceProposalRetryReceipt = Readonly<{
  batchId: string;
  restored: boolean;
  bar: StoragePileBar;
  undo: (() => Promise<boolean>) | null;
  restoreEntries: readonly TrashEntryV1[];
  restoreOutcomes: ResourceProposalRestoreOutcomes;
  putBackBeside: ((entryId: string) => Promise<boolean>) | null;
  emptyNow: (() => Promise<boolean>) | null;
}>;
