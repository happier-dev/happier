import { createRailwayProjectOperations } from '@happier-dev/railway-api';
import { expect, it } from 'vitest';

const selection = { projectId: 'project', environmentId: 'production', serviceId: 'database', workspaceId: 'workspace' };
const instance = { environmentId: selection.environmentId, serviceId: selection.serviceId, serviceName: 'Orders',
  deletedAt: null, service: { projectId: selection.projectId, templateId: 'pg-template', project: { workspaceId: 'workspace' } } };
type Request = { query: string; variables: Record<string, unknown> };

function vendor(respond: (request: Request) => unknown) {
  const requests: Request[] = [];
  const project = createRailwayProjectOperations(async (url, init) => {
    expect(url).toBe('https://backboard.railway.com/graphql/v2');
    const request = JSON.parse(String(init?.body)) as Request;
    requests.push(request);
    return Response.json({ data: respond(request) });
  });
  return { project, requests };
}

it('inspects exact service and template scope in one request', async () => {
  const { project, requests } = vendor(() => ({ template: { id: 'pg-template' }, serviceInstance: instance }));
  await expect(project.readServiceInstance(selection, 'postgres')).resolves.toEqual({ id: 'database', name: 'Orders' });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.variables).toEqual({ environmentId: 'production', serviceId: 'database', templateCode: 'postgres' });
});

it('rejects a service belonging to an adjacent workspace', async () => {
  const { project } = vendor(() => ({ template: { id: 'pg-template' },
    serviceInstance: { ...instance, service: { ...instance.service, project: { workspaceId: 'adjacent' } } } }));
  await expect(project.readServiceInstance(selection, 'postgres')).resolves.toBeNull();
});

it('checks paged scoped inventory before settling removal', async () => {
  const { project, requests } = vendor(({ variables }) => ({ environment: {
    id: 'production', projectId: 'project', serviceInstances: variables.after === null
      ? { edges: [], pageInfo: { endCursor: 'second', hasNextPage: true } }
      : { edges: [{ node: instance }], pageInfo: { endCursor: null, hasNextPage: false } },
  } }));
  await expect(project.observeServiceAbsent(selection)).resolves.toBe(false);
  expect(requests.map(({ variables }) => variables.after)).toEqual([null, 'second']);
});

it('finds the reviewed service volume and checks its attachments across environment pages', async () => {
  const page = <T>(nodes: T[], endCursor: string | null = null) => ({
    edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: endCursor !== null, endCursor },
  });
  const attachment = (environmentId: string, serviceId: string, volumeId: string) => ({
    id: environmentId + '-' + volumeId, environmentId, serviceId, volumeId, deletedAt: null, isPendingDeletion: false,
  });
  const { project, requests } = vendor(({ query, variables }) => {
    if (query.includes('environment(id:')) {
      return { environment: { id: 'production', projectId: 'project', volumeInstances: page([{
        ...attachment('production', 'database', 'orders-volume'), volume: { id: 'orders-volume', name: 'Orders data' },
      }]) } };
    }
    return { project: { id: 'project', name: 'Orders', environments: variables.after === null
      ? page([{ id: 'staging', volumeInstances: page([attachment('staging', 'database', 'orders-volume')]) }], 'next-environment')
      : page([{ id: 'production', name: 'Production',
        volumeInstances: page([attachment('production', 'another-service', 'another-volume')], 'next-instance') }]) } };
  });
  await expect(project.readServiceVolume(selection)).resolves.toEqual({
    providerScope: { projectName: 'Orders', environmentName: 'Production' },
    volume: { id: 'orders-volume', name: 'Orders data', otherEnvironments: 1,
      url: 'https://railway.com/project/project/volume/orders-volume?environmentId=staging' },
  });
  expect(requests).toHaveLength(3);
  expect(requests[2]?.query).toContain('volume { id name }');
});

it('creates a project in the selected workspace and returns its default environment', async () => {
  const { project, requests } = vendor(() => ({ projectCreate: { id: 'project', name: 'Orders', workspaceId: 'workspace',
    environments: { edges: [{ node: { id: 'production', name: 'production' } }] } } }));
  await expect(project.createProject({ name: 'Orders', workspaceId: 'workspace' })).resolves.toEqual({
    project: { id: 'project', name: 'Orders' }, environment: { id: 'production', name: 'production' },
  });
  expect(requests).toEqual([expect.objectContaining({ query: expect.stringContaining('projectCreate'),
    variables: { input: { name: 'Orders', workspaceId: 'workspace' } } })]);
});

it('creates an environment in the selected project', async () => {
  const { project, requests } = vendor(() => ({ environmentCreate: { id: 'staging', name: 'Staging', projectId: 'project' } }));
  await expect(project.createEnvironment({ name: 'Staging', projectId: 'project' })).resolves.toEqual({
    id: 'staging', name: 'Staging',
  });
  expect(requests).toEqual([expect.objectContaining({ query: expect.stringContaining('environmentCreate'),
    variables: { input: { name: 'Staging', projectId: 'project' } } })]);
});
