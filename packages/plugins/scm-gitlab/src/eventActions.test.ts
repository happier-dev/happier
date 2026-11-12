import { describe, expect, it } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { encodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { gitlabRepositoryEventSourceInstanceId } from '@happier-dev/plugin-sdk/scm';
import { receiveGitlabWebhook, setupGitlabRepositoryEvent } from './eventActions.js';
import { GITLAB_EVENT_LOCAL_IDS, GITLAB_WEBHOOK_CONTRIBUTION_ID } from './events.js';
import { GITLAB_PLUGIN_ID } from './triage/contribution.js';
import { createStubGitlabTransport, GITLAB_TEST_ACCOUNT } from './triage/testkit/gitlabTriage.test-support.js';

const baseUrl = 'https://forge.example/gitlab';
const sourceInstanceId = gitlabRepositoryEventSourceInstanceId(baseUrl, '77');
const endpointId = 'wh_ep_AAECAwQFBgcICQoLDA0ODw';
const sourceDefinition = { automationId: 'automation-1', triggerId: 'trigger-1', triggerRevision: 1,
  sourceSelectorId: '00000000-0000-4000-8000-000000000001',
  eventRef: { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_EVENT_LOCAL_IDS.push }, sourceInstanceId,
  sourceContractVersion: 1, sourceConfig: {}, filter: null, maximumObservationAgeMs: null,
  observationTransport: { kind: 'durablePush', webhookEndpointId: endpointId,
    endpointMaterializationRef: { pluginId: GITLAB_PLUGIN_ID, machineId: 'machine-1', materializationId: 'materialization-1' }, observationStartsAt: 0 },
};
function webhookInput(projectId = 77) {
  const body = new TextEncoder().encode(JSON.stringify({ project: { id: projectId, path_with_namespace: 'acme/widgets' },
    ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40) }));
  return { v: 1, endpoint: { webhookContribution: { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_WEBHOOK_CONTRIBUTION_ID },
    sourceInstanceId, webhookEndpointId: endpointId },
    delivery: { deliveryId: 'delivery-1', attempt: 1, replay: 0, receivedAtMs: 1000, providerDeliveryId: 'gitlab-delivery-1' },
    request: { contentType: 'application/json', headers: [{ name: 'x-gitlab-event', value: 'Push Hook' }],
      rawBodyBytes: body.byteLength, rawBodyBase64: encodeBase64(body, 'base64') },
    verified: { verifier: 'gitlab_token_v1', eventType: 'Push Hook' } };
}
function webhookContext(execute: (id: string, input: unknown) => Promise<unknown>): PluginInvocationContext {
  const transport = createStubGitlabTransport({ respond: () => { throw new Error('Webhook must not contact GitLab'); } });
  // The host Action transport is the system boundary; the SDK admission bridge stays real.
  return { ...transport.context, surface: 'plugin', caller: { kind: 'host', domain: 'ingress', originSurface: 'webhook',
    contribution: { id: GITLAB_WEBHOOK_CONTRIBUTION_ID, qualifiedId: `${GITLAB_PLUGIN_ID}/${GITLAB_WEBHOOK_CONTRIBUTION_ID}` } },
    services: { ...transport.context.services, actions: { execute } } } as unknown as PluginInvocationContext;
}

describe('GitLab repository Event Actions', () => {
  it('resolves the exact account and configured deployment through one authenticated project read', async () => {
    const transport = createStubGitlabTransport({ origin: baseUrl, respond: request => {
      expect(request.url).toBe(`${baseUrl}/api/v4/projects/acme%2Fwidgets`);
      return { status: 200, body: { id: 77, path_with_namespace: 'acme/widgets' } };
    } });
    expect(await setupGitlabRepositoryEvent({ credentialRef: GITLAB_TEST_ACCOUNT, baseUrl: `${baseUrl}/`, repository: 'acme/widgets' }, transport.context))
      .toMatchObject({ v: 1, sourceInstanceId, sourceContractVersion: 1, webhookDelivery: 'required',
        sourceConfig: { credentialRef: GITLAB_TEST_ACCOUNT, repository: { repositoryId: '77', nameWithOwner: 'acme/widgets', baseUrl } } });
    expect(transport.requests).toHaveLength(1);
    expect(transport.materializeCount()).toBe(1);
    await expect(setupGitlabRepositoryEvent({ credentialRef: GITLAB_TEST_ACCOUNT,
      baseUrl: 'https://foreign.example', repository: 'acme/widgets' }, transport.context)).rejects.toMatchObject({ code: 'gitlab_source_unavailable' });
    expect(transport.requests).toHaveLength(1);
    expect(transport.materializeCount()).toBe(1);
  });

  it.each(['admitted', 'rejoined', 'filtered', 'unavailable'] as const)('reports the host %s outcome without inventing an admission', async outcome => {
    const admissions: unknown[] = [];
    const context = webhookContext(async (id, input) => {
      if (id === 'automation.event.sources.list') return { kind: 'page', revision: '1', definitions: [sourceDefinition], nextCursor: null };
      if (id === 'automation.event.source.status.report') return {};
      if (id === 'automation.event.admit') {
        admissions.push(input);
        if (outcome === 'unavailable') throw new Error('Home unavailable');
        return { results: [outcome === 'filtered' ? { kind: 'skipped', reason: 'filtered', checkpointSafe: true }
          : { kind: outcome, runId: 'run-1', checkpointSafe: true }] };
      }
      throw new Error(`Unexpected Action ${id}`);
    });
    expect(await receiveGitlabWebhook(webhookInput(), context)).toEqual(outcome === 'unavailable'
      ? { kind: 'retry', code: 'gitlab.automation-unavailable' }
      : { kind: 'settled', disposition: outcome === 'filtered' ? 'ignored' : 'accepted' });
    expect(admissions).toEqual([expect.objectContaining({ eventRef: sourceDefinition.eventRef,
      occurrenceId: 'gitlab-delivery-1', payload: expect.objectContaining({ after: 'b'.repeat(40) }),
      definitions: [{ automationId: 'automation-1', triggerId: 'trigger-1', triggerRevision: 1,
        sourceSelectorId: sourceDefinition.sourceSelectorId }] })]);
  });

  it('refuses synthetic callers and ignores another project before any host admission', async () => {
    const context = webhookContext(async () => { throw new Error('No host call expected'); });
    expect(await receiveGitlabWebhook(webhookInput(), { ...context, surface: 'cli' })).toEqual({ kind: 'deadLetter', code: 'gitlab_webhook_caller_invalid' });
    expect(await receiveGitlabWebhook(webhookInput(88), context)).toEqual({ kind: 'settled', disposition: 'ignored' });
    expect(await receiveGitlabWebhook({ ...webhookInput(), verified: { verifier: 'github_hmac_sha256_v1', eventType: 'push' } }, context))
      .toEqual({ kind: 'deadLetter', code: 'gitlab_payload_invalid' });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(receiveGitlabWebhook(webhookInput(), { ...context, signal: controller.signal })).rejects.toThrow('cancelled');
  });
});
