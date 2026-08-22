import { logger } from '@/ui/logger';

export function logAutomationInfo(message: string, data?: Record<string, unknown>): void {
  logger.debug(`[DAEMON AUTOMATION] ${message}`, data);
}

export function logAutomationWarn(message: string, error?: unknown, data?: Record<string, unknown>): void {
  logger.warn(`[DAEMON AUTOMATION] ${message}`, {
    ...(data ?? {}),
    // Run failure details are private Account content. Keep structural context
    // in `data`, but never promote an arbitrary boundary error into telemetry.
    error: error ? 'redacted' : undefined,
  });
}
