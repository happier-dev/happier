import type { ConnectedServiceDaemonRestartDiagnosticRecord } from '../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';

type RestartDiagnosticLogger = Readonly<{
  debug: (message: string, record: ConnectedServiceDaemonRestartDiagnosticRecord) => void;
  info: (message: string, record: ConnectedServiceDaemonRestartDiagnosticRecord) => void;
}>;

export function logConnectedServiceDaemonRestartDiagnostic(
  logger: RestartDiagnosticLogger,
  record: ConnectedServiceDaemonRestartDiagnosticRecord,
): void {
  logger.info('[DAEMON RUN] Connected-service daemon restart diagnostic', record);
}
