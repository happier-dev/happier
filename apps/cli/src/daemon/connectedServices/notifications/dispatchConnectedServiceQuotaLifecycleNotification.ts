import type { AccountSettings } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { isUsageQuotaNotificationEnabled, type UsageQuotaNotificationsV1 } from '@happier-dev/protocol/account/settings/usagePacingPreferencesV1';
import { deriveProviderAccountUsagePace, readProviderAccountUsageWindowComparabilityReason, resolveProviderAccountUsagePaceWindow } from '@happier-dev/protocol/connect/deriveProviderAccountUsagePace';
import { isConnectedServiceQuotaObservationFresh } from '@happier-dev/protocol/connect/quotaObservationTime';
import { ConnectedServiceUsageNotificationV1Schema, type ConnectedServiceUsageNotificationV1 } from '@happier-dev/protocol/activity/webhookPayload';

import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import type { ExpoPushActivityNotificationSender } from '@/notifications/activity/sendExpoPushActivityNotification';
import type { AutomaticQuotaResetConsumedEvent, ConnectedServiceQuotaLifecycleTransition, ConnectedServiceUsageSnapshotTransition } from '../quotas/ConnectedServiceQuotasCoordinator';
import { resolveConnectedServiceNotificationDisplayName } from './connectedServiceNotificationLabels';

type NotificationDeliveryContext = Pick<Parameters<typeof dispatchActivityNotificationAsync>[0],
  'notificationChannelCatalog' | 'savedSecretMaterializer' | 'isCurrent' | 'pluginNotifications' | 'usageNoticeArtifactStore'>;

