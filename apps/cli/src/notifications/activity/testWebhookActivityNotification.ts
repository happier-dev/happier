import type { WebhookNotificationTestResult } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { isNetworkConnectionErrorCode, readNormalizedConnectionErrorCode } from '@/api/client/classifyServerEndpointError';
import { SavedSecretResolutionError } from '@/settings/secrets/savedSecretCatalog';
import { SavedSecretOperationAdmissionError } from '@/settings/secrets/savedSecretCatalogRead';
import { NotificationChannelCatalogUnavailableError, readRuntimeNotificationCatalog } from './runtimeNotificationCatalog';
import { sendWebhookActivityNotificationAsync, WebhookDestinationAdmissionError } from './sendWebhookActivityNotification';

/** A diagnostic uses the same catalog, signing material, admission and sender as delivery. */
export async function testWebhookActivityNotificationAsync(
  params: Parameters<typeof readRuntimeNotificationCatalog>[0] & Readonly<{ channelId: string }>,
): Promise<WebhookNotificationTestResult> {
  try {
    const runtime = await readRuntimeNotificationCatalog(params);
    const channel = runtime.channels.find(channel => channel.id === params.channelId && channel.kind === 'webhook');
    if (!channel || channel.kind !== 'webhook') return { status: 'refused', reason: 'channel_not_found' };
    const savedSecretMaterializer = await runtime.acquireSigningMaterializer(
      channel.signingSecretRef === null ? [] : [channel.signingSecretRef], params.signal);
    await sendWebhookActivityNotificationAsync({ channel, savedSecretMaterializer,
      assertCurrent: () => runtime.assertCurrent(params.signal), signal: params.signal,
      // Explicit diagnostics do not alter enabled/topic/privacy preferences or carry Session content.
      event: { topic: 'notify_me', title: 'Happier webhook test', message: 'Your webhook is working.' },
    });
    return { status: 'delivered' };
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof NotificationChannelCatalogUnavailableError) return { status: 'refused', reason: 'catalog_unavailable' };
    if (error instanceof SavedSecretResolutionError || error instanceof SavedSecretOperationAdmissionError) {
      return { status: 'refused', reason: 'signing_secret_unavailable' };
    }
    const status = readHttpStatus(error);
    if (status !== null && status !== undefined) return { status: 'refused', reason: 'http_rejected', httpStatus: status };
    const cause = error instanceof WebhookDestinationAdmissionError ? error.cause : error;
    const code = readNormalizedConnectionErrorCode(cause);
    if (error instanceof WebhookDestinationAdmissionError && !isNetworkConnectionErrorCode(code)) {
      return { status: 'refused', reason: 'destination_rejected' };
    }
    // Receipts never contain endpoint URLs, response bodies, signing values or raw error messages.
    return { status: 'unreachable', reason: readUnexpectedActionErrorDiagnosticV1(cause).errorCode ?? 'network_error' };
  }
}
