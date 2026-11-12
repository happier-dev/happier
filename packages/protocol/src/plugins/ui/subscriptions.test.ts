import { describe, expect, it } from 'vitest';
import { ManagedServiceNativeLogResultV1Schema } from '../../local/services/nativeLogsV1.js';
import { DaemonPluginUiResourceWatchOpenRequestSchema, DaemonPluginUiResourceWatchOpenResponseSchema } from '../../daemon/contributionRegistryProjection.js';

import {
  PluginUiResourceSubscriptionEventV1Schema,
  PluginUiResourceSubscriptionRequestV1Schema,
  resolvePluginUiHostReadActionIdV1,
} from './subscriptions.js';

describe('plugin UI resource subscriptions', () => {
  it.each([
    ['machines.services.logs', 'machines.services.logs.read'],
    ['deployments.logs', 'deployments.logs.read'],
    ['deployments.health.edge', 'deployments.health.current'],
    ['machines.services.list', 'machines.services.list'],
    ['usage.query', 'usage.query'],
    ['deployments.environments.list', 'deployments.environments.list'],
  ] satisfies Array<[Parameters<typeof resolvePluginUiHostReadActionIdV1>[0], string]>)('admits %s through its canonical %s Action', (hostRead, actionId) => {
    expect(resolvePluginUiHostReadActionIdV1(hostRead)).toBe(actionId);
  });
  it('admits the exact Machine Services list through the same host Resource transport', () => {
    const resource = { hostRead: 'machines.services.list', input: { serverId: 'home-a', machineId: 'machine-a' } };
    expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource, subscriptionId: 'services' }).success).toBe(true);
    expect(DaemonPluginUiResourceWatchOpenRequestSchema.safeParse({ machineId: 'machine-a', subscriptionId: 'services', resource }).success).toBe(true);
    const selected = { ...resource, input: { ...resource.input, environmentId: 'environment-a', composeService: 'web' } };
    expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: selected, subscriptionId: 'services' }).success).toBe(true);
    expect(DaemonPluginUiResourceWatchOpenRequestSchema.safeParse({ machineId: 'machine-a', subscriptionId: 'services', resource: selected }).success).toBe(true);
    expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: { ...resource,
      input: { ...resource.input, composeService: 'web' } }, subscriptionId: 'services' }).success).toBe(false);
    for (const extra of [{ accountId: 'foreign' }, { serviceId: 'other' }]) {
      expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: { ...resource, input: { ...resource.input, ...extra } }, subscriptionId: 'services' }).success).toBe(false);
    }
  });
  it('admits an exact consumer and purpose authority watch without accepting credential or routing inputs', () => {
    const resource = { readAuthority: { consumer: { pluginId: 'acme.external', localId: 'read-ci' }, purpose: 'github', input: {} } };
    expect(PluginUiResourceSubscriptionRequestV1Schema.parse({ resource, subscriptionId: 'authority' }).resource).toEqual(resource);
    expect(DaemonPluginUiResourceWatchOpenRequestSchema.parse({ machineId: 'machine-1', callerPluginId: 'acme.external',
      expectedCallerOccurrenceId: 'occurrence-7', subscriptionId: 'authority', resource }).resource).toEqual(resource);
    expect(DaemonPluginUiResourceWatchOpenResponseSchema.parse({ ok: true, subscriptionId: 'authority' }))
      .toEqual({ ok: true, subscriptionId: 'authority' });
    for (const extra of [{ accountId: 'selected' }, { tokenHash: 'private' }, { machineId: 'foreign' }]) {
      expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: {
        readAuthority: { ...resource.readAuthority, ...extra },
      }, subscriptionId: 'authority' }).success).toBe(false);
    }
  });
  it('admits closed host read references through the incumbent subscription target', () => {
    for (const hostRead of ['usage.query', 'connectedServices.quota.get', 'connectedServices.pools.selection.get', 'discussion.get']) {
      const resource = { hostRead, input: { queries: [] } };
      expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource, subscriptionId: 'host' }).success).toBe(true);
      expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: { ...resource, accountId: 'foreign' }, subscriptionId: 'host' }).success).toBe(false);
    }
    expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: { hostRead: 'settings.set', input: {} }, subscriptionId: 'host' }).success).toBe(false);
  });
  it('admits only the exact active managed-inventory read through its closed Resource reference', () => {
    const managed = { hostRead: 'machines.managed.list', input: { homeId: 'home-a' } };
    expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: managed, subscriptionId: 'managed' }).success).toBe(true);
    for (const extra of [{ accountId: 'foreign' }, { archived: true }, { presetId: 'unrequested' }]) {
      expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: {
        ...managed, input: { ...managed.input, ...extra },
      }, subscriptionId: 'managed' }).success).toBe(false);
    }
  });
  it('keeps preview collection Resources on the canonical exact repository and pull request input', () => {
    const resource = { hostRead: 'deployments.environments.list', input: { serverId: 'home', includeDeleted: true,
      previewRepository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repository' },
      previewPullRequestIds: ['17'] } };
    expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource, subscriptionId: 'preview' }).success).toBe(true);
    for (const input of [{ ...resource.input, previewPullRequestIds: [] }, { ...resource.input, accountId: 'foreign' },
      { previewPullRequestIds: ['17'] }, { includeDeleted: true }, { includeDeleted: true, machineId: 'machine' }]) {
      expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: { ...resource, input }, subscriptionId: 'preview' }).success).toBe(false);
    }
  });

  it('uses subscription ids for events instead of request sequence correlation', () => {
    const request = PluginUiResourceSubscriptionRequestV1Schema.parse({
      resource: { pluginId: 'acme.preview', localId: 'live-status' },
      subscriptionId: 'sub-1',
    });

    expect(PluginUiResourceSubscriptionEventV1Schema.parse({
      version: 1,
      subscriptionId: request.subscriptionId,
      kind: 'invalidated',
      digest: `sha256:${'a'.repeat(64)}`,
    })).toMatchObject({
      subscriptionId: 'sub-1',
      kind: 'invalidated',
    });

    expect(PluginUiResourceSubscriptionEventV1Schema.safeParse({
      version: 1,
      requestSequence: 1,
      kind: 'invalidated',
      digest: `sha256:${'a'.repeat(64)}`,
    }).success).toBe(false);
  });

  it('keeps invalidations payload-free and rejects the retired declarative snapshot vocabulary', () => {
    // Rereadable Resources still invalidate without carrying content. The retired
    // `snapshot` arm carried a full `PluginUiResourceSnapshotV1` payload bound
    // to the declarative session-resource-target vocabulary.
    expect(PluginUiResourceSubscriptionEventV1Schema.safeParse({
      version: 1,
      subscriptionId: 'sub-1',
      kind: 'snapshot',
      snapshot: {
        resource: { kind: 'localService', idPath: '/services/0/id' },
        state: 'available',
        capturedAtMs: 1,
        payload: { status: 'ready' },
      },
    }).success).toBe(false);
    expect(PluginUiResourceSubscriptionEventV1Schema.safeParse({
      version: 1,
      subscriptionId: 'sub-1',
      kind: 'invalidated',
      digest: `sha256:${'a'.repeat(64)}`,
      payload: { status: 'ready' },
    }).success).toBe(false);
    // The digest is the canonical plugin UI digest, not any opaque string.
    expect(PluginUiResourceSubscriptionEventV1Schema.safeParse({
      version: 1,
      subscriptionId: 'sub-1',
      kind: 'invalidated',
      digest: 'not-a-digest',
    }).success).toBe(false);
  });

  it('admits a normalized identified native frame inside a finite Resource page without erasing its identity or metadata', () => {
    const row = { rowId: 'vendor-row', timestampInMs: 1000, level: 'info', message: 'accepted',
      messageTruncated: false, source: 'function', domain: 'example.test', requestMethod: 'GET',
      requestPath: '/health', responseStatusCode: 200 };
    const result = { kind: 'page', page: { rowId: row.rowId, sourceRevision: 'deployment',
      text: `${JSON.stringify(row)}\n`, nextCursor: null, truncated: true } };
    const admitted = ManagedServiceNativeLogResultV1Schema.parse(result);
    expect(admitted).toEqual(result);
  });

  it('carries finite Resource pages in order on the admitted subscription and rejects malformed content', () => {
    const content = { contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`, bytesBase64: 'e30=' };
    const event = { version: 1, subscriptionId: 'pages', kind: 'pages', pages: [content, { ...content, bytesBase64: 'W10=' }] };
    expect(PluginUiResourceSubscriptionEventV1Schema.parse(event)).toEqual(event);
    for (const page of [{ ...content, credential: 'private' }, { ...content, bytesBase64: '***' },
      { ...content, digest: 'invalid' }, { ...content, contentType: '' }]) {
      expect(PluginUiResourceSubscriptionEventV1Schema.safeParse({ ...event, pages: [page] }).success).toBe(false);
    }
    expect(PluginUiResourceSubscriptionEventV1Schema.safeParse({ ...event, resource: 'another-slot' }).success).toBe(false);
  });

  it('keeps acknowledged-async retirement and rejection on the same event union', () => {
    expect(PluginUiResourceSubscriptionEventV1Schema.parse({
      version: 1,
      subscriptionId: 'sub-1',
      kind: 'complete',
    })).toMatchObject({ kind: 'complete', diagnostics: [] });
    expect(PluginUiResourceSubscriptionEventV1Schema.parse({
      version: 1,
      subscriptionId: 'sub-1',
      kind: 'error',
      code: 'stale_surface',
    })).toMatchObject({ kind: 'error', code: 'stale_surface' });
  });

  it('owns the generic host-resource disposal payload used by every host API tier', async () => {
    const subscriptions = await import('./subscriptions.js');
    expect('PluginUiDisposeHostResourceRequestV1Schema' in subscriptions).toBe(true);
    expect('PluginUiResourceUnsubscribeRequestV1Schema' in subscriptions).toBe(false);

    const schema = (subscriptions as unknown as {
      PluginUiDisposeHostResourceRequestV1Schema: {
        parse(value: unknown): unknown;
        safeParse(value: unknown): { success: boolean };
      };
    }).PluginUiDisposeHostResourceRequestV1Schema;
    expect(schema.parse({
      subscriptionId: 'sub-1',
    })).toEqual({
      subscriptionId: 'sub-1',
    });
    expect(schema.safeParse({
      subscriptionId: 'sub-1',
      requestSequence: 1,
    }).success).toBe(false);
  });
});
