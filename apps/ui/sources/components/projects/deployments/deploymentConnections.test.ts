import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { projectDeploymentConnections } from './deploymentConnections';
describe('declared Environment connections', () => {
 it('retains managed database attachments and exact configure keys when domains are unavailable', () => {
  const detail = createDeploymentEnvironmentDetailV1();
  const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'managed-db', role: 'data', targetKind: 'managed-postgres', machines: [], members: [],
    source: { kind: 'plugin', contribution: { pluginId: 'com.example.database', localId: 'database' } } });
  const result = projectDeploymentConnections({ ...detail, targetLinks: [{ targetLink }] },
    { status: 'unavailable', items: [], reason: 'machine_offline' });
  expect(result.status).toBe('partial');
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ kind: 'database', id: 'managed-db', service: null, resource: 'managed-postgres',
    source: { kind: 'environment', id: detail.environment.id }, configure: { params: { deploymentService: 'managed-db' } } });
 });
 it('projects database, volume and native domain routes without exposing credential bindings', () => {
  const detail = createDeploymentEnvironmentDetailV1();
  const template: NonNullable<typeof detail.content.template> = { templateRef: { sourceId: 'apps', itemId: 'app', version: '1', ref: { kind: 'content', digest: 'sha256:' + 'a'.repeat(64) } }, definition: detail.content.definition,
    services: ['app', 'db'], data: [{ engine: 'postgres' as const, service: 'db', variables: {} }],
    volumes: [{ id: 'storage', service: 'app', target: '/data', persistent: true, backup: true }] };
  const result = projectDeploymentConnections({ ...detail, content: { ...detail.content, template } },
    { status: 'ready', items: [{ domain: { id: 'domain-a' }, title: 'example.test', content: { hostname: 'example.test', target: { service: 'app', containerPort: 3000 } } }] });
  expect(result.status).toBe('ready');
  expect(projectDeploymentConnections({ ...detail, content: { ...detail.content, template: { ...template, data: [], volumes: [] } } }, { status: 'empty', items: [] }).status).toBe('empty');
  expect(projectDeploymentConnections({ ...detail, content: { ...detail.content, template } }, { status: 'ready', items: [], hasNextPage: true }).status).toBe('partial');
  expect(result.items.map(item => [item.kind, item.service])).toEqual([['database', 'db'], ['volume', 'app'], ['domain', 'app']]);
  expect(result.items[0]?.configure.params.deploymentService).toBe('db');
  expect(result.items[1]?.configure.params.deploymentTab).toBe('settings');
  expect(result.items[2]?.configure.params.deploymentTab).toBe('domains');
  expect(JSON.stringify(result)).not.toContain('bindings');
 });
 it('keeps known edges when domains fail and distinguishes undeclared metadata from an empty graph', () => {
  const detail = createDeploymentEnvironmentDetailV1();
  const linked = projectDeploymentConnections({ ...detail, content: { ...detail.content, bindings: [createDeploymentSecretVariableBindingV1({ name: 'PASSWORD', phase: 'runtime', resourceId: 'secret-custody-id', resourceRevision: 1 }), { purpose: 'variable', name: 'DATABASE_URL', phase: 'runtime', source: { kind: 'reference', environmentId: 'database-env', export: 'url', via: 'auto' } }] } }, { status: 'ready', items: [] });
  expect(JSON.stringify(linked)).not.toContain('secret-custody-id');
  expect(linked.items).toHaveLength(1);
  expect(linked.items[0]).toMatchObject({ kind: 'reference', targetEnvironmentId: 'database-env', export: 'url', configure: { params: { deploymentTab: 'variables' } } });
  expect(projectDeploymentConnections(detail, { status: 'loading', items: [] }).status).toBe('loading');
  expect(projectDeploymentConnections(detail, { status: 'unavailable', items: [], reason: 'machine_offline' })).toMatchObject({ status: 'partial', domains: { status: 'unavailable', reason: 'machine_offline' }, declarations: 'unknown' });
  expect(projectDeploymentConnections(detail, { status: 'ready', items: [] }).status).toBe('partial');
 });
});
