import { computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { decodePluginWebhookActionRawBody, PluginWebhookActionInputSchema, type PluginWebhookActionResult } from '@happier-dev/plugin-sdk/webhooks';
import { buildTriageEntryRouteSegmentV1, TRIAGE_PUBLISH_ATTENTION_ACTION_REF_V1, TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TriagePublishAttentionResultV1Schema, TriageReadConfiguredSourceInstancesResultV1Schema,
  isTriageSourceConnectedAccountInstanceV1, type TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { decodeSentryLocalInstanceKey } from '../instances/sentryInstanceConfiguration.js';
import { deriveSentryCollisionScope, isSentryNumericId } from '../instances/sentryCollisionScope.js';
import { SENTRY_ENTRY_KIND_ID } from '../sentryContracts.js';
import { createSentryApiClient } from '../api/sentryApiClient.js';
import { classifySentryFailure } from '../api/sentryFailure.js';
import { readSentryIssue } from '../entries/getIssueOutcome.js';
import { admitSentryEntryInvocation } from './operations.js';

const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const ignored = { kind: 'settled', disposition: 'ignored' } as const;
const failedDelivery = (failure: Pick<TriageSourceFailureV1, 'class' | 'code'>): PluginWebhookActionResult => ({
  kind: failure.class === 'transient' || failure.class === 'rateLimit' ? 'retry' : 'deadLetter', code: failure.code,
});

/** Only the host-verified envelope supplies ingress provenance; provider JSON supplies no authority. */
export async function acceptSentryAttentionWebhook(raw: unknown, context: PluginInvocationContext): Promise<PluginWebhookActionResult> {
  const parsed = PluginWebhookActionInputSchema.safeParse(raw);
  if (!parsed.success || context.surface !== 'plugin' || context.caller?.kind !== 'host'
    || context.caller.domain !== 'ingress' || context.caller.originSurface !== 'webhook'
    || parsed.data.endpoint.webhookContribution.pluginId !== 'happier.sentry'
    || parsed.data.endpoint.webhookContribution.localId !== 'issue-attention'
    || context.caller.contribution.id !== 'issue-attention'
    || context.caller.contribution.qualifiedId !== 'happier.sentry/issue-attention'
    || parsed.data.verified.verifier !== 'sentry_hmac_sha256_v1') return { kind: 'deadLetter', code: 'sentry_webhook_caller_invalid' };
  const input = parsed.data;
  if (input.verified.eventType !== 'issue') return ignored;
  const decoded = decodePluginWebhookActionRawBody(input);
  let body: Record<string, unknown> | null;
  try { body = record(JSON.parse(new TextDecoder().decode(decoded))); }
  catch { return { kind: 'deadLetter', code: 'sentry_webhook_body_invalid' }; }
  if (body?.action !== 'assigned' && body?.action !== 'resolved') return ignored;
  const issue = record(record(body.data)?.issue);
  if (typeof issue?.id !== 'string' || !isSentryNumericId(issue.id)) return { kind: 'deadLetter', code: 'sentry_webhook_issue_invalid' };
  const listing = TriageReadConfiguredSourceInstancesResultV1Schema.safeParse(await context.services.actions.execute(
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1, { v: 1 }, { signal: context.signal },
  ));
  if (!listing.success || listing.data.kind !== 'read' || listing.data.status !== 'complete') return { kind: 'retry', code: 'sentry_configuration_unavailable' };
  const matches = listing.data.instances.filter(row => row.lifecycle === 'active'
    && row.configured.instance.sourceInstanceId === input.endpoint.sourceInstanceId);
  if (matches.length !== 1) return ignored;
  const instance = matches[0]!.configured;
  if (!isTriageSourceConnectedAccountInstanceV1(instance)) return { kind: 'deadLetter', code: 'sentry_configuration_invalid' };
  const scope = decodeSentryLocalInstanceKey(instance.localInstanceKey);
  if (!scope.ok) return { kind: 'deadLetter', code: 'sentry_configuration_invalid' };
  const localRef = { kindId: SENTRY_ENTRY_KIND_ID, entryId: issue.id, collisionScope: deriveSentryCollisionScope(scope.instance) };
  const admitted = admitSentryEntryInvocation({ localInstanceKey: instance.localInstanceKey,
    configurationToken: instance.configuration.token, localRef });
  if (!admitted.ok) return failedDelivery(admitted.failure);
  const client = await createSentryApiClient(context, {
    account: instance.binding.account, deployment: admitted.deployment, nowMs: Date.now,
  });
  const current = await readSentryIssue(client, admitted.instance, localRef.entryId);
  if (current.kind === 'unresolved') return failedDelivery(current.failure);
  if (current.kind !== 'present') return { kind: 'retry', code: 'sentry_issue_unavailable' };
  const entryRef = { source: instance.instance.source, ...current.localRef };
  const resolved = current.snapshot.state.presentation === 'resolved';
  // Terminal facts retire this plugin's stable notice even when resolution cleared its assignee.
  if (!resolved) {
    if (current.assignedTo?.type !== 'user') return ignored;
    // Sentry's public member endpoint and OrganizationMemberEndpoint's native "me"
    // selector identify the authenticated USER, not the organization membership id.
    const viewer = await client.request({
      url: new URL(`/api/0/organizations/${admitted.instance.organizationId}/members/me/`, admitted.deployment.origin).toString(),
      operation: 'organizationMember',
    });
    if (viewer.kind === 'failed') return failedDelivery(viewer.failure);
    if (viewer.response.status !== 200) return failedDelivery(classifySentryFailure({
      kind: 'status', operation: 'organizationMember', nowMs: Date.now(), response: viewer.response,
    }));
    let userId: unknown;
    try { userId = record(record(JSON.parse(viewer.response.bodyText))?.user)?.id; }
    catch { return { kind: 'deadLetter', code: 'sentry_attention_viewer_unavailable' }; }
    if (typeof userId !== 'string' || !isSentryNumericId(userId)) return { kind: 'deadLetter', code: 'sentry_attention_viewer_unavailable' };
    if (current.assignedTo.id !== userId) return ignored;
  }
  const result = TriagePublishAttentionResultV1Schema.safeParse(await context.services.actions.execute(
    TRIAGE_PUBLISH_ATTENTION_ACTION_REF_V1, {
      v: 1, sourceInstanceId: input.endpoint.sourceInstanceId, entryRef, reason: 'assignment', type: 'update',
      title: current.snapshot.title, resolved,
      clientRequestId: computeCanonicalDomainSeparatedDigest('happier.sentry.assignment-notice.v1', [
        input.delivery.deliveryId, buildTriageEntryRouteSegmentV1(entryRef), current.snapshot.title, String(resolved),
      ]),
    }, { signal: context.signal },
  ));
  return result.success && result.data.kind === 'published'
    ? { kind: 'settled', disposition: 'accepted' }
    : { kind: 'retry', code: 'sentry_attention_unavailable' };
}
