import { logger } from '@/ui/logger';
import { clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

export type DaemonShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';

export type DaemonShutdownRequest = {
  source: DaemonShutdownSource;
  errorMessage?: string;
};

export function createDaemonShutdownController(): {
  requestShutdown: (source: DaemonShutdownSource, errorMessage?: string) => void;
  resolvesWhenShutdownRequested: Promise<DaemonShutdownRequest>;
} {
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: DaemonShutdownSource, errorMessage?: string) => void;
  const resolvesWhenShutdownRequested = new Promise<DaemonShutdownRequest>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.infoFile('[DAEMON RUN] Shutdown requested', { code: 'daemon_shutdown_requested', source });
      logger.flushSync();

      // A stopped daemon must revoke its local Account incumbent before any
      // asynchronous drain/cleanup work runs. The shutdown controller is the
      // lifecycle owner shared by authenticated control stop and OS shutdown.
      clearActiveAccountSettingsSnapshot();

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', () => {
    // Rejected work can carry private materialization paths or account data.
    // The shared fatal logger drains a closed reason without serializing it.
    logger.fatal(new Error('daemon_uncaught_exception'));
    requestShutdown('exception', 'daemon_uncaught_exception');
  });

  process.on('unhandledRejection', () => {
    logger.fatal(new Error('daemon_unhandled_rejection'));
    requestShutdown('exception', 'daemon_unhandled_rejection');
  });

  process.on('exit', (code) => {
    if (code !== 0) {
      logger.fatal(new Error(`daemon_process_exit_nonzero:${code}`));
    } else {
      logger.infoFile('[DAEMON RUN] Process exiting', { code: 'daemon_process_exit', exitCode: code });
      logger.flushSync();
    }
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  return { requestShutdown: requestShutdown!, resolvesWhenShutdownRequested };
}
