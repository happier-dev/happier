import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { resolveEffectiveActionInputFields } from '@happier-dev/plugin-sdk/actions';
import * as entry from '../index.js';

const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' };
const credentialPrincipal = { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
  localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } };
const draft = { credentialRef, credentialPrincipal, product: 'pages', providerIdentity: { providerAccountId: 'account' } };
const json = (result: unknown, result_info?: unknown) => ({ status: 200, headers: {},
  body: new TextEncoder().encode(JSON.stringify({ success: true, result, ...(result_info ? { result_info } : {}) })) });

it('keeps an empty Account discovery distinct from a missing draft dependency', async () => {
  const http = createPluginHttpFixture({ async request() { return json([]); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('target-options-read', { credentialRef, credentialPrincipal,
      fieldPath: 'providerIdentity.providerAccountId' })).resolves.toEqual({ options: [] });
    await expect(kit.invokeAction('target-options-read', { credentialRef, credentialPrincipal, product: 'pages',
      fieldPath: 'providerIdentity.providerResourceId' })).rejects.toMatchObject({ code: 'missing_option_dependency',
        details: { requiredDraftPath: 'providerIdentity.providerAccountId' } });
    await expect(kit.invokeAction('target-options-read', { ...draft, product: 'workers',
      fieldPath: 'triggerUuid' })).rejects.toMatchObject({ code: 'missing_option_dependency',
        details: { requiredDraftPath: 'providerIdentity.providerResourceId' } });
    const { product: _product, ...withoutProduct } = draft;
    await expect(kit.invokeAction('target-options-read', { ...withoutProduct,
      fieldPath: 'providerIdentity.providerResourceId' })).rejects.toMatchObject({ code: 'missing_option_dependency',
        details: { requiredDraftPath: 'product' } });
  } finally { await kit.dispose(); }
});

it.each(['workers-inspect', 'pages-inspect', 'targets-inspect-v1'])('resolves required discovery choices and conditional trigger visibility for %s', (actionId) => {
  const action = entry.manifest.contributes.actions.find(value => value.id === actionId);
  if (!action) throw new Error('Missing Cloudflare inspect Action');
  const fields = (input: unknown) => resolveEffectiveActionInputFields({ inputHints: action.inputHints }, input);
  expect(fields({}).filter(field => field.required).map(field => field.path)).toEqual(expect.arrayContaining([
    'providerIdentity.providerAccountId', 'providerIdentity.providerResourceId', 'providerEnvironment',
  ]));
  if (actionId !== 'pages-inspect') {
    expect(fields({ providerEnvironment: { kind: 'script', scriptName: 'worker' } })
      .find(field => field.path === 'triggerUuid')).toMatchObject({ required: true });
    const script = { kind: 'script', scriptName: 'worker' };
    expect(fields({ providerEnvironment: script, sourceMethod: 'upload' })
      .some(field => field.path === 'triggerUuid')).toBe(false);
    expect(fields({ providerEnvironment: script, sourceMethod: 'gitIntegration' })
      .find(field => field.path === 'triggerUuid')).toMatchObject({ required: true });
    expect(fields({ providerEnvironment: { kind: 'preview', scriptName: 'worker', previewName: 'feature' } })
      .some(field => field.path === 'triggerUuid')).toBe(false);
    expect(fields({ providerEnvironment: { kind: 'script', scriptName: 'worker' } })
      .some(field => field.path === 'preparedNative.projectName' && field.required)).toBe(false);
  }
  if (actionId !== 'workers-inspect') {
    for (const kind of ['production', 'preview']) {
      expect(fields({ providerEnvironment: { kind } })
        .find(field => field.path === 'preparedNative.projectName')).toMatchObject({ required: true });
    }
  }
});

it.each([
  { targetKind: 'cloudflare-workers', row: { id: 'selected-worker', tag: 'worker-tag' },
    expected: { value: 'worker-tag', label: 'selected-worker' }, endpoint: '/workers/scripts' },
  { targetKind: 'cloudflare-pages', row: { id: 'pages-id', name: 'selected-pages' },
    expected: { value: 'pages-id', label: 'selected-pages' }, endpoint: '/pages/projects' },
])('a per-product $targetKind target exposes no product choice and discovers its own projects from an empty draft', async ({ targetKind, row, expected, endpoint }) => {
  const target = entry.manifest.contributes.deploymentTargets.find(value => value.targetKind === targetKind);
  if (!target || target.role !== 'runtime') throw new Error('Missing Cloudflare runtime target');
  const inspect = entry.manifest.contributes.actions.find(action => action.id === target.actions.inspect);
  const fields = inspect?.inputHints?.fields ?? [];
  expect(fields.map(field => field.path)).not.toContain('product');
  const project = fields.find(field => field.path === 'providerIdentity.providerResourceId');
  if (!project?.inputType || !('localId' in project.inputType)) throw new Error('Missing project input type');
  const typeId = project.inputType.localId;
  const inputType = entry.manifest.contributes.inputTypes?.find(type => type.id === typeId);
  const resourceRef = inputType?.options?.resource;
  const resourceId = typeof resourceRef === 'string' ? resourceRef : resourceRef?.localId;
  if (typeof resourceId !== 'string') throw new Error('Missing project options Resource');
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) { requests.push(request); return json([row]); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const resource = kit.registration('resources', resourceId);
    if (!resource) throw new Error('Missing project choices Resource');
    const bytes = await resource.read(createTestResourceInvocationContext({
      query: { draftInput: { credentialRef, credentialPrincipal: { ...credentialPrincipal, purpose: {
        ...credentialPrincipal.purpose, consumer: { pluginId: entry.manifest.id, localId: target.actions.inspect } } },
        providerIdentity: { providerAccountId: 'account' } }, fieldPath: project.path },
      readAction: async (ref, input) => ({ ok: true, result: await kit.invokeAction(ref.localId, input) }) }));
    expect(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)))
      .toEqual({ options: [expected] });
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([`/client/v4/accounts/account${endpoint}`]);
  } finally { await kit.dispose(); }
});

