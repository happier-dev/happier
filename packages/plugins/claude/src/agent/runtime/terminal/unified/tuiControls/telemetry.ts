import type {
  ApplyRuntimeConfigReason,
  RuntimeConfigOutcomeChangeKeyV1,
  RuntimeConfigOutcomeStatusV1,
  RuntimeConfigOutcomeTimingV1,
} from './types.js';

type LoggerLike = Readonly<{
  debug(message: string, ...args: unknown[]): void;
}>;

/**
 * Observability events for the Claude Unified TUI runtime-control controller.
 *
 * Every outcome event status MUST be one of the five frozen public statuses; queued/scheduled/skipped
 * state is carried by the optional `timing` field, never by a new status value.
 */
export type ClaudeTuiControlTelemetryEvent =
  | Readonly<{
      name: 'unified.control.start';
      properties: Readonly<{
        changeKeys: string;
        reason: ApplyRuntimeConfigReason;
        featureEnabled: boolean;
      }>;
    }>
  | Readonly<{
      name: 'unified.control.outcome';
      properties: Readonly<{
        key: RuntimeConfigOutcomeChangeKeyV1;
        status: RuntimeConfigOutcomeStatusV1;
        timing?: RuntimeConfigOutcomeTimingV1 | undefined;
        reason?: string | undefined;
      }>;
    }>
  | Readonly<{
      name: 'unified.control.verification_mismatch';
      properties: Readonly<{
        key: RuntimeConfigOutcomeChangeKeyV1;
        expected: string;
        observed?: string | undefined;
      }>;
    }>
  | Readonly<{
      name: 'unified.control.settings_restore_failed';
      properties: Readonly<{
        key: RuntimeConfigOutcomeChangeKeyV1;
        reason?: string | undefined;
      }>;
    }>;

export type ClaudeTuiControlTelemetrySink = Readonly<{
  emit(event: ClaudeTuiControlTelemetryEvent): void;
}>;

function sanitizeReason(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 80);
  return normalized.length > 0 ? normalized : 'unknown';
}

/** Logger-backed sink. Plugins pass `ctx.logger`; file-log only, never stdout (agent session paths). */
export function createClaudeTuiControlTelemetrySink(params: Readonly<{
  logger: LoggerLike;
}>): ClaudeTuiControlTelemetrySink {
  const { logger } = params;
  return {
    emit(event) {
      const payload: Record<string, unknown> = { event: event.name, ...event.properties };
      if (typeof payload.reason === 'string') payload.reason = sanitizeReason(payload.reason);
      logger.debug('[claude-tui-control]', payload);
    },
  };
}
