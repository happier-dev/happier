import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/plugin-sdk/events';
import { encodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import { AZURE_DEVOPS_PLUGIN_ID } from './azureDevopsContracts.js';
import { AZURE_DEVOPS_PLUGIN } from './manifest.js';
import {
  AZURE_DEVOPS_CONNECTED_ACCOUNT_ID,
  AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID,
  AZURE_DEVOPS_TRIAGE_KIND_ID,
  AZURE_DEVOPS_TRIAGE_PURPOSE,
} from './triage/descriptor.js';

const baseUrl = 'https://dev.azure.com/Fabrikam';
const account = {
  service: { pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: AZURE_DEVOPS_CONNECTED_ACCOUNT_ID },
  accountId: 'azure-personal',
};
const repository = {
  id: 'b1b1b1b1-cccc-dddd-eeee-f2f2f2f2f2f2',
  name: 'Widget',
  project: { id: 'f5f5f5f5-aaaa-bbbb-cccc-d6d6d6d6d6d6', name: 'Engineering' },
  remoteUrl: `${baseUrl}/Engineering/_git/Widget`,
};
const webhookEndpointId = 'wh_ep_AAECAwQFBgcICQoLDA0ODw';
const providerEventId = 'a0a0a0a0-bbbb-cccc-dddd-e1e1e1e1e1e1';
const providerAuthorId = '11bb11bb-cc22-dd33-ee44-55ff55ff55ff';
const head = 'a'.repeat(40);
const baseHead = 'd'.repeat(40);
const eventAt = '2026-11-17T15:36:00.000Z';
const receivedAtMs = Date.parse(eventAt) + 1000;

const sourceInput = {
  baseUrl,
  credentialRef: account,
  project: repository.project.id,
  repository: repository.id,
  changes: 'sourceBranch',
};

async function createHarness(configuredBase = baseUrl) {
  const setup = AZURE_DEVOPS_PLUGIN.manifest.contributes.events?.find(({ id }) => id === 'automation/pull-request-lifecycle-v1')?.automation?.source;
  expect(setup, 'Azure DevOps should offer a pull-request lifecycle Event source').toBeDefined();
  if (!setup) throw new Error('Azure DevOps pull-request lifecycle Event is missing');
  const materializeListedAccount = vi.fn(async () => ({
    kind: 'httpHeaders' as const,
    headers: { authorization: 'Basic expected-account' },
  }));
  const request = vi.fn(async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      ...repository, remoteUrl: `${configuredBase}/Engineering/_git/Widget`,
    })),
  }));
  // Connected Account and provider HTTP calls cross host and network boundaries.
  const connectedAccounts = {
    listAccounts: async () => ({
      status: 'complete',
      accounts: [
        { account, displayName: 'Personal', state: 'connected',
          connectedAccountBases: [configuredBase], connectedAccountOrigins: [new URL(configuredBase).origin] },
        { account: { ...account, accountId: 'other-connection' }, displayName: 'Other', state: 'connected',
          connectedAccountBases: ['https://dev.azure.com/Other'], connectedAccountOrigins: ['https://dev.azure.com'] },
      ],
    }),
    materializeListedAccount,
  } as Pick<ConnectedAccountsService, 'listAccounts' | 'materializeListedAccount'> as ConnectedAccountsService;
  const kit = await createPluginTestkit({
    manifest: AZURE_DEVOPS_PLUGIN.manifest,
    module: AZURE_DEVOPS_PLUGIN,
    services: { connectedAccounts, http: createPluginHttpFixture({ request }) },
  });
  return { kit, setup, request, materializeListedAccount };
}

function webhookBody(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: providerEventId,
    eventType: 'git.pullrequest.created',
    publisherId: 'tfs',
    createdDate: eventAt,
    resource: {
      repository,
      pullRequestId: 17,
      status: 'active',
      createdBy: { id: providerAuthorId, displayName: 'Original author' },
      updatedBy: { id: 'delivery-actor' },
      forkSource: { repository: { remoteUrl: `${baseUrl}/Forks/_git/ContributorWidget` } },
      sourceRefName: 'refs/heads/topic',
      targetRefName: 'refs/heads/main',
      lastMergeSourceCommit: { commitId: head },
      lastMergeTargetCommit: { commitId: baseHead },
      lastMergeCommit: { commitId: 'b'.repeat(40) },
    },
    ...overrides,
  };
}

function webhookInput(contributionId: string, sourceInstanceId: string, body: unknown, providerDeliveryId = 'host-generated-id') {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    v: 1,
    endpoint: {
      webhookContribution: { pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: contributionId },
      sourceInstanceId,
      webhookEndpointId,
    },
    delivery: { deliveryId: 'delivery-1', attempt: 1, replay: 0, receivedAtMs, providerDeliveryId },
    request: { contentType: 'application/json', headers: [], rawBodyBytes: bytes.byteLength, rawBodyBase64: encodeBase64(bytes, 'base64') },
    verified: { verifier: 'capabilityUrl_v1' },
  };
}

