import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { NotificationBatchResult } from '@happier-dev/plugin-sdk/notifications';
import type { SessionPullRequestUpdateV1 } from '@happier-dev/channels-protocol/v1';
import { summarizeSessionPullRequestUpdateV1 } from './sessionPullRequestLatestUpdate.js';

export const SESSION_PULL_REQUEST_NOTIFICATION_CATEGORY_ID = 'session-pull-request-updates';

/** A retained update is push-only; C1 owns attention policy and native delivery. */
export async function notifyRetainedSessionPullRequestUpdateForInvocation(input: Readonly<{
  update: SessionPullRequestUpdateV1;
  retainedLeaderId: string;
  sessionId: string;
}>, context: PluginInvocationContext): Promise<NotificationBatchResult> {
  return sendSessionPullRequestNotificationForInvocation({
    sessionId: input.sessionId,
    clientRequestId: input.retainedLeaderId,
    title: 'Pull request update',
    body: `${input.update.pullRequest.repository}#${input.update.pullRequest.number}: ${summarizeSessionPullRequestUpdateV1(input.update)}`,
    type: 'update',
  }, context);
}

/** Credential health is already committed; this is its best-effort phone consequence. */
export async function notifySessionPullRequestCredentialsSuspendedForInvocation(input: Readonly<{
  sessionId: string;
  clientRequestId: string;
  assertCurrent?: () => Promise<void>;
}>, context: PluginInvocationContext): Promise<NotificationBatchResult> {
  return sendSessionPullRequestNotificationForInvocation({
    ...input,
    title: 'Pull request watch needs attention',
    body: 'Reconnect your account to resume pull request updates.',
    type: 'blocked',
  }, context);
}

async function sendSessionPullRequestNotificationForInvocation(input: Readonly<{
  sessionId: string;
  clientRequestId: string;
  title: string;
  body: string;
  type: 'update' | 'blocked';
  assertCurrent?: () => Promise<void>;
}>, context: PluginInvocationContext): Promise<NotificationBatchResult> {
  context.signal.throwIfAborted();
  const session = await context.services.sessions.get(input.sessionId);
  const address = (await session?.summary())?.address;
  context.signal.throwIfAborted();
  if (!address || address.sessionId !== input.sessionId) {
    throw new PluginError({ code: 'channels_pr_notification_unavailable',
      message: 'The PR notification has no admitted exact Session/Home destination.', retryable: true });
  }
  await input.assertCurrent?.();
  context.signal.throwIfAborted();
  const result = await context.services.notifications.send({
    clientRequestId: input.clientRequestId, categoryId: SESSION_PULL_REQUEST_NOTIFICATION_CATEGORY_ID,
    title: input.title, body: input.body,
    type: input.type, data: { sessionId: address.sessionId, serverId: address.serverId, serverUrl: address.serverUrl },
  }, { signal: context.signal });
  const unsettled = result.deliveries.filter(delivery => delivery.status === 'failed' || delivery.status === 'outcomeUnknown');
  if (unsettled.length > 0) {
    throw new PluginError({ code: 'channels_pr_notification_unavailable',
      message: 'The PR notification did not receive a delivery settlement.',
      retryable: unsettled.some(delivery => delivery.status === 'outcomeUnknown' || delivery.retryable === true),
      details: { deliveries: unsettled.map(delivery => ({ status: delivery.status, code: delivery.code })) } });
  }
  return result;
}
