import { expect, it } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { BITBUCKET_PLUGIN_ID } from './bitbucketContracts.js';
import { normalizeBitbucketWebhookDelivery, bitbucketRepositoryEventSourceId, BITBUCKET_EVENT_LOCAL_ID } from './events.js';
import { receiveBitbucketWebhook, setupBitbucketRepositoryEvent } from './eventActions.js';
import { accountRef, createConnectedAccountsStub, createHttpStub, createInvocationContext } from './triage/source/testSupport.js';

const UUID = '{11111111-1111-4111-8111-111111111111}';
const endpointId = 'wh_ep_AAECAwQFBgcICQoLDA0ODw';
function payload() {
  return { actor: { account_id: 'webhook-actor', nickname: 'actor' }, repository: { uuid: UUID, full_name: 'team/repo' },
    pullrequest: { id: 42, state: 'OPEN', author: { account_id: 'true-author', nickname: 'Public display nickname' },
      source: { branch: { name: 'feature' }, commit: { hash: 'a'.repeat(40) },
        repository: { uuid: '{22222222-2222-4222-8222-222222222222}', full_name: 'contributor/fork' } },
      destination: { branch: { name: 'main' }, repository: { uuid: UUID, full_name: 'team/repo' } } } };
}
function delivery(eventType = 'pullrequest:created', body = payload()) {
  const bytes = Buffer.from(JSON.stringify(body));
  return { v: 1, endpoint: { webhookContribution: { pluginId: BITBUCKET_PLUGIN_ID, localId: 'bitbucket-events' },
    webhookEndpointId: endpointId, sourceInstanceId: bitbucketRepositoryEventSourceId(UUID) },
    delivery: { deliveryId: 'delivery-1', attempt: 1, replay: 0, receivedAtMs: 1000, providerDeliveryId: 'vendor-delivery-1' },
    request: { contentType: 'application/json', headers: [{ name: 'x-event-key', value: eventType }],
      rawBodyBytes: bytes.byteLength, rawBodyBase64: bytes.toString('base64') },
    verified: { verifier: 'bitbucket_hmac_sha256_v1', eventType } };
}

it('resolves the selected repository with its exact Account and propagates provider refusal and cancellation', async () => {
  const { connectedAccounts, materializations } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
  const { http, requests } = createHttpStub(() => ({ body: { uuid: UUID, full_name: 'team/repo' } }));
  const input = { credentialRef: accountRef('account-1'), repository: 'Team/Repo' };
  const setup = await setupBitbucketRepositoryEvent(input, createInvocationContext(connectedAccounts, http));
  expect(setup).toMatchObject({ sourceContractVersion: 1, sourceInstanceId: bitbucketRepositoryEventSourceId(UUID),
    sourceConfig: { v: 1, credentialRef: input.credentialRef, repository: { repositoryId: UUID, nameWithOwner: 'team/repo' } },
    webhookDelivery: 'required' });
  expect(materializations).toEqual(['account-1']);
  expect(requests.map(({ url }) => url)).toEqual(['https://api.bitbucket.org/2.0/repositories/team/repo']);
  const refused = createHttpStub(() => ({ status: 403, body: {} }));
  await expect(setupBitbucketRepositoryEvent(input, createInvocationContext(connectedAccounts, refused.http))).rejects.toMatchObject({ code: 'bitbucket_source_unavailable' });
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await expect(setupBitbucketRepositoryEvent(input, createInvocationContext(connectedAccounts, http, controller.signal))).rejects.toThrow('cancelled');
});

