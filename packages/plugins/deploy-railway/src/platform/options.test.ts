import { definePlugin } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { expect, it } from 'vitest';
import { railwayHostAccess, railwayIdentity } from './account.js';
import { optionsAction, optionsResources } from './options.js';
import { providerEnvironment, railwayAccount } from './fixtures/service.js';

const { projectId, environmentId, serviceId } = providerEnvironment.selection;
const draft = { credentialRef: railwayAccount, credentialPrincipal: { kind: 'account', accountId: 'owner',
  purpose: { consumer: { pluginId: railwayIdentity.id, localId: 'targets-inspect-v1' }, purpose: 'cloud-api' },
  target: { kind: 'account', account: railwayAccount } } };

type OptionsDraft = Readonly<Record<string, JsonValue>>;

function withOptions(respond: (query: string, variables: Record<string, unknown>) => unknown, assert: (read: (fieldPath: string, input: OptionsDraft, cursor?: string, creating?: boolean) => Promise<unknown>,
  requests: readonly { query: string; variables: unknown }[]) => Promise<void>, savedProject: string | null = projectId) {
  return (async () => {
    const requests: { query: string; variables: Record<string, unknown> }[] = [];
    const unavailable = (): never => { throw new Error('Unexpected Connected Account operation'); };
    const plugin = definePlugin({ ...railwayIdentity, hostAccess: railwayHostAccess,
      actions: { 'target-options-read': optionsAction }, resources: optionsResources });
    const http = createPluginHttpFixture({ async request(request) {
      expect(request.credentialBinding).toMatchObject({ kind: 'connectedAccountPurpose', purpose: 'cloud-api' });
      const document = JSON.parse(new TextDecoder().decode(request.body)) as typeof requests[number];
      requests.push(document);
      const result = respond(document.query, document.variables);
      const response = result instanceof Response ? result : Response.json({ data: result });
      return { status: response.status, headers: {}, body: new Uint8Array(await response.arrayBuffer()) };
    } });
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { http, connectedAccounts: {
      requestSelection: unavailable, listAccounts: unavailable, materializeListedAccount: unavailable, watch: unavailable,
      async getBinding(purpose) {
        return { purpose, service: railwayAccount.service, account: railwayAccount, target: { kind: 'account', displayName: 'Backend project' } };
      },
      async materialize(purpose, request) {
        expect(purpose).toBe('cloud-api');
        expect(request).toEqual({ kind: 'environment', keys: ['RAILWAY_PROJECT_ID'] });
        const env: Record<string, string> = savedProject === null ? {} : { RAILWAY_PROJECT_ID: savedProject };
        return { kind: 'environment', env };
      },
    } } });
    try {
      const read = async (fieldPath: string, input: OptionsDraft, cursor?: string, creating = false) => {
        const resource = kit.registration('resources', creating ? 'create-options' : 'target-options');
        if (!resource) throw new Error('Missing target-options Resource');
        const invocation = createTestResourceInvocationContext({ signal: new AbortController().signal, context: { kind: 'global' },
          async readAction(ref, actionInput, options) {
            return { ok: true, result: await kit.invokeAction(ref.localId, actionInput, { signal: options?.signal, surface: 'plugin' }) };
          } });
        const bytes = await resource.read({ ...invocation, query: { draftInput: input, fieldPath, cursor } });
        return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));
      };
      await assert(read, requests);
    } finally { await kit.dispose(); }
  })();
}

it('uses the selected Connected Account scope and reveals one provider page per demanded field', () => withOptions(query => {
  if (query.includes('serviceInstances')) return { environment: { id: environmentId, projectId,
    serviceInstances: { pageInfo: { endCursor: null, hasNextPage: false }, edges: [
      { node: { serviceId, serviceName: 'Backend', deletedAt: null } },
      { node: { serviceId: 'removed', serviceName: 'Removed', deletedAt: '2026-11-19T23:00:00Z' } },
    ] } } };
  return { project: { environments: { pageInfo: { endCursor: 'more', hasNextPage: true }, edges: [
    { node: { id: environmentId, name: 'Production' } },
  ] } } };
}, async (read, requests) => {
  await expect(read('providerAccountId', draft)).resolves.toEqual({ options: [{ value: projectId, label: 'Backend project' }] });
  expect(requests).toHaveLength(0);
  const project = { ...draft, providerAccountId: projectId };
  await expect(read('railwayEnvironmentId', project)).resolves.toEqual({ options: [{ value: environmentId, label: 'Production' }], nextCursor: 'more' });
  expect(requests).toHaveLength(1);
  await expect(read('providerEnvironment', { ...project, railwayEnvironmentId: environmentId })).resolves.toEqual({
    options: [{ value: providerEnvironment, label: 'Backend' }],
  });
  expect(requests.map(({ variables }) => variables)).toEqual([
    { projectId, after: null }, { projectId, environmentId, after: null },
  ]);
}));

