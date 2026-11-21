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

function withOptions(respond: (query: string) => unknown, assert: (read: (fieldPath: string, input: OptionsDraft, cursor?: string, creating?: boolean) => Promise<unknown>,
  requests: readonly { query: string; variables: unknown }[]) => Promise<void>, savedProject: string | null = projectId) {
  return (async () => {
    const requests: { query: string; variables: unknown }[] = [];
    const unavailable = (): never => { throw new Error('Unexpected Connected Account operation'); };
    const plugin = definePlugin({ ...railwayIdentity, hostAccess: railwayHostAccess,
      actions: { 'target-options-read': optionsAction }, resources: optionsResources });
    const http = createPluginHttpFixture({ async request(request) {
      expect(request.credentialBinding).toMatchObject({ kind: 'connectedAccountPurpose', purpose: 'cloud-api' });
      const document = JSON.parse(new TextDecoder().decode(request.body)) as typeof requests[number];
      requests.push(document);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ data: respond(document.query) })) };
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

it('reads one page of accessible projects for the account token', () => withOptions(() => ({
  projects: { pageInfo: { endCursor: 'next', hasNextPage: true }, edges: [
    { node: { id: projectId, name: 'Backend project' } },
  ] },
}), async (read, requests) => {
  await expect(read('providerAccountId', draft, 'prior')).resolves.toEqual({
    options: [{ value: projectId, label: 'Backend project' }], nextCursor: 'next',
  });
  expect(requests.map(({ variables }) => variables)).toEqual([{ after: 'prior' }]);
}, null));
