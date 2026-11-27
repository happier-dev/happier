import {
    loadAnalyticsPropertiesSent,
    saveAnalyticsPropertiesSent,
    type AnalyticsPropertiesScope,
} from '@/sync/domains/state/persistence';

import { diffAnalyticsProperties } from './diffAnalyticsSnapshot';
import type { SettingsAnalyticsPropertyValue } from './types';

// PostHog keeps person and group properties, so a launch sends only what changed since this device
// last sent them, and the whole snapshot at most once a day per subject (owner request: identify
// and groupidentify were re-sent on every launch and settings change).
const FULL_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The properties to send now for this subject (null for none), recorded as sent. */
export function takeAnalyticsPropertiesToSend(
    scope: AnalyticsPropertiesScope,
    subject: string,
    properties: Record<string, SettingsAnalyticsPropertyValue>,
): Record<string, SettingsAnalyticsPropertyValue> | null {
    const now = Date.now();
    const sent = loadAnalyticsPropertiesSent(scope);
    if (!sent || sent.subject !== subject || now - sent.fullSentAtMs >= FULL_SNAPSHOT_INTERVAL_MS) {
        saveAnalyticsPropertiesSent(scope, { subject, fullSentAtMs: now, properties });
        return properties;
    }
    const changed = diffAnalyticsProperties(sent.properties, properties);
    if (changed) saveAnalyticsPropertiesSent(scope, { ...sent, properties });
    return changed;
}
