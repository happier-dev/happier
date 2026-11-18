import { describe, expect, it } from 'vitest';

import { createCoderClient } from './nativeClient.js';
import { CoderLaunchSchema, CoderResourceSchema } from './schemas.js';

const launch = CoderLaunchSchema.parse({
  organizationId: 'org',
  templateId: 'template',
  templateVersionId: 'version',
  agentName: 'main',
  parameterValues: [],
});

const resource = CoderResourceSchema.parse({
  workspaceId: 'workspace',
  ownerId: 'user-a',
  ownerName: 'alice',
  workspaceName: 'hm-attached',
  organizationId: 'org',
  templateId: 'template',
  agentName: 'main',
  managedId: 'attached-managed',
});

const workspace = (transition: 'start' | 'delete' = 'start', status = 'running') => ({
  id: resource.workspaceId,
  owner_id: resource.ownerId,
  owner_name: resource.ownerName,
  organization_id: resource.organizationId,
  template_id: resource.templateId,
  name: resource.workspaceName,
  latest_build: {
    id: `build-${transition}`,
    workspace_id: resource.workspaceId,
    template_version_id: launch.templateVersionId,
    transition,
    status,
    job: { status },
    resources: [],
  },
});

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('remote workspace provider shape contracts', () => {
  it.fails('F1 attach: selecting an existing Coder workspace performs zero workspace-create POSTs', async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const client = createCoderClient({
      signal: new AbortController().signal,
      observedAt: 1,
      waitForObservation: async () => undefined,
      request: async (path, init) => {
        requests.push({ path, method: init?.method ?? 'GET' });
        if (path === '/api/v2/users/me') return response({ id: resource.ownerId, username: resource.ownerName });
        if (path === '/api/v2/templateversions/version') return response({ id: 'version', template_id: 'template', organization_id: 'org' });
        if (path.endsWith('/workspaces')) return response(workspace());
        throw new Error(`unexpected Coder request ${path}`);
      },
    });

    await client.acquire(launch, resource.managedId);
    expect(requests.filter(request => request.method === 'POST' && request.path.endsWith('/workspaces'))).toHaveLength(0);
  });

  it.fails('F9 Forget: retiring an attached Coder workspace performs zero provider destroy POSTs', async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const client = createCoderClient({
      signal: new AbortController().signal,
      observedAt: 1,
      waitForObservation: async () => undefined,
      request: async (path, init) => {
        requests.push({ path, method: init?.method ?? 'GET' });
        if (path === '/api/v2/users/me') return response({ id: resource.ownerId, username: resource.ownerName });
        if (path.startsWith('/api/v2/workspaces/')) return response(workspace());
        if (path.endsWith('/builds')) return response(workspace('delete', 'deleting').latest_build);
        throw new Error(`unexpected Coder request ${path}`);
      },
    });

    await client.destroy({ resource });
    expect(requests.filter(request => request.method === 'POST' && request.path.endsWith('/builds'))).toHaveLength(0);
  });
});
