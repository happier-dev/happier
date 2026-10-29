import type { AccountSettings, WorkflowRunUpdateKindV1 } from '@happier-dev/protocol';
import axios from '@/api/client/credentialAxios';
import { resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { GetOtherAccountFollowResponseV1Schema, SessionFollowErrorResponseSchema } from '@happier-dev/protocol/sessions/follow/api';
import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { createSavedSecretMaterializerFromSnapshotV1, type SavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';

import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { WorkflowCoordinatorResult } from '@/daemon/workflows/coordinator';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import {
  dispatchActivityNotificationAsync,
} from './dispatchActivityNotification';
import type { ExpoPushActivityNotificationSender } from './sendExpoPushActivityNotification';

type SettingsSnapshot = Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: () => boolean | Promise<boolean>;
}>;

type CommittedWorkflowTransition = Readonly<{
  run: Readonly<{ id: string }>;
  result: WorkflowCoordinatorResult;
  reviewEntry?: true;
}>;

function updateKindForResult(
  result: WorkflowCoordinatorResult,
): WorkflowRunUpdateKindV1 | null {
  if (result.state === 'succeeded') {
    return result.completedWithFailures === true
      ? 'completed_with_failures'
      : 'completed';
  }
  if (result.state === 'cancelled' || result.state === 'waiting_for_review') return null;
  return result.state;
}

/**
 * Adapts the coordinator's post-CAS hook to the existing Account Activity
 * dispatcher. Lifecycle remains coordinator-owned. Internal/provider failure
 * detail is deliberately not projected; only the closed update kind leaves
 * the daemon until an explicitly safe reason vocabulary has an owner.
 */
export function createWorkflowRunCommittedNotificationHandler(params: Readonly<{
  getSettingsSnapshot?: () => SettingsSnapshot | null;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  dispatch?: typeof dispatchActivityNotificationAsync;
  /** The source Account's captured Home; explicit Run Follow owns its personal terminal delivery. */
  followSource?: Readonly<{ token: string; serverHttpBaseUrl: string }>;
}> = {}): (transition: CommittedWorkflowTransition) => Promise<void> {
  const getSettingsSnapshot: () => SettingsSnapshot | null = params.getSettingsSnapshot ?? getActiveAccountSettingsSnapshot;
  const dispatch = params.dispatch ?? dispatchActivityNotificationAsync;
  return async ({ run, result, reviewEntry }) => {
    const updateKind = reviewEntry === true ? 'review_required' : updateKindForResult(result);
    if (!updateKind) return;
    try {
      if (params.followSource && (result.state === 'succeeded' || result.state === 'failed' || result.state === 'interrupted')) {
        const route = resolveSessionFollowActionRequest('follow.get', { receiver: { kind: 'account' },
          source: { kind: 'workflow_run', runId: run.id } });
        const response = await axios.get(`${params.followSource.serverHttpBaseUrl}${route.path}`, {
          headers: { Authorization: `Bearer ${params.followSource.token}` }, validateStatus: () => true,
        });
        const follow = response.status === 200 ? GetOtherAccountFollowResponseV1Schema.safeParse(response.data) : null;
        const failure = SessionFollowErrorResponseSchema.safeParse(response.data);
        const featureUnavailable = response.status === 404 && failure.success && failure.data.error === 'feature_unavailable';
        // Unavailable configuration is pending; it cannot revive the implicit
        // report path over a person's explicit policy or Unfollow.
        // A definitively disabled Follow feature leaves the incumbent
        // Workflow report available. Unknown/denied source reads stay closed.
        if (!featureUnavailable && (!follow?.success || follow.data.follow !== null)) return;
      }
      const snapshot = getSettingsSnapshot();
      const active = getActiveAccountSettingsSnapshot();
      const incumbent = snapshot === active && active?.scopeKey
        ? { scopeKey: active.scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() } : null;
      await dispatch({
        settings: snapshot?.settings,
        notificationChannelCatalog: snapshot?.notificationChannelCatalog,
        savedSecretMaterializer: snapshot?.savedSecretMaterializer ?? (snapshot === active && active
          ? createSavedSecretMaterializerFromSnapshotV1(active) : undefined),
        isCurrent: snapshot?.isCurrent ?? (incumbent ? () => isActiveAccountSettingsSnapshotLifetimeCurrent(incumbent) : undefined),
        ...(snapshot?.settingsSecretsReadKeys
          ? { settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys }
          : {}),
        ...(params.expoPushSender ? { expoPushSender: params.expoPushSender } : {}),
        event: {
          topic: 'workflow_run_update',
          runId: run.id,
          updateKind,
        },
      });
    } catch (error) {
      logger.debug(
        '[workflowRunNotifications] Failed to dispatch committed Run update',
        serializeAxiosErrorForLog(error),
      );
    }
  };
}

/** Called only after a new invocation hold has been durably committed. */
export function createWorkflowRunReviewEntryNotificationHandler(
  params: Parameters<typeof createWorkflowRunCommittedNotificationHandler>[0] = {},
): (entry: Readonly<{ runId: string }>) => Promise<void> {
  const notify = createWorkflowRunCommittedNotificationHandler(params);
  return async ({ runId }) => await notify({ run: { id: runId }, result: { state: 'waiting_for_review' }, reviewEntry: true });
}
