import * as React from 'react';

import { formatMachineCountdown } from '@/components/machines/durationWords';
import { useGuardRemainingMs } from '@/components/machines/guard/GuardCountdown';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Modal } from '@/modal';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { machineGuardStore } from '@/sync/domains/machines/guard/machineGuardStore';
import { keepMachineGuardWorkRunningViaAction } from '@/sync/domains/machines/guard/machineGuardRpc';
import { useMachineGuardView } from '@/sync/domains/machines/guard/useMachineGuardView';
import { useMachineDaemonReadTarget } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * A terminal running a command that Guard is about to close (plan 50 §17C): one warning line over the
 * terminal with the clock and Keep running, the same words and Action as the Guard tab's terminal rows. It
 * reads the machine's Guard view (one shared watch), so it clears itself when the terminal gets input or is kept.
 */
export function MachineTerminalGuardWarning(
  props: Readonly<{ serverId: string; machineId: string; terminalKey: string }>,
): React.ReactElement | null {
  const view = useMachineGuardView({ serverId: props.serverId, machineId: props.machineId }).view;
  const terminal = view?.idleTerminals?.find((row) => row.terminalKey === props.terminalKey);
  if (!terminal || terminal.status !== 'stops_at' || terminal.commandRunning !== true || terminal.stopAt === undefined) return null;
  return <TerminalGuardWarningLine {...props} stopAt={terminal.stopAt} />;
}

const TerminalGuardWarningLine = React.memo(function TerminalGuardWarningLine(
  props: Readonly<{ serverId: string; machineId: string; terminalKey: string; stopAt: number }>,
) {
  const { key, accountBinding } = useMachineDaemonReadTarget({ serverId: props.serverId, machineId: props.machineId });
  const [keeping, setKeeping] = React.useState(false);
  const duration = formatMachineCountdown(useGuardRemainingMs(props.stopAt));
  const keepRunning = React.useCallback(() => {
    setKeeping(true);
    fireAndForget((async () => {
      const kept = await keepMachineGuardWorkRunningViaAction({ ...key, terminalKey: props.terminalKey });
      setKeeping(false);
      machineGuardStore.refreshMachine(key);
      if (!kept.ok && accountBinding?.isCurrent()) {
        Modal.alert(t('machineGuard.session.keepRunning'),
          resolveActionExecutionErrorMessage(kept, t('machineGuard.session.keepRunningFailed')));
      }
    })(), { tag: 'MachineTerminalGuardWarning.keepRunning' });
  }, [accountBinding, key, props.terminalKey]);
  const reason = t('machineGuard.terminals.closesIn', { duration });
  return (
    <SurfaceFreshnessLine
      testID="machine-terminal-guard-warning"
      tone="warning"
      reason={reason}
      emphasis={reason}
      action={{ label: t('machineGuard.session.keepRunning'), onPress: keepRunning, busy: keeping, testID: 'machine-terminal-guard-warning-keep' }}
    />
  );
});
