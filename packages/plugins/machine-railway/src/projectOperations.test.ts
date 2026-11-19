import { describe, expect, it } from 'vitest';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import * as projectOperations from './projectOperations.js';

const project = { id: 'project-one', name: 'Example' };
const environment = { id: 'environment-one', name: 'Production' };
const service = { id: 'service-one', name: 'Postgres' };
const selection = { projectId: project.id, environmentId: environment.id, serviceId: service.id };

function page(nodes: readonly { id: string; name: string }[], next: string | null = null) {
  return { edges: nodes.map(node => ({ node })), pageInfo: { endCursor: next, hasNextPage: next !== null } };
}

function boundary(...responses: readonly unknown[]) {
  const calls: Parameters<HttpService['request']>[0][] = [];
  const signal = new AbortController().signal;
  const http: Pick<HttpService, 'request'> = {
    async request(request) {
      expect(request).toMatchObject({
        url: 'https://backboard.railway.com/graphql/v2', method: 'POST',
        credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'cloud-api', headerNames: ['authorization'] },
      });
      expect(new Headers(request.headers).has('authorization')).toBe(false);
      const response = responses[calls.length];
      calls.push(request);
      expect(response).toBeDefined();
      return { status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(response)) };
    },
  };
  const request = projectOperations.nativeFetch({ signal, services: { http } });
  const documents = () => calls.map(call => JSON.parse(new TextDecoder().decode(call.body)));
  return { request, signal, documents };
}

describe('Railway shared project operations through Connected Account HTTP', () => {
  it('traverses provider pages and keeps the project, environment and service selections distinct', async () => {
    const other = { id: 'project-two', name: 'Other' };
    const vendor = boundary(
      { data: { projects: page([project], 'next-page') } },
      { data: { projects: page([other]) } },
      { data: { project: { environments: page([environment]) } } },
      { data: { project: { services: page([service]) } } },
      { data: { externalWorkspaces: [{ id: 'workspace-one', name: 'First workspace', projects: [project] },
        { id: 'workspace-two', name: 'Second workspace', projects: [other] }] } },
    );
    const client = projectOperations.createRailwayProjectOperations(vendor.request, vendor.signal);
    expect(await client.listProjects('workspace-one')).toEqual([project, other]);
    expect(await client.listEnvironments(project.id)).toEqual([environment]);
    expect(await client.listServices(project.id)).toEqual([service]);
    expect(await client.listGrantedProjects()).toEqual([project, other]);
    expect(vendor.documents()).toEqual([
      { query: expect.stringContaining('projects(workspaceId:'), variables: { workspaceId: 'workspace-one', after: null } },
      { query: expect.stringContaining('projects(workspaceId:'), variables: { workspaceId: 'workspace-one', after: 'next-page' } },
      { query: expect.stringContaining('environments(after:'), variables: { projectId: project.id, after: null } },
      { query: expect.stringContaining('services(after:'), variables: { projectId: project.id, after: null } },
      { query: expect.stringContaining('externalWorkspaces'), variables: {} },
    ]);
  });

  it('writes the selected service variables in one merge and suppresses deploy when requested', async () => {
    const vendor = boundary({ data: { variableCollectionUpsert: true } });
    const client = projectOperations.createRailwayProjectOperations(vendor.request, vendor.signal);
    await client.upsertServiceVariables({ ...selection, variables: { DATABASE_URL: '${{Postgres.DATABASE_URL}}', OPTIONAL: '' }, skipDeploys: true });
    expect(vendor.documents()).toEqual([{
      query: expect.stringContaining('variableCollectionUpsert(input:'),
      variables: { input: { ...selection, variables: { DATABASE_URL: '${{Postgres.DATABASE_URL}}', OPTIONAL: '' }, skipDeploys: true, replace: false } },
    }]);
  });

  it.each([
    [{ data: { variableCollectionUpsert: false } }, 'railway_variable_upsert_unconfirmed'],
    [{ data: { variableCollectionUpsert: true }, errors: [{ message: 'vendor-private-detail' }] }, 'railway_graphql_unavailable'],
  ])('does not report a refused or ambiguous write as success or replay it', async (response, code) => {
    const vendor = boundary(response);
    const client = projectOperations.createRailwayProjectOperations(vendor.request, vendor.signal);
    await expect(client.upsertServiceVariables({ ...selection, variables: { EXAMPLE: 'value' } }))
      .rejects.toMatchObject({ code, message: code });
    expect(vendor.documents()).toHaveLength(1);
  });
});
