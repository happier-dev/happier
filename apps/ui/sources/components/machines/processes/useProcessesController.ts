import * as React from 'react';
import { ActionApprovalRequestCreatedResultSchema, isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  MachineProcessesActionResultV1Schema,
  MachineProcessesCheckResultV1Schema,
  MachineProcessesCleanUpResultV1Schema,
  MachineProcessesGetResultV1Schema,
  MachineProcessesStartAgainResultV1Schema,
  type MachineProcessesAnswerV1,
  type MachineProcessTargetV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
  executeMachineProcessesActionV1,
  executeMachineProcessesLeftBehindCleanUpV1,
  executeMachineProcessesStartAgainV1,
  type MachineProcessesActionScope,
} from '@/sync/domains/machines/processes/machineProcessesActions';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { showLeftBehindReview } from './LeftBehindReview';
import { describeEndedOwner } from './processOwnerIdentity';
import {
  showProcessConfirmDialog,
  type ProcessConfirmContent,
  type ProcessConfirmFact,
  type ProcessRecheck,
} from './ProcessConfirmDialog';
import {
  describeProcessesItemTitle,
  formatProcessCpu,
  formatProcessMemory,
} from './processesCollectionAnatomy';
import { PROCESS_ROW_EXIT_MS, PROCESSES_MOTION } from './processesMotion';
import type {
  ProcessesItem,
  ProcessesLeftBehindItem,
  ProcessesOwnerItem,
} from './processesPresentation';

/** What the memory tile says under its meter: the preview while a Stop is pointed at, then what was freed. */
export type ProcessesMeterNote =
  | Readonly<{ kind: 'preview'; bytes: number }>
  | Readonly<{
      kind: 'freed';
      bytes: number | null;
      name: string;
      startAgain: (() => void) | null;
    }>;

export type ProcessesController = Readonly<{
  /** The tab cannot act (offline, stale, a recipient): menus say why instead. */
  unavailableReason: string | null;
  leaving: ReadonlySet<string>;
  hidden: ReadonlySet<string>;
  /** Why a row came back ("It didn't stop"), drawn in its status word. */
  notes: ReadonlyMap<string, string>;
  /** Memory the meter already shows as given back, until the next sample measures it. */
  pendingFreedBytes: number;
  meterNote: ProcessesMeterNote | null;
  previewStop(bytes: number | null): void;
  stop(item: ProcessesOwnerItem, confirmation?: MachineProcessesActionScope['confirmation']): void;
  killProcess(
    item: Extract<
      ProcessesItem,
      { kind: 'process' | 'leftBehind' | 'appMember' }
    >,
  ): void;
  killTree(item: ProcessesOwnerItem): void;
  cleanUp(items: readonly ProcessesLeftBehindItem[]): void;
  openSession(sessionId: string): void;
  copy(text: string): void;
  /** The row's name as the tree shows it (menus and dialogs name the thing). */
  titleOf(item: ProcessesItem): string;
}>;

export const ProcessesControllerContext =
  React.createContext<ProcessesController | null>(null);

type ControllerInput = Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
  answer: MachineProcessesAnswerV1 | null;
  titles: ReadonlyMap<string, string>;
  expectedAccountId: string | null;
  isCurrent: () => boolean;
  unavailableReason: string | null;
  /** Move keyboard focus to the row after the one that left (never to the page body). */
  focusAfter(key: string): void;
}>;

const PLATFORM_NAMES = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
} as const;

function durationSince(startedAtMs: number): string {
  return formatRelativeTimeShort(startedAtMs, Date.now());
}

function readActionResult<T>(
  outcome: Awaited<ReturnType<typeof executeMachineProcessesActionV1>>,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): Readonly<
  { kind: 'ok'; value: T } | { kind: 'approval' } | { kind: 'declined' } | { kind: 'failed' }
> {
  if (!outcome.ok) return { kind: isActionApprovalDeclinedErrorCode(outcome.errorCode) || outcome.errorCode === 'cancelled' ? 'declined' : 'failed' };
  if (
    ActionApprovalRequestCreatedResultSchema.safeParse(outcome.result).success
  )
    return { kind: 'approval' };
  const parsed = parse(outcome.result);
  return parsed.success
    ? { kind: 'ok', value: parsed.data }
    : { kind: 'failed' };
}

