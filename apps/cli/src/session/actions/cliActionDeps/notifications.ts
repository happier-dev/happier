import { SAVED_HEALTH_ALERT_TEST_ACTION_ID, WEBHOOK_NOTIFICATION_TEST_ACTION_ID } from '@happier-dev/protocol/actions/notificationConfigurationActionIds';
import type { CliActionDepsParams } from './types';
import type { postWebhookJsonAsync, WebhookDestinationAdmissionError } from '@/notifications/activity/sendWebhookActivityNotification';
import { randomUUID } from 'node:crypto';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { PushNotificationClient } from '@/api/pushNotifications';
import type { dispatchActivityNotificationAsync, listActivityNotificationChannels, NotificationChannelCatalogUnavailableError } from '@/notifications/activity/dispatchActivityNotification';
import type { hydrateNotificationChannelCatalogForActiveAccount, hydrateNotificationChannelCatalogForOperation } from '@/settings/notifications/hydrateNotificationChannelCatalog';
import type { SavedSecretResolutionError } from '@/settings/secrets/savedSecretCatalog';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
type CliNotificationCatalogHost = Pick<CliActionDepsParams, 'credentials' | 'savedSecretOperationContext' | 'serverHttpBaseUrl' | 'serverId' | 'isCredentialCurrent' | 'resolvePluginNotifications'>;

/** Shared Account-custody catalog owner for Actions, saved alert setup and Readiness. */
export function createCliNotificationCatalogForHost(params: CliNotificationCatalogHost) {
  const readNotificationContext = async (signal?: AbortSignal, options?: Readonly<{ maintainSource?: false }>) => {
    const credentials = params.credentials;
    if (!credentials) {
      const { NotificationChannelCatalogUnavailableError } = await import("@/notifications/activity/dispatchActivityNotification");
      throw new NotificationChannelCatalogUnavailableError('unauthorized');
    }
    const operation = params.savedSecretOperationContext;
    const home = operation?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
    const scopeKey = runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKeyForToken(credentials.token));
    const readSnapshot = () => operation ? operation.readSnapshot() : getActiveAccountSettingsSnapshot();
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const isCurrent = async () => !signal?.aborted && readSnapshot()?.scopeKey === scopeKey
      && (operation ? operation.credentials.token === credentials.token && await operation.isCurrent()
        : isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey, lifetimeToken }))
      && (!params.isCredentialCurrent || await params.isCredentialCurrent());
    const assertCurrent = async () => {
      signal?.throwIfAborted();
      if (!await isCurrent()) {
        const { NotificationChannelCatalogUnavailableError } = await import("@/notifications/activity/dispatchActivityNotification");
        throw new NotificationChannelCatalogUnavailableError('scope-retired');
      }
    };
    await assertCurrent();
    let snapshot = readSnapshot();
    if (!snapshot) {
      const { NotificationChannelCatalogUnavailableError } = await import("@/notifications/activity/dispatchActivityNotification");
      throw new NotificationChannelCatalogUnavailableError('scope-retired');
    }
    if (!snapshot.notificationChannelCatalog || snapshot.notificationChannelCatalog.status === 'loading') {
      if (operation) {
        const { hydrateNotificationChannelCatalogForOperation } = await import("@/settings/notifications/hydrateNotificationChannelCatalog");
        const catalog = await hydrateNotificationChannelCatalogForOperation({ operationContext: operation, signal, assertCurrent,
          maintainSource: options?.maintainSource });
        if (catalog.status === 'unavailable' && catalog.reason === 'scope-retired') {
          const { NotificationChannelCatalogUnavailableError } = await import("@/notifications/activity/dispatchActivityNotification");
          throw new NotificationChannelCatalogUnavailableError('scope-retired');
        }
      } else {
        const { hydrateNotificationChannelCatalogForActiveAccount } = await import("@/settings/notifications/hydrateNotificationChannelCatalog");
        await runWithServerHttpBaseUrl(home, () => hydrateNotificationChannelCatalogForActiveAccount({ credentials, scopeKey, lifetimeToken, signal,
          maintainSource: options?.maintainSource }));
      }
      await assertCurrent();
      snapshot = readSnapshot();
    }
    if (!snapshot) {
      const { NotificationChannelCatalogUnavailableError } = await import("@/notifications/activity/dispatchActivityNotification");
      throw new NotificationChannelCatalogUnavailableError('scope-retired');
    }
    const captured = snapshot;
    return { settings: captured.settings, notificationChannelCatalog: captured.notificationChannelCatalog ?? { status: 'loading' as const },
      ...(operation ? { operationContext: operation } : {}), isCurrent };
  };
  const notificationFailure = async (error: unknown) => {
    const [{ NotificationChannelCatalogUnavailableError }, { SavedSecretResolutionError }] = await Promise.all([import("@/notifications/activity/dispatchActivityNotification"), import("@/settings/secrets/savedSecretCatalog")]);
    if (error instanceof NotificationChannelCatalogUnavailableError) return { ok: false as const,
      errorCode: error.code, error: 'Notification channel catalog is unavailable', details: { reason: error.reason } };
    if (error instanceof SavedSecretResolutionError) return { ok: false as const,
      errorCode: error.code, error: 'Notification signing material is unavailable', details: { reason: error.status } };
    throw error;
  };
  const readChannels = async (context: Parameters<NonNullable<ActionExecutorDeps['notificationChannelsList']>>[0],
    options?: Readonly<{ maintainSource?: false }>) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      context.signal?.throwIfAborted();
      try {
        const { PushNotificationClient } = await import("@/api/pushNotifications");
        const { listActivityNotificationChannels } = await import("@/notifications/activity/dispatchActivityNotification");
        const items = await listActivityNotificationChannels({ ...await readNotificationContext(context.signal, options),
          pushTokenReader: new PushNotificationClient(params.credentials.token,
            params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl,
            params.serverId ?? configuration.activeServerId),
          ...(params.resolvePluginNotifications ? { pluginNotifications: params.resolvePluginNotifications() } : {}) });
        context.signal?.throwIfAborted();
        return { items };
      } catch (error) { return notificationFailure(error); }
  };
  return { readContext: readNotificationContext, readChannels, projectFailure: notificationFailure };
}

