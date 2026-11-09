import type { MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import { randomUUID } from 'node:crypto';
import type { TerminalGuardResource, TerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import type { ActivityLog } from './activityLog';
import type { GuardPolicyWork } from './guardRuntime';
import type { GuardTerminalPreview, GuardViewRequester } from './view/guardWatch';
import type { GuardOwnership } from './guardPlanner';
import { equalProcessStart } from '../processes/ownership/types';
import { waitForChangeOrDeadline } from '../lifecycle/waitForChangeOrDeadline';
import { terminalClose } from './actuators/terminalClose';

export type IdleTerminalPolicyInput = Readonly<{
  getTerminals(): TerminalPtySessionManager | null;
  ownership: Pick<ReturnType<typeof createProcessOwnershipRuntime>, 'readOwners'>;
  activityLog: Pick<ActivityLog, 'append'>;
  readPolicy(): MachineGuardPolicyV1;
  readTarget(): Readonly<{ serverId: string; machineId: string; installationId: string }>;
  notifyWarning(input: Readonly<{ terminal: TerminalGuardResource; stopAt: number; idleMs: number; signal: AbortSignal }>): Promise<void>;
  nowMs?: () => number;
}>;

type TerminalPlan = Readonly<{ terminal: TerminalGuardResource; preview: GuardTerminalPreview;
  nextAt?: number; due?: 'warning' | 'close' }>;

/** One eligibility projection serves private preview and the due actuator. */
export function planIdleTerminals(input: Readonly<{
  terminals: readonly TerminalGuardResource[]; ownership: GuardOwnership;
  policy: MachineGuardPolicyV1['idleTerminals']; now: number;
  target: ReturnType<IdleTerminalPolicyInput['readTarget']>;
}>): readonly TerminalPlan[] {
  return input.terminals.filter(terminal => !terminal.ended).map(terminal => {
    const reasons: GuardTerminalPreview['reasons'][number][] = [];
    if (terminal.custody && (terminal.custody.serverId !== input.target.serverId
      || terminal.custody.machineId !== input.target.machineId || terminal.custody.installationId !== input.target.installationId)) reasons.push('wrong_target');
    const root = input.ownership.status === 'ok' ? input.ownership.roots.find(root => root.live && root.pid === terminal.pid
      && root.owner.kind === 'terminal' && root.owner.terminalId === terminal.terminalId) : undefined;
    const native = input.ownership.status === 'ok' ? input.ownership.snapshot.rows.find(row => row.pid === terminal.pid) : undefined;
    const owned = root !== undefined && native !== undefined && equalProcessStart(root.start, native.start);
    const foreground = input.ownership.status === 'ok'
      ? input.ownership.snapshot.rows.find(row => row.pid === terminal.foregroundPid) : undefined;
    const foregroundOwner = input.ownership.status === 'ok'
      ? input.ownership.rows.find(row => row.pid === terminal.foregroundPid) : undefined;
    const foregroundOwned = foreground && (terminal.foregroundPid === terminal.pid || foregroundOwner?.level === 'proven'
      && foregroundOwner.owner?.kind === 'terminal' && foregroundOwner.owner.terminalId === terminal.terminalId
      && !foregroundOwner.ownerEnded && equalProcessStart(foregroundOwner.start, foreground.start));
    const commandRunning = owned && foregroundOwned && Number.isSafeInteger(foreground.pgid) && foreground.pgid! > 0
      && Number.isSafeInteger(foreground.tpgid) && foreground.tpgid! > 0 ? foreground.pgid !== foreground.tpgid : null;
    if (!owned) reasons.push('native_owner_unknown');
    else if (commandRunning === null) reasons.push('foreground_unknown');
    if (terminal.finiteHold) reasons.push('finite_work');
    if (terminal.stopPending || terminal.stopUnconfirmed || root?.state === 'stopping') reasons.push('stop_pending');
    if (commandRunning && terminal.guardWarningFailedPolicy?.afterMs === input.policy.afterMs
      && terminal.guardWarningFailedPolicy.warnBeforeMs === input.policy.warnBeforeMs) reasons.push('warning_unavailable');
    const stopAt = terminal.lastActivityAtMs + input.policy.afterMs;
    const warning = terminal.terminalGuardStateV1?.stopAt === stopAt ? terminal.terminalGuardStateV1 : undefined;
    const warnAt = stopAt - input.policy.warnBeforeMs;
    let nextAt: number | undefined;
    let due: TerminalPlan['due'];
    if (input.policy.enabled && reasons.length === 0) {
      nextAt = commandRunning && !warning ? warnAt : stopAt;
      if (input.now >= nextAt) due = commandRunning && !warning ? 'warning' : 'close';
    }
    if (!due && !warning && reasons.length === 0) reasons.push('not_yet');
    const attribution = terminal.custody ? { serverId: terminal.custody.serverId,
      accountId: terminal.custody.requesterAccountId, machineId: terminal.custody.machineId,
      installationId: terminal.custody.installationId } : { kind: 'unknown' as const };
    return { terminal, nextAt, due, preview: { terminalId: terminal.terminalId, terminalKey: terminal.terminalKey,
      label: terminal.terminalKey, idleMs: Math.max(0, input.now - terminal.lastActivityAtMs), commandRunning,
      eligible: due === 'close', status: warning && reasons.length === 0 ? 'stops_at' : due === 'close' ? 'eligible' : 'not_yet',
      ...(warning && reasons.length === 0 ? { stopAt } : {}), reasons, attribution } };
  });
}

export function createIdleTerminalPolicy(input: IdleTerminalPolicyInput): GuardPolicyWork & {
  keepRunning(target: Readonly<{ terminalKey: string }>, requester: GuardViewRequester, signal?: AbortSignal): Promise<Readonly<{ status: 'kept' | 'not_pending' }>>;
  terminalState: Readonly<{ readPreview(input: Readonly<{ ownership: GuardOwnership; policy: MachineGuardPolicyV1; now: number }>): readonly GuardTerminalPreview[] | undefined }>;
  refreshOnTick(): void; deactivate(): void; stop(): void;
} {
  const now = input.nowMs ?? Date.now;
  const resources = (terminals: TerminalPtySessionManager) => terminals.readGuardResources();
  const clear = () => {
    const terminals = input.getTerminals();
    for (const terminal of terminals?.readGuardResources() ?? []) if (terminal.terminalGuardStateV1 || terminal.guardWarningFailedPolicy)
      terminals?.setGuardState({ terminalId: terminal.terminalId, expectedLastActivityAtMs: terminal.lastActivityAtMs });
  };
  const read = async (terminals: TerminalPtySessionManager, signal: AbortSignal) => {
    let ownership: GuardOwnership | undefined;
    await waitForChangeOrDeadline({ signal, waitForChange: async () => {
      ownership = await input.ownership.readOwners({ freshness: 'fresh' });
    } });
    if (signal.aborted || !ownership || input.getTerminals() !== terminals) return [];
    return planIdleTerminals({ terminals: resources(terminals), ownership, policy: input.readPolicy().idleTerminals, now: now(), target: input.readTarget() });
  };
  const receipt = (terminal: TerminalGuardResource, kind: 'closed_terminal' | 'kept_running') => {
    const target = terminal.custody ?? input.readTarget();
    return input.activityLog.append({ v: 1, id: randomUUID(), at: now(), kind, rule: 'idle_terminals', outcome: 'done',
      subject: { kind: 'terminal', terminalKey: terminal.terminalKey, label: terminal.terminalKey,
        idleMs: Math.max(0, now() - terminal.lastActivityAtMs) },
      attribution: terminal.custody ? { serverId: terminal.custody.serverId, accountId: terminal.custody.requesterAccountId,
        machineId: terminal.custody.machineId, installationId: terminal.custody.installationId } : { kind: 'unknown' },
      ...(kind === 'closed_terminal' ? { wayBack: [{ label: 'reopen' as const, actionId: 'machines.terminal.open' as const,
        input: { serverId: target.serverId, machineId: target.machineId, terminalKey: terminal.terminalKey,
          cwd: terminal.cwd,
          ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}),
          ...(terminal.custody && terminal.custody.kind === undefined ? { workspace: {
            serverId: terminal.custody.serverId, workspaceId: terminal.custody.workspaceRefId,
            machineId: terminal.custody.machineId, rootPath: terminal.custody.rootPath,
          } } : {}),
        } }] } : {}),
    });
  };
  return {
    enabled: policy => policy.idleTerminals.enabled,
    subscribe: listener => input.getTerminals()?.getLiveWorkProducer().subscribe(listener) ?? (() => {}),
    terminalState: { readPreview: request => {
      const terminals = input.getTerminals();
      return terminals ? planIdleTerminals({ terminals: resources(terminals), ownership: request.ownership,
        policy: request.policy.idleTerminals, now: request.now, target: input.readTarget() }).map(item => item.preview) : undefined;
    } },
    refreshOnTick: () => input.getTerminals()?.clearGuardWarningFailures(),
    deactivate: clear, stop: clear,
    readPlan: async request => {
      const readSignal = request.readSignal ?? request.signal;
      if (readSignal.aborted || request.signal.aborted) return {};
      if (!request.policy.idleTerminals.enabled) { clear(); return {}; }
      const terminals = input.getTerminals();
      if (!terminals) return {};
      const plan = await read(terminals, readSignal);
      if (readSignal.aborted || request.signal.aborted) return {};
      for (const item of plan) {
        if (readSignal.aborted || request.signal.aborted) return {};
        if (item.terminal.terminalGuardStateV1 && item.preview.status !== 'stops_at')
          terminals.setGuardState({ terminalId: item.terminal.terminalId, expectedLastActivityAtMs: item.terminal.lastActivityAtMs });
      }
      if (readSignal.aborted || request.signal.aborted) return {};
      const due = plan.find(item => item.due !== undefined);
      const nextAt = plan.reduce<number | undefined>((next, item) => item.nextAt === undefined ? next
        : next === undefined ? item.nextAt : Math.min(next, item.nextAt), undefined);
      return { ...(nextAt === undefined ? {} : { nextAt }), ...(due ? { run: async () => {
        await waitForChangeOrDeadline({ signal: request.signal, waitForChange: async () => {
        // Warning delivery needs a fresh preview. A close instead delegates its
        // one final native/policy admission to the captured PTY owner below.
        const current = due.due === 'close' ? due : (await read(terminals, request.signal)).find(item => item.terminal.terminalId === due.terminal.terminalId
          && item.terminal.lastActivityAtMs === due.terminal.lastActivityAtMs);
        if (!current?.due || request.signal.aborted) return;
        if (current.due === 'warning') {
          const policy = input.readPolicy().idleTerminals;
          const stopAt = current.terminal.lastActivityAtMs + policy.afterMs;
          if (!terminals.setGuardState({ terminalId: current.terminal.terminalId, expectedLastActivityAtMs: current.terminal.lastActivityAtMs,
            state: { v: 1, kind: 'stopping', rule: 'idle_terminals', stopAt } })) return;
          try { await input.notifyWarning({ terminal: current.terminal, stopAt, idleMs: current.preview.idleMs, signal: request.signal }); }
          catch (error) {
            if (!request.signal.aborted) terminals.setGuardState({ terminalId: current.terminal.terminalId, expectedLastActivityAtMs: current.terminal.lastActivityAtMs,
              failedPolicy: { afterMs: policy.afterMs, warnBeforeMs: policy.warnBeforeMs } });
            throw error;
          }
          return;
        }
        if (await terminalClose({ terminals, terminal: current.terminal, signal: request.signal,
          verifyCurrent: async () => (await read(terminals, request.signal)).some(item => item.terminal.terminalId === current.terminal.terminalId
            && item.terminal.lastActivityAtMs === current.terminal.lastActivityAtMs && item.due === 'close') }))
          await receipt(current.terminal, 'closed_terminal');
        } });
      } } : {}) };
    },
    keepRunning: async (target, requester, signal) => {
      if (signal?.aborted) return { status: 'not_pending' };
      const terminals = input.getTerminals(); const machine = input.readTarget();
      if (!terminals || requester.serverId !== machine.serverId || requester.machineId !== machine.machineId
        || requester.installationId !== machine.installationId) return { status: 'not_pending' };
      const matches = resources(terminals).filter(terminal => terminal.terminalKey === target.terminalKey && terminal.terminalGuardStateV1
        && (!terminal.custody || terminal.custody.serverId === machine.serverId && terminal.custody.machineId === machine.machineId
          && terminal.custody.installationId === machine.installationId)
        && (requester.isCustodian || terminal.custody?.requesterAccountId === requester.accountId));
      const terminal = matches.length === 1 ? matches[0] : undefined;
      if (!terminal || !terminals.keepGuardRunning({ terminalId: terminal.terminalId, expectedLastActivityAtMs: terminal.lastActivityAtMs }))
        return { status: 'not_pending' };
      await receipt(terminal, 'kept_running'); return { status: 'kept' };
    },
  };
}
