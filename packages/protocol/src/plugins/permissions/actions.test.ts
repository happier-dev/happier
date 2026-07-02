import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';
import { ActionIdSchema } from '../../actions/actionIds.js';
import { getActionSpec } from '../../actions/actionSpecs.js';

const GRANT_ACTION_IDS = [
  'plugins.permissions.grants.list',
  'plugins.permissions.grants.request',
  'plugins.permissions.grants.grant',
  'plugins.permissions.grants.revoke',
  'plugins.permissions.grants.dismissRequest',
] as const;

function readProtocolExport<T = unknown>(name: string): T {
  return (protocol as Record<string, unknown>)[name] as T;
}

describe('plugin permission grant actions', () => {
  it('registers durable optional-permission grant ActionSpec ids', () => {
    for (const actionId of GRANT_ACTION_IDS) {
      expect(ActionIdSchema.safeParse(actionId).success, actionId).toBe(true);

      const spec = getActionSpec(actionId as any);
      expect(spec.surfaces.rpc).toBe(true);
      expect(spec.bindings?.rpcMethod).toBe(actionId);
      expect(spec.inputSchema).toBeDefined();
      expect(spec.outputSchema).toBeDefined();
    }
  });

  it('validates grant request, grant, revoke, and dismiss action inputs', () => {
    const requestInputSchema = readProtocolExport<any>('PluginPermissionGrantRequestActionInputV1Schema');
    const grantInputSchema = readProtocolExport<any>('PluginPermissionGrantGrantActionInputV1Schema');
    const revokeInputSchema = readProtocolExport<any>('PluginPermissionGrantRevokeActionInputV1Schema');
    const dismissInputSchema = readProtocolExport<any>('PluginPermissionGrantDismissRequestActionInputV1Schema');

    expect(requestInputSchema).toBeDefined();
    expect(grantInputSchema).toBeDefined();
    expect(revokeInputSchema).toBeDefined();
    expect(dismissInputSchema).toBeDefined();

    expect(requestInputSchema.parse({
      pluginId: 'review-coderabbit',
      capability: 'reviews.comments.write.direct',
      targetScope: { kind: 'project', projectId: 'project-1' },
      reason: 'Publish approved review comments directly.',
      requester: { kind: 'plugin', pluginId: 'review-coderabbit', sessionId: 'session-1' },
    })).toMatchObject({
      pluginId: 'review-coderabbit',
      targetScope: { kind: 'project', projectId: 'project-1' },
    });

    expect(grantInputSchema.parse({ requestId: 'request-1' })).toEqual({ requestId: 'request-1' });
    expect(revokeInputSchema.parse({ grantId: 'grant-1' })).toEqual({ grantId: 'grant-1' });
    expect(dismissInputSchema.parse({ requestId: 'request-1' })).toEqual({ requestId: 'request-1' });
  });

  it('fails closed for missing target scope instead of treating it as account-wide', () => {
    const requestInputSchema = readProtocolExport<any>('PluginPermissionGrantRequestActionInputV1Schema');
    expect(requestInputSchema).toBeDefined();

    expect(requestInputSchema.safeParse({
      pluginId: 'review-coderabbit',
      capability: 'reviews.comments.write.direct',
      reason: 'Publish approved review comments directly.',
      requester: { kind: 'plugin', pluginId: 'review-coderabbit' },
    }).success).toBe(false);

    expect(requestInputSchema.parse({
      pluginId: 'review-coderabbit',
      capability: 'reviews.comments.write.direct',
      targetScope: { kind: 'account' },
      reason: 'Publish approved review comments directly.',
      requester: { kind: 'plugin', pluginId: 'review-coderabbit' },
    }).targetScope).toEqual({ kind: 'account' });
  });

  it('parses legacy bundled grant records with bundled authority defaults', () => {
    const grantSchema = readProtocolExport<any>('PluginPermissionGrantV1Schema');
    const requestSchema = readProtocolExport<any>('PluginPermissionGrantRequestV1Schema');

    expect(grantSchema.parse({
      v: 1,
      id: 'grant-1',
      accountId: 'account-1',
      pluginId: 'review-coderabbit',
      capability: 'reviews.comments.write.direct',
      targetScope: { kind: 'project', projectId: 'project-1' },
      status: 'active',
      grantedByUserId: 'user-1',
      grantedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    }).authoritySource).toEqual({ kind: 'bundled' });

    expect(requestSchema.parse({
      v: 1,
      id: 'request-1',
      accountId: 'account-1',
      pluginId: 'review-coderabbit',
      capability: 'reviews.comments.write.direct',
      targetScope: { kind: 'project', projectId: 'project-1' },
      requester: { kind: 'plugin', pluginId: 'review-coderabbit' },
      reason: 'Publish approved review comments directly.',
      status: 'pending',
      createdByUserId: 'user-1',
      createdAt: 1,
      updatedAt: 1,
    }).authoritySource).toEqual({ kind: 'bundled' });
  });
});
