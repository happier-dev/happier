import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DaemonTerminalLaunchIntent, DaemonTerminalShellAvailabilityV1 } from '@happier-dev/protocol/daemon/terminal';

import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useTerminalApprovalOpener } from '@/components/terminal/embedded/useTerminalApprovalOpener';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';

import { MachineTerminalGuardWarning } from './MachineTerminalGuardWarning';
import { describeMachineTerminalTitle } from './machineTerminalTitle';

export type MachineTerminalSheetTarget = Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
} & (
  | { machineShell: Extract<DaemonTerminalShellAvailabilityV1, { ok: true }>; launch?: never }
  | { machineShell?: never; launch: Extract<DaemonTerminalLaunchIntent, { kind: 'service_shell' }> }
)>;

/**
 * A machine or service shell in a card (a sheet on phones). The terminal is
 * opened through the same `machines.terminal.open` Action every other terminal uses (the session controller's
 * admission), so approval policy and agent parity stay with that owner; the shell ends with the card.
 */
export function showMachineTerminalSheet(
  target: MachineTerminalSheetTarget,
): void {
  Modal.show({
    component: MachineTerminalModal,
    props: target,
    chrome: {
      kind: 'card',
      phonePresentation: 'sheet',
      testID: 'machine-terminal-modal',
      title: describeMachineTerminalTitle(target.machineName),
      scrollHost: 'body',
      bodyScroll: 'none',
      dimensions: { size: 'lg' },
    },
    closeOnBackdrop: false,
  });
}

const MachineTerminalModal = React.memo(function MachineTerminalModal(
  props: MachineTerminalSheetTarget,
) {
  const presence = useMachinePresenceSummary(props.serverId, props.machineId);
  const terminalRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
  // One shell per opening: a second opening is a second terminal, never the first one's screen.
  const terminalKey = React.useMemo(
    () => `machine-shell:${props.machineId}:${randomUUID()}`,
    [props.machineId],
  );
  const controller = useMachineTerminalSession({
    machineId: props.machineId,
    serverId: props.serverId,
    cwd: props.machineShell?.cwd ?? null,
    launch: props.launch,
    machineReachable: presence.reachability === 'unknown' ? null : presence.reachability === 'reachable',
    machineRpcTargetAvailable: true,
    terminalKey,
    terminalRef,
    closeOnUnmount: true,
  });
  const onOpenApproval = useTerminalApprovalOpener(controller);
  return (
    <View style={styles.frame}>
      <MachineTerminalGuardWarning
        serverId={props.serverId}
        machineId={props.machineId}
        terminalKey={terminalKey}
      />
      <EmbeddedTerminalPane
        title={describeMachineTerminalTitle(props.machineName)}
        controller={{ ...controller, onOpenApproval }}
        terminalRef={terminalRef}
        chrome="none"
        machineName={props.machineName}
        testIdPrefix="machine-terminal"
        nativeSurfaceKey={terminalKey}
      />
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  frame: {
    flex: 1,
    minHeight: 360,
    minWidth: 0,
  },
}));