describe('Azure DevOps pull-request lifecycle Event', () => {
  it('reads one repository using the selected account and refuses another organization on the same origin', async () => {
    const { kit, setup, request, materializeListedAccount } = await createHarness();
    try {
      const source = await kit.invokeAction(setup.setupActionRef.localId, sourceInput);
      expect(source).toMatchObject({
        v: 1,
        sourceContractVersion: 1,
        webhookDelivery: 'required',
        sourceConfig: { credentialRef: account, repository: { id: repository.id, baseUrl } },
      });
      expect(materializeListedAccount).toHaveBeenCalledExactlyOnceWith({
        purpose: AZURE_DEVOPS_TRIAGE_PURPOSE,
        account,
        materialization: { kind: 'httpHeaders', origin: 'https://dev.azure.com', headerNames: ['authorization'] },
      }, expect.anything());
      expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        method: 'GET',
        url: `${baseUrl}/${repository.project.id}/_apis/git/repositories/${repository.id}?api-version=7.1`,
        headers: { accept: 'application/json', authorization: 'Basic expected-account' },
      }), expect.anything());
      await expect(kit.invokeAction(setup.setupActionRef.localId, { ...sourceInput, baseUrl: 'https://dev.azure.com/Other' }))
        .rejects.toMatchObject({ details: { cause: 'azure-devops/configured-base-stale' } });
      expect(request).toHaveBeenCalledTimes(1);
      expect(materializeListedAccount).toHaveBeenCalledTimes(1);
    } finally {
      await kit.dispose();
    }
  });

  it('returns the exact source config for a long Azure Server collection address', async () => {
    const collection = 'https://azure.example.test/company/engineering/tfs/Fabrikam';
    const { kit, setup } = await createHarness(collection);
    try {
      await expect(kit.invokeAction(setup.setupActionRef.localId, { ...sourceInput, baseUrl: collection }))
        .resolves.toMatchObject({
          webhookDelivery: 'required',
          sourceConfig: { credentialRef: account, repository: { id: repository.id, baseUrl: collection } },
        });
    } finally {
      await kit.dispose();
    }
  });

  it('adopts the vendor occurrence, original author and exact review target through durable admission', async () => {
    const { kit, setup } = await createHarness();
    try {
      const source = PluginEventAutomationSetupResultV1Schema.parse(await kit.invokeAction(setup.setupActionRef.localId, sourceInput));
      const webhook = AZURE_DEVOPS_PLUGIN.manifest.contributes.webhooks?.find(({ id }) => id === setup.webhookContributionRef?.localId);
      expect(webhook?.verifier).toEqual({ kind: 'capabilityUrl_v1', routing: 'accountEndpoint' });
      if (!webhook || !('handlerAction' in webhook)) throw new Error('Azure DevOps webhook handler is missing');
      const handler = kit.registration('actions', webhook.handlerAction.localId);
      if (!handler) throw new Error('Azure DevOps webhook handler was not activated');

      const eventRef = { pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: 'automation/pull-request-lifecycle-v1' };
      const definition = {
        automationId: 'automation-1', triggerId: 'trigger-1', triggerRevision: 1,
        sourceSelectorId: '00000000-0000-4000-8000-000000000001',
        eventRef, sourceInstanceId: source.sourceInstanceId, sourceContractVersion: 1, sourceConfig: source.sourceConfig,
        filter: null, maximumObservationAgeMs: null,
        observationTransport: { kind: 'durablePush', webhookEndpointId, observationStartsAt: 0,
          endpointMaterializationRef: { pluginId: AZURE_DEVOPS_PLUGIN_ID, machineId: 'machine-1', materializationId: 'materialization-1' } },
      };
      const execute = vi.fn(async (action: string, _input: unknown) => {
        switch (action) {
          case 'automation.event.sources.list':
            return { kind: 'page', revision: '1', definitions: [definition], nextCursor: null };
          case 'automation.event.source.status.report':
            return {};
          case 'automation.event.admit':
            return { results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }] };
          default:
            throw new Error(`Unexpected host Action ${action}`);
        }
      });
      // The daemon's authenticated ingress and host Action transport are the system boundaries.
      const context = {
        surface: 'plugin', signal: new AbortController().signal,
        caller: { kind: 'host', domain: 'ingress', originSurface: 'webhook',
          contribution: { id: webhook.id, qualifiedId: `${AZURE_DEVOPS_PLUGIN_ID}/${webhook.id}` } },
        services: { actions: { execute } as unknown as ActionsService },
      } as unknown as PluginInvocationContext;
      const input = webhookInput(webhook.id, source.sourceInstanceId, webhookBody());

      await expect(handler(input, context)).resolves.toEqual({ kind: 'settled', disposition: 'accepted' });
      await expect(handler({ ...input, delivery: { ...input.delivery, providerDeliveryId: 'another-host-id' } }, context))
        .resolves.toEqual({ kind: 'settled', disposition: 'accepted' });
      const admissions = execute.mock.calls.filter(([id]) => id === 'automation.event.admit').map(([, value]) => value);
      expect(admissions).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
        eventRef,
        occurrenceId: providerEventId,
        occurredAt: Date.parse(eventAt),
        payload: {
          repository: expect.objectContaining({ id: repository.id }),
          pullRequest: expect.objectContaining({
            id: '17', number: 17, action: 'opened', headSha: head,
            baseRepository: { kind: 'azure-devops', deployment: baseUrl, repository: 'Fabrikam/Engineering/Widget' },
            headRepository: { kind: 'azure-devops', deployment: baseUrl, repository: 'Fabrikam/Forks/ContributorWidget' },
            author: expect.objectContaining({ id: providerAuthorId, login: null }),
            authorAssociation: 'unknown',
          }),
          reviewTarget: {
            entryRef: {
              source: { pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID },
              kindId: AZURE_DEVOPS_TRIAGE_KIND_ID,
              collisionScope: `azure-devops:${encodeBase64(new TextEncoder().encode(baseUrl), 'base64url')}:${repository.id}`,
              entryId: '17',
            },
            lastKnownLocator: { v: 1, routingToken: 'Fabrikam/Engineering/Widget' },
            comparisonSource: { kind: 'pullRequest', locator: {
              providerId: 'azure-devops', repository: 'Fabrikam/Engineering/Widget', number: 17, baseOid: baseHead, headOid: head,
            } },
          },
        },
      })));

      const statusSource = PluginEventAutomationSetupResultV1Schema.parse(await kit.invokeAction(
        setup.setupActionRef.localId, { ...sourceInput, changes: 'status' },
      ));
      expect(statusSource.sourceInstanceId).not.toBe(source.sourceInstanceId);
      const anotherHead = 'c'.repeat(40);
      const original = webhookBody();
      const update = { ...original, id: 'a0a0a0a0-bbbb-cccc-dddd-e1e1e1e1e1e2', eventType: 'git.pullrequest.updated',
        resource: { ...original.resource, pullRequestId: 18, lastMergeSourceCommit: { commitId: anotherHead } } };
      execute.mockClear();
      await expect(handler(webhookInput(webhook.id, source.sourceInstanceId, update), context))
        .resolves.toEqual({ kind: 'settled', disposition: 'accepted' });
      definition.sourceInstanceId = statusSource.sourceInstanceId;
      definition.sourceConfig = statusSource.sourceConfig;
      await expect(handler(webhookInput(webhook.id, statusSource.sourceInstanceId, update), context))
        .resolves.toEqual({ kind: 'settled', disposition: 'accepted' });
      expect(execute.mock.calls.filter(([id]) => id === 'automation.event.admit').map(([, value]) => value)).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({
          pullRequest: expect.objectContaining({ number: 18, action: 'synchronize', headSha: anotherHead }),
          reviewTarget: expect.objectContaining({ entryRef: expect.objectContaining({ entryId: '18' }),
            comparisonSource: expect.objectContaining({ locator: expect.objectContaining({ number: 18, headOid: anotherHead }) }) }),
        }) }),
        expect.objectContaining({ payload: expect.objectContaining({
          pullRequest: expect.objectContaining({ number: 18, action: 'reopened', headSha: anotherHead }),
        }) }),
      ]);

      execute.mockClear();
      await expect(handler(input, { ...context, surface: 'cli' })).resolves.toMatchObject({ kind: 'deadLetter' });
      await expect(handler(webhookInput(webhook.id, statusSource.sourceInstanceId, original), context))
        .resolves.toEqual({ kind: 'settled', disposition: 'ignored' });
      await expect(handler(webhookInput(webhook.id, statusSource.sourceInstanceId, {
        ...update, resource: { ...update.resource, status: 'completed' },
      }), context)).resolves.toEqual({ kind: 'settled', disposition: 'ignored' });
      const otherSource = webhookBody();
      const badInput = webhookInput(webhook.id, source.sourceInstanceId, {
        ...otherSource, resource: { ...otherSource.resource, repository: { ...repository, id: 'b1b1b1b1-cccc-dddd-eeee-f2f2f2f2f2f3' } },
      });
      await expect(handler(badInput, context)).resolves.toEqual({ kind: 'settled', disposition: 'ignored' });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await kit.dispose();
    }
  });
});
