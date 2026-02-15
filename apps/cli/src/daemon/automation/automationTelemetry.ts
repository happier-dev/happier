import { logger } from '@/ui/logger';

export function logAutomationInfo(message: string, data?: Record<string, unknown>): void {
  logger.debug(`[DAEMON AUTOMATION] ${message}`, data);
}

export function logAutomationWarn(message: string, error?: unknown, data?: Record<string, unknown>): void {
  logger.warn(`[DAEMON AUTOMATION] ${message}`, {
    ...(data ?? {}),
    error: error instanceof Error ? error.message : (error ? String(error) : undefined),
  });
}