it('uses native code-push facts, preserves fork head and true author, and refuses incomplete pinned heads', () => {
  const normalize = (eventType: string, body = payload()) => normalizeBitbucketWebhookDelivery({ eventType,
    providerDeliveryId: 'vendor-delivery-1', receivedAtMs: 1000, rawBody: Buffer.from(JSON.stringify(body)) });
  expect(normalize('pullrequest:push')?.payload.pullRequest).toMatchObject({ action: 'synchronize', headSha: 'a'.repeat(40),
    baseRepository: { repository: 'team/repo' }, headRepository: { repository: 'contributor/fork' },
    author: { id: 'true-author', login: null, kind: 'unsupported' }, authorAssociation: 'unknown' });
  for (const number of [42, 43]) {
    const body = payload(); body.pullrequest.id = number;
    expect(normalize('pullrequest:push', body)).toMatchObject({ payload: { reviewTarget: {
      entryRef: { source: { pluginId: BITBUCKET_PLUGIN_ID, localId: 'bitbucket-forge' },
        kindId: 'pull-request', collisionScope: `bitbucket:${UUID}`, entryId: String(number) },
      lastKnownLocator: { v: 1, routingToken: 'team/repo' },
      comparisonSource: { kind: 'pullRequest', locator: { providerId: 'bitbucket',
        repository: 'team/repo', number, headOid: 'a'.repeat(40) } },
    } } });
  }
  expect(normalize('pullrequest:updated')).toBeNull();
  const incomplete = payload(); incomplete.pullrequest.source.commit.hash = 'a'.repeat(12);
  expect(() => normalize('pullrequest:push', incomplete)).toThrow();
  for (const [eventType, state, action] of [['pullrequest:fulfilled', 'MERGED', 'merged'], ['pullrequest:rejected', 'DECLINED', 'closed']] as const) {
    const body = payload(); body.pullrequest.state = state;
    expect(normalize(eventType, body)?.payload.pullRequest.action).toBe(action);
  }
});

it('admits host-authenticated deliveries through the SDK, preserving source scope and retry recovery', async () => {
  const credentialRef = accountRef('account-1');
  const admissions: unknown[] = [];
  let admissionAvailable = true;
  const source = { automationId: 'automation-1', triggerId: 'trigger-1', triggerRevision: 1,
    sourceSelectorId: '00000000-0000-4000-8000-000000000001',
    eventRef: { pluginId: BITBUCKET_PLUGIN_ID, localId: BITBUCKET_EVENT_LOCAL_ID },
    sourceInstanceId: bitbucketRepositoryEventSourceId(UUID), sourceContractVersion: 1,
    sourceConfig: { v: 1, credentialRef, repository: { repositoryId: UUID, nameWithOwner: 'team/repo' } },
    filter: null, maximumObservationAgeMs: null,
    observationTransport: { kind: 'durablePush', webhookEndpointId: endpointId,
      endpointMaterializationRef: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: BITBUCKET_PLUGIN_ID }, observationStartsAt: 0 } };
  // Only the host Action transport is doubled; listing and admission use the real SDK.
  const context = { surface: 'plugin', signal: new AbortController().signal,
    caller: { kind: 'host', domain: 'ingress', originSurface: 'webhook',
      contribution: { id: 'bitbucket-events', qualifiedId: `${BITBUCKET_PLUGIN_ID}/bitbucket-events` } },
    services: { actions: { execute: async (id: string, input: unknown) => {
      if (id === 'automation.event.sources.list') return { kind: 'page', revision: '1', definitions: [source], nextCursor: null };
      if (id === 'automation.event.source.status.report') return {};
      if (!admissionAvailable) throw new Error('transport unavailable');
      if (id === 'automation.event.admit') { admissions.push(input); return { results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }] }; }
      throw new Error(`Unexpected host action ${id}`);
    } } },
  } as unknown as PluginInvocationContext;
  expect(await receiveBitbucketWebhook(delivery(), context)).toEqual({ kind: 'settled', disposition: 'accepted' });
  expect(admissions).toHaveLength(1);
  expect(JSON.stringify(admissions)).toContain('true-author');
  expect(JSON.stringify(admissions)).not.toContain('webhook-actor');
  const wrong = delivery(); wrong.endpoint.sourceInstanceId = 'bitbucket:repository:other';
  expect(await receiveBitbucketWebhook(wrong, context)).toEqual({ kind: 'settled', disposition: 'ignored' });
  expect(await receiveBitbucketWebhook(delivery(), { ...context, surface: 'ui' })).toMatchObject({ kind: 'deadLetter' });
  admissionAvailable = false;
  expect(await receiveBitbucketWebhook(delivery('pullrequest:push'), context)).toMatchObject({ kind: 'retry' });
});
