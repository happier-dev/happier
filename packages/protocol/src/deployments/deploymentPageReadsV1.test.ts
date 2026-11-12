import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from '../actions/actionIds.js';
import { getActionSpec, listActionSpecsForSurface } from '../actions/actionSpecs.js';
import { bindHomeDomainHttpRequestV1 } from '../actions/homeDomainHttpBinding.js';
import { createActionExecutor } from '../actions/actionExecutor.js';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '../storage/artifactStoredContent.js';
import { DeploymentEnvironmentHeaderV1Schema, DeploymentDomainHeaderV1Schema } from './deploymentActionsV1.js';

describe('Account deployment inventory pages', () => {
  it.each([
    ['deployments.domains.page', '/v1/deployments/domains'],
    ['deployments.data.page', '/v1/deployments/data-services'],
  ])('serves %s as one Account read with a bundled Artifact page', async (id, path) => {
    const actionId = ActionIdSchema.parse(id);
    const spec = getActionSpec(actionId);
    const input = { serverId: 'home', projectSourceId: 'source', cursor: 'opaque-next', limit: 25 };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.executionPlacement).toBe('account');
    expect(spec.sideEffectClass).toBe('read');
    expect(spec.approvalScope).toBeUndefined();
    expect(listActionSpecsForSurface('agent').some(row => row.id === actionId)).toBe(true);
    const request = bindHomeDomainHttpRequestV1({ inputSchema: spec.inputSchema, input, transport: spec.serverTransport! });
    const url = new URL(request.path, 'https://home.invalid');
    expect({ method: request.method, path: url.pathname, body: request.body })
      .toEqual({ method: 'GET', path, body: undefined });
    expect(Object.fromEntries(url.searchParams)).toEqual({ serverId: 'home', projectSourceId: 'source', cursor: 'opaque-next', limit: '25' });
    const artifact = { id: 'artifact', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      header: 'opaque', headerVersion: 1, body: 'opaque', bodyVersion: 1, publicAudience: 'none',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 1, createdAt: 1, updatedAt: 1 };
    const page = { ok: true, items: [], artifacts: [artifact], nextCursor: 'next', coverage: 'partial' };
    expect(spec.outputSchema.parse(page)).toEqual(page);
    const encrypted = { ...artifact, encryptionMode: 'e2ee', dataEncryptionKey: 'sealed-key' };
    expect(spec.outputSchema.parse({ ...page, artifacts: [encrypted] })).toEqual({ ...page, artifacts: [encrypted] });
    expect(spec.outputSchema.safeParse({ ...page, artifacts: [{ ...artifact, authority: 'owner' }] }).success).toBe(false);
    const environment = DeploymentEnvironmentHeaderV1Schema.parse({ v: 1, id: 'environment', serverId: 'home', projectSourceId: 'source', revision: 1,
      owner: { kind: 'account', accountId: 'owner' }, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      controllerMachineId: 'machine', contentArtifactId: 'artifact', contentHeaderVersion: 1, contentBodyVersion: 1,
      createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
      capabilities: { role: 'manager', read: true, deploy: true, manage: true, manageBindings: true, manageTargets: true, delete: true } });
    const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: environment.id,
      targetLinkId: 'target', revision: 1, state: 'pending', contentArtifactId: 'domain-content', contentHeaderVersion: 1,
      contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 });
    const items = id === 'deployments.domains.page' ? [{ domain, environment }] : [{ environment }];
    expect(spec.outputSchema.parse({ ...page, items })).toEqual({ ...page, items });
    expect(spec.inputSchema.safeParse({ ...input, environmentId: 'unrelated' }).success).toBe(false);
    let requests = 0;
    let artifactRequests = 0;
    const executor = createActionExecutor({
      deploymentAction: async () => { requests++; return { ok: true, items: [], artifacts: [], nextCursor: null }; },
      deploymentReadArtifactHeaders: async () => { artifactRequests++; return []; },
    });
    expect(await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner' }))
      .toEqual({ ok: true, result: { ok: true, items: [], artifacts: [], nextCursor: null } });
    expect({ requests, artifactRequests }).toEqual({ requests: 1, artifactRequests: 0 });
  });
});