it('returns a terminal empty service page for a newly created Railway environment', () => withOptions(query => {
  expect(query).toContain('serviceInstances');
  return { environment: { id: environmentId, projectId,
    serviceInstances: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
}, async read => {
  await expect(read('providerEnvironment', { ...draft, providerAccountId: projectId, railwayEnvironmentId: environmentId }))
    .resolves.toEqual({ options: [] });
}));

it('offers the reviewed environment for Create in one request without requiring a service', () => withOptions(() => ({
  project: { environments: { pageInfo: { endCursor: null, hasNextPage: false }, edges: [
    { node: { id: environmentId, name: 'Production' } },
  ] } },
}), async (read, requests) => {
  await expect(read('providerEnvironment', { ...draft, providerAccountId: projectId }, undefined, true)).resolves.toEqual({
    options: [{ value: { kind: 'native', selection: { projectId, environmentId } }, label: 'Production' }],
  });
  expect(requests.map(({ variables }) => variables)).toEqual([{ projectId, after: null }]);
}));

it('requires the selected native Environment before reading service options', () => withOptions(() => undefined, async (read, requests) => {
  await expect(read('providerEnvironment', { ...draft, providerAccountId: projectId })).rejects.toMatchObject({
    code: 'missing_option_dependency', data: { details: { requiredDraftPath: 'railwayEnvironmentId' } },
  });
  expect(requests).toHaveLength(0);
}));

it('lists token projects across workspaces and resumes the selected workspace page', () => {
  const first = 'workspace-one';
  const second = 'workspace-two';
  const third = 'workspace-three';
  return withOptions((query, variables) => {
    if (query.includes('me { workspaces')) return {
      me: { workspaces: [{ id: first, name: 'First' }, { id: second, name: 'Second' }] },
      externalWorkspaces: [{ id: third, name: 'Shared' }],
    };
    const more = variables.workspaceId === second && !variables.after;
    const id = more ? projectId : variables.workspaceId === second ? 'second-project'
      : variables.workspaceId === third ? 'shared-project' : null;
    return { projects: { pageInfo: { endCursor: more ? 'railway-cursor' : null, hasNextPage: more },
      edges: id ? [{ node: { id, name: id } }] : [] } };
  }, async (read, requests) => {
    type ProjectOptions = { options: { value: string; label: string }[]; nextCursor?: string };
    const firstPage = await read('providerAccountId', draft) as ProjectOptions;
    expect(firstPage).toEqual({ options: [{ value: 'shared-project', label: 'shared-project', source: { kind: 'railway-workspace', locator: third } }], nextCursor: expect.any(String) });
    expect(requests.map(({ variables }) => variables)).toEqual([{}, { workspaceId: third, after: null }]);
    const nextPage = await read('providerAccountId', draft, firstPage.nextCursor) as ProjectOptions;
    expect(nextPage).toEqual({ options: [{ value: projectId, label: projectId, source: { kind: 'railway-workspace', locator: second } }], nextCursor: expect.any(String) });
    await expect(read('providerAccountId', draft, nextPage.nextCursor)).resolves.toEqual({
      options: [{ value: 'second-project', label: 'second-project', source: { kind: 'railway-workspace', locator: second } }] });
    expect(requests.map(({ variables }) => variables)).toEqual([
      {},
      { workspaceId: third, after: null }, { workspaceId: first, after: null }, { workspaceId: second, after: null },
      { workspaceId: second, after: 'railway-cursor' },
    ]);
  }, null);
});

it('returns the typed Railway refusal if a remaining workspace disappears between project pages', () => {
  const first = { id: 'current', name: 'Current' };
  const remaining = { id: 'remaining', name: 'Remaining' };
  let removed = false;
  return withOptions((query, variables) => {
    if (query.includes('me { workspaces')) return {
      me: { workspaces: removed ? [first] : [first, remaining] }, externalWorkspaces: [],
    };
    if (variables.workspaceId === remaining.id && removed) {
      return Response.json({ errors: [{ extensions: { code: 'FORBIDDEN' } }] });
    }
    return { projects: { edges: [{ node: { id: 'project', name: 'Project' } }],
      pageInfo: { endCursor: null, hasNextPage: false } } };
  }, async (read, requests) => {
    const firstPage = await read('providerAccountId', draft) as { nextCursor: string };
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    removed = true;
    await expect(read('providerAccountId', draft, firstPage.nextCursor)).rejects.toMatchObject({
      code: 'deployment_access_denied',
      data: { failureCause: { errorCode: 'railway_graphql_unavailable', nativeErrorCode: 'FORBIDDEN', httpStatus: 200 } },
    });
    expect(requests.map(({ variables }) => variables)).toEqual([
      {}, { workspaceId: first.id, after: null }, { workspaceId: remaining.id, after: null },
    ]);
  }, null);
});
