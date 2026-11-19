import { describe, expect, it } from 'vitest';

import { coderWorkspaceName, createCoderClient } from './nativeClient.js';
import { CoderLaunchSchema, CoderResourceSchema } from './schemas.js';
import { coderOptions } from './options.js';
import { projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

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
  workspaceName: 'outside-happier',
  organizationId: 'org',
  templateId: 'template',
  agentName: 'main',
  managedId: 'managed',
});

const workspace = (name: string, transition: 'start' | 'delete' = 'start', status = 'running') => ({
  id: resource.workspaceId,
  owner_id: resource.ownerId,
  owner_name: resource.ownerName,
  organization_id: resource.organizationId,
  template_id: resource.templateId,
  name,
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
  it('lists Coder account workspaces as selectable attach launches', async () => {
    const client = createCoderClient({
      signal: new AbortController().signal,
      observedAt: 1,
      waitForObservation: async () => undefined,
      request: async (path, init) => {
        expect(init?.method).toBe('GET');
        const url = new URL(path, 'https://coder.example');
        expect(url.pathname).toBe('/api/v2/workspaces');
        expect(url.searchParams.get('q')).toBe('owner:me');
        return response({ workspaces: [
          { ...workspace(resource.workspaceName), template_name: 'api', template_display_name: 'API Development' },
          { ...workspace('stopped-api', 'start', 'stopped'), id: 'stopped', template_name: 'api', template_display_name: '' },
          { ...workspace('starting-api', 'start', 'starting'), id: 'starting' },
        ], count: 3 });
      },
    });
    const query = { attachExisting: true, agentName: resource.agentName } as const;

    const options = await coderOptions(client, query);

    expect(options.dimensions.image).toEqual([expect.objectContaining({
      id: resource.workspaceId,
      title: resource.workspaceName,
      nativeFacts: { image: { id: resource.templateId, title: 'API Development' }, workspaceStatus: 'running' },
    }), expect.objectContaining({
      id: 'stopped',
      nativeFacts: { image: { id: resource.templateId, title: 'api' }, workspaceStatus: 'stopped' },
    }), expect.objectContaining({
      id: 'starting',
      nativeFacts: { workspaceStatus: 'starting' },
    })]);
    expect(projectMachineProvisionerSelectionV1({ options, selection: { image: resource.workspaceId },
      launchSchema: CoderLaunchSchema.jsonSchema })).toMatchObject({
      kind: 'ready', launch: { existingWorkspaceId: resource.workspaceId, agentName: resource.agentName,
        organizationId: resource.organizationId, templateId: resource.templateId },
    });
  });

  it.each(['create', 'attach', 'recover attachment'] as const)('F1: Coder %s creates a workspace only when asked to create one', async variant => {
    const createPosts: string[] = [];
    const createdName = coderWorkspaceName(resource.managedId);
    const client = createCoderClient({
      signal: new AbortController().signal,
      observedAt: 1,
      waitForObservation: async () => undefined,
      request: async (path, init) => {
        if (path === '/api/v2/users/me') return response({ id: resource.ownerId, username: resource.ownerName });
        if (path === '/api/v2/templateversions/version') return response({ id: 'version', template_id: 'template', organization_id: 'org' });
        if (path === `/api/v2/users/${resource.ownerId}/workspaces` && init?.method === 'POST') {
          createPosts.push(path);
          return response(workspace(createdName));
        }
        if (path.split('?')[0] === `/api/v2/workspaces/${resource.workspaceId}` && init?.method === 'GET') {
          return response(workspace(resource.workspaceName));
        }
        throw new Error(`unexpected Coder request ${path}`);
      },
    });

    const selection = variant === 'create' ? launch : { ...launch, existingWorkspaceId: resource.workspaceId };
    const acquired = variant === 'recover attachment'
      ? await client.recover(await client.operationFor(selection, resource.managedId))
      : await client.acquire(selection, resource.managedId);
    expect(createPosts).toHaveLength(variant === 'create' ? 1 : 0);
    expect(acquired).toMatchObject({
      kind: 'bound',
      resource: { value: {
        workspaceId: resource.workspaceId, workspaceName: variant === 'create' ? createdName : resource.workspaceName,
      } },
    });
    if (acquired.kind === 'bound') expect(acquired.resource.origin).toBe(variant === 'create' ? 'created' : undefined);
  });

  it('ordinary deletion still submits a Coder delete build for a Happier-created workspace', async () => {
    const builds: unknown[] = [];
    const ownedName = coderWorkspaceName(resource.managedId);
    const client = createCoderClient({
      signal: new AbortController().signal,
      observedAt: 1,
      waitForObservation: async () => undefined,
      request: async (path, init) => {
        if (path === '/api/v2/users/me') return response({ id: resource.ownerId, username: resource.ownerName });
        if (path === `/api/v2/workspaces/${resource.workspaceId}/builds` && init?.method === 'POST') {
          builds.push(JSON.parse(String(init.body)));
          return response(workspace(ownedName, 'delete', 'deleting').latest_build);
        }
        if (path === `/api/v2/workspaces/${resource.workspaceId}?include_deleted=true`) {
          return response(workspace(ownedName));
        }
        throw new Error(`unexpected Coder request ${path}`);
      },
    });

    expect(await client.destroy({ resource: { ...resource, workspaceName: ownedName } })).toMatchObject({ kind: 'accepted' });
    expect(builds).toEqual([{ transition: 'delete' }]);
  });
});
