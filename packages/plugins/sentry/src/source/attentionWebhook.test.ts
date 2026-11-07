import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { definePluginWebhookTestFixture } from '@happier-dev/plugin-sdk/webhooks';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import issueDetail from '../fixtures/issueDetail.json' with { type: 'json' };
import { encodeSentryInstanceConfiguration } from '../instances/sentryInstanceConfiguration.js';
import { SENTRY_CONNECTED_ACCOUNT_PURPOSE, SENTRY_SCOPE_SEPARATOR } from '../sentryContracts.js';

describe('registered Sentry verified assignment ingress', () => {
  it('updates and resolves one exact assignment item through current source reads, and rejects a forged caller', async () => {
    const sourceInstanceId = '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05';
    const instance = { v: 1,
      instance: { source: { pluginId: 'happier.sentry', localId: 'sentry-issues' }, sourceInstanceId },
      binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
        account: { service: { pluginId: 'happier.sentry', localId: 'sentry-account' }, accountId: 'account-1' } },
      localInstanceKey: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`,
      configuration: { v: 1, token: encodeSentryInstanceConfiguration({ v: 1, organizationId: '7701',
        projectScope: { kind: 'all' }, environmentScope: { kind: 'all' } }) },
    };
    const publications: Readonly<{ ref: unknown; input: unknown }>[] = [];
    let issueReads = 0;
    let viewerReads = 0;
    let materializations = 0;
    let resolved = false;
    let assignedTo: typeof issueDetail.body.assignedTo | null = issueDetail.body.assignedTo;
    let viewerStatus = 200;
    let viewer: unknown = { id: '9001', user: { id: issueDetail.body.assignedTo.id } };
    const context = {
      signal: new AbortController().signal, surface: 'plugin', invokedAtMs: 1,
      plugin: { id: 'happier.sentry', version: '0.0.0' },
      contribution: { id: 'sentry/accept-attention-webhook', qualifiedId: 'happier.sentry/actions/sentry/accept-attention-webhook' },
      caller: { kind: 'host', domain: 'ingress', originSurface: 'webhook',
        contribution: { id: 'issue-attention', qualifiedId: 'happier.sentry/issue-attention' } },
      services: {
        actions: { execute: async (ref: { localId?: string }, input: unknown) => {
          if (ref.localId === 'attention/publish-v1') {
            publications.push({ ref, input });
            return { v: 1, kind: 'published', itemId: 'target-owned-notice' };
          }
          return { kind: 'read', status: 'complete', instances: [{ v: 1, lifecycle: 'active', configured: instance }] };
        } },
        connectedAccounts: {
          listAccounts: async () => ({ status: 'complete', accounts: [{ account: instance.binding.account, state: 'connected',
            connectedAccountOrigins: ['https://us.sentry.io'], connectedAccountBases: ['https://us.sentry.io'] }] }),
          materializeListedAccount: async () => {
            materializations += 1;
            return { kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-token' } };
          },
        },
        http: createPluginHttpFixture({ request: async input => {
          if (new URL(input.url).pathname.endsWith('/members/me/')) {
            expect(input.url).toBe('https://us.sentry.io/api/0/organizations/7701/members/me/');
            viewerReads += 1;
            return { status: viewerStatus, finalUrl: input.url, headers: {},
              body: new TextEncoder().encode(JSON.stringify(viewer)) };
          }
          issueReads += 1;
          return { status: 200, finalUrl: input.url, headers: {},
            body: new TextEncoder().encode(JSON.stringify({ ...issueDetail.body, assignedTo, ...(resolved ? { status: 'resolved' } : {}) })) };
        } }),
        notifications: { send: async () => { throw new Error('Attention must be published by the target, whose page owns the destination'); } },
      },
    } as unknown as PluginInvocationContext;
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const inputFor = (action: 'assigned' | 'resolved', deliveryId: string) => {
      const body = Buffer.from(JSON.stringify({ action, data: { issue: issueDetail.body } }));
      return definePluginWebhookTestFixture({ webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        input: { v: 1, endpoint: { webhookContribution: { pluginId: 'happier.sentry', localId: 'issue-attention' }, sourceInstanceId },
          delivery: { deliveryId, providerDeliveryId: deliveryId, attempt: 1, replay: 0, receivedAtMs: 1 },
          request: { contentType: 'application/json', headers: [{ name: 'sentry-hook-resource', value: 'issue' }],
            rawBodyBytes: body.byteLength, rawBodyBase64: body.toString('base64') },
          verified: { verifier: 'sentry_hmac_sha256_v1', eventType: 'issue' } },
        result: { kind: 'settled', disposition: 'accepted' },
      }).input;
    };
    try {
      const handler = kit.registration('actions', 'sentry/accept-attention-webhook');
      expect(handler).toBeTypeOf('function');
      if (!handler) throw new Error('Verified assignment handler must be registered');
      const assignment = inputFor('assigned', 'delivery-1');
      const declaration = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'sentry/accept-attention-webhook');
      expect(declaration?.inputSchema).toBeDefined();
      expect(declaration?.resultSchema).toBeDefined();
      if (!declaration?.inputSchema || !declaration.resultSchema) throw new Error('Verified webhook Action schemas must be declared');
      const validateInput = compilePluginJsonSchema(declaration.inputSchema);
      const validateResult = compilePluginJsonSchema(declaration.resultSchema);
      expect(isValidPluginJsonSchemaValue(validateInput, assignment)).toBe(true);
      expect(isValidPluginJsonSchemaValue(validateInput, {
        ...assignment, delivery: { ...assignment.delivery, attempt: 0 },
      })).toBe(false);
      expect(isValidPluginJsonSchemaValue(validateInput, { ...assignment, unverified: true })).toBe(false);
      for (const result of [{ kind: 'settled', disposition: 'accepted' },
        { kind: 'settled', disposition: 'ignored' }, { kind: 'retry', code: 'upstream.busy' },
        { kind: 'deadLetter', code: 'sentry_attention_viewer_unavailable' }]) {
        expect(isValidPluginJsonSchemaValue(validateResult, result)).toBe(true);
      }
      expect(isValidPluginJsonSchemaValue(validateResult, { kind: 'settled', disposition: 'retry' })).toBe(false);
      expect(isValidPluginJsonSchemaValue(validateResult, { kind: 'retry', code: 'invalid code' })).toBe(false);
      expect(await handler(assignment, { ...context, caller: undefined })).toMatchObject({ kind: 'deadLetter' });
      expect(issueReads).toBe(0); expect(viewerReads).toBe(0); expect(publications).toHaveLength(0);
      assignedTo = { ...issueDetail.body.assignedTo, id: '999' };
      expect(await handler(assignment, context)).toEqual({ kind: 'settled', disposition: 'ignored' });
      assignedTo = { ...issueDetail.body.assignedTo, type: 'team' };
      expect(await handler(assignment, context)).toEqual({ kind: 'settled', disposition: 'ignored' });
      assignedTo = issueDetail.body.assignedTo;
      viewerStatus = 403;
      expect(await handler(assignment, context)).toMatchObject({ kind: 'deadLetter', code: 'sentry-insufficient-permission' });
      viewerStatus = 200; viewer = { user: null };
      expect(await handler(assignment, context)).toMatchObject({ kind: 'deadLetter', code: 'sentry_attention_viewer_unavailable' });
      expect(publications).toHaveLength(0);
      viewer = { id: '9001', user: { id: issueDetail.body.assignedTo.id } };
      expect(await handler(assignment, context)).toEqual({ kind: 'settled', disposition: 'accepted' });
      expect(publications).toHaveLength(1);
      expect(publications[0]).toMatchObject({ ref: { pluginId: 'happier.triage', localId: 'attention/publish-v1' },
        input: { type: 'update', resolved: false, sourceInstanceId,
          entryRef: { source: instance.instance.source, entryId: issueDetail.body.id } } });
      resolved = true; assignedTo = null;
      expect(await handler(inputFor('resolved', 'delivery-2'), context)).toEqual({ kind: 'settled', disposition: 'accepted' });
      expect(publications[1]).toMatchObject({ ref: publications[0]?.ref,
        input: { entryRef: { source: instance.instance.source, entryId: issueDetail.body.id }, resolved: true } });
      expect(issueReads).toBe(6);
      expect(viewerReads).toBe(4);
      expect(materializations).toBe(6);
    } finally { await kit.dispose(); }
  });
});
