import { t } from '@/text';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';

/**
 * One enabled capability's delivery, from the collector status owner's latest retained sample (`capabilityLastSampleAt`):
 * "Receiving · last sample 3 minutes ago", or "Not receiving yet" until its first sample is kept. The window a view
 * reads says its own coverage; this line is independent of it. The setup sheet and the Telemetry tab both say it.
 */
export function formatTelemetryCapabilityStatus(lastSampleAt: number | null, nowMs = Date.now()): string {
  return lastSampleAt === null
    ? t('deploymentTelemetry.sheet.notReceiving')
    : t('deploymentTelemetry.sheet.lastSample', { time: formatRelativeTime(lastSampleAt, nowMs) });
}