/** Live accepted B observations supply both sides; absent history is hydration, never a crossing. */
function deriveUsageNotifications(transition: ConnectedServiceUsageSnapshotTransition & Readonly<{ preferences: UsageQuotaNotificationsV1 }>, nowMs: number): ConnectedServiceUsageNotificationV1[] {
  const { snapshot, previous } = transition;
  if (!previous || previous.recordId !== snapshot.recordId || previous.observedAtMs >= snapshot.observedAtMs) return [];
  if (snapshot.state !== 'loaded_data' || previous.state !== 'loaded_data'
    || !isConnectedServiceQuotaObservationFresh({ observedAtMs: snapshot.observedAtMs, nowMs, maxAgeMs: snapshot.staleAfterMs })) return [];
  const events: ConnectedServiceUsageNotificationV1[] = [];
  for (const meter of snapshot.meters) {
    const next = deriveProviderAccountUsagePace({ snapshot, meterId: meter.meterId, nowMs });
    const prior = deriveProviderAccountUsagePace({ snapshot: previous, meterId: meter.meterId, nowMs: previous.observedAtMs });
    const nextWindow = resolveProviderAccountUsagePaceWindow(snapshot, meter.meterId);
    const priorWindow = resolveProviderAccountUsagePaceWindow(previous, meter.meterId);
    if (!nextWindow || !priorWindow) continue;
    const sameWindow = nextWindow.resetAtMs === priorWindow.resetAtMs && nextWindow.windowDurationMs === priorWindow.windowDurationMs;
    const priorWindowWitness = prior.status === 'available' || prior.reason === 'zero_elapsed'
      || (prior.reason === 'outside_window' && previous.observedAtMs === priorWindow.resetAtMs);
    const witnessedReset = !sameWindow && priorWindowWitness
      && (next.status === 'available' || next.reason === 'zero_elapsed')
      && readProviderAccountUsageWindowComparabilityReason({ previous, current: snapshot, meterId: meter.meterId }) === null
      && nextWindow.windowStartAtMs === priorWindow.resetAtMs
      && nextWindow.windowDurationMs === priorWindow.windowDurationMs;
    const fingerprint = (kind: ConnectedServiceUsageNotificationV1['kind']) => JSON.stringify([
      snapshot.recordId, meter.meterId, nextWindow.resetAtMs, nextWindow.windowDurationMs, kind]);
    if (witnessedReset) {
      events.push(ConnectedServiceUsageNotificationV1Schema.parse({ topic: 'connected_service_usage', kind: 'reset',
        serviceId: transition.serviceId, profileId: transition.profileId, issueFingerprint: fingerprint('reset'),
        evidence: { ...nextWindow, observedAtMs: snapshot.observedAtMs, previousObservedAtMs: previous.observedAtMs,
          witnessedAtMs: snapshot.observedAtMs } }));
      if (prior.status === 'available' && prior.usedFraction < 1) events.push(ConnectedServiceUsageNotificationV1Schema.parse({
        topic: 'connected_service_usage', kind: 'unused', serviceId: transition.serviceId, profileId: transition.profileId,
        issueFingerprint: fingerprint('unused'), evidence: { ...prior.window, observedAtMs: previous.observedAtMs,
          previousObservedAtMs: previous.observedAtMs, witnessedAtMs: snapshot.observedAtMs,
          usedFraction: prior.usedFraction, elapsedFraction: prior.elapsedFraction, pace: prior.pace,
          projectedResetUtilizationFraction: prior.projectedResetUtilizationFraction, qualification: prior.qualification,
          sampleCount: prior.sampleCount } }));
      continue;
    }
    if (next.status !== 'available' || prior.status !== 'available') continue;
    const comparable = deriveProviderAccountUsagePace({ snapshot, meterId: meter.meterId, nowMs, history: [previous] });
    const emit = (kind: ConnectedServiceUsageNotificationV1['kind'], pace = next) => {
      events.push(ConnectedServiceUsageNotificationV1Schema.parse({ topic: 'connected_service_usage', kind,
        serviceId: transition.serviceId, profileId: transition.profileId,
        issueFingerprint: fingerprint(kind),
        evidence: { ...pace.window, observedAtMs: kind === 'unused' ? previous.observedAtMs : snapshot.observedAtMs,
          previousObservedAtMs: previous.observedAtMs, witnessedAtMs: snapshot.observedAtMs,
          usedFraction: pace.usedFraction, elapsedFraction: pace.elapsedFraction, pace: pace.pace,
          projectedResetUtilizationFraction: pace.projectedResetUtilizationFraction,
          qualification: pace.qualification, sampleCount: sameWindow && comparable.status === 'available' ? comparable.sampleCount : pace.sampleCount } }));
    };
    if (!sameWindow || comparable.status !== 'available') continue;
    if (prior.pace <= 1 && next.pace > 1) emit('pace');
    if (prior.projectedResetUtilizationFraction <= 1 && next.projectedResetUtilizationFraction > 1) emit('depletion');
    const remainingThreshold = transition.preferences.almostOutRemainingFraction;
    if (remainingThreshold !== null && 1 - prior.usedFraction > remainingThreshold && 1 - next.usedFraction <= remainingThreshold) emit('almost_out');
    const endingBeforeMs = transition.preferences.endingBeforeMs;
    if (endingBeforeMs !== null && prior.window.resetAtMs - previous.observedAtMs > endingBeforeMs
      && next.window.resetAtMs - snapshot.observedAtMs <= endingBeforeMs) emit('ending');
  }
  const creditExpiryBeforeMs = transition.preferences.creditExpiryBeforeMs;
  if (creditExpiryBeforeMs !== null) {
    for (const credit of snapshot.recoveryCredits?.credits ?? []) {
      if (!credit.id || credit.kind === 'unknown' || credit.expiresAtMs == null || credit.redeemedAtMs != null || credit.redeemStartedAtMs != null) continue;
      const prior = previous.recoveryCredits?.credits.find(value => value.id === credit.id);
      if (!prior || prior.status !== 'available' || prior.expiresAtMs !== credit.expiresAtMs || prior.kind !== credit.kind
        || prior.redeemedAtMs != null || prior.redeemStartedAtMs != null
        || prior.providerResetType !== credit.providerResetType || prior.appliesToProviderLimitId !== credit.appliesToProviderLimitId
        || prior.grantedAtMs !== credit.grantedAtMs) continue;
      const availableLead = credit.status === 'available' && credit.expiresAtMs > snapshot.observedAtMs;
      const witnessedExpiry = credit.status === 'expired' && previous.observedAtMs < credit.expiresAtMs && snapshot.observedAtMs >= credit.expiresAtMs;
      if (!availableLead && !witnessedExpiry) continue;
      if (credit.expiresAtMs - previous.observedAtMs <= creditExpiryBeforeMs || credit.expiresAtMs - snapshot.observedAtMs > creditExpiryBeforeMs) continue;
      events.push(ConnectedServiceUsageNotificationV1Schema.parse({ topic: 'connected_service_usage', kind: 'credit_expiry',
        serviceId: transition.serviceId, profileId: transition.profileId,
        issueFingerprint: JSON.stringify([snapshot.recordId, credit.id, credit.expiresAtMs, 'credit_expiry']),
        evidence: { recordId: snapshot.recordId, creditId: credit.id, expiresAtMs: credit.expiresAtMs,
          observedAtMs: snapshot.observedAtMs, previousObservedAtMs: previous.observedAtMs } }));
    }
  }
  return events;
}