it('loads one requested Pages page through the registered global Resource and named Account Action, without prefetch or secret projection', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return json([{ id: 'project-2', name: 'selected-project', deployment_configs: { production: { env_vars: { SECRET: { value: 'secret-value' } } } } }],
      { page: 2, per_page: 20, total_pages: 3, total_count: 41 });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const resource = kit.registration('resources', 'target-options');
    expect(resource, 'global target-options Resource must be registered').toBeDefined();
    if (!resource) throw new Error('Missing target-options Resource');
    const options = createTestResourceInvocationContext({ context: { kind: 'global' },
      query: { draftInput: { ...draft, providerEnvironment: {}, preparedNative: {} }, fieldPath: 'providerIdentity.providerResourceId', query: 'selected', cursor: '2' },
      readAction: async (ref, input) => ({ ok: true, result: await kit.invokeAction(ref.localId, input) }) });
    await resource.observe(() => { throw new Error('Explicit catalog reads have no push source'); }, options);
    expect(requests).toHaveLength(0);
    const bytes = await resource.read(options);
    const page = JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));
    expect(page).toEqual({ options: [{ value: 'project-2', label: 'selected-project' }], nextCursor: '3' });
    expect(JSON.stringify(page)).not.toContain('secret-value');
    expect(requests.map(value => [value.method, value.url])).toEqual([
      ['GET', 'https://api.cloudflare.com/client/v4/accounts/account/pages/projects?page=2'],
    ]);
    expect(requests[0].credentialBinding).toEqual({ kind: 'connectedAccountPurpose', purpose: 'deploy.manage',
      origin: 'https://api.cloudflare.com', method: 'GET', headerNames: ['authorization'] });
    expect(requests[0].headers ?? {}).not.toHaveProperty('authorization');
  } finally { await kit.dispose(); }
});

it('keeps Worker names and immutable tags distinct, filters scripts by search and discovers native triggers', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return request.url.endsWith('/triggers')
      ? json([{ trigger_uuid: 'trigger-id', external_script_id: 'immutable-tag', branch_includes: ['main'] }])
      : json([{ id: 'hello-worker', tag: 'immutable-tag' }, { id: 'other-worker', tag: 'other-tag' }]);
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const selected = { ...draft, product: 'workers' };
    expect(await kit.invokeAction('target-options-read', { ...selected, fieldPath: 'providerIdentity.providerResourceId', query: 'hello' }))
      .toEqual({ options: [{ value: 'immutable-tag', label: 'hello-worker' }] });
    expect(await kit.invokeAction('target-options-read', { ...selected, fieldPath: 'providerEnvironment', query: 'hello' }))
      .toEqual({ options: [{ value: { kind: 'script', scriptName: 'hello-worker' }, label: 'hello-worker' }] });
    expect(await kit.invokeAction('target-options-read', { ...selected, providerIdentity: { providerAccountId: 'account', providerResourceId: 'immutable-tag' }, fieldPath: 'triggerUuid' }))
      .toEqual({ options: [{ value: 'trigger-id', label: 'trigger-id' }] });
    expect(requests[2].url).toBe('https://api.cloudflare.com/client/v4/accounts/account/builds/workers/immutable-tag/triggers');
  } finally { await kit.dispose(); }
});