export function createCliNotificationActionDeps(
  params: CliNotificationCatalogHost,
  workflowAction: ActionExecutorDeps['workflowAction'] | null,
): Pick<ActionExecutorDeps, 'notificationChannelsList' | 'webhookCall' | 'notificationsNotifyMe' | 'notificationConfigurationAction' | 'prepareNotificationTestApproval'> {
  const { readContext: readNotificationContext, readChannels, projectFailure: notificationFailure } = createCliNotificationCatalogForHost(params);
  return {
    prepareNotificationTestApproval: async ({ input, context }) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const { createSavedHealthAlertTestApprovalForHost } = await import('@/notifications/activity/savedHealthAlertDelivery');
      return createSavedHealthAlertTestApprovalForHost({ credentials: params.credentials,
        serverId: params.serverId ?? configuration.activeServerId,
        serverHttpBaseUrl: params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      })(input, context);
    },
    notificationConfigurationAction: async ({ actionId, input, context }) => {
      if (actionId === SAVED_HEALTH_ALERT_TEST_ACTION_ID) {
        if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        const [{ createSavedHealthAlertTestForHost }, { NotificationConfigurationActionInputSchemas }] = await Promise.all([
          import('@/notifications/activity/savedHealthAlertDelivery'),
          import('@happier-dev/protocol/actions/notificationConfigurationActionFamily'),
        ]);
        return createSavedHealthAlertTestForHost({ credentials: params.credentials,
          serverId: params.serverId ?? configuration.activeServerId,
          serverHttpBaseUrl: params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
        })(NotificationConfigurationActionInputSchemas[actionId].parse(input), context);
      }
      if (actionId !== WEBHOOK_NOTIFICATION_TEST_ACTION_ID) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const { NotificationConfigurationActionInputSchemas } = await import('@happier-dev/protocol/actions/notificationConfigurationActionFamily');
      const { channelId } = NotificationConfigurationActionInputSchemas[actionId].parse(input);
      const { testWebhookActivityNotificationAsync } = await import('@/notifications/activity/testWebhookActivityNotification');
      try {
        return await testWebhookActivityNotificationAsync({ ...await readNotificationContext(context.signal), channelId, signal: context.signal });
      } catch (error) {
        context.signal?.throwIfAborted();
        const { NotificationChannelCatalogUnavailableError } = await import('@/notifications/activity/dispatchActivityNotification');
        if (error instanceof NotificationChannelCatalogUnavailableError) return { status: 'refused', reason: 'catalog_unavailable' };
        throw error;
      }
    },
    notificationChannelsList: readChannels,
    webhookCall: async (input, context) => {
      context.signal?.throwIfAborted();
      let result: Awaited<ReturnType<typeof postWebhookJsonAsync>>;
      try {
        const { postWebhookJsonAsync } = await import("@/notifications/activity/sendWebhookActivityNotification");
        result = await postWebhookJsonAsync({ ...input,
          idempotencyKey: context.actionRequestId ?? randomUUID(),
          ...(context.signal ? { signal: context.signal } : {}) });
      } catch (error) {
        const { WebhookDestinationAdmissionError } = await import("@/notifications/activity/sendWebhookActivityNotification");
        if (error instanceof WebhookDestinationAdmissionError) {
          return { ok: false, errorCode: 'webhook_destination_rejected', error: 'Webhook destination rejected' };
        }
        throw error;
      }
      return result.status >= 300
        ? { ok: false, errorCode: 'webhook_failed', error: 'Webhook failed', details: result } : result;
    },
    notificationsNotifyMe: async (input, context) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      context.signal?.throwIfAborted();
      if (input.open?.kind === 'session') {
        const { fetchSessionById } = await import("@/session/transport/http/sessionsHttp");
        const session = await fetchSessionById({ reason: 'session-action', token: params.credentials.token, sessionId: input.open.sessionId,
          ...(params.savedSecretOperationContext?.serverHttpBaseUrl || params.serverHttpBaseUrl
            ? { serverUrl: params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl } : {}),
          ...(context.signal ? { signal: context.signal } : {}), accessProjectionVersion: 1 });
        if (session?.id !== input.open.sessionId || !session.effectiveAccess?.capabilities.readTranscript) {
          return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
        }
      } else if (input.open?.kind === 'workflow_run') {
        if (!workflowAction) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        const visible = await workflowAction({ actionId: 'workflow.run.get', input: { runId: input.open.runId }, context });
        if ('errorCode' in visible && visible.ok === false) return visible;
      }
      context.signal?.throwIfAborted();
      try {
      const { PushNotificationClient } = await import("@/api/pushNotifications");
      const { dispatchActivityNotificationAsync } = await import("@/notifications/activity/dispatchActivityNotification");
      return await dispatchActivityNotificationAsync({
        ...await readNotificationContext(context.signal),
        expoPushSender: new PushNotificationClient(params.credentials.token,
          params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl,
          params.serverId ?? configuration.activeServerId),
        ...(params.resolvePluginNotifications ? { pluginNotifications: params.resolvePluginNotifications() } : {}),
        ...(input.channels ? { channels: input.channels } : {}),
        event: { topic: 'notify_me', message: input.message,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.open ? { open: input.open } : {}),
          ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}) },
      });
      } catch (error) { return notificationFailure(error); }
    },
  };
}

