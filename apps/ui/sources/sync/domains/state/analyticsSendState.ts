import { getPersistenceStorage } from './persistenceStorage';

/**
 * What this device last sent to PostHog, so launches do not resend it. Device-local: it describes
 * this device's own sends, not the Account.
 */
export type AnalyticsPropertiesScope = 'person' | 'device_user';

type AnalyticsPropertyValue = string | number | boolean | null;

/** What this device last sent as one subject's person or group properties. */
export type AnalyticsPropertiesSentRecord = Readonly<{
  subject: string;
  fullSentAtMs: number;
  properties: Readonly<Record<string, AnalyticsPropertyValue>>;
}>;

function analyticsPropertiesSentKey(scope: AnalyticsPropertiesScope): string {
  return `analytics-properties-sent-v1:${scope}`;
}

const SCM_STATUS_SYNC_FAILURE_REPORTED_AT_KEY =
  'scm-status-sync-failure-reported-at-v1';

function isAnalyticsPropertyValue(
  value: unknown,
): value is AnalyticsPropertyValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function readJsonObject(key: string): Record<string, unknown> | null {
  const raw = getPersistenceStorage().getString(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function loadAnalyticsPropertiesSent(
  scope: AnalyticsPropertiesScope,
): AnalyticsPropertiesSentRecord | null {
  const parsed = readJsonObject(analyticsPropertiesSentKey(scope));
  if (!parsed) return null;
  const { subject, fullSentAtMs, properties } = parsed;
  if (
    typeof subject !== 'string' ||
    typeof fullSentAtMs !== 'number' ||
    !Number.isFinite(fullSentAtMs)
  )
    return null;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  )
    return null;
  if (!Object.values(properties).every(isAnalyticsPropertyValue)) return null;
  return {
    subject,
    fullSentAtMs,
    properties: properties as AnalyticsPropertiesSentRecord['properties'],
  };
}

export function saveAnalyticsPropertiesSent(
  scope: AnalyticsPropertiesScope,
  record: AnalyticsPropertiesSentRecord,
): void {
  getPersistenceStorage().set(
    analyticsPropertiesSentKey(scope),
    JSON.stringify(record),
  );
}

/** PostHog's reset() drops the identity and $groups, so the next person and group properties go in full. */
export function clearAnalyticsPropertiesSent(): void {
  const storage = getPersistenceStorage();
  storage.delete(analyticsPropertiesSentKey('person'));
  storage.delete(analyticsPropertiesSentKey('device_user'));
}

/** When each scm_status_sync_failed bucket was last reported from this device, in epoch ms. */
export function loadScmStatusSyncFailureReportedAt(): Record<string, number> {
  const parsed = readJsonObject(SCM_STATUS_SYNC_FAILURE_REPORTED_AT_KEY);
  if (!parsed) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}

export function saveScmStatusSyncFailureReportedAt(
  reportedAt: Readonly<Record<string, number>>,
): void {
  getPersistenceStorage().set(
    SCM_STATUS_SYNC_FAILURE_REPORTED_AT_KEY,
    JSON.stringify(reportedAt),
  );
}
