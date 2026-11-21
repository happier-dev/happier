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