export async function dispatchConnectedServiceAutomaticQuotaResetNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  event: AutomaticQuotaResetConsumedEvent;
  nowMs?: () => number;
  dedupeWindowMs?: number;
}>): Promise<void> {
  const { event } = params;
  await dispatchActivityNotificationAsync({
    ...params,
    event: {
      topic: 'connected_service_quota_recovered',
      recoveryReason: 'automatic_quota_reset',
      sessionId: event.sessionId,
      serviceId: event.serviceId,
      serviceDisplayName: resolveConnectedServiceNotificationDisplayName(event.serviceId),
      groupId: event.groupId,
      profileId: event.profileId,
      issueFingerprint: event.receipt.idempotencyKey,
    },
  });
}

export async function dispatchConnectedServiceQuotaLifecycleNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  transition: ConnectedServiceQuotaLifecycleTransition | ConnectedServiceUsageSnapshotTransition;
  nowMs?: () => number;
  dedupeWindowMs?: number;
}> & NotificationDeliveryContext): Promise<void> {
  const transition = params.transition;
  const preferences = accountSettingsParse(params.settings ?? {}).usageQuotaNotificationsV1;
  if (transition.phase === 'observed') {
    for (const event of deriveUsageNotifications({ ...transition, preferences }, (params.nowMs ?? Date.now)())) {
      if (isUsageQuotaNotificationEnabled(preferences, event.kind)) await dispatchActivityNotificationAsync({ ...params, event });
    }
    return;
  }
  const topic = transition.phase === 'blocked'
    ? ('connected_service_quota_blocked' as const)
    : ('connected_service_quota_recovered' as const);
  const nowMs = (params.nowMs ?? (() => Date.now()))();
  const retryAfterMs =
    typeof transition.resetAtMs === 'number' && Number.isFinite(transition.resetAtMs) && transition.resetAtMs > nowMs
      ? Math.trunc(transition.resetAtMs - nowMs)
      : null;

  for (const sessionId of transition.sessionIds) {
    await dispatchActivityNotificationAsync({
      notificationChannelCatalog: params.notificationChannelCatalog,
      savedSecretMaterializer: params.savedSecretMaterializer,
      isCurrent: params.isCurrent,
      pluginNotifications: params.pluginNotifications,
      settings: params.settings,
      settingsSecretsReadKeys: params.settingsSecretsReadKeys,
      expoPushSender: params.expoPushSender,
      event: {
        topic,
        sessionId,
        serviceId: transition.serviceId,
        serviceDisplayName:
          resolveConnectedServiceNotificationDisplayName(transition.serviceId),
        issueFingerprint: transition.issueFingerprint,
        groupId: transition.groupId,
        profileId: transition.activeProfileId,
        limitCategory: 'usage_limit',
        retryAfterMs,
      },
      nowMs: params.nowMs,
      dedupeWindowMs: params.dedupeWindowMs,
    });
  }
}
