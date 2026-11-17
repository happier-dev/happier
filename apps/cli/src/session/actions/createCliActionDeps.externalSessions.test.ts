import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import type { StoredCredentials } from '@/persistence';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';

const http = vi.hoisted(() => ({ get: vi.fn() }));
const persistedCredentials = vi.hoisted(() => ({ current: null as StoredCredentials | null }));
// Session ownership and link admission stay real beneath the authenticated HTTP boundary.
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: http.get } };
});
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => persistedCredentials.current,
}));

const configurationBoundary = vi.hoisted(() => ({
  activeServerDir: '/tmp/happier-external-session-action-unset',
}));

vi.mock('@/configuration', async importOriginal => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: { ...actual.configuration,
    get activeServerDir() { return configurationBoundary.activeServerDir; },
  } };
});

import { createCliActionDeps } from './createCliActionDeps';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { SessionWorkspaceReturnPreviewV1Schema } from '@happier-dev/protocol/actions/specs/session/projectFilesReturn';
import { scanWorkspaceManifest } from '@/scm/workspace/workspaceExportPackaging/scanWorkspaceManifest';
import { createScmBackendRegistry } from '@/scm/registry';
import { readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { runWithScmAccountScope } from '@/scm/accountScope';
import { registerSessionWorkspaceReturnRpcHandlers } from '@/rpc/handlers/sessionWorkspaceReturn';
import type { RpcHandler } from '@/api/rpc/types';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

const roots: string[] = [];
const runtimes: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>[] = [];

beforeEach(() => { http.get.mockReset(); persistedCredentials.current = null; });

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('createCliActionDeps External Session bindings', () => {
  it('prepares, reads, applies and swaps copied changes in the admitted Account scope', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-project-return-action-'));
    roots.push(activeServerDir);
    configurationBoundary.activeServerDir = activeServerDir;
    runtimes.push(await createAdmittedPluginRuntimeFixture({ happyHomeDir: activeServerDir, controller: pluginReloadController,
      runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } }));
    const credentials = {
      token: `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`,
      encryption: null,
    };
    persistedCredentials.current = credentials;
    const hostRoot = join(activeServerDir, 'host');
    const guestRoot = join(activeServerDir, 'guest');
    const requesterRoot = join(activeServerDir, 'requester');
    await mkdir(hostRoot); await mkdir(guestRoot); await mkdir(requesterRoot);
    await writeFile(join(hostRoot, 'both.txt'), 'base both\n');
    await writeFile(join(hostRoot, 'agent.txt'), 'base agent\n');
    const baseline = await scanWorkspaceManifest({ workspaceRoot: hostRoot, scmRegistry: createScmBackendRegistry([]),
      safeFilterPolicy: { excludeAdministrativePaths: true } });
    await writeFile(join(hostRoot, 'both.txt'), 'person change\n');
    await writeFile(join(guestRoot, 'both.txt'), 'agent conflict\n');
    await writeFile(join(guestRoot, 'agent.txt'), 'agent change\n');
    const sourceWorkspace = { serverId: 'home', machineId: 'original', workspaceId: 'host', rootPath: hostRoot };
    const targetWorkspace = { serverId: 'home', machineId: 'sandbox', workspaceId: 'guest', rootPath: guestRoot };
    const fields = buildSessionMetadataEnvelopeFields({ credentials,
      accountEncryptionMode: 'plain', storedContentMode: 'plain', agentState: null,
      metadata: { sessionCreationCorrespondenceV1: { v: 1,
        sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'created' }),
        recipe: {
          execution: { machineId: 'sandbox', directory: { kind: 'path', path: targetWorkspace.rootPath } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
          connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
          agentSessionStartupInstructionsMarkerV1: null, checkout: null,
          projectFilesOrigin: { sourceWorkspace, targetWorkspace, baseline },
        },
      } },
    });
    const session = createCurrentSessionProjectionRecordFixture({ id: 'c1111111111111111111111111', encryptionMode: 'plain', share: null,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: fields.ownerMetadata,
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    });
    const response = V2SessionByIdResponseSchema.parse({ session });
    http.get.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v2/sessions/c1111111111111111111111111') return { status: 200, data: response };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error(`unexpected_http:${path}`);
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'plugin-global', mode: 'plain', ctx: null,
      readRequesterWorkspaceScope: async () => ({ kind: 'available', homeDir: requesterRoot, workspaceRoot: requesterRoot }),
    });
    const prepared = await deps.prepareHostReviewedChildren?.({ actionId: 'session.workspace.return.prepare',
      input: { sessionId: 'c1111111111111111111111111', machineId: 'original' },
      context: { surface: 'cli', authority: 'present_user', actionRequestId: 'return-request' },
    });
    expect(prepared).toMatchObject({ children: [
      { action: 'projects.open', input: { machineId: 'original', materialization: { kind: 'attach' } } },
      { action: 'projects.open', input: { machineId: 'original', materialization: {
        kind: 'sync', targetPath: expect.stringContaining(requesterRoot),
      } } },
    ] });
    if (!prepared || !('children' in prepared) || !prepared.executeAdmittedAction) throw new Error('Return was not admitted');
    const runtimeAccountId = 'admitted-return-account'; // Deliberately differs from hosting credentials.
    const actionContext = { surface: 'cli' as const, authority: 'present_user' as const,
      actionRequestId: 'return-request', runtimeAccountId,
      hostReviewedChild: { invoke: async (child: Parameters<NonNullable<import('@happier-dev/protocol').ActionExecutorContext['hostReviewedChild']>['invoke']>[0]) => {
        const request = OpenProjectInputV1Schema.parse(child.input);
        if (request.materialization.kind === 'attach') return { ok: true as const, result: {
          kind: 'opened', directory: hostRoot, workspace: sourceWorkspace, setup: 'notRequired',
        } };
        if (request.materialization.kind !== 'sync') throw new Error('Expected copied Return stage');
        const destination = request.materialization.targetPath;
        if (!destination) throw new Error('Expected requester destination');
        // Project Open is the admitted Machine boundary; comparison/apply stay real.
        await cp(guestRoot, destination, { recursive: true });
        return { ok: true as const, result: { kind: 'opened', directory: destination,
          workspace: { ...sourceWorkspace, workspaceId: 'return-stage', rootPath: destination }, setup: 'notRequired' } };
      } },
    };
    const result = await prepared.executeAdmittedAction({ actionId: 'session.workspace.return.prepare',
      input: { sessionId: session.id, machineId: 'original' }, context: actionContext,
      execute: async () => { throw new Error('Prepared Return must execute its admitted children'); } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.errorCode);
    const preview = SessionWorkspaceReturnPreviewV1Schema.parse(result.result);
    const captured = await runWithScmAccountScope(runtimeAccountId, () => readCapturedScmComparison({
      cwd: hostRoot, sessionId: session.id, comparisonId: preview.returnId }));
    expect(captured.files.map(file => file.path).sort()).toEqual(['agent.txt', 'both.txt']);
    expect(captured.files.find(file => file.path === 'agent.txt')?.unifiedDiff).toContain('+agent change');
    await expect(runWithScmAccountScope('account-1', () => readCapturedScmComparison({
      cwd: hostRoot, sessionId: session.id, comparisonId: preview.returnId }))).rejects.toBeDefined();
    const handlers = new Map<string, RpcHandler>();
    registerSessionWorkspaceReturnRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } });
    const apply = handlers.get('session.workspace.return.apply');
    if (!apply) throw new Error('Return apply handler unavailable');
    const input = { sessionId: session.id, machineId: 'original', returnId: preview.returnId, paths: ['agent.txt', 'both.txt'] };
    const rpcContext = { signal: new AbortController().signal, localActionContext: { runtimeAccountId } };
    expect(await apply(input, rpcContext)).toMatchObject({ appliedPaths: ['agent.txt'], conflicts: [{ path: 'both.txt', code: 'both_changed' }] });
    expect(await readFile(join(hostRoot, 'both.txt'), 'utf8')).toBe('person change\n');
    expect(await readFile(join(hostRoot, 'agent.txt'), 'utf8')).toBe('agent change\n');
    expect(await apply({ ...input, paths: ['both.txt'], replaceConflictPaths: ['both.txt'] }, rpcContext))
      .toMatchObject({ appliedPaths: ['both.txt'], conflicts: [] });
    expect(await readFile(join(hostRoot, 'both.txt'), 'utf8')).toBe('agent conflict\n');
  });

  it('routes hook management through the daemon-composed External Sessions owner', async () => {
    const hookManagementAction = vi.fn(async () => ({
      ok: true as const,
      result: {
        ok: true as const,
        rows: [],
        nextCursor: null,
        diagnostics: [],
      },
    }));
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
      externalSessionPluginAdmissionOwner: { hookManagementAction },
    });

    await expect(deps.pluginSessionHookManagementAction?.({
      actionId: 'plugins.sessionHooks.status.get',
      input: { intent: 'passive_inventory' },
    })).resolves.toEqual({
      ok: true,
      rows: [],
      nextCursor: null,
      diagnostics: [],
    });
    expect(hookManagementAction).toHaveBeenCalledWith(
      'plugins.sessionHooks.status.get',
      { intent: 'passive_inventory' },
      { surface: 'action' },
    );
  });

  it('passes the daemon-composed private materialize Start into the plugin action consumer', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-plugin-materialize-action-'));
    roots.push(activeServerDir);
    configurationBoundary.activeServerDir = activeServerDir;
    const credentials = {
      token: `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`,
      encryption: null,
    };
    persistedCredentials.current = credentials;
    const fields = buildSessionMetadataEnvelopeFields({ credentials,
      accountEncryptionMode: 'plain', storedContentMode: 'plain', agentState: null,
      metadata: { externalSessionV1: { v: 1, machineId: 'machine-1', agentId: 'codex',
        remoteSessionId: 'remote-1', source: { kind: 'codexHome', home: '/private/home' }, linkedAtMs: 1 } },
    });
    const session = createCurrentSessionProjectionRecordFixture({ id: 'session-1', encryptionMode: 'plain', share: null,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: fields.ownerMetadata,
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    });
    const sessionResponse = V2SessionByIdResponseSchema.parse({ session });
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    });
    http.get.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v2/sessions/session-1') return { status: 200, data: sessionResponse };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      throw new Error(`unexpected_http:${path}`);
    });
    const materializeStart = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'internal_error' as const, message: 'fixture' },
    }));
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
      externalSessionPluginAdmissionOwner: { materializeStart },
    });

    const result = await deps.externalSessionAction?.({
      actionId: 'sessions.external.materialize.start',
      input: {
        request: {
          v: 1,
          idempotencyKey: 'caller-key',
          sessionId: 'session-1',
          plan: 'materialize',
          targetStorageMode: 'external-linked',
          targetRuntimeMode: null,
        },
      },
      pluginId: 'author.example',
    });

    expect(result).toEqual({
      ok: true,
      result: {
        ok: false,
        error: { code: 'internal_error', message: 'fixture' },
      },
    });
    expect(materializeStart).toHaveBeenCalledWith({
      sessionId: 'session-1',
      durableIdempotencyKey: expect.stringMatching(
        /^plugin-operation:v1:[0-9a-f]{64}$/,
      ),
      authorIntent: {
        v: 1,
        surface: 'plugin',
        kind: 'materialize',
        sessionId: 'session-1',
        targetStorageMode: 'external-linked',
      },
    });
  });
});
