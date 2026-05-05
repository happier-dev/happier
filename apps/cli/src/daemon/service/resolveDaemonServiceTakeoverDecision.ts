import type { DaemonServiceCliAction } from '@/daemon/service/cli';
import type { DaemonServiceLifecycleConflict } from '@/daemon/ownership/evaluateServiceLifecycleOwnership';

export type DaemonServiceTakeoverDecision =
  | Readonly<{ kind: 'ok' }>
  | Readonly<{ kind: 'conflict'; conflict: DaemonServiceLifecycleConflict }>
  | Readonly<{ kind: 'manual-owner-takeover' }>;

export function resolveDaemonServiceTakeoverDecision(params: Readonly<{
  lifecycleOwnership: Readonly<{ kind: 'ok' }> | DaemonServiceLifecycleConflict;
  takeoverRequested: boolean;
}>): DaemonServiceTakeoverDecision {
  if (params.lifecycleOwnership.kind === 'ok') {
    return { kind: 'ok' };
  }

  if (params.takeoverRequested && params.lifecycleOwnership.kind === 'manual-owner-conflict') {
    return { kind: 'manual-owner-takeover' };
  }

  return { kind: 'conflict', conflict: params.lifecycleOwnership };
}

function describeAction(action: Extract<DaemonServiceCliAction, 'install' | 'start' | 'restart'>): string {
  if (action === 'install') return 'enable automatic startup';
  if (action === 'start') return 'start the background service';
  return 'restart the background service';
}

export function buildDaemonServiceTakeoverHint(params: Readonly<{
  commandPath: string;
  action: Extract<DaemonServiceCliAction, 'install' | 'start' | 'restart'>;
}>): string {
  return `Re-run with \`${params.commandPath} ${params.action} --takeover\` if you want to stop the current manually started daemon and ${describeAction(params.action)}.`;
}

export function buildDaemonServiceTakeoverNotice(params: Readonly<{
  action: Extract<DaemonServiceCliAction, 'install' | 'start' | 'restart'>;
}>): Readonly<{ title: string; lines: readonly string[] }> {
  return {
    title: 'Taking over the current manual daemon.',
    lines: [
      `Happier will stop the current manually started daemon before it ${describeAction(params.action)}.`,
    ],
  };
}
