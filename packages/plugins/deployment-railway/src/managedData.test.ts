import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from './index.js';

const credentialRef = { service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'connected' };
const selection = { projectId: 'project-one', railwayEnvironmentId: 'production', workspaceId: 'workspace-one' };
const databaseService = { serviceId: 'database-one', serviceName: 'Database', deletedAt: null,
  service: { templateId: 'pg-template' } };
const instance = { ...databaseService, environmentId: 'production',
  service: { ...databaseService.service, projectId: 'project-one', project: { workspaceId: 'workspace-one' } } };
function preparation(localId: string) {
  return { v: 1, serverId: 'home', environmentId: 'happier-env', expectedRevision: 1, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner',
      purpose: { consumer: { pluginId: 'happier.deploy.railway-data', localId }, purpose: 'cloud-api' },
      target: { kind: 'account', account: credentialRef } },
    providerAccountId: 'connected', providerEnvironment: { kind: 'native', selection: {} } };
}

async function host(...replies: readonly unknown[]) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const http = createPluginHttpFixture({ async request(request: HttpRequest) {
    expect(request.credentialBinding).toMatchObject({ kind: 'connectedAccountPurpose', purpose: 'cloud-api' });
    const reply = replies[calls.length];
    calls.push(JSON.parse(new TextDecoder().decode(request.body)));
    if (reply instanceof Error) throw reply;
    expect(reply).toBeDefined();
    return { status: 200, body: new TextEncoder().encode(JSON.stringify(reply)), headers: {} };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  return { calls, kit, invoke(localId: string, operands: Record<string, string>) {
    return kit.invokeAction(localId, { ...preparation(localId), ...operands });
  } };
}

describe('activated Railway managed database actions', () => {
  it('creates one template workflow and returns no adoptable service or vendor payload', async () => {
    const h = await host({ data: { template: { id: 'pg-template', serializedConfig: 'opaque-config' },
      environment: { id: 'production', projectId: 'project-one' }, project: { id: 'project-one', workspaceId: 'workspace-one' } } },
      { data: { templateDeployV2: { projectId: 'project-one', workflowId: 'workflow-one', password: 'private-value' } } });
    try {
      await expect(h.invoke('postgresql-provision', selection)).resolves.toEqual({
        status: 'adoption_required', workflowId: 'workflow-one', ...selection,
      });
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1]?.variables).toEqual({ input: { templateId: 'pg-template', serializedConfig: 'opaque-config',
        projectId: 'project-one', environmentId: 'production', workspaceId: 'workspace-one' } });
    } finally { await h.kit.dispose(); }
  });

  it('does not replay a paid creation after losing the write response', async () => {
    const h = await host({ data: { template: { id: 'pg-template', serializedConfig: 'opaque-config' },
      environment: { id: 'production', projectId: 'project-one' }, project: { id: 'project-one', workspaceId: 'workspace-one' } } },
      new TypeError('private response'));
    try {
      await expect(h.invoke('postgresql-provision', selection)).resolves.toMatchObject({ status: 'outcome_unknown', ...selection });
      expect(h.calls).toHaveLength(2);
    } finally { await h.kit.dispose(); }
  });

  it('lists exact template matches, filtered by provenance and not display name', async () => {
    const h = await host({ data: { template: { id: 'pg-template' }, environment: { id: 'production', projectId: 'project-one',
      serviceInstances: { edges: [databaseService, { ...databaseService, serviceId: 'different', service: { templateId: null } },
        { ...databaseService, serviceId: 'deleted', deletedAt: '2026-11-20' }].map(node => ({ node })),
        pageInfo: { endCursor: null, hasNextPage: false } } } } });
    try {
      await expect(h.invoke('postgresql-list', selection)).resolves.toEqual({ databases: [{ id: 'database-one', name: 'Database' }] });
      expect(h.calls).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('inspects the exact selected service and exposes only protected link facts', async () => {
    const h = await host({ data: { template: { id: 'pg-template' }, serviceInstance: instance } });
    try {
      await expect(h.invoke('postgresql-link', { ...selection, serviceId: 'database-one' })).resolves.toMatchObject({
        engine: 'postgresql', providerIdentity: { providerResourceId: 'database-one', providerEnvironment: 'production' },
      });
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.variables).toMatchObject({ serviceId: 'database-one', environmentId: 'production' });
    } finally { await h.kit.dispose(); }
  });

  it('refuses adjacent environment data before exposing a link', async () => {
    const h = await host({ data: { template: { id: 'pg-template' }, serviceInstance: { ...instance, environmentId: 'preview' } } });
    try {
      await expect(h.invoke('postgresql-link', { ...selection, serviceId: 'database-one' })).rejects.toMatchObject({ code: 'target_mismatch' });
      expect(h.calls).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });
});

const linkedScope = {
  providerIdentity: { providerAccountId: 'project-one', providerResourceId: 'database-one', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'native', selection: { projectId: 'project-one', environmentId: 'production', serviceId: 'database-one' } },
};

describe('Railway native app connection reference', () => {
  const action = 'postgresql-connection-reference';
  const app = (environmentId: string) => ({
    runtimeProviderIdentity: { providerAccountId: 'project-one', providerResourceId: 'app', providerEnvironment: environmentId },
    runtimeProviderEnvironment: { kind: 'native', selection: { projectId: 'project-one', environmentId, serviceId: 'app' } },
  });

  it('returns one reference and makes no variable write or secret read', async () => {
    const h = await host({ data: { template: { id: 'pg-template' }, serviceInstance: instance } });
    try {
      await expect(h.kit.invokeAction(action, { ...preparation(action), ...linkedScope, ...app('production') }))
        .resolves.toEqual({ reference: '${{Database.DATABASE_URL}}' });
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.query).not.toMatch(/mutation|variablesForServiceDeployment/);
    } finally { await h.kit.dispose(); }
  });

  it('refuses a link in an adjacent Railway environment before any vendor request', async () => {
    const h = await host();
    try {
      await expect(h.kit.invokeAction(action, { ...preparation(action), ...linkedScope, ...app('preview') }))
        .rejects.toMatchObject({ code: 'target_mismatch' });
      expect(h.calls).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });
});

describe('adopted Railway database removal', () => {
  const action = 'database-delete';
  const absent = { data: { environment: { id: 'production', projectId: 'project-one',
    serviceInstances: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } } } } };
  it.each([true, false])('sends scoped deletion once, acknowledgement=%s', async acknowledged => {
    const h = await host(acknowledged ? { data: { serviceDelete: true } } : new TypeError('private response'), absent);
    try {
      const { providerAccountId: _account, ...prepared } = preparation(action);
      await expect(h.kit.invokeAction(action, { ...prepared, ...linkedScope, targetLinkId: 'data-link',
        expectedTargetLinkRevision: 1 })).resolves.toMatchObject({ state: 'succeeded', providerResourceAbsent: true });
      expect(h.calls).toHaveLength(acknowledged ? 1 : 2);
      expect(h.calls[0]?.variables).toEqual({ environmentId: 'production', id: 'database-one' });
      if (!acknowledged) expect(h.calls[1]?.variables).toMatchObject({ projectId: 'project-one', environmentId: 'production' });
    } finally { await h.kit.dispose(); }
  });
});