/**
 * The tab's one controller for what a person does to rows (plan 30 PROC-18, R16): Stop is gentle and
 * immediate with Start again; Kill asks; anything not proven is re-checked when confirmed. Every effect is
 * the canonical `machines.processes.*` Action — approval is that Action's own policy (R41), never this UI's.
 */
export function useProcessesController(
  input: ControllerInput,
): ProcessesController {
  const reducedMotion = useReducedMotionPreference();
  const navigateToSession = useNavigateToSession();
  const writeClipboard = useClipboardWrite(input.serverId);
  const [leaving, setLeaving] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [notes, setNotes] = React.useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [pendingFreedBytes, setPendingFreed] = React.useState(0);
  const [meterNote, setMeterNote] = React.useState<ProcessesMeterNote | null>(
    null,
  );
  const latest = React.useRef(input);
  latest.current = input;

  // A newer answer measures what was freed: the meter stops borrowing the optimistic amount.
  const capturedAt = input.answer?.capturedAtMs ?? null;
  const settledAt = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (
      capturedAt !== null &&
      settledAt.current !== null &&
      capturedAt > settledAt.current
    ) {
      settledAt.current = null;
      setPendingFreed(0);
      setHidden(new Set());
    }
  }, [capturedAt]);

  const captureTarget = React.useCallback(() => {
    const { machineId, serverId, expectedAccountId } = latest.current;
    if (!expectedAccountId) return null;
    const actionScope = { serverId, expectedAccountId };
    const isCurrent = () => latest.current.isCurrent() && latest.current.machineId === machineId
      && latest.current.serverId === serverId && latest.current.expectedAccountId === expectedAccountId;
    return { machineId, actionScope, isCurrent };
  }, []);

  const add = (set: ReadonlySet<string>, key: string) => new Set([...set, key]);
  const remove = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set);
    next.delete(key);
    return next;
  };

  /** The row lets go: it fades, its height closes, then it is gone; reduced motion removes it at once. */
  const leave = React.useCallback(
    (key: string, delayMs = 0) => {
      latest.current.focusAfter(key);
      if (reducedMotion) {
        setHidden((current) => add(current, key));
        return;
      }
      setTimeout(() => {
        setLeaving((current) => add(current, key));
        setTimeout(() => {
          setHidden((current) => add(current, key));
          setLeaving((current) => remove(current, key));
        }, PROCESS_ROW_EXIT_MS);
      }, delayMs);
    },
    [reducedMotion],
  );

  const comeBack = React.useCallback((key: string, note: string) => {
    setLeaving((current) => remove(current, key));
    setHidden((current) => remove(current, key));
    setNotes((current) => new Map(current).set(key, note));
  }, []);

  const previewStop = React.useCallback((bytes: number | null) => {
    setMeterNote((current) =>
      bytes === null || bytes <= 0
        ? current?.kind === 'preview'
          ? null
          : current
        : { kind: 'preview', bytes },
    );
  }, []);

  const startAgain = React.useCallback(
    (ref: string, name: string) => {
      const captured = captureTarget();
      if (!captured) return;
      const { machineId, actionScope, isCurrent } = captured;
      setMeterNote(null);
      fireAndForget(
        (async () => {
          const outcome = await executeMachineProcessesStartAgainV1(
            { machineId, ref },
            actionScope,
            {
              runtimeActionExecute: createFrontDoorRuntimeActionExecutor(),
              isCurrent,
            },
          );
          if (!isCurrent()) return;
          const result = readActionResult(outcome.processAction, (value) =>
            MachineProcessesStartAgainResultV1Schema.safeParse(value),
          );
          if (result.kind === 'declined') return;
          const started =
            result.kind === 'ok' &&
            (result.value.status === 'started' ||
              outcome.serviceStartResponse !== undefined);
          const wakes =
            result.kind === 'ok' &&
            result.value.status === 'already_wakes_on_next_message';
          publishPresentationNotice({
            key: `machine-processes:start-again:${ref}`,
            severity: started || wakes ? 'info' : 'error',
            message: started
              ? t('machineProcesses.results.startedAgain', { name })
              : wakes
                ? t('machineProcesses.results.resumesOnMessage')
                : result.kind === 'approval'
                  ? t('machineProcesses.results.approvalPending')
                  : resolveActionExecutionErrorMessage(outcome.processAction, t('machineProcesses.results.startAgainFailed', { name })),
          });
        })(),
        { tag: 'MachineProcesses.startAgain' },
      );
    },
    [captureTarget],
  );

  const runStop = React.useCallback(
    (item: ProcessesOwnerItem, confirmation?: MachineProcessesActionScope['confirmation']) => {
      const captured = captureTarget();
      if (!item.rootRef || !captured || latest.current.unavailableReason) return;
      const { machineId, actionScope, isCurrent } = captured;
      const name = describeProcessesItemTitle(item, latest.current.titles);
      const optimistic = item.memoryBytes ?? 0;
      setMeterNote(null);
      setNotes((current) => {
        const next = new Map(current);
        next.delete(item.key);
        return next;
      });
      const target: MachineProcessTargetV1 = {
        ref: item.rootRef,
        expect: { level: item.rootLevel, owner: item.owner.owner },
      };
      fireAndForget(
        (async () => {
          const outcome = await executeMachineProcessesActionV1(
            'machines.processes.stop',
            { machineId, targets: [target] },
            { ...actionScope, confirmation },
          );
          if (!isCurrent()) return;
          const result = readActionResult(outcome, (value) =>
            MachineProcessesActionResultV1Schema.safeParse(value),
          );
          const first =
            result.kind === 'ok' ? result.value.outcomes[0] : undefined;
          if (first?.outcome === 'ended' || first?.outcome === 'gone_before') {
            const freed = first.freedBytes ?? null;
            leave(item.key);
            // The freed amount is the measured drop, never the row's last number.
            setPendingFreed(
              (current) => current + (freed ?? optimistic),
            );
            settledAt.current = Date.now();
            setMeterNote({
              kind: 'freed',
              bytes: freed,
              name,
              startAgain: item.owner.canStartAgain === true
                ? () => startAgain(item.rootRef!, name)
                : null,
            });
            return;
          }
          if (result.kind === 'declined') return;
          const note =
            result.kind === 'approval'
              ? t('machineProcesses.results.approvalPending')
              : first?.outcome === 'survived'
                ? t('machineProcesses.results.survived', { name })
                : resolveActionExecutionErrorMessage(outcome, t('machineProcesses.results.failedReason'));
          comeBack(item.key, note);
        })(),
        { tag: 'MachineProcesses.stop' },
      );
    },
    [captureTarget, comeBack, leave, startAgain],
  );

  /**
   * Guest identity belongs to the shared policy's confirmation content; a waiver also applies to guest work.
   */
  const stop = React.useCallback(
    (item: ProcessesOwnerItem, confirmation?: MachineProcessesActionScope['confirmation']) => {
      if (!item.rootRef || latest.current.unavailableReason) return;
      const requester = item.owner.requester;
      if (!requester) {
        runStop(item, confirmation);
        return;
      }
      const name = describeProcessesItemTitle(item, latest.current.titles);
      runStop(item, async () => (await showProcessConfirmDialog({
          testID: 'machine-processes-stop-guest',
          title: t('machineProcesses.stopGuest.title', { name }),
          paragraphs: [t('machineProcesses.kill.guest', { name: requester.displayName })],
          facts: [],
          confirmLabel: t('machineProcesses.stopGuest.confirm'),
        })) === 'confirm');
    },
    [runStop],
  );

  const recheck = React.useCallback(
    (ref: string): (() => Promise<ProcessRecheck>) =>
      async () => {
        const captured = captureTarget();
        if (!captured)
          return {
            kind: 'blocked',
            line: t('machineProcesses.kill.recheckedChanged'),
          };
        const { machineId, actionScope } = captured;
        const [outcome, detail] = await Promise.all([executeMachineProcessesActionV1(
          'machines.processes.check',
          { machineId, refs: [ref] },
          actionScope,
        ),
        executeMachineProcessesActionV1('machines.processes.get', { machineId, ref }, actionScope),
      ]);
        const result = readActionResult(outcome, (value) =>
          MachineProcessesCheckResultV1Schema.safeParse(value),
        );
        const check = result.kind === 'ok' ? result.value.checks.find((entry) => entry.ref === ref) : undefined;
        if (!check) {
          const fallback = t('common.requestFailed');
          return { kind: 'blocked', line: outcome.ok ? fallback : resolveActionExecutionErrorMessage(outcome, fallback) };
        }
        const fresh = readActionResult(detail, (value) => MachineProcessesGetResultV1Schema.safeParse(value));
        const freshRow = fresh.kind === 'ok' && fresh.value.row && 'level' in fresh.value.row ? fresh.value.row : null;
        const met = freshRow?.evidence?.find((entry) => entry.state === 'met');
        const evidence = met ? { title: t(`machineProcesses.detail.evidence.${met.kind}`), detail: t(`machineProcesses.detail.reasons.${met.reason}`) } : null;
        if (!check.present)
          return {
            kind: 'blocked',
            line: t('machineProcesses.kill.recheckedGone'),
          };
        if (!check.identityEqual)
          return {
            kind: 'blocked',
            line: t('machineProcesses.kill.recheckedChanged'),
          };
        const row =
          latest.current.answer?.owners
            .flatMap((owner) => owner.members)
            .find((member) => member.ref === ref) ??
          latest.current.answer?.leftBehind.find(
            (member) => member.ref === ref,
          );
        return {
      kind: 'same',
      evidence,
      line: t('machineProcesses.kill.rechecked', {
            time: row ? formatAsOfTime(row.startedAtMs) : '',
          }),
        };
      },
    [captureTarget],
  );

  const runKill = React.useCallback(
    (
      key: string,
      name: string,
      target: MachineProcessTargetV1,
      tree: boolean,
      count: number,
      content: ProcessConfirmContent,
      alternative?: () => void,
    ) => {
      const captured = captureTarget();
      if (!captured) return;
      const { machineId, actionScope, isCurrent } = captured;
      fireAndForget(
        (async () => {
          // Identity and evidence remain required input validation even when approval is waived.
          const checked = await content.recheck?.();
          if (!isCurrent()) return;
          if (checked?.kind === 'blocked') {
            publishPresentationNotice({ key: `machine-processes:kill:${key}`, severity: 'warning', message: checked.line });
            return;
          }
          const outcome = await executeMachineProcessesActionV1(
            'machines.processes.kill',
            { machineId, targets: [target], tree },
            { ...actionScope, confirmation: async () => {
              if (!isCurrent()) return false;
              const decision = await showProcessConfirmDialog({ ...content,
                ...(checked ? { recheck: async () => checked } : {}) });
              if (!isCurrent()) return false;
              if (decision === 'alternative') alternative?.();
              return decision === 'confirm';
            } },
          );
          if (!isCurrent()) return;
          const result = readActionResult(outcome, (value) =>
            MachineProcessesActionResultV1Schema.safeParse(value),
          );
          const first =
            result.kind === 'ok' ? result.value.outcomes[0] : undefined;
          if (result.kind === 'declined') return;
          if (first?.outcome === 'ended' || first?.outcome === 'gone_before') {
            leave(key);
            setPendingFreed((current) => current + (first.freedBytes ?? 0));
            settledAt.current = Date.now();
            publishPresentationNotice({
              key: `machine-processes:kill:${key}`,
              severity: 'info',
              message: tree
                ? t('machineProcesses.results.endedTree', { name, count })
                : t('machineProcesses.results.ended', { name }),
            });
            return;
          }
          publishPresentationNotice({
            key: `machine-processes:kill:${key}`,
            severity: result.kind === 'approval' ? 'info' : 'warning',
            message:
              result.kind === 'approval'
                ? t('machineProcesses.results.approvalPending')
                : first?.outcome === 'survived'
                  ? t('machineProcesses.results.survived', { name })
                  : resolveActionExecutionErrorMessage(outcome, t('machineProcesses.results.refused', { name })),
          });
        })(),
        { tag: 'MachineProcesses.kill' },
      );
    },
    [captureTarget, leave],
  );

  const killProcess = React.useCallback(
    (
      item: Extract<
        ProcessesItem,
        { kind: 'process' | 'leftBehind' | 'appMember' }
      >,
    ) => {
      if (latest.current.unavailableReason) return;
      const { titles, answer } = latest.current;
      const name = describeProcessesItemTitle(item, titles);
      const using: ProcessConfirmFact = {
        label: t('machineProcesses.kill.facts.using'),
        value: t('machineProcesses.kill.usingValue', {
          memory: formatProcessMemory(item.memoryBytes),
          cpu: formatProcessCpu(item.cpuPercent).replace('%', ''),
        }),
      };
      if (item.kind === 'appMember') {
        runKill(item.key, name, { ref: item.row.ref, expect: { level: 'not_happier' } }, false, 1, {
            testID: 'machine-processes-kill-not-happier',
            title: t('machineProcesses.kill.processTitle', { name }),
            paragraphs: [
              t('machineProcesses.kill.notHappierBody', {
                app: item.row.appGroup,
              }),
              t('machineProcesses.kill.neverOnItsOwn'),
            ],
            facts: [
              {
                label: t('machineProcesses.kill.facts.app'),
                value: item.row.appGroup,
              },
              using,
            ],
            recheck: recheck(item.row.ref),
            confirmLabel: t('machineProcesses.kill.confirmProcess'),
        });
        return;
      }
      const row = item.row;
      const owner = item.kind === 'process' ? item.owner : null;
      const ownerRef =
        item.kind === 'leftBehind' ? item.row.owner : item.owner.owner;
      const ownerTitle = owner
        ? (titles.get(owner.rowId) ?? '')
        : describeEndedOwner(ownerRef);
      const proven = row.level === 'proven';
      const facts: ProcessConfirmFact[] = [
        ...(row.command
          ? [
              {
                label: t('machineProcesses.kill.facts.command'),
                value: row.command,
                mono: true,
              },
            ]
          : []),
        ...(!proven && row.cwd
          ? [
              {
                label: t('machineProcesses.kill.facts.folder'),
                value: row.cwd,
                mono: true,
              },
            ]
          : []),
        using,
        ...(proven
          ? [
              {
                label: t('machineProcesses.kill.facts.running'),
                value: t('machineProcesses.kill.runningSince', {
                  time: formatAsOfTime(row.startedAtMs),
                  duration: durationSince(row.startedAtMs),
                }),
              },
            ]
          : []),
      ];
      const met = row.evidence?.find((entry) => entry.state === 'met');
      const paragraphs = [
        proven
          ? t('machineProcesses.kill.processBody', { owner: ownerTitle })
          : row.level === 'left_behind'
            ? t('machineProcesses.kill.leftBehindBody')
            : t('machineProcesses.kill.likelyBody', {
                owner: ownerTitle,
                platform: PLATFORM_NAMES[answer?.platform ?? 'darwin'],
              }),
        ...(owner?.requester
          ? [
              t('machineProcesses.kill.guest', {
                name: owner.requester.displayName,
              }),
            ]
          : []),
      ];
      runKill(item.key, name, { ref: row.ref, expect: { level: row.level, owner: ownerRef } }, false, 1, {
          testID: proven
            ? 'machine-processes-kill-process'
            : 'machine-processes-kill-ask-first',
          title: t('machineProcesses.kill.processTitle', { name }),
          paragraphs,
          facts,
          evidence: met
            ? {
                title: t(`machineProcesses.detail.evidence.${met.kind}`),
                detail: t(`machineProcesses.detail.reasons.${met.reason}`),
              }
            : null,
          ...(proven ? {} : { recheck: recheck(row.ref) }),
          confirmLabel: t('machineProcesses.kill.confirmProcess'),
      });
    },
    [recheck, runKill],
  );

  const killTree = React.useCallback(
    (item: ProcessesOwnerItem) => {
      if (!item.rootRef || latest.current.unavailableReason) return;
      const name = describeProcessesItemTitle(item, latest.current.titles);
      const session = item.owner.owner.kind === 'session';
      runKill(item.key, name, { ref: item.rootRef, expect: { level: item.rootLevel, owner: item.owner.owner } }, true, item.processCount, {
          testID: 'machine-processes-kill-tree',
          title: t('machineProcesses.kill.treeTitle', {
            name,
            count: item.processCount,
          }),
          paragraphs: [
            t('machineProcesses.kill.treeBody'),
            ...(item.owner.requester
              ? [
                  t('machineProcesses.kill.guest', {
                    name: item.owner.requester.displayName,
                  }),
                ]
              : []),
          ],
          facts: [
            {
              label: t('machineProcesses.kill.facts.frees'),
              value: t('machineProcesses.kill.usingValue', {
                memory: formatProcessMemory(item.memoryBytes),
                cpu: formatProcessCpu(item.cpuPercent).replace('%', ''),
              }),
            },
            ...(session
              ? [
                  {
                    label: t('machineProcesses.kill.facts.gentler'),
                    value: t('machineProcesses.kill.treeGentler'),
                  },
                ]
              : []),
          ],
          ...(session
            ? { alternative: t('machineProcesses.kill.stopInstead') }
            : {}),
          ...(item.rootLevel === 'proven' ? {} : { recheck: recheck(item.rootRef) }),
          confirmLabel: t('machineProcesses.kill.confirmTree', {
            count: item.processCount,
          }),
      }, () => stop(item));
    },
    [recheck, runKill, stop],
  );

  const cleanUp = React.useCallback(
    (items: readonly ProcessesLeftBehindItem[]) => {
      const captured = captureTarget();
      if (!captured || items.length === 0 || latest.current.unavailableReason) return;
      const { machineId, actionScope, isCurrent } = captured;
      fireAndForget(
        (async () => {
          const rows = items.map((item) => ({
            row: item.row,
            ownerTitle: describeEndedOwner(item.row.owner),
            when: formatRelativeTimeShort(item.row.confirmedAtMs, Date.now()),
          }));
          const selectedRefs = await showLeftBehindReview({
            machineName: latest.current.machineName,
            rows,
          });
          if (!selectedRefs) return;
          const outcome = await executeMachineProcessesLeftBehindCleanUpV1(
            machineId,
            items.map((item) => item.row),
            { selectedRefs },
            actionScope,
          );
          if (!isCurrent()) return;
          const result = readActionResult(outcome, (value) =>
            MachineProcessesCleanUpResultV1Schema.safeParse(value),
          );
          if (result.kind === 'declined') return;
          if (result.kind !== 'ok') {
            publishPresentationNotice({
              key: 'machine-processes:clean-up',
              severity: result.kind === 'approval' ? 'info' : 'warning',
              message:
                result.kind === 'approval'
                  ? t('machineProcesses.results.approvalPending')
                  : resolveActionExecutionErrorMessage(outcome, t('machineProcesses.results.failedReason')),
            });
            return;
          }
          // Rows collapse one by one; the meter eases once, by the measured total.
          result.value.ended.forEach((ended, index) =>
            leave(`l:${ended.ref}`, index * PROCESSES_MOTION.cleanupStaggerMs),
          );
          setPendingFreed(
            (current) =>
              current +
              result.value.ended.reduce(
                (total, ended) => total + ended.freedBytes,
                0,
              ),
          );
          settledAt.current = Date.now();
          const skipped = result.value.skipped;
          const reason =
            skipped[0]?.reason === 'identity_changed' ||
            skipped[0]?.reason === 'expectation_changed'
              ? t('machineProcesses.results.skipReasons.restarted')
              : skipped[0]?.reason === 'gone_before'
                ? t('machineProcesses.results.skipReasons.gone')
                : t('machineProcesses.results.skipReasons.changed');
          publishPresentationNotice({
            key: 'machine-processes:clean-up',
            severity: 'info',
            message: [
              t('machineProcesses.results.cleanedUp', {
                count: result.value.ended.length,
              }),
              ...(skipped.length > 0
                ? [
                    t('machineProcesses.results.skipped', {
                      count: skipped.length,
                      reason,
                    }),
                  ]
                : []),
            ].join(' · '),
          });
        })(),
        { tag: 'MachineProcesses.cleanUp' },
      );
    },
    [captureTarget, leave],
  );

  const openSession = React.useCallback(
    (sessionId: string) => {
      fireAndForget(
        navigateToSession(sessionId, { serverId: latest.current.serverId }),
        { tag: 'MachineProcesses.openSession' },
      );
    },
    [navigateToSession],
  );

  const copy = React.useCallback((text: string) => {
    fireAndForget(
      writeClipboard(text).then((copied) => {
        if (copied)
          publishPresentationNotice({
            key: 'machine-processes:copied',
            severity: 'info',
            message: t('machineProcesses.results.copied'),
          });
      }),
      { tag: 'MachineProcesses.copy' },
    );
  }, [writeClipboard]);

  const titleOf = React.useCallback((item: ProcessesItem) => describeProcessesItemTitle(item, latest.current.titles), []);

  return React.useMemo(
    () => ({
      unavailableReason: input.unavailableReason,
      leaving,
      hidden,
      notes,
      pendingFreedBytes,
      meterNote,
      previewStop,
      stop,
      killProcess,
      killTree,
      cleanUp,
      openSession,
      copy,
    titleOf,
    }),
    [
      cleanUp,
      titleOf,
      copy,
      hidden,
      input.unavailableReason,
      killProcess,
      killTree,
      leaving,
      meterNote,
      notes,
      openSession,
      pendingFreedBytes,
      previewStop,
      stop,
    ],
  );
}

