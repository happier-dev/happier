import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { AccountSettings, ConnectedAccountServiceKey, ConnectedServiceBindingsV2, ConnectedServiceId, SessionContinuationResumePromptModeV1 } from '@happier-dev/protocol';
import { resolveRoutedUsageLimitRecoveryResumePromptMode } from '@/session/usageLimitRecoveryControls/resolveRoutedUsageLimitRecoveryResumePromptMode';
import type { TrackedSession } from "@/daemon/types";
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type { ConnectedServiceRuntimeFailureClassification } from "@/daemon/connectedServices/runtimeAuth/types";
import { createConnectedServiceSwitchDeferralQueue } from "@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue";
import { runSelectionPostSwitchRecovery } from "@/daemon/connectedServices/sessionAuthSwitch/runSelectionPostSwitchRecovery";
import { createConnectedServiceContinuationMessageDispatcher, type ConnectedServiceContinuationInterruption, type RuntimeAuthRecoveryContinuationAdmission } from "@/daemon/connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher";
import type { ConnectedServiceSessionAuthSwitchReason } from "@/daemon/connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore";

export async function resolveContinuationResumePromptMode(
  input: Readonly<{
    serviceId?: ConnectedAccountServiceKey;
    groupId?: string | null;
    explicit?: unknown;
    readAccountSettings?: () => unknown;
    loadGroupPolicy?: () => Promise<unknown> | unknown;
  }>,
): Promise<SessionContinuationResumePromptModeV1> {
  const readAccountSettings =
    input.readAccountSettings ??
    (() => getActiveAccountSettingsSnapshot()?.settings ?? null);
  return await resolveRoutedUsageLimitRecoveryResumePromptMode({
    explicit: input.explicit,
    accountSettings: readAccountSettings(),
    loadGroupPolicy: input.loadGroupPolicy,
  });
}

export function resolveConnectedServiceContinuationOriginId(
  input: Readonly<{
    source: 'daemon_report' | 'scheduler_retry';
    activeTurnId?: string | null;
    reportId?: string | null;
  }>,
): string | null {
  // Intake and replay supply the persisted attempt identity. A live user turn is not that identity.
  const reportId = input.reportId?.trim() ?? '';
  return reportId || null;
}

export function readContinuationCustomResumePrompt(
  settings: AccountSettings | null | undefined,
): string | null {
  return settings?.usageLimitRecoverySettingsV1?.customResumePrompt ?? null;
}

export function createConnectedServiceContinuationHandler(
  params: Readonly<{
    credentials: Parameters<
      typeof updateSessionMetadataWithRetry
    >[0]['credentials'];
    isCurrent?: () => Promise<boolean>;
    interruptedOriginId?: string | null;
    resumePromptMode: SessionContinuationResumePromptModeV1;
    resolveResumePromptMode?: () => Promise<SessionContinuationResumePromptModeV1>;
    customResumePrompt?: string | null;
    recoveryKind?: ConnectedServiceRuntimeFailureClassification['kind'] | null;
    runtimeAuthRecovery?: RuntimeAuthRecoveryContinuationAdmission;
    resolveInterruption: (
      input: Readonly<{
        sessionId: string;
        action: 'hot_applied' | 'restart_requested';
        switchReason?: ConnectedServiceSessionAuthSwitchReason;
      }>,
    ) => ConnectedServiceContinuationInterruption;
  }>,
): (input: Readonly<{
      sessionId: string;
      attemptId: string;
      action: 'hot_applied' | 'restart_requested';
      switchReason?: ConnectedServiceSessionAuthSwitchReason;
    }>) => Promise<void> {
  const continuationMessageDispatcher =
    createConnectedServiceContinuationMessageDispatcher({
      credentials: params.credentials,
      sendMessage: async (...args: Parameters<typeof sendSessionMessage>) => {
        if (params.isCurrent && !(await params.isCurrent()))
          throw new Error('requester_session_not_current');
        return await sendSessionMessage(...args);
      },
    });
  return async (
    input: Readonly<{
      sessionId: string;
      attemptId: string;
      action: 'hot_applied' | 'restart_requested';
      switchReason?: ConnectedServiceSessionAuthSwitchReason;
    }>,
  ) => {
    const interruptedOriginId = params.interruptedOriginId?.trim() ?? '';
    if (!interruptedOriginId) return;
    await continuationMessageDispatcher.enqueueInterruptedOriginContinuation({
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      interruptedOriginId,
      interruption: params.resolveInterruption({
        sessionId: input.sessionId,
        action: input.action,
        switchReason: input.switchReason,
      }),
      resumePromptMode: await params.resolveResumePromptMode?.() ?? params.resumePromptMode,
      customResumePrompt: params.customResumePrompt,
      recoveryKind: params.recoveryKind,
      runtimeAuthRecovery: params.runtimeAuthRecovery,
    });
  };
}

export function createSelectionPostSwitchRecoveryHandler(): (input: Readonly<{
      tracked: TrackedSession;
      sessionId: string;
      normalizedBindings: ConnectedServiceBindingsV2;
      serviceIds: ReadonlySet<ConnectedServiceId>;
      action: 'hot_applied' | 'restart_requested';
      runtimeAuthSelectionsByServiceId?: ReadonlyMap<
        ConnectedServiceId,
        unknown
      >;
    }>) => ReturnType<typeof runSelectionPostSwitchRecovery> {
  return async (
    input: Readonly<{
      tracked: TrackedSession;
      sessionId: string;
      normalizedBindings: ConnectedServiceBindingsV2;
      serviceIds: ReadonlySet<ConnectedServiceId>;
      action: 'hot_applied' | 'restart_requested';
      runtimeAuthSelectionsByServiceId?: ReadonlyMap<
        ConnectedServiceId,
        unknown
      >;
    }>,
  ) => {
    return await runSelectionPostSwitchRecovery({
      ...input,
      runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId,
    });
  };
}

export function resolveConnectedServiceContinuationInterruptionForSwitch(
  input: Readonly<{
    sessionId: string;
    interruptedSessionId?: string | null;
    action: 'hot_applied' | 'restart_requested';
    switchReason?: ConnectedServiceSessionAuthSwitchReason;
    groupSwitchTriggerReason?: string | null;
    failureDriven?: boolean;
    turnDeferralQueue: ReturnType<
      typeof createConnectedServiceSwitchDeferralQueue
    >;
  }>,
): ConnectedServiceContinuationInterruption {
  if (
    input.interruptedSessionId &&
    input.sessionId !== input.interruptedSessionId
  ) {
    return 'none';
  }
  if (
    input.interruptedSessionId === input.sessionId &&
    (input.failureDriven === true ||
      input.groupSwitchTriggerReason === 'usage_limit' ||
      input.groupSwitchTriggerReason === 'auth_expired' ||
      input.groupSwitchTriggerReason === 'refresh_failed')
  ) {
    return 'provider_failed_turn';
  }
  if (
    input.action === 'hot_applied' ||
    input.switchReason === 'pre_turn_group_policy'
  ) {
    return 'none';
  }
  return 'clean_boundary';
}