it('propagates cancelled Resource lifetime and custody refusal without provider reads or a second credential path', async () => {
  const controller = new AbortController();
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry });
  try {
    const resource = kit.registration('resources', 'target-options');
    expect(resource).toBeDefined();
    if (!resource) throw new Error('Missing target-options Resource');
    controller.abort();
    await expect(resource.read(createTestResourceInvocationContext({ signal: controller.signal,
      query: { draftInput: draft, fieldPath: 'providerIdentity.providerResourceId' },
      readAction: async (_ref, _input, options) => { options?.signal?.throwIfAborted(); throw new Error('Unexpected read'); } }))).rejects.toMatchObject({ name: 'AbortError' });
    await expect(resource.read(createTestResourceInvocationContext({
      query: { draftInput: draft, fieldPath: 'providerIdentity.providerResourceId' },
      readAction: async () => ({ ok: false, errorCode: 'connected_account_access_denied', error: 'Denied' }) })))
      .rejects.toMatchObject({ code: 'connected_account_access_denied' });
    // The Resource-to-host Action boundary returns the canonical typed refusal.
    await expect(resource.read(createTestResourceInvocationContext({
      query: { draftInput: draft, fieldPath: 'triggerUuid' },
      readAction: async () => ({ ok: false, errorCode: 'missing_option_dependency', error: 'missing_option_dependency',
        details: { requiredDraftPath: 'providerIdentity.providerResourceId' } }) })))
      .rejects.toMatchObject({ code: 'missing_option_dependency',
        details: { requiredDraftPath: 'providerIdentity.providerResourceId' } });
  } finally { await kit.dispose(); }
});

it('discovers Accounts with provider paging and filters product and Pages environment choices without network reads', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return json([{ id: 'account', name: 'Selected Account' }], { count: 1, page: 1, per_page: 20, total_count: 21 });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    expect(await kit.invokeAction('target-options-read', { credentialRef, credentialPrincipal, fieldPath: 'providerIdentity.providerAccountId', query: 'Selected' }))
      .toEqual({ options: [{ value: 'account', label: 'Selected Account' }], nextCursor: '2' });
    expect(requests[0].url).toBe('https://api.cloudflare.com/client/v4/accounts?name=Selected');
    expect(await kit.invokeAction('target-options-read', { credentialRef, credentialPrincipal, fieldPath: 'product', query: 'Pages' }))
      .toEqual({ options: [{ value: 'pages', label: 'Pages' }] });
    expect(await kit.invokeAction('target-options-read', { ...draft, fieldPath: 'providerEnvironment', query: 'Preview' }))
      .toEqual({ options: [{ value: { kind: 'preview' }, label: 'Preview' }] });
    expect(requests).toHaveLength(1);
  } finally { await kit.dispose(); }
});

it('cancels an in-flight provider read with the invoking lifetime', async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const http = createPluginHttpFixture({ async request(_request, options) {
    entered();
    await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }));
    return json([]);
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const pending = kit.invokeAction('target-options-read', { ...draft, fieldPath: 'providerIdentity.providerResourceId' }, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'plugin_action_aborted' });
  } finally { await kit.dispose(); }
});

it('offers existing native Previews only for the selected Worker, without creating a Preview', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return json([{ id: 'preview-id', name: 'feature/one', slug: 'feature-one', tags: [], observability: { enabled: false },
      logpush: false, tail_consumers: [], urls: [], created_on: '2026-10-31T12:00:00Z', updated_on: '2026-10-31T12:00:00Z' }],
      { page: 2, total_pages: 3, per_page: 10, total_count: 21 });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    expect(await kit.invokeAction('target-options-read', { ...draft, product: 'workers',
      scriptName: 'chosen-worker', fieldPath: 'providerEnvironment', query: 'feature', cursor: '2' }))
      .toEqual({ options: [{ value: { kind: 'preview', scriptName: 'chosen-worker', previewName: 'feature/one' }, label: 'feature/one' }], nextCursor: '3' });
    expect(requests.map(value => [value.method, value.url])).toEqual([
      ['GET', 'https://api.cloudflare.com/client/v4/accounts/account/workers/workers/chosen-worker/previews?page=2&name=feature'],
    ]);
  } finally { await kit.dispose(); }
});

it.each([
  { environment: { kind: 'script', scriptName: 'existing-worker' }, row: { id: 'existing-worker', tag: 'native-tag' },
    expected: { value: 'native-tag', label: 'existing-worker' } },
  { environment: { kind: 'production' }, row: { id: 'native-project', name: 'existing-project' },
    expected: { value: 'native-project', label: 'existing-project' } },
])('resolves choices for an existing inspect draft whose environment already identifies the product: $environment.kind', async ({ environment, row, expected }) => {
  const http = createPluginHttpFixture({ async request() { return json([row]); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const resource = kit.registration('resources', 'target-options');
    if (!resource) throw new Error('Missing target-options Resource');
    const bytes = await resource.read(createTestResourceInvocationContext({
      query: { draftInput: { credentialRef, credentialPrincipal, providerIdentity: { providerAccountId: 'account', providerResourceId: 'native-tag' },
        providerEnvironment: environment }, fieldPath: 'providerIdentity.providerResourceId' },
      readAction: async (ref, input) => ({ ok: true, result: await kit.invokeAction(ref.localId, input) }) }));
    expect(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)))
      .toEqual({ options: [expected] });
  } finally { await kit.dispose(); }
});
