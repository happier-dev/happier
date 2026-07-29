import { logger as defaultLogger } from '@/ui/logger';

import { drainRuntimeAuthFailureReportOutboxToDaemon } from './runtimeAuthFailureReportOutboxDrain';

type RuntimeAuthFailureReportOutboxDrainLogger = Readonly<{
  debug: (message: string, error?: unknown) => void;
}>;

type Timer = ReturnType<typeof setTimeout>;

const DEFAULT_DRAIN_DELAY_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 10_000;
const DEFAULT_DRAIN_LIMIT = 8;
const DEFAULT_MAX_AUTOMATIC_ATTEMPTS = 3;

let scheduledTimer: Timer | null = null;
let drainInFlight = false;

function clearScheduledTimer(clearTimeoutFn: typeof clearTimeout = clearTimeout): void {
  if (!scheduledTimer) return;
  clearTimeoutFn(scheduledTimer);
  scheduledTimer = null;
}

function unrefTimer(timer: Timer): void {
  const maybeUnref = (timer as { unref?: () => void }).unref;
  if (typeof maybeUnref === 'function') {
    maybeUnref.call(timer);
  }
}

function readDelayMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

type DrainScheduleInput = Readonly<{
  outboxDir?: string;
  logger?: RuntimeAuthFailureReportOutboxDrainLogger;
  logPrefix?: string;
  delayMs?: number;
  retryDelayMs?: number;
  maxAutomaticAttempts?: number;
  limit?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  drain?: typeof drainRuntimeAuthFailureReportOutboxToDaemon;
}>;

function readMaxAutomaticAttempts(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_AUTOMATIC_ATTEMPTS;
}

async function drainOnce(input: DrainScheduleInput, automaticAttempt: number): Promise<void> {
  if (drainInFlight) return;

  const logger = input.logger ?? defaultLogger;
  const logPrefix = input.logPrefix ?? '[connected-services]';
  const drain = input.drain ?? drainRuntimeAuthFailureReportOutboxToDaemon;
  let shouldRetry = false;

  drainInFlight = true;
  try {
    const result = await drain({
      ...(input.outboxDir ? { outboxDir: input.outboxDir } : {}),
      limit: input.limit ?? DEFAULT_DRAIN_LIMIT,
    });
    shouldRetry = result.retried > 0;
  } catch (error) {
    shouldRetry = true;
    logger.debug(`${logPrefix} Failed to drain connected-service runtime auth failure report outbox (non-fatal)`, error);
  } finally {
    drainInFlight = false;
  }

  if (shouldRetry && automaticAttempt < readMaxAutomaticAttempts(input.maxAutomaticAttempts)) {
    scheduleDrain({
      ...input,
      delayMs: readDelayMs(input.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
    }, automaticAttempt + 1);
  }
}

export function resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests(): void {
  clearScheduledTimer();
  drainInFlight = false;
}

function scheduleDrain(input: DrainScheduleInput, automaticAttempt: number): void {
  if (scheduledTimer || drainInFlight) return;

  const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
  const delayMs = readDelayMs(input.delayMs, DEFAULT_DRAIN_DELAY_MS);
  scheduledTimer = setTimeoutFn(() => {
    clearScheduledTimer(clearTimeoutFn);
    void drainOnce(input, automaticAttempt);
  }, delayMs);
  unrefTimer(scheduledTimer);
}

export function scheduleRuntimeAuthFailureReportOutboxDrainToDaemon(
  input: DrainScheduleInput = {},
): void {
  scheduleDrain(input, 1);
}
