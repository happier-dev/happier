import axios from 'axios';
import * as fs from 'node:fs/promises';
import { configuration } from '@/configuration';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { bindPresentUserActionConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { ProjectAccountRowV1Schema, ProjectAccountRowReadRequestV1Schema, ProjectAccountRowReadResponseV1Schema,
  ProjectAccountRowMutationRequestV1Schema, buildProjectAccountRowPhysicalKeyV1,
  type ProjectAccountRowKeyV1, type ProjectAccountOrganizationV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { buildProjectLastOpenedMemoryKeyV1, type AuthoringMemoryRowV1 } from '@happier-dev/protocol/account/authoringMemory';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipV1Schema,
  type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';

import { createCliActionDeps } from './createCliActionDeps';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createAuthoringMemoryRowCipher } from '@/settings/authoringMemory/createAuthoringMemoryClient';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

let accountFixtureSequence = 0;
afterEach(() => { vi.restoreAllMocks(); accountFixtureSequence += 1; });

function executor(accountId = `project-account-${accountFixtureSequence}`) {
  const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  return createActionExecutor(createCliActionDeps({
    token, credentials: { token, encryption: null },
    sessionId: 'cli-global', mode: 'plain', ctx: null,
    serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.test',
  }));
}

describe('project definition exact Machine transport', () => {
  it('dispatches setup edits through the bound Project owner and preserves its association refusal', async () => {
    accountBoundary();
    const accountId = 'setup-editor';
    const actions = executor(accountId);
    const context: ActionExecutorContext = { authority: 'present_user', surface: 'cli', actionCaller: { kind: 'host' },
      runtimeAccountId: accountId, serverId: 'home-a', serverIdentityId: 'home-a', actionRequestId: 'setup-association-check',
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }) };
    // An existing Account Project mutation proves this exact Home boundary works.
    expect(await actions.execute('projects.organization.update', {
      projectRef: { serverId: 'home-a', projectKey: 'first' }, expectedRevision: 2, label: 'Setup edit control',
    }, context)).toMatchObject({ ok: true, result: { ok: true, revision: 3 } });
    const input = {
      projectRef: { serverId: 'home-a', projectKey: 'first' }, expectedRevision: 3,
      workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'visible', rootPath: '/work/visible' },
      intent: { kind: 'personal', setupOverrides: null },
    } as const;
    // Exercise the real in-flow confirmation owner; child policy consumes the
    // same normalized Account settings before the Project association check.
    expect(await actions.execute('projects.setup.set', input,
      bindPresentUserActionConfirmationV1('projects.setup.set', input, context)))
      .toMatchObject({ ok: true, result: { ok: false, errorCode: 'project_workspace_association_mismatch' } });
  });
  it('carries original requester authority to Project Open instead of using ambient Account transport', async () => {
    const token = 'requester-token';
    const privateKey = new Uint8Array(32).fill(3);
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'source-session',
      mode: 'plain', ctx: null, serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.test',
      externalActionMachineRequestPrivateKey: privateKey, externalActionMachineInstallationId: 'source-install' });
    const input = { serverId: 'home-a', machineId: 'target', source: { kind: 'folder' as const, path: '/repo' },
      materialization: { kind: 'attach' as const } };
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', actionRequestId: 'original-request',
      externalActionTarget: { kind: 'machine', machineId: 'target' }, externalActionExecutionAuthorization: {
        v: 1, token: 'home-issued-token', binding: { accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 },
          serverIdentityId: 'home', machineId: 'target', custodianAccountId: 'custodian', installationId: 'target-install',
          actionId: 'projects.open', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43),
          target: { kind: 'machine', machineId: 'target' } },
      } };
    const boundary = vi.spyOn(machineTransport, 'callExactMachineRpc').mockResolvedValue({ kind: 'refused', code: 'setup_required' });
    const ambient = vi.spyOn(machineTransport, 'callMachineRpc').mockResolvedValue({ kind: 'refused', code: 'wrong_authority' });
    expect(await deps.projectsOpen!(input, context)).toEqual({ kind: 'refused', code: 'setup_required' });
    expect(boundary).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'target', request: input,
      requestId: 'original-request', externalAction: { context, effectActionId: 'projects.open',
        installationId: 'source-install', privateKey } }));
    expect(ambient).not.toHaveBeenCalled();
    boundary.mockRejectedValueOnce(markRpcRequestDisposition(
      new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND), 'notSent'));
    await expect(deps.projectsOpen!(input, context)).resolves.toMatchObject({
      kind: 'refused', code: RPC_ERROR_CODES.UPDATE_REQUIRED,
    });
    boundary.mockRejectedValueOnce(markRpcRequestDisposition(
      new RpcError('Temporary routing failure', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE), 'notSent'));
    await expect(deps.projectsOpen!(input, context)).resolves.toMatchObject({
      kind: 'refused', code: 'machine_unreachable',
    });
  });
  it('carries the qualified workspace, admitted authority and cancellation to the exact Machine, validates output and refuses another Home', async () => {
    const token = 'project-token';
    // Already-admitted host transport is the network boundary. Original
    // Account inspection is covered through Home and installed ingress.
    const boundary = vi.fn(async (_method: string, _request: unknown,
      _options?: Parameters<NonNullable<Parameters<typeof createCliActionDeps>[0]['machineActionDirectTargetTransport']>['invoke']>[2]): Promise<unknown> => ({
      definition: { basis: { kind: 'absent' }, document: null },
      detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
    }));
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.test',
      machineActionDirectTargetTransport: { machineId: 'machine-a', invoke: boundary } });
    const fallback = vi.spyOn(machineTransport, 'callMachineRpc').mockRejectedValue(new Error('wrong_machine_transport'));
    const workspace = { serverId: 'home-a', workspaceId: 'workspace-a', machineId: 'machine-a', rootPath: '/work/project' };
    const signal = new AbortController().signal;
    expect(deps.projectDefinitionAction).toBeTypeOf('function');
    expect(await deps.projectDefinitionAction!({ actionId: 'projects.inspect', input: { workspace }, context: { signal } }))
      .toMatchObject({ definition: { basis: { kind: 'absent' } }, detection: { coverage: 'complete' } });
    expect(boundary).toHaveBeenCalledWith('daemon.projects.inspect.v1', { workspace }, expect.objectContaining({ signal }));
    expect(fallback).not.toHaveBeenCalled();
    const sourceDefinition = { basis: { kind: 'present' as const, hash: 'a'.repeat(64) },
      document: readProjectManifestDocument(JSON.stringify({ version: 1,
        scripts: { check: { source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } },
      })) };
    expect(sourceDefinition.document.status).toBe('valid');
    boundary.mockResolvedValue({ definition: sourceDefinition,
      detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [] });
    const fullExecutor = createActionExecutor(deps);
    expect(await fullExecutor.execute('projects.inspect', { workspace }, {
      authority: 'account_automation', surface: 'api', signal, serverId: workspace.serverId,
      externalActionTarget: { kind: 'machine', machineId: workspace.machineId },
    })).toMatchObject({ ok: true, result: { definition: sourceDefinition } });
    expect(boundary).toHaveBeenLastCalledWith('daemon.projects.inspect.v1', { workspace }, expect.objectContaining({ signal,
      localActionContext: expect.objectContaining({ authority: 'account_automation' }),
    }));
    boundary.mockClear();
    expect(await deps.projectDefinitionAction!({ actionId: 'projects.inspect', input: { workspace: { ...workspace, serverId: 'home-b' } }, context: {} }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(boundary).not.toHaveBeenCalled();
    boundary.mockResolvedValue({ kind: 'approval_request_created', artifactId: 'review-a', actionId: 'projects.manifest.update' });
    expect(await deps.projectDefinitionAction!({ actionId: 'projects.manifest.update', input: { workspace, expectedBasis: { kind: 'absent' }, bytes: '{"version":1}' }, context: {} }))
      .toMatchObject({ kind: 'approval_request_created', artifactId: 'review-a', actionId: 'projects.manifest.update' });
    boundary.mockResolvedValue({ definition: { basis: { kind: 'absent' }, document: null }, detection: {}, unadmitted: true });
    expect(await deps.projectDefinitionAction!({ actionId: 'projects.inspect', input: { workspace }, context: {} }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });
});

