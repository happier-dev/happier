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
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

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

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  return { requestShutdown: requestShutdown!, resolvesWhenShutdownRequested };
}
