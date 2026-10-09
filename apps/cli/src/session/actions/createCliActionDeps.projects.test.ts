import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { ProjectAccountRowV1Schema, ProjectAccountRowMutationRequestV1Schema, buildProjectAccountRowPhysicalKeyV1,
  type ProjectAccountRowKeyV1, type ProjectAccountOrganizationV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { buildProjectLastOpenedMemoryKeyV1, type AuthoringMemoryRowV1 } from '@happier-dev/protocol/account/authoringMemory';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipV1Schema,
  type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';

import { createCliActionDeps } from './createCliActionDeps';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createAuthoringMemoryRowCipher } from '@/settings/authoringMemory/createAuthoringMemoryClient';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';

let accountFixtureSequence = 0;
afterEach(() => { vi.restoreAllMocks(); accountFixtureSequence += 1; });

function executor() {
  const token = `header.${Buffer.from(JSON.stringify({ sub: `project-account-${accountFixtureSequence}` })).toString('base64url')}.signature`;
  return createActionExecutor(createCliActionDeps({
    token, credentials: { token, encryption: null },
    sessionId: 'cli-global', mode: 'plain', ctx: null,
    serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.test',
  }));
}

describe('project definition exact Machine transport', () => {
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
  });
  it('carries the qualified workspace, admitted authority and cancellation to the exact Machine, validates output and refuses another Home', async () => {
    const token = 'project-token';
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.test' });
    const fallback = vi.spyOn(machineTransport, 'callMachineRpc').mockRejectedValue(new Error('wrong_machine_transport'));
    const boundary = vi.spyOn(machineTransport, 'callExactMachineRpc').mockResolvedValue({ definition: { basis: { kind: 'absent' }, document: null },
      detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [] });
    const workspace = { serverId: 'home-a', workspaceId: 'workspace-a', machineId: 'machine-a', rootPath: '/work/project' };
    const signal = new AbortController().signal;
    expect(deps.projectDefinitionAction).toBeTypeOf('function');
    expect(await deps.projectDefinitionAction!({ actionId: 'projects.inspect', input: { workspace }, context: { signal } }))
      .toMatchObject({ definition: { basis: { kind: 'absent' } }, detection: { coverage: 'complete' } });
    expect(boundary).toHaveBeenCalledWith(expect.objectContaining({ machineId: workspace.machineId, method: 'daemon.projects.inspect.v1', request: { workspace }, signal }));
    expect(fallback).not.toHaveBeenCalled();
    const sourceDefinition = { basis: { kind: 'present' as const, hash: 'a'.repeat(64) },
      document: readProjectManifestDocument(JSON.stringify({ version: 1,
        scripts: { check: { source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } },
      })) };
    expect(sourceDefinition.document.status).toBe('valid');
    boundary.mockResolvedValue({ definition: sourceDefinition,
      detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [] });
    const fullExecutor = createActionExecutor(deps);
    expect(await fullExecutor.execute('projects.inspect', { workspace }, {
      authority: 'account_automation', surface: 'api', signal, serverId: workspace.serverId,
      externalActionTarget: { kind: 'machine', machineId: workspace.machineId },
    })).toMatchObject({ ok: true, result: { definition: sourceDefinition } });
    expect(boundary).toHaveBeenLastCalledWith(expect.objectContaining({
      machineId: workspace.machineId, method: 'daemon.projects.inspect.v1', request: { workspace },
      authorityCeiling: 'account_automation', credentials: { token, encryption: null }, signal,
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
  const refs = [ref('visible'), ref('second', 'home-a', 'machine-b'), ref('first'), ref('visible', 'home-b')];
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
    expect(url).toBe('https://home-a.test/v1/account/project-rows/list');
    return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
  });
  return { post, rows };
}

describe('projects.list through the real CLI Account composition', () => {
  it('ranks requester rows from requester memory and Machine visibility without borrowing the custodian token', async () => {
    const memoryCipher = createAuthoringMemoryRowCipher({ accountMode: 'plain', material: null });
    const memoryRows = [['first', 10], ['visible', 40]].map(([projectKey, value]) => {
      const key = buildProjectLastOpenedMemoryKeyV1({ serverId: 'home-a', projectKey: String(projectKey) });
      return { key, revision: 0, content: memoryCipher.seal(key, value) };
    });
    const { post, rows } = accountBoundary({ visibleUnpinned: true, memoryRows });
    const get = vi.mocked(axios.get);
    const readBoundary = get.getMockImplementation()!;
    get.mockImplementation(async (url, config) => {
      expect(config?.headers).toMatchObject({ 'x-requester-proof': 'bob' });
      expect(config?.headers).not.toHaveProperty('Authorization');
      expect(url).not.toContain('/v1/account/encryption');
      return readBoundary(url, config);
    });
    const rowBoundary = post.getMockImplementation()!;
    post.mockImplementation(async (url, body, config) => {
      expect(config?.headers).toMatchObject({ 'x-requester-proof': 'bob' });
      expect(config?.headers).not.toHaveProperty('Authorization');
      return rowBoundary(url, body, config);
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    const owner = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'custodian-session', mode: 'plain', ctx: null, serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.test' }));
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
    expect(await owner.execute('projects.list', {}, context)).toMatchObject({ ok: true, result: { items: [
      { projectKey: { id: 'visible' }, reachable: true }, { projectKey: { id: 'first' }, reachable: true },
      { projectKey: { id: 'second' }, reachable: false },
    ] } });
    expect(rows).toEqual(before);
    current = false; get.mockClear(); post.mockClear();
    expect(await owner.execute('projects.list', {}, context)).toMatchObject({ ok: false });
    expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });

  it('ranks qualified Project anchors from authoring memory without writing structural rows or using leaf recency', async () => {
    const memoryRows = ([['home-a', 'first', 10], ['home-a', 'visible', 40], ['home-a', 'second', 2000], ['home-b', 'first', 3000]] as const)
      .map(([serverId, projectKey, value]) => ({ key: buildProjectLastOpenedMemoryKeyV1({ serverId, projectKey }),
        revision: 0, content: { t: 'plain' as const, v: value } }));
    const { post } = accountBoundary({ visibleUnpinned: true, memoryRows });
    const listed = await executor().execute('projects.list', {}, { surface: 'mcp', bypassApprovals: true });
    expect(vi.mocked(axios.get).mock.calls.filter(([url]) => url.endsWith('/authoring-memory'))).toHaveLength(1);
    expect(listed).toMatchObject({ ok: true, result: {
      items: [{ projectKey: { id: 'visible' }, hidden: false, pinned: false },
        { projectKey: { id: 'first' }, hidden: false, pinned: false },
        { projectKey: { id: 'second' }, hidden: false, pinned: false }],
    } });
    expect(post.mock.calls.every(([url]) => !url.endsWith('/mutate'))).toBe(true);
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
    expect(await owner.execute('projects.workspace.forget', { serverId: 'home-a', workspaceId: 'second' }, approvedPresentUser))
      .toEqual({ ok: true, result: { ok: true, workspaceId: 'second' } });
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