function accountBoundary(options?: Readonly<{
  visibleUnpinned?: boolean;
  memoryRows?: readonly AuthoringMemoryRowV1[];
  promptStack?: ProjectAccountOrganizationV1['promptStack'];
  relationships?: readonly WorkspaceSyncRelationshipV1[];
}>) {
  const ref = (id: string, serverId = 'home-a', machineId = 'machine-a') => ({
    id, serverId, machineId, rootPath: `/work/${id}`, projectKey: id === 'second' ? 'first' : id, createdAtMs: 1,
  });
  const row = (key: ProjectAccountRowKeyV1, value: unknown) => ProjectAccountRowV1Schema.parse({
    key, revision: 2, content: { t: 'plain', v: { key, value } },
  });
  // "visible" was set up from a Source, so it is a Project the person added (owner 11-08: the list holds those).
  const refs = [{ ...ref('visible'), source: { sourceId: 'visible-source', revision: 1 } }, ref('second', 'home-a', 'machine-b'), ref('first'), ref('visible', 'home-b')];
  const rows = [
    ...refs.map(value => row({ kind: 'workspace-ref', serverId: value.serverId, id: value.id }, value)),
    row({ kind: 'project-organization', serverId: 'home-a', projectKey: 'first' },
      { hidden: options?.visibleUnpinned !== true, pinned: options?.visibleUnpinned !== true, promptStack: options?.promptStack ?? [] }),
    ...(options?.relationships ? [row({ kind: 'relationship-graph' }, { relationships: options.relationships })] : []),
  ];
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    expect(url).toMatch(/^https:\/\/home-a\.test\//);
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (url.endsWith('/v1/account/authoring-memory')) return { status: 200, data: { rows: options?.memoryRows ?? [] } };
    if (url.endsWith('/v1/machines')) return { status: 200, data: [
      { id: 'machine-a', active: true, kind: 'persistent', revokedAt: null, replacedByMachineId: null },
      { id: 'machine-b', active: false, kind: 'persistent', revokedAt: null, replacedByMachineId: null },
    ] };
    throw new Error(`unexpected_get:${url}`);
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (url.endsWith('/mutate')) {
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      // HTTP is the mocked boundary; acknowledge the whole atomic CAS batch so real owner validation remains exercised.
      const currentRow = (key: ProjectAccountRowKeyV1) => rows.find(value => buildProjectAccountRowPhysicalKeyV1(value.key) === buildProjectAccountRowPhysicalKeyV1(key));
      for (const item of [...request.expectedRefs, ...request.mutations]) {
        const current = currentRow(item.key);
        if ((current?.revision ?? 'absent') !== item.expectedRevision) return { status: 200,
          data: { status: 'conflict', key: item.key, revision: current?.revision ?? -1 } };
      }
      const changed = request.mutations.map(mutation => ProjectAccountRowV1Schema.parse({ key: mutation.key,
        revision: (currentRow(mutation.key)?.revision ?? -1) + 1, content: mutation.content }));
      for (const next of changed) {
        const index = rows.findIndex(value => buildProjectAccountRowPhysicalKeyV1(value.key) === buildProjectAccountRowPhysicalKeyV1(next.key));
        if (index < 0) rows.push(next); else rows[index] = next;
      }
      return { status: 200, data: { status: 'updated', rows: changed, cursor: Math.max(...changed.map(row => row.revision)) } };
    }
    if (url.endsWith('/read')) {
      const { key } = ProjectAccountRowReadRequestV1Schema.parse(body);
      const current = rows.find(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(key));
      return { status: 200, data: ProjectAccountRowReadResponseV1Schema.parse(current
        ? current.content === null ? { status: 'deleted', revision: current.revision } : { status: 'present', row: current }
        : { status: 'absent' }) };
    }
    expect(url).toBe('https://home-a.test/v1/account/project-rows/list');
    return projectAccountRowsReadHttpResponse(rows, url, body);
  });
  return { post, rows };
}

describe('Project choices through the real CLI Account composition', () => {
  it('names Usage operands from encrypted native Project rows outside the answering Home namespace', async () => {
    const serverId = 'home-a';
    const accountId = 'usage-project-options';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const encryption = { type: 'legacy' as const, secret: new Uint8Array(32).fill(8) };
    const cipher = createProjectAccountRowCipherV1({ mode: 'e2ee', material: encryption, randomBytes: n => new Uint8Array(n) });
    const desktop = 'a'.repeat(64);
    const laptop = 'b'.repeat(64);
    const unknown = 'c'.repeat(64);
    const unused = 'd'.repeat(64);
    const foreignCheckout = 'foreign-checkout';
    const organizations = [
      { home: 'native-source-one', key: desktop, root: '/private/first/work' },
      { home: 'native-source-two', key: laptop, root: '/private/second/work' },
      { home: 'native-source-two', key: unused, root: '/private/unused/work' },
    ].map(({ home, key: projectKey, root }) => {
      const key = { kind: 'project-organization' as const, serverId: home, projectKey };
      return { key, revision: 0, content: cipher.seal({ key, value: { label: 'work', nativeUsageRootPath: root } }) };
    });
    const key = { kind: 'workspace-ref' as const, serverId: 'unrelated-home', id: foreignCheckout };
    const rows = [...organizations, { key, revision: 0, content: cipher.seal({ key, value: {
      serverId: key.serverId, id: key.id, machineId: 'foreign-machine', rootPath: '/private/foreign', label: 'Foreign checkout', createdAtMs: 1,
    } }) }];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 0 } };
      if (url.endsWith('/v1/machines')) return { status: 200, data: [] };
      throw new Error(`Unexpected GET ${url}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => projectAccountRowsReadHttpResponse(rows, url, body));
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
      scopeKeys: [{ dimension: 'project', keys: [desktop, laptop, unknown, foreignCheckout] }] });
    const deps = createCliActionDeps({ token, credentials: { token, encryption }, sessionId: 'cli-global',
      mode: 'legacy', ctx: null, serverId, serverHttpBaseUrl: 'https://home-a.test' });
    const actions = createActionExecutor({ ...deps, usageActions: {
      query: async ({ queries }) => resolveUsagePageAggregation({ queries,
        accounting: queries.map(query => ({ query, value: accounting, status: 'available' as const })),
      }, bundledUsageModelPriceCatalog),
    } });

    const choices = await actions.execute('action.options.resolve', {
      actionId: 'usage.query', optionsSourceId: 'usage.filters.projects', draftInput: { period: { relative: '7days' } },
    }, { surface: 'agent', serverId, runtimeAccountId: accountId });

    expect(choices).toMatchObject({ ok: true, result: { options: expect.arrayContaining([
      { value: desktop, label: 'work · first' }, { value: laptop, label: 'work · second' },
      { value: unknown, label: 'No project name' }, { value: foreignCheckout, label: 'No project name' },
    ]) } });
    if (!choices.ok) throw new Error('Expected Project choices');
    expect(choices.result).toMatchObject({ options: { length: 4 } });
    expect(post.mock.calls.filter(([url]) => url.endsWith('/v1/account/project-rows/list'))).toHaveLength(1);
  });
});

describe('projects.list through the real CLI Account composition', () => {
  it('returns a listed managed checkout through Action output validation', async () => {
    const { rows } = accountBoundary();
    const key = { kind: 'workspace-ref', serverId: 'home-a', id: 'coder-checkout' } as const;
    const controller = { machineId: 'machine-a', installationId: 'coder-installation' };
    const rootPath = '/home/coder/qa-rws-repo';
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: { t: 'plain', v: {
      key, value: { v: 2, kind: 'managed', id: key.id, serverId: key.serverId, managedId: 'coder-guest',
        controller, rootPath, createdAtMs: 1, source: { sourceId: 'coder-source', revision: 1 } },
    } } }));

    const listed = await executor().execute('projects.list', {}, { surface: 'cli', bypassApprovals: true });

    expect(listed.ok, listed.ok ? undefined : listed.errorCode).toBe(true);
    expect(listed).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
      expect.objectContaining({ workspaceAddress: {
        v: 2, kind: 'managed', workspaceId: key.id, serverId: key.serverId, managedId: 'coder-guest', controller, rootPath,
      }, reachable: null }),
      expect.objectContaining({ workspaceAddress: {
        workspaceId: 'visible', serverId: key.serverId, machineId: 'machine-a', rootPath: '/work/visible',
      }, machineId: 'machine-a' }),
    ]) } });
    if (listed.ok) {
      const managed = (listed.result as { items: { workspaceAddress: { workspaceId: string } }[] }).items
        .find(item => item.workspaceAddress.workspaceId === key.id);
      expect(managed).not.toHaveProperty('machineId');
    }
  });

  it('includes Session-only Projects only when includeUnlisted is admitted', async () => {
    const { rows } = accountBoundary();
    const key = { kind: 'workspace-ref' as const, serverId: 'home-a', id: 'session-only' };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: { t: 'plain', v: {
      key, value: { id: key.id, serverId: key.serverId, machineId: 'machine-a',
        rootPath: '/work/session-only', projectKey: key.id, createdAtMs: 1 },
    } } }));
    const owner = executor();
    for (const includeUnlisted of [undefined, false, true]) {
      const result = await owner.execute('projects.list', {
        ...(includeUnlisted === undefined ? {} : { includeUnlisted }),
      }, { surface: 'mcp', bypassApprovals: true });
      expect(result).toMatchObject({ ok: true, result: {
        items: includeUnlisted
          ? [{ projectKey: { id: 'session-only' } }, { projectKey: { id: 'visible' } }]
          : [{ projectKey: { id: 'visible' } }],
        truncated: false, coverage: 'complete',
      } });
    }
  });

  it('projects an implicit same-Home profile context through the canonical Home identity', async () => {
    accountBoundary();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'same-home-account' })).toString('base64url')}.signature`;
    const owner = createActionExecutor(createCliActionDeps({
      token,
      credentials: { token, encryption: null },
      sessionId: 'same-home-session',
      mode: 'plain',
      ctx: null,
      serverId: 'profile-a',
      serverIdentityId: 'home-a',
      serverHttpBaseUrl: 'https://home-a.test',
    }));

    expect(await owner.execute('projects.list', {}, {
      surface: 'mcp',
      serverId: 'profile-a',
      bypassApprovals: true,
    })).toMatchObject({
      ok: true,
      result: {
        items: [
          { projectKey: { serverId: 'home-a', id: 'visible' } },
        ],
      },
    });
  });

  it('ranks requester rows from requester memory and Machine visibility without borrowing the custodian token', async () => {
    const memoryCipher = createAuthoringMemoryRowCipher({ accountMode: 'plain', material: null });
    const memoryRows = [['first', 10], ['visible', 40]].map(([projectKey, value]) => {
      const key = buildProjectLastOpenedMemoryKeyV1({ serverId: 'home-a', projectKey: String(projectKey) });
      return { key, revision: 0, content: memoryCipher.seal(key, value) };
    });
    const { post, rows } = accountBoundary({ visibleUnpinned: true, memoryRows });
    let retireOnMachineRead = false;
    const get = vi.mocked(axios.get);
    const readBoundary = get.getMockImplementation()!;
    get.mockImplementation(async (url, config) => {
      expect(config?.headers).toMatchObject({ 'x-requester-proof': 'bob' });
      expect(config?.headers).not.toHaveProperty('Authorization');
      expect(url).not.toContain('/v1/account/encryption');
      const response = await readBoundary(url, config);
      if (retireOnMachineRead && url.endsWith('/v1/machines')) current = false;
      return response;
    });
    const rowBoundary = post.getMockImplementation()!;
    post.mockImplementation(async (url, body, config) => {
      expect(config?.headers).toMatchObject({ 'x-requester-proof': 'bob' });
      expect(config?.headers).not.toHaveProperty('Authorization');
      return rowBoundary(url, body, config);
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    const owner = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'custodian-session', mode: 'plain', ctx: null, serverId: 'home-a', serverIdentityId: 'home-a', serverHttpBaseUrl: 'https://home-a.test' }));
    let current = true;
    const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'original-proof', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'identity',
      machineId: 'machine-a', custodianAccountId: 'alice', installationId: 'installation', actionId: 'projects.list',
      requestId: 'request-projects-list', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine-a' }, accountEncryptionMode: 'plain',
    } };
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId: 'bob', serverId: 'home-a', accountEncryptionMode: 'plain',
      projectAccountRowCipher: createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) }),
      authoringMemoryRowCipher: memoryCipher, isCurrent: async () => current, readArtifact: async () => null } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId: 'bob', serverId: 'home-a', serverIdentityId: 'identity',
      serverHttpBaseUrl: 'https://home-a.test', accountEncryptionMode: 'plain', isCurrent: async () => current,
      createRequestHeaders: async () => current ? { 'x-requester-proof': 'bob' } : null } });
    const context: ActionExecutorContext = { surface: 'mcp', bypassApprovals: true, externalActionExecutionAuthorization: authorization };
    const before = structuredClone(rows);
    const reads = vi.spyOn(fs, 'readFile');
    expect(await owner.execute('projects.list', {}, context)).toMatchObject({ ok: true, result: { items: [
      { projectKey: { id: 'visible' }, reachable: true }, { projectKey: { id: 'first' }, reachable: true },
      { projectKey: { id: 'second' }, reachable: false },
    ] } });
    expect(rows).toEqual(before);
    expect.soft(reads.mock.calls.filter(([file]) => file === configuration.settingsFile)).toHaveLength(1);
    current = false; get.mockClear(); post.mockClear();
    expect(await owner.execute('projects.list', {}, context)).toMatchObject({ ok: false });
    expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    current = true; retireOnMachineRead = true;
    expect(await owner.execute('projects.list', {}, context)).toMatchObject({ ok: false });
    expect(get.mock.calls.some(([url]) => url.endsWith('/v1/machines'))).toBe(true);
  });

  it('ranks qualified Project anchors from authoring memory without writing structural rows or using leaf recency', async () => {
    const memoryRows = ([['home-a', 'first', 10], ['home-a', 'visible', 40], ['home-a', 'second', 2000], ['home-b', 'first', 3000]] as const)
      .map(([serverId, projectKey, value]) => ({ key: buildProjectLastOpenedMemoryKeyV1({ serverId, projectKey }),
        revision: 0, content: { t: 'plain' as const, v: value } }));
    const { post, rows } = accountBoundary({ visibleUnpinned: true, memoryRows });
    for (let index = 0; index < 1024; index++) {
      const key = { kind: 'project-organization' as const, serverId: 'home-a', projectKey: `unrelated-${index}` };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: { t: 'plain', v: { key, value: {} } } }));
    }
    const listed = await executor().execute('projects.list', {}, { surface: 'mcp', bypassApprovals: true });
    expect(vi.mocked(axios.get).mock.calls.filter(([url]) => url.endsWith('/authoring-memory'))).toHaveLength(1);
    expect(listed).toMatchObject({ ok: true, result: {
      items: [{ projectKey: { id: 'visible' }, hidden: false, pinned: false },
        { projectKey: { id: 'first' }, hidden: false, pinned: false },
        { projectKey: { id: 'second' }, hidden: false, pinned: false }],
    } });
    expect(post.mock.calls.every(([url]) => !url.endsWith('/mutate'))).toBe(true);
    expect(post.mock.calls.map(([, body]) => body)).toEqual([{ kinds: ['workspace-ref', 'project-organization'], serverId: 'home-a' }]);
  });

  it('shows an anchored Project through the same organization CAS without dropping pins or context', async () => {
    const { post } = accountBoundary();
    const owner = executor();
    expect(await owner.execute('projects.visibility.set', {
      target: { serverId: 'home-a', projectKey: 'first' }, expectedRevision: 2, hidden: false,
    }, { surface: 'agent', bypassApprovals: true })).toMatchObject({ ok: true, result: {
      row: { hidden: false, pinned: true, promptStack: [] }, revision: 3,
    } });
    const mutation = post.mock.calls.find(([url]) => url.endsWith('/mutate'))?.[1];
    expect(mutation).toMatchObject({ topologyChange: false, expectedRefs: [], mutations: [{
      key: { kind: 'project-organization', serverId: 'home-a', projectKey: 'first' }, expectedRevision: 2,
      content: { t: 'plain', v: { value: { hidden: false, pinned: true, promptStack: [] } } },
    }] });
    expect(await owner.execute('projects.list', {}, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { items: [{ projectKey: { id: 'first' }, hidden: false },
        { projectKey: { id: 'second' }, hidden: false }, { projectKey: { id: 'visible' }, hidden: false }] } });
  });
  it('omits hidden anchors in Agent/MCP reads, includes their exact ordered leaves only on explicit request', async () => {
    accountBoundary();
    const owner = executor();
    const visible = { projectKey: { serverId: 'home-a', id: 'visible' },
      project: { serverId: 'home-a', projectKey: 'visible' },
      workspaceAddress: { serverId: 'home-a', workspaceId: 'visible', machineId: 'machine-a', rootPath: '/work/visible' },
      hidden: false };
    for (const surface of ['agent', 'mcp'] as const) {
      expect(await owner.execute('projects.list', {}, { surface, bypassApprovals: true }))
        .toMatchObject({ ok: true, result: { items: [visible], truncated: false, coverage: 'complete' } });
    }
    const includingHidden = await owner.execute('projects.list', { includeHidden: true }, { surface: 'mcp', bypassApprovals: true });
    expect(includingHidden).toMatchObject({ ok: true, result: { items: [
      { projectKey: { serverId: 'home-a', id: 'first' }, project: { serverId: 'home-a', projectKey: 'first' }, hidden: true },
      { projectKey: { serverId: 'home-a', id: 'second' }, project: { serverId: 'home-a', projectKey: 'first' }, hidden: true },
      visible,
    ], truncated: false, coverage: 'complete' } });
    expect(await owner.execute('projects.list', { includeHidden: true, machineId: 'machine-b', limit: 1 }, { surface: 'cli', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { items: [{ projectKey: { serverId: 'home-a', id: 'second' } }], truncated: false } });
    expect(await owner.execute('projects.list', { includeHidden: true, limit: 1 }, { surface: 'cli', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { items: [{ projectKey: { serverId: 'home-a', id: 'first' } }], truncated: true, coverage: 'partial' } });
  });

  it('admits requester Project rows once per read and preserves Home, Account, custody and cancellation refusals', async () => {
    const { post } = accountBoundary({ visibleUnpinned: true });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'custodian-session', mode: 'plain', ctx: null, serverId: 'home-a', serverIdentityId: 'home-a',
      serverHttpBaseUrl: 'https://home-a.test' });
    let current = true;
    const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'original-proof', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home-a',
      machineId: 'machine-a', custodianAccountId: 'alice', installationId: 'installation', actionId: 'action.options.resolve',
      requestId: 'request-project-choices', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine-a' }, accountEncryptionMode: 'plain',
    } };
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId: 'bob', serverId: 'home-a', accountEncryptionMode: 'plain',
      projectAccountRowCipher: createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) }),
      isCurrent: async () => current, readArtifact: async () => null } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId: 'bob', serverId: 'home-a', serverIdentityId: 'home-a',
      serverHttpBaseUrl: 'https://home-a.test', accountEncryptionMode: 'plain', isCurrent: async () => current,
      createRequestHeaders: async () => current ? { 'x-requester-proof': 'bob' } : null } });
    const context: ActionExecutorContext = { surface: 'mcp', externalActionExecutionAuthorization: authorization };
    // Observe the real filesystem boundary: each pinned Home admission reads
    // its saved profiles once to reject ambiguous identities. No owner is mocked.
    const reads = vi.spyOn(fs, 'readFile');
    const choices = await deps.projectWorkspaceRefs!({}, context);
    expect(choices).toMatchObject({ workspaceRefs: [
      { id: 'first' }, { id: 'second' }, { id: 'visible' },
    ] });
    expect(post.mock.calls).toHaveLength(1);
    expect(post.mock.calls[0]?.[2]?.headers).toMatchObject({ 'x-requester-proof': 'bob' });
    expect(post.mock.calls[0]?.[2]?.headers).not.toHaveProperty('Authorization');
    expect(reads.mock.calls.filter(([file]) => file === configuration.settingsFile)).toHaveLength(1);
    for (const refused of [
      { ...context, serverId: 'another-home' },
      { ...context, runtimeAccountId: 'another-account' },
      { surface: 'mcp' as const, externalActionCredential: {
        accountId: 'alice', principalId: 'alice', credentialId: 'unadmitted', grant: API_TOKEN_FULL_GRANT_V1,
      } },
    ]) {
      post.mockClear();
      expect(await deps.projectWorkspaceRefs!({}, refused)).toMatchObject({ ok: false, errorCode: 'project_account_access_denied' });
      expect(post).not.toHaveBeenCalled();
    }
    current = false; post.mockClear();
    await expect(deps.projectWorkspaceRefs!({}, context)).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
    expect(post).not.toHaveBeenCalled();
    current = true;
    const cancelled = new AbortController(); cancelled.abort();
    await expect(deps.projectWorkspaceRefs!({}, { ...context, signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(post).not.toHaveBeenCalled();
  });

  it('offers the visible checkouts of this Home as the typed Checkout input choices, through the admission the input validator uses', async () => {
    accountBoundary({ visibleUnpinned: true });
    const owner = executor();
    const accountId = `project-account-${accountFixtureSequence}`;
    const surface = { serverId: 'home-a', accountId, owner: { kind: 'home' as const } };
    const request = { consumer: { kind: 'widget' as const, surface, definition: { kind: 'builtin' as const, id: 'project_checkouts' } }, fieldPath: 'checkout' };
    const result = await owner.execute('action.options.resolve', request, { surface: 'mcp', bypassApprovals: true, serverId: 'home-a' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { optionsSourceId: 'host-input:workspace' } });
    if (!result.ok) return;
    const options = (result.result as { options: readonly { value: { id: string; serverId: string; machineId: string } }[] }).options;
    // Another Home's checkout is not a choice, and a choice carries the complete ref the validator resolves.
    expect(options.map(option => option.value.id).sort()).toEqual(['first', 'second', 'visible']);
    expect(options.every(option => option.value.serverId === 'home-a')).toBe(true);
    expect(options.find(option => option.value.id === 'second')?.value).toMatchObject({ machineId: 'machine-b', rootPath: '/work/second' });
  });

  it('refuses another Home before touching the current Account and exposes no unaccepted registration Action', async () => {
    const { post } = accountBoundary();
    const owner = executor();
    expect(await owner.execute('projects.list', { serverId: 'home-b' }, { surface: 'agent', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(post).not.toHaveBeenCalled();
    expect(ActionIdSchema.safeParse('projects.workspace.register').success).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('workspace metadata parity through the real CLI Account composition', () => {
  const promptStack = [{ id: 'project-context', ref: { kind: 'doc' as const, serverId: 'home-a', artifactId: 'context-doc' },
    enabled: true, placement: 'system_append' as const, maxChars: 1024 }];
  // This fixture represents the host replaying an explicitly approved present-user decision.
  const approvedPresentUser = { surface: 'cli' as const, authority: 'present_user' as const, bypassApprovals: true };

  it('does not turn an unsealed same-Account public principal into private row custody', async () => {
    const { post, rows } = accountBoundary();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'custodian-session',
      mode: 'plain', ctx: null, serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.test' });
    const before = structuredClone(rows);
    expect(await deps.projectsWorkspaceUpdate!({ serverId: 'home-a', workspaceId: 'second', label: 'Unadmitted' }, {
      externalActionCredential: { accountId: 'alice', principalId: 'alice', credentialId: 'public-token', grant: API_TOKEN_FULL_GRANT_V1 },
    })).toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    expect(rows).toEqual(before); expect(post).not.toHaveBeenCalled();
  });

  it('mutates the requester ref, visibility and context under original authority and refuses retired custody', async () => {
    const { post, rows } = accountBoundary({ promptStack });
    const boundary = post.getMockImplementation()!;
    let retireOnAcknowledgement = false;
    post.mockImplementation(async (url, body, config) => {
      expect(config?.headers).toMatchObject({ 'x-requester-proof': 'bob' });
      expect(config?.headers).not.toHaveProperty('Authorization');
      const receipt = await boundary(url, body, config);
      if (retireOnAcknowledgement && url.endsWith('/mutate')) current = false;
      return receipt;
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    const owner = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'custodian-session', mode: 'plain', ctx: null, serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.test' }));
    let current = true;
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const context = (actionId: string): ActionExecutorContext => {
      const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'home-proof', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'identity',
        machineId: 'machine-a', custodianAccountId: 'alice', installationId: 'installation', actionId,
        requestId: `request-${actionId}`, requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine-a' }, accountEncryptionMode: 'plain',
      } };
      Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId: 'bob', serverId: 'home-a', accountEncryptionMode: 'plain',
        projectAccountRowCipher: cipher, isCurrent: async () => current, readArtifact: async () => null } });
      Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId: 'bob', serverId: 'home-a', serverIdentityId: 'identity',
        serverHttpBaseUrl: 'https://home-a.test', accountEncryptionMode: 'plain', isCurrent: async () => current,
        createRequestHeaders: async () => current ? { 'x-requester-proof': 'bob' } : null } });
      return { ...approvedPresentUser, externalActionExecutionAuthorization: authorization };
    };
    expect(await owner.execute('projects.workspace.update', { serverId: 'home-a', workspaceId: 'second', label: 'Bob label' }, context('projects.workspace.update')))
      .toMatchObject({ ok: true, result: { workspaceRef: { label: 'Bob label' } } });
    expect(await owner.execute('projects.visibility.set', { target: { serverId: 'home-a', projectKey: 'first' }, expectedRevision: 2, hidden: false },
      context('projects.visibility.set'))).toMatchObject({ ok: true, result: { row: { hidden: false, pinned: true, promptStack }, revision: 3 } });
    expect(await owner.execute('projects.context.update', { target: { serverId: 'home-a', projectKey: 'first' }, expectedRevision: 3,
      intent: { kind: 'set_budget', entryId: 'project-context', maxChars: 512 } }, context('projects.context.update')))
      .toMatchObject({ ok: true, result: { revision: 4, row: { promptStack: [{ maxChars: 512 }] } } });
    retireOnAcknowledgement = true;
    expect(await owner.execute('projects.workspace.forget', { serverId: 'home-a', workspaceId: 'second' }, context('projects.workspace.forget')))
      .toMatchObject({ ok: true, result: { workspaceId: 'second' } });
    const accepted = structuredClone(rows);
    current = false;
    post.mockClear();
    expect(await owner.execute('projects.workspace.update', { serverId: 'home-a', workspaceId: 'first', label: 'Retired' }, context('projects.workspace.update')))
      .toMatchObject({ ok: false });
    expect(rows).toEqual(accepted);
    expect(post).not.toHaveBeenCalled();
  });

  it('renames and resets the Project label through every Action surface while preserving checkouts and organization fields', async () => {
    const { post, rows } = accountBoundary({ promptStack });
    const organization = rows.find(row => row.key.kind === 'project-organization' && row.key.projectKey === 'first')!;
    if (organization.content?.t !== 'plain' || organization.content.v.key.kind !== 'project-organization') throw new Error('fixture');
    organization.content = { t: 'plain', v: { key: organization.content.v.key,
      value: { hidden: true, pinned: true, atmosphere: 'home', promptStack } } };
    const owner = executor();
    for (const workspaceId of ['first', 'second']) {
      expect(await owner.execute('projects.workspace.update', { serverId: 'home-a', workspaceId, label: `Checkout ${workspaceId}` }, approvedPresentUser))
        .toMatchObject({ ok: true, result: { workspaceRef: { label: `Checkout ${workspaceId}` } } });
    }
    const unchangedRows = structuredClone(rows.filter(row => !(row.key.kind === 'project-organization' && row.key.projectKey === 'first')));
    const projectRef = { serverId: 'home-a', projectKey: 'first' };
    let revision = 2;
    for (const surface of ['ui', 'agent', 'mcp', 'voice', 'cli'] as const) {
      const context = { surface, authority: 'account_automation' as const };
      const label = `Project ${surface}`;
      expect(await owner.execute('projects.organization.update', { projectRef, expectedRevision: revision, label }, context))
        .toMatchObject({ ok: true, result: { ok: true, revision: ++revision,
          row: { label, hidden: true, pinned: true, atmosphere: 'home', promptStack } } });
      expect(await owner.execute('projects.organization.update', { projectRef, expectedRevision: 2, label: 'Stale' }, context))
        .toMatchObject({ ok: true, result: { ok: false, errorCode: 'project_organization_conflict', currentRevision: revision } });
    }
    const reset = await owner.execute('projects.organization.update', { projectRef, expectedRevision: revision, label: null }, approvedPresentUser);
    expect(reset.ok && reset.result).toEqual({ ok: true, revision: ++revision,
      row: { hidden: true, pinned: true, atmosphere: 'home', promptStack } });
    expect(rows.filter(row => !(row.key.kind === 'project-organization' && row.key.projectKey === 'first'))).toEqual(unchangedRows);
    const beforeRefusal = structuredClone(rows);
    expect(await owner.execute('projects.organization.update', {
      projectRef: { ...projectRef, serverId: 'home-b' }, expectedRevision: revision, label: 'Wrong Home',
    }, approvedPresentUser)).toMatchObject({ ok: true, result: { ok: false, errorCode: 'project_organization_access_denied' } });
    expect(rows).toEqual(beforeRefusal);
    const transport = post.getMockImplementation()!;
    post.mockImplementation(async (url, body, config) => {
      if (url.endsWith('/mutate')) throw new Error('connection lost after dispatch');
      return transport(url, body, config);
    });
    expect(await owner.execute('projects.organization.update', { projectRef, expectedRevision: revision, label: 'Unknown' }, approvedPresentUser))
      .toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
  });

  it.each(['projects.visibility.set', 'projects.context.update'] as const)(
    'preserves the unknown settlement of %s after its committed row acknowledgement is lost', async actionId => {
      const { post, rows } = accountBoundary({ promptStack });
      const transport = post.getMockImplementation()!;
      post.mockImplementation(async (url, body, config) => {
        const response = await transport(url, body, config);
        if (url.endsWith('/mutate')) throw new Error('committed response lost');
        return response;
      });
      const target = { serverId: 'home-a', projectKey: 'first' };
      const input = actionId === 'projects.visibility.set'
        ? { target, expectedRevision: 2, hidden: false }
        : { target, expectedRevision: 2, intent: { kind: 'set_budget', entryId: 'project-context', maxChars: 512 } };
      const result = await executor().execute(actionId, input, approvedPresentUser);
      const organization = rows.find(row => row.key.kind === 'project-organization' && row.key.projectKey === 'first');
      expect(organization).toMatchObject({ revision: 3, content: { t: 'plain', v: { value: actionId === 'projects.visibility.set'
        ? { hidden: false, pinned: true, promptStack }
        : { hidden: true, pinned: true, promptStack: [{ ...promptStack[0], maxChars: 512 }] } } } });
      expect(post.mock.calls.filter(([url]) => url.endsWith('/mutate'))).toHaveLength(1);
      expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    });

  it('renames and resets an exact checkout label while pinning its anchor without dropping context or neighboring rows', async () => {
    const { post, rows } = accountBoundary({ promptStack });
    const untouched = rows.filter(row => row.key.kind === 'workspace-ref' && row.key.id !== 'second');
    const owner = executor();
    const target = { serverId: 'home-a', workspaceId: 'second' };
    expect(await owner.execute('projects.workspace.update', { ...target, label: 'Renamed checkout', pinned: false },
      { surface: 'cli', bypassApprovals: true })).toMatchObject({ ok: true, result: {
      workspaceRef: { id: 'second', serverId: 'home-a', machineId: 'machine-b', rootPath: '/work/second', projectKey: 'first', label: 'Renamed checkout' },
      organization: { hidden: true, pinned: false, promptStack },
    } });
    expect(rows.find(row => row.key.kind === 'workspace-ref' && row.key.id === 'second')).toMatchObject({ revision: 3,
      content: { t: 'plain', v: { value: { projectKey: 'first', label: 'Renamed checkout' } } } });
    expect(rows.find(row => row.key.kind === 'project-organization' && row.key.projectKey === 'first')).toMatchObject({ revision: 3,
      content: { t: 'plain', v: { value: { hidden: true, pinned: false, promptStack } } } });
    expect(await owner.execute('projects.workspace.update', { ...target, label: null, pinned: true },
      { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: true, result: {
      workspaceRef: { id: 'second', projectKey: 'first', label: null }, organization: { hidden: true, pinned: true, promptStack },
    } });
    expect(rows.find(row => row.key.kind === 'workspace-ref' && row.key.id === 'second')).toMatchObject({ revision: 4,
      content: { t: 'plain', v: { value: { id: 'second', projectKey: 'first', label: null } } } });
    expect(rows.find(row => row.key.kind === 'project-organization' && row.key.projectKey === 'first')).toMatchObject({ revision: 4,
      content: { t: 'plain', v: { value: { hidden: true, pinned: true, promptStack } } } });
    expect(rows.filter(row => row.key.kind === 'workspace-ref' && row.key.id !== 'second')).toEqual(untouched);
    expect(rows.some(row => row.key.kind === 'relationship-graph')).toBe(false);
    expect(post.mock.calls.filter(([url]) => url.endsWith('/mutate')).map(([, body]) =>
      ProjectAccountRowMutationRequestV1Schema.parse(body))).toMatchObject([
      { topologyChange: false, mutations: [{ key: { kind: 'workspace-ref', id: 'second' } }, { key: { kind: 'project-organization', projectKey: 'first' } }] },
      { topologyChange: false, mutations: [{ key: { kind: 'workspace-ref', id: 'second' } }, { key: { kind: 'project-organization', projectKey: 'first' } }] },
    ]);
  });

  it('Forgets an approved exact checkout through the graph CAS while preserving the other anchored checkout and organization', async () => {
    const { rows } = accountBoundary({ promptStack });
    const untouched = rows.filter(row => !(row.key.kind === 'workspace-ref' && row.key.id === 'second'));
    const owner = executor();
    const forgotten = await owner.execute('projects.workspace.forget', { serverId: 'home-a', workspaceId: 'second' }, approvedPresentUser);
    expect(forgotten.ok && forgotten.result).toEqual({ ok: true, workspaceId: 'second' });
    expect(rows.find(row => row.key.kind === 'workspace-ref' && row.key.id === 'second')).toMatchObject({ revision: 3, content: null });
    expect(rows.find(row => row.key.kind === 'relationship-graph')).toMatchObject({ revision: 0,
      content: { t: 'plain', v: { value: { relationships: [] } } } });
    expect(rows.filter(row => row.key.kind !== 'relationship-graph' && !(row.key.kind === 'workspace-ref' && row.key.id === 'second')))
      .toEqual(untouched);
    expect(await owner.execute('projects.list', { includeHidden: true }, { surface: 'cli', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { items: [
        { projectKey: { id: 'first' }, project: { projectKey: 'first' }, hidden: true },
        { projectKey: { id: 'visible' } },
      ] } });
  });

  it.each([true, false])('refuses Forget while an enabled=%s relationship still retains the checkout, without mutating any row', async enabled => {
    const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = WorkspaceSyncRelationshipV1Schema.parse({ v: 1, relationshipId: 'protected-link', controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'first', betaWorkspaceRefId: 'second', mode: 'keep_synced', enabled,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 });
    const { post, rows } = accountBoundary({ promptStack, relationships: [relationship] });
    const before = structuredClone(rows);
    expect(await executor().execute('projects.workspace.forget', { serverId: 'home-a', workspaceId: 'second' }, approvedPresentUser))
      .toMatchObject({ ok: false, errorCode: 'workspace_ref_in_use', details: { relationshipIds: ['protected-link'] } });
    expect(rows).toEqual(before);
    expect(post.mock.calls.some(([url]) => url.endsWith('/mutate'))).toBe(false);
  });
});
