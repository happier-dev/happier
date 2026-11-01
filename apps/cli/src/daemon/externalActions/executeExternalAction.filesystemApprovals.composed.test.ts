import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { cp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AccountApiTokensCreateActionOutputV1Schema, API_TOKEN_FULL_GRANT_V1,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  decodeExternalActionResolvedTargetV1 } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { requiresExactDaemonApprovalReplay } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getActiveProjectAccountRowsSnapshot, subscribeActiveProjectAccountRowsSnapshot, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1, PROJECT_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createActionApprovalContinuation } from '../../../../../apps/ui/sources/components/approvals/actionApprovalContinuation';
import { ActionOperationGetV1ResponseSchema, ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { assertActionOutputContract } from '@/testkit/actionOutputContract';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readReviewedServiceMoveInput, isReviewedServiceMoveChild } from '@/api/externalActionExecutionAuthorization';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import * as machineRpcTransport from '@/session/transport/rpc/machineRpc';
import { logger } from '@/ui/logger';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { TerminalStreamReadResponseSchema, decodeTerminalStreamBytesFrame } from '@happier-dev/protocol/terminal/stream';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';

import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

// Each Home HTTP fixture is independent even though it uses the same origin.
beforeEach(() => resetServerFeaturesClientForTests());
afterEach(() => { vi.restoreAllMocks(); resetFilesystemApprovalSocketBoundary(); withdrawActiveProjectAccountRowsSnapshot(); });
const filesystemIds = ['daemon.filesystem.readFile', 'daemon.filesystem.writeFile', 'daemon.filesystem.listDirectory',
  'daemon.filesystem.getDirectoryTree', 'daemon.filesystem.createDirectory', 'daemon.filesystem.rename', 'daemon.filesystem.delete'] as const;
const bytes = Buffer.from([0, 255, 128, 10]);
const repository = { provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'happier-dev/happier', cloneUrl: 'https://github.com/happier-dev/happier.git' }, protocol: 'https' as const };

describe('Machine filesystem approval continuity from UI and paired terminal', () => {
  it.each([false, true])('binds signed worker Service preparation to exact SOURCE and destination refs (protected=%s)', async protectedInput => {
    const h = await createHarness('localServices.launcher.start', 'allowed', false, 'srv_portableHome', undefined, true);
    try {
      expect(await h.prepareSignedServiceStart(protectedInput ? { protectedInput: 'requester material' } : {})).toMatchObject({ ok: true });
      expect(h.copies()).toBe(1);
      expect(await readFile(join(h.workerRef.rootPath, 'original'))).toEqual(bytes);
      expect(h.rpcOutcomes).toContainEqual(expect.objectContaining({ phase: 'installed.sourceDelivery',
        method: 'source-machine:daemon.workspaceSync.prepareBetween.v1', originalEnvelopeVersion: protectedInput ? 2 : 1 }));
    } finally { await h.close(); }
  });
  it.each(['other source', 'other target', 'other selected Machine', 'changed envelope', 'wrong requester key'] as const)(
    'refuses signed worker Service preparation before copying: %s', async variant => {
      const h = await createHarness('localServices.launcher.start', 'allowed', false, 'srv_portableHome', undefined, true);
      try {
        await expect(h.prepareSignedServiceStart({
          ...(variant === 'other source' ? { sourceWorkspaceRefId: h.workerRef.id } : {}),
          ...(variant === 'other target' ? { targetWorkspaceRefId: h.ref.id } : {}),
          ...(variant === 'other selected Machine' ? { selectedMachineId: 'unreviewed-machine',
            protectedInput: 'requester material' as const } : {}),
          ...(variant === 'changed envelope' ? { changedEnvelope: true } : {}),
          ...(variant === 'wrong requester key' ? { protectedInput: 'other material' as const } : {}),
        })).rejects.toMatchObject({ code: variant === 'changed envelope'
          ? 'project_requester_authority_unavailable' : 'project_workspace_changed' });
        expect(h.copies()).toBe(0);
        expect(h.serviceInstances()).toHaveLength(0);
      } finally { await h.close(); }
    });
  it('refuses changed approved worker Service inputs before copy or Start', async () => {
    const h = await createHarness('localServices.launcher.start', 'ask', false, 'srv_portableHome', undefined, true);
    try {
      await cp(h.rootPath, h.workerRef.rootPath, { recursive: true });
      expect(await h.runOriginalCli(await h.serviceInput(), 'localServices.launcher.start')).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created' } });
      const file = join(h.rootPath, '.happier/project.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      manifest.services.checked.source.command = 'echo changed';
      await writeFile(file, JSON.stringify(manifest));
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      expect((await h.approval()).execution).toMatchObject({ ok: true,
        result: { status: 'denied', reasonCode: 'project_service_effect_changed' } });
      expect(h.copies()).toBe(0);
      expect(h.serviceInstances()).toHaveLength(0);
    } finally { await h.close(); }
  });
  it('copies the approved signed worker Service Start through the authenticated SOURCE preparation corridor', async () => {
    const h = await createHarness('localServices.launcher.start', 'ask', false, 'srv_portableHome', undefined, true);
    try {
      await cp(h.rootPath, h.workerRef.rootPath, { recursive: true });
      const input = await h.serviceInput();
      expect(await h.runOriginalCli(input, 'localServices.launcher.start')).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created' } });
      expect(await h.approval()).toMatchObject({ actionArgs: input, preview: { serviceStartReview: {
        request: input, target: { machineId: h.workerRef.machineId, rootPath: h.workerRef.rootPath },
      } } });
      expect(h.copies()).toBe(0);
      expect(h.serviceInstances()).toHaveLength(0);
      await writeFile(join(h.rootPath, 'original'), 'current SOURCE bytes');
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      const execution = (await h.approval()).execution;
      expect(execution, JSON.stringify({ execution, outcomes: h.rpcOutcomes })).toMatchObject({ ok: true,
        result: { status: 'succeeded', currentTarget: { machineId: h.workerRef.machineId,
          workspaceId: h.workerRef.id, cwd: h.workerRef.rootPath } } });
      expect(h.copies()).toBe(1);
      expect(await readFile(join(h.workerRef.rootPath, 'original'), 'utf8')).toBe('current SOURCE bytes');
      expect(h.serviceInstances()).toHaveLength(1);
      expect(h.rpcOutcomes).toContainEqual(expect.objectContaining({ phase: 'installed.sourceDelivery',
        method: 'source-machine:daemon.workspaceSync.prepareBetween.v1' }));
    } finally {
      await Promise.all(h.serviceInstances().map(service => service.stop()));
      await h.close();
    }
  });
  it.each(['retained', 'missing'] as const)('refuses Move before SOURCE Stop when destination setup needs consent (%s copy)', async copy => {
    const h = await createHarness('projects.service.relocate', 'allowed', true, 'srv_portableHome', undefined, true);
    const service = await h.seedMoveService();
    try {
      if (copy === 'retained') await cp(h.rootPath, h.workerRef.rootPath, { recursive: true });
      service.finishStop();
      const refusal = ActionExecuteFailureSchema.parse(await h.prepareSignedMove({ sourceCoordinator: true, executeMove: service.request }));
      expect(refusal).toMatchObject({ ok: false,
        errorCode: copy === 'retained' ? 'project_setup_consent_required' : 'project_setup_review_unavailable',
      });
      expect(service.snapshot().state).toBe('running');
      expect(h.copies()).toBe(0);
      expect(h.spawned).toHaveLength(0);
      expect(h.serviceInstances().filter(instance => instance.workspace.rootPath === h.workerRef.rootPath)).toHaveLength(0);
      expect(h.networkPaths.filter(path => path.includes('/projects/execution/config/mutate'))).toHaveLength(0);
    } finally { service.finishStop(); await h.close(); }
  });
  it('admits Move with remembered destination setup consent and runs setup only after confirmed SOURCE Stop', async () => {
    const h = await createHarness('projects.service.relocate', 'allowed', true, 'srv_portableHome', undefined, true);
    const service = await h.seedMoveService();
    try {
      await cp(h.rootPath, h.workerRef.rootPath, { recursive: true });
      const reviewed = await h.reviewSetup();
      if (reviewed.kind !== 'reviewed') throw new Error(reviewed.code);
      const post = vi.mocked(axios.post).getMockImplementation()!;
      vi.mocked(axios.post).mockImplementation(async (url, body, options) => new URL(String(url)).pathname === '/v1/account/project-trust/read'
        ? { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: {
          project: { serverId: h.ref.serverId, projectId: h.ref.projectKey }, reviewedEffectDigest: reviewed.plan.reviewedEffectDigest, approvedAtMs: 1,
        } } } } : await post(url, body, options));
      service.finishStop();
      const moving = h.prepareSignedMove({ sourceCoordinator: true, executeMove: service.request });
      const outcome = await Promise.race([h.waitForSpawn(0).then(pty => ({ kind: 'spawned' as const, pty })),
        moving.then(result => ({ kind: 'settled' as const, result }))]);
      if (outcome.kind !== 'spawned') throw new Error('Move settled before setup launch: ' + JSON.stringify(outcome.result));
      expect(service.snapshot().state).toBe('stopped');
      outcome.pty.exit(0);
      expect(await moving).toMatchObject({ kind: 'found', operation: { state: 'succeeded', result: { status: 'moved' } } });
      expect(h.copies()).toBeGreaterThan(0);
    } finally {
      service.finishStop();
      await Promise.all(h.serviceInstances().filter(instance => instance.workspace.rootPath === h.workerRef.rootPath).map(instance => instance.stop()));
      await h.close();
    }
  });
  it('refuses Move before SOURCE Stop when copied setup input bytes invalidate destination consent', async () => {
    const h = await createHarness('projects.service.relocate', 'allowed', true, 'srv_portableHome', undefined, true);
    const service = await h.seedMoveService();
    try {
      const file = join(h.rootPath, '.happier/project.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      manifest.workspace.setupInputs = ['setup-input'];
      await writeFile(file, JSON.stringify(manifest));
      await writeFile(join(h.rootPath, 'setup-input'), 'new reviewed inputs');
      await cp(h.rootPath, h.workerRef.rootPath, { recursive: true });
      await writeFile(join(h.workerRef.rootPath, 'setup-input'), 'old reviewed inputs');
      const reviewed = await h.reviewSetup(h.workerRef);
      if (reviewed.kind !== 'reviewed') throw new Error(reviewed.code);
      const post = vi.mocked(axios.post).getMockImplementation()!;
      vi.mocked(axios.post).mockImplementation(async (url, body, options) => new URL(String(url)).pathname === '/v1/account/project-trust/read'
        ? { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: {
          project: { serverId: h.ref.serverId, projectId: h.ref.projectKey }, reviewedEffectDigest: reviewed.plan.reviewedEffectDigest, approvedAtMs: 1,
        } } } } : await post(url, body, options));
      service.finishStop();
      expect(await h.prepareSignedMove({ sourceCoordinator: true, executeMove: service.request })).toMatchObject({
        ok: false, errorCode: 'project_setup_effect_changed',
      });
      expect(service.snapshot().state).toBe('running');
      expect(h.copies()).toBe(0);
      expect(h.spawned).toHaveLength(0);
    } finally { service.finishStop(); await h.close(); }
  });
  it('admits original CLI Service Start before reaching the installed declaration launcher', async () => {
    const h = await createHarness('localServices.launcher.start', 'allowed');
    try {
      const result = await h.runOriginalCli(await h.serviceInput(), 'localServices.launcher.start');
      expect(result, JSON.stringify({ result, outcomes: h.rpcOutcomes })).toMatchObject({ ok: true, result: { status: 'succeeded' } });
      if (result.ok) assertActionOutputContract('localServices.launcher.start', result.result);
      expect(h.serviceInstances()).toHaveLength(1);
    } finally {
      await Promise.all(h.serviceInstances().map(service => service.stop()));
      await h.close();
    }
  });
  it.each(['default', 'source'] as const)('routes original CLI Move through SOURCE and passes pre-Stop admission (%s)', async originalCli => {
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Controller observation unavailable'));
    const h = await createHarness('projects.service.relocate', 'allowed', false, 'srv_portableHome', undefined, true);
    const service = await h.seedMoveService();
    try {
      service.finishStop();
      const terminal = await h.prepareSignedMove({ sourceCoordinator: true, executeMove: service.request, originalCli });
      expect(terminal, JSON.stringify({ terminal, outcomes: h.rpcOutcomes })).toMatchObject({ kind: 'found', operation: {
        scope: { machineId: h.ref.machineId }, state: 'succeeded', result: { status: 'moved', currentTarget: { machineId: h.workerRef.machineId } },
      } });
      expect(service.snapshot().state).toBe('stopped');
      expect(h.copies()).toBeGreaterThan(0);
    } finally {
      service.finishStop();
      await Promise.all(h.serviceInstances().filter(service => service.workspace.rootPath === h.workerRef.rootPath).map(service => service.stop()));
      await h.close();
    }
  });
  it('reviews original Account CLI declared-Service Ask before publication despite a UI waiver', async () => {
    const h = await createHarness('localServices.launcher.start', 'ask', false, 'srv_n2', undefined, false, false,
      { authentication: 'account', askWithUiWaiver: true });
    try {
      const input = await h.serviceInput();
      expect(await h.runOriginalCli(input, 'localServices.launcher.start')).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created' } });
      expect(await h.approval()).toMatchObject({ actionArgs: input, preview: { serviceStartReview: {
        request: input, target: { machineId: input.machineId, rootPath: h.rootPath }, reviewedEffectDigest: expect.any(String),
      } } });
      expect(h.serviceInstances()).toHaveLength(0);
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      expect((await h.approval()).execution).toMatchObject({ ok: true, result: { status: 'succeeded' } });
      expect(h.serviceInstances()).toHaveLength(1);
    } finally {
      await Promise.all(h.serviceInstances().map(service => service.stop()));
      await h.close();
    }
  });
  it.each(['waived', 'unavailable'] as const)('refuses original CLI Service Ask when Account policy is %s', async hostOnlyAsk => {
    const h = await createHarness('localServices.launcher.start', 'allowed', false, 'srv_portableHome', undefined, false, false,
      { authentication: 'account', hostOnlyAsk });
    try {
      expect(await h.runOriginalCli(await h.serviceInput(), 'localServices.launcher.start')).toMatchObject({ ok: false,
        errorCode: 'approval_context_unavailable' });
      expect(h.hasApproval()).toBe(false);
      expect(h.serviceInstances()).toHaveLength(0);
    } finally {
      await Promise.all(h.serviceInstances().map(service => service.stop()));
      await h.close();
    }
  });
  it('bounds Home root verifications to admission, ingress and final status phases in each invocation', async () => {
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Controller observation unavailable'));
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
    const post = vi.mocked(axios.post).getMockImplementation()!;
    let verifications = 0;
    vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
      if (new URL(String(url)).pathname === '/v1/actions/projects.worker.status/execution-authorization/verify') {
        verifications++;
      }
      return post(url, body, config);
    });
    try {
      for (let invocation = 1; invocation <= 2; invocation++) {
        const before = verifications;
        const result = await h.run({ workspace: { serverId: h.ref.serverId, refId: h.ref.id },
          destination: { kind: 'machine', machineId: h.workerRef.machineId }, purpose: 'service-start' },
        'cli', false, 'present_user', 'projects.worker.status');
        expect(result).toMatchObject({ ok: true, result: { eligible: true } });
        expect(verifications - before).toBe(3);
      }
      expect(h.copies()).toBe(0);
    } finally { await h.close(); }
  });
  it.each([2, 3])('preserves a Home outage during signed worker currentness without reporting retired credentials (check %s)', async failAt => {
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Controller observation unavailable'));
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
    const post = vi.mocked(axios.post).getMockImplementation()!;
    let verifications = 0;
    vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
      if (new URL(String(url)).pathname === '/v1/actions/projects.worker.status/execution-authorization/verify'
        && ++verifications >= failAt) return { status: 503, data: { error: 'database_connection_unavailable' } };
      return post(url, body, config);
    });
    const retained = getActiveProjectAccountRowsSnapshot();
    try {
      const result = await h.run({ workspace: { serverId: h.ref.serverId, refId: h.ref.id },
        destination: { kind: 'machine', machineId: h.workerRef.machineId }, purpose: 'service-start' },
      'cli', false, 'present_user', 'projects.worker.status');
      expect(result).toMatchObject({ ok: false, errorCode: 'project_requester_home_unavailable' });
      expect(getActiveProjectAccountRowsSnapshot()).toBe(retained);
      expect(h.copies()).toBe(0);
    } finally { await h.close(); }
  });
  it.each([401, 403])('refuses a final worker observation when Home revokes its admitted root (%s)', async status => {
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Controller observation unavailable'));
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
    const post = vi.mocked(axios.post).getMockImplementation()!;
    let verifications = 0;
    let rowReads = 0;
    vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/project-rows/list') rowReads++;
      if (path === '/v1/actions/projects.worker.status/execution-authorization/verify' && ++verifications === 3) {
        expect(rowReads).toBeGreaterThan(0);
        return { status, data: { error: 'invalid_token' } };
      }
      return post(url, body, config);
    });
    try {
      expect(await h.run({ workspace: { serverId: h.ref.serverId, refId: h.ref.id },
        destination: { kind: 'machine', machineId: h.workerRef.machineId }, purpose: 'service-start' },
      'cli', false, 'present_user', 'projects.worker.status')).toMatchObject({ ok: true,
        result: { eligible: false, explanation: 'unavailable' } });
      expect(verifications).toBe(3);
      expect(h.copies()).toBe(0);
    } finally { await h.close(); }
  });
  it('records the typed preparation outage when reopening an approved Move requester', async () => {
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Controller observation unavailable'));
    const h = await createHarness('projects.service.relocate', 'ask', false, 'srv_portableHome', undefined, true);
    const service = await h.seedMoveService();
    try {
      expect(await h.run(service.request, 'ui', false, 'present_user')).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created' } });
      const get = vi.mocked(axios.get).getMockImplementation()!;
      let profiles = 0;
      vi.mocked(axios.get).mockImplementation(async (url, config) => {
        // The deciding invocation opens first. Reopening the original reviewed
        // requester is a separate HTTP read at the same real admission owner.
        if (new URL(String(url)).pathname === '/v1/account/profile' && ++profiles >= 2) {
          return { status: 503, data: { error: 'database_connection_unavailable' } };
        }
        return get(url, config);
      });
      const decided = await h.decide('approve');
      expect(decided).toMatchObject({ ok: true, result: { status: 'failed', execution: {
        ok: false, effectAttempted: false, errorCode: 'project_requester_home_unavailable',
      } } });
      const approval = await h.approval();
      expect(approval).toMatchObject({ status: 'failed', execution: { errorCode: 'project_requester_home_unavailable' } });
      expect(getActionSpec('approval.request.decide').outputSchema!.safeParse(decided.ok ? decided.result : null).success).toBe(true);
      expect(service.snapshot().state).toBe('running');
      expect(h.copies()).toBe(0);
    } finally { service.finishStop(); await h.close(); }
  });
  it('leaves an approved Move recoverable when Home cannot recheck its origin', async () => {
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Controller observation unavailable'));
    const h = await createHarness('projects.service.relocate', 'ask', false, 'srv_portableHome', undefined, true);
    const service = await h.seedMoveService();
    try {
      expect(await h.run(service.request, 'ui', false, 'present_user')).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created' } });
      const post = vi.mocked(axios.post).getMockImplementation()!;
      vi.mocked(axios.post).mockImplementation(async (url, body, config) =>
        new URL(String(url)).pathname === '/v1/actions/projects.service.relocate/execution-authorization/verify'
          ? { status: 503, data: { error: 'database_connection_unavailable' } } : post(url, body, config));
      expect(await h.decide('approve')).toMatchObject({ ok: false, errorCode: 'project_requester_home_unavailable' });
      expect(await h.approval()).toMatchObject({ status: 'approved' });
      expect((await h.approval()).execution).toBeUndefined();
      expect(service.snapshot().state).toBe('running');
      expect(h.copies()).toBe(0);
      vi.mocked(axios.post).mockImplementation(post);
      expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      const approval = await h.approval();
      if (!approval.execution?.ok || !approval.execution.result || typeof approval.execution.result !== 'object'
        || !('operation' in approval.execution.result)) throw new Error('Missing recovered Move operation');
      const operation = ActionOperationSnapshotV1Schema.parse(approval.execution.result.operation);
      service.finishStop();
      expect(ActionOperationGetV1ResponseSchema.parse(await h.waitForTerminal(operation.operationId)))
        .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
    } finally { service.finishStop(); await h.close(); }
  });
  it('carries standalone MCP worker status through admitted requester custody to the installed daemon', async () => {
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Controller observation unavailable'));
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
    const post = vi.mocked(axios.post).getMockImplementation()!;
    let privateReads = 0;
    vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
      if (new URL(String(url)).pathname === '/v1/account/project-rows/list') {
        if (config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) return { status: 401, data: { error: 'invalid_token' } };
        expect(config?.headers?.Authorization).toBe(`Bearer ${h.installedToken}`);
        privateReads++;
      }
      return post(url, body, config);
    });
    const retained = getActiveProjectAccountRowsSnapshot();
    let publications = 0;
    const unsubscribe = subscribeActiveProjectAccountRowsSnapshot(() => { publications++; });
    const { mcp } = runWithServerHttpBaseUrl('https://home.example.test', () => createExternalMcpServer({
      credentials: { token: h.installedToken, encryption: null, credentialProvenance: 'stored_session' },
      machineId: h.ref.machineId,
      serverFeaturesSnapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: h.ref.serverId } } }) },
    }));
    const client = new Client({ name: 'installed-worker-mcp', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'projects_worker_status', arguments: {
        workspace: { serverId: h.ref.serverId, refId: h.ref.id },
        destination: { kind: 'machine', machineId: h.workerRef.machineId }, purpose: 'service-start',
      } }));
      expect(result.isError, JSON.stringify({ result, networkPaths: h.networkPaths, rpcOutcomes: h.rpcOutcomes })).not.toBe(true);
      expect(result.structuredContent, JSON.stringify({ result, privateReads, rpcOutcomes: h.rpcOutcomes })).toMatchObject({ eligible: true, candidate: { machineId: h.workerRef.machineId } });
      assertActionOutputContract('projects.worker.status', result.structuredContent);
      expect(privateReads).toBeGreaterThan(0);
      expect(publications).toBe(0);
      expect(getActiveProjectAccountRowsSnapshot()).toBe(retained);
    } finally { unsubscribe(); await client.close(); await mcp.close(); await h.close(); }
  });
  it('resolves original worker status through private requester row custody at the installed worker', async () => {
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Controller observation unavailable'));
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
    const post = vi.mocked(axios.post).getMockImplementation()!;
    let privateReads = 0;
    vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
      if (new URL(String(url)).pathname === '/v1/account/project-rows/list') {
        // Home HTTP is the boundary. A status root by itself cannot read the
        // catalog; the real installed projection must supply requester custody.
        if (config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) return { status: 401, data: { error: 'invalid_token' } };
        expect(config?.headers?.Authorization).toBe(`Bearer ${h.installedToken}`);
        privateReads++;
      }
      return post(url, body, config);
    });
    const retained = getActiveProjectAccountRowsSnapshot();
    let publications = 0;
    const unsubscribe = subscribeActiveProjectAccountRowsSnapshot(() => { publications++; });
    try {
      const result = await h.run({ workspace: { serverId: h.ref.serverId, refId: h.ref.id },
        destination: { kind: 'machine', machineId: h.workerRef.machineId }, purpose: 'service-start' },
      'cli', false, 'present_user', 'projects.worker.status');
      expect(result).toMatchObject({ ok: true, result: { eligible: true, candidate: { machineId: h.workerRef.machineId } } });
      if (result.ok) assertActionOutputContract('projects.worker.status', result.result);
      expect(privateReads).toBeGreaterThan(0);
      expect(publications).toBe(0);
      expect(getActiveProjectAccountRowsSnapshot()).toBe(retained);
    } finally { unsubscribe(); await h.close(); }
  });
  it.each(['moved', 'revoked', 'cancelled'] as const)('retains the reviewed Move executor after approval cleanup through post-Stop copy and native start (%s)', async outcome => {
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Controller observation unavailable'));
    const h = await createHarness('projects.service.relocate', 'ask', false, 'srv_portableHome', undefined, true);
    const service = await h.seedMoveService();
    try {
      expect(await h.run(service.request, 'ui', false, 'present_user')).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created' } });
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      // This read occurs after executeExternalAction's approval-decision finally.
      const approval = await h.approval();
      expect(approval, JSON.stringify({ execution: approval.execution, rpcOutcomes: h.rpcOutcomes })).toMatchObject({ status: 'executed', execution: { ok: true, result: { status: 'accepted' } } });
      if (!approval.execution?.ok || !approval.execution.result || typeof approval.execution.result !== 'object'
        || !('operation' in approval.execution.result)) throw new Error('Missing accepted Move');
      const operation = ActionOperationSnapshotV1Schema.parse(approval.execution.result.operation);
      expect(service.snapshot().state).toBe('running');
      if (outcome === 'revoked') await h.retireRequester();
      if (outcome === 'cancelled') expect(await h.cancelOperation(operation.operationId)).toEqual({ kind: 'requested' });
      service.finishStop();
      const terminal = ActionOperationGetV1ResponseSchema.parse(await h.waitForTerminal(operation.operationId));
      if (outcome === 'cancelled') {
        // Cancellation during an unacknowledged native Stop cannot certify it.
        expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'running', progress: { phase: 'stopping' },
          observation: { kind: 'stop_unconfirmed' } } });
        await expect.poll(() => h.readOperation(operation.operationId)).toMatchObject({ kind: 'found', operation: {
          cancellation: 'unsupported', observation: { kind: 'stop_unconfirmed' } } });
        expect(h.copies()).toBe(0);
        return;
      }
      if (outcome === 'revoked') {
        expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'failed', progress: { phase: 'stopped' } } });
        expect(h.copies()).toBe(0);
        return;
      }
      expect(terminal, JSON.stringify(terminal)).toMatchObject({ kind: 'found', operation: { state: 'succeeded',
        result: { status: 'moved', currentTarget: { machineId: h.workerRef.machineId, workspaceId: h.workerRef.id } } } });
      expect(h.copies()).toBeGreaterThan(0);
      if (terminal.kind === 'found') assertActionOutputContract('projects.service.relocate', terminal.operation.result);
    } finally { service.finishStop(); await h.close(); }
  });
  it.each(['unavailable', 'not-starting'] as const)(
    'settles a forwarded Move with the delivered destination refusal when SOURCE claim is %s', async mode => {
    const h = await createHarness('projects.service.relocate', 'allowed', false, 'srv_portableHome', undefined, true);
    const service = await h.seedMoveService();
    const call = machineRpcTransport.callExactMachineRpc;
    let claims = 0;
    vi.spyOn(machineRpcTransport, 'callExactMachineRpc').mockImplementation(async params => {
      if (params.method === 'actionOperation.serviceMoveStart.claim.v1') {
        claims++;
        if (mode === 'not-starting') return { kind: 'refused', reasonCode: 'service_move_not_starting' };
        throw new Error('Synthetic SOURCE claim transport outage');
      }
      return await call(params);
    });
    try {
      service.finishStop();
      const terminal = await h.prepareSignedMove({ sourceCoordinator: true, executeMove: service.request });
      const errorCode = mode === 'unavailable' ? 'service_move_start_authority_unavailable' : 'service_move_not_starting';
      expect(claims, JSON.stringify(terminal)).toBe(1);
      expect(h.rpcOutcomes).toContainEqual(expect.objectContaining({ phase: 'installed.moveChildResponse',
        result: expect.objectContaining({ errorCode }) }));
      expect(h.serviceInstances().filter(instance => instance.workspace.rootPath === h.workerRef.rootPath)).toHaveLength(0);
      expect(service.snapshot().state).toBe('stopped');
      expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'failed',
        error: { errorCode },
        progress: { kind: 'phase', phase: 'stopped' } } });
    } finally { service.finishStop(); await h.close(); }
  });
  it.each(['lost-acknowledgement', 'malformed-response', 'duplicate-attempt'] as const)(
    'keeps a forwarded Move uncertain after native establishment with %s', async mode => {
    const h = await createHarness('projects.service.relocate', 'allowed', false, 'srv_portableHome', undefined, true);
    const service = await h.seedMoveService();
    const call = machineRpcTransport.callExactMachineRpc;
    const startMethod = getActionSpec('localServices.launcher.start').bindings!.rpcMethod;
    let starts = 0;
    vi.spyOn(machineRpcTransport, 'callExactMachineRpc').mockImplementation(async params => {
      const result = await call(params);
      if (params.method !== startMethod) return result;
      starts++;
      expect(DaemonLocalServiceLauncherStartResponseV1Schema.parse(result).status).toBe('succeeded');
      // Only the network acknowledgement changes; the original native Start
      // has already run through its real admission and lifecycle owners.
      if (mode === 'duplicate-attempt') return await call(params);
      if (mode === 'malformed-response') return { status: 'succeeded' };
      throw new Error('Synthetic lost destination Start acknowledgement');
    });
    try {
      service.finishStop();
      const terminal = await h.prepareSignedMove({ sourceCoordinator: true, executeMove: service.request });
      expect(starts, JSON.stringify({ terminal, outcomes: h.rpcOutcomes })).toBe(1);
      expect(service.snapshot().state).toBe('stopped');
      const instances = h.serviceInstances().filter(instance => instance.workspace.rootPath === h.workerRef.rootPath);
      expect(instances).toHaveLength(1);
      expect(instances[0]?.snapshot().state).toBe('running');
      expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'running',
        progress: { phase: 'starting' }, observation: { kind: 'outcome_uncertain' } } });
      if (mode === 'duplicate-attempt') expect(h.rpcOutcomes).toContainEqual(expect.objectContaining({
        phase: 'installed.moveChildResponse', result: expect.objectContaining({ errorCode: 'service_move_start_already_claimed' }) }));
    } finally {
      service.finishStop();
      await Promise.all(h.serviceInstances().filter(instance => instance.workspace.rootPath === h.workerRef.rootPath).map(instance => instance.stop()));
      await h.close();
    }
  });
  it.each([false, true])('starts the SOURCE-bound Move child at the installed destination under its admitted requester custody (protected=%s)', async protectedInput => {
    const h = await createHarness('projects.service.relocate', 'allowed', false, 'srv_portableHome', undefined, true);
    try {
      expect(await h.prepareSignedMove()).toMatchObject({ ok: true });
      await h.prepareSignedMove({ sourceCoordinator: true, activeMove: true,
        ...(protectedInput ? { protectedInput: 'requester material' as const } : {}), inspectRequester: async ({ start }) => {
        const result = DaemonLocalServiceLauncherStartResponseV1Schema.parse(await start());
        expect(result, JSON.stringify({ result, finiteIngress: h.finiteIngress })).toMatchObject({ status: 'succeeded',
          currentTarget: { machineId: h.workerRef.machineId, workspaceId: h.workerRef.id } });
        const instances = h.serviceInstances().filter(service => service.workspace.rootPath === h.workerRef.rootPath);
        try {
          expect(instances).toHaveLength(1);
          expect(instances[0]?.instanceId).toBe(result.currentTarget?.managedServiceId);
          expect(instances[0]?.snapshot().state).toBe('running');
        } finally { await Promise.all(instances.map(service => service.stop())); }
      } });
    } finally { await h.close(); }
  });
  it.each(['settled', 'cancelled', 'starting'] as const)('refuses a captured destination Start replay when its Move is %s', async phase => {
    const h = await createHarness('projects.service.relocate', 'allowed', false, 'srv_portableHome', undefined, true);
    try {
      expect(await h.prepareSignedMove()).toMatchObject({ ok: true });
      await h.prepareSignedMove({ sourceCoordinator: true, activeMove: true,
        inspectRequester: async ({ start, settleMove, cancelMove }) => {
          const first = DaemonLocalServiceLauncherStartResponseV1Schema.parse(await start());
          expect(first).toMatchObject({ status: 'succeeded' });
          const instances = () => h.serviceInstances().filter(service => service.workspace.rootPath === h.workerRef.rootPath);
          await Promise.all(instances().map(service => service.stop()));
          if (phase === 'settled') await settleMove();
          if (phase === 'cancelled') await cancelMove();
          try {
            const replay = await start();
            expect(replay).toMatchObject({ errorCode: phase === 'starting'
              ? 'service_move_start_already_claimed' : 'service_move_not_starting' });
            expect(instances().every(service => service.snapshot().state === 'stopped')).toBe(true);
          } finally { await Promise.all(instances().map(service => service.stop())); }
        } });
    } finally { await h.close(); }
  });
  it.each(['settled', 'cancelled'] as const)('refuses an unspent destination Start packet after its Move is %s', async phase => {
    const h = await createHarness('projects.service.relocate', 'allowed', false, 'srv_portableHome', undefined, true);
    try {
      expect(await h.prepareSignedMove()).toMatchObject({ ok: true });
      await h.prepareSignedMove({ sourceCoordinator: true, activeMove: true,
        inspectRequester: async ({ start, settleMove, cancelMove }) => {
          await start(true);
          if (phase === 'settled') await settleMove(); else await cancelMove();
          try {
            expect(await start()).toMatchObject({ errorCode: 'service_move_not_starting' });
            expect(h.serviceInstances().filter(service => service.workspace.rootPath === h.workerRef.rootPath)).toHaveLength(0);
          } finally {
            await Promise.all(h.serviceInstances().filter(service => service.workspace.rootPath === h.workerRef.rootPath).map(service => service.stop()));
          }
        } });
    } finally { await h.close(); }
  });
  it.each([false, true])('admits the SOURCE-bound Service Move status child at the installed destination with finite execution disabled (protected=%s)', async protectedInput => {
    const traceEnv = createEnvKeyScope(['HAPPIER_WEB_LATENCY_TRACE']);
    traceEnv.patch({ HAPPIER_WEB_LATENCY_TRACE: '1' });
    const trace = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    // The optional controller freshness read is a network boundary; eligibility
    // does not require it and this fixture has no public controller socket.
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Controller observation unavailable'));
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
    try {
      await h.prepareSignedMove({ sourceCoordinator: true, requesterToken: h.installedToken + '-independent-requester',
        ...(protectedInput ? { protectedInput: 'requester material' as const } : {}), inspectRequester: async ({ status }) => {
        const retained = getActiveProjectAccountRowsSnapshot();
        expect(retained).not.toBeNull();
        const relationships = await h.syncRelationships();
        expect(relationships.flatMap(result => result.relationships)).toContainEqual(h.workerRelationship);
        let publications = 0;
        const unsubscribe = subscribeActiveProjectAccountRowsSnapshot(() => { publications++; });
        let result: unknown;
        trace.mockClear();
        try { result = await status().catch(error => ({ error: error instanceof Error ? error.message : String(error) })); }
        finally { unsubscribe(); }
        expect(result, JSON.stringify({ result, rpcOutcomes: h.rpcOutcomes })).toMatchObject({ eligible: true,
          candidate: { machineId: h.workerRef.machineId } });
        assertActionOutputContract('projects.worker.status', result);
        const stages = trace.mock.calls.filter(([message]) => message === '[external-action-stage]');
        expect(stages).toEqual(expect.arrayContaining([
          ['[external-action-stage]', expect.objectContaining({ stage: 'worker_status.snapshot.begin' })],
          ['[external-action-stage]', expect.objectContaining({ stage: 'project_rows.fetch.end' })],
          ['[external-action-stage]', expect.objectContaining({ stage: 'worker_status.eligibility.end' })],
        ]));
        expect(JSON.stringify(stages)).not.toContain(h.installedToken);
        expect(publications).toBe(0);
        expect(getActiveProjectAccountRowsSnapshot()).toBe(retained);
        expect(getActiveProjectAccountRowsSnapshot()?.scopeKey).toBe(retained?.scopeKey);
        expect(await h.syncRelationships()).toEqual(relationships);
        expect(await status('missing-packet')).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(await status('changed-input')).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      } });
      expect(h.copies()).toBe(0);
    } finally { await h.close(); traceEnv.restore(); }
  });
  it.each([false, true])('keeps an awaited SOURCE-bound Service Move status read private when requester custody retires (protected=%s)', async protectedInput => {
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Controller observation unavailable'));
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
    try {
      await h.prepareSignedMove({ sourceCoordinator: true, requesterToken: h.installedToken + '-retiring-requester',
        ...(protectedInput ? { protectedInput: 'requester material' as const } : {}), inspectRequester: async ({ status }) => {
        const retained = getActiveProjectAccountRowsSnapshot();
        const relationships = await h.syncRelationships();
        expect(relationships.flatMap(result => result.relationships)).toContainEqual(h.workerRelationship);
        const post = vi.mocked(axios.post).getMockImplementation()!;
        let rowRead = false;
        vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
          const response = await post(url, body, config);
          if (new URL(String(url)).pathname === '/v1/account/project-rows/list') {
            rowRead = true;
            // Retire through the real requester-currentness socket while the
            // HTTP row response is awaited, before the reader can accept it.
            await h.retireRequester();
          }
          return response;
        });
        let publications = 0;
        const unsubscribe = subscribeActiveProjectAccountRowsSnapshot(() => { publications++; });
        let result: unknown;
        try { result = await status(); } finally { unsubscribe(); }
        expect(rowRead).toBe(true);
        expect(result).toMatchObject({ eligible: false, explanation: 'unavailable' });
        assertActionOutputContract('projects.worker.status', result);
        expect(publications).toBe(0);
        expect(getActiveProjectAccountRowsSnapshot()).toBe(retained);
        expect(getActiveProjectAccountRowsSnapshot()?.scopeKey).toBe(retained?.scopeKey);
        expect(await h.syncRelationships()).toEqual(relationships);
      } });
    } finally { await h.close(); }
  });
  it('preserves personal copy inspection through the original standalone CLI admission', async () => {
    const h = await createHarness('projects.worker.copy.inspect', 'allowed', false, 'srv_portableHome', undefined, true, true);
    try {
      const input = getActionSpec('projects.worker.copy.inspect').inputSchema.parse({
        kind: 'preview', workspace: { serverId: h.ref.serverId, refId: h.ref.id }, machineId: h.ref.machineId,
        targetMachineId: h.workerRef.machineId, targetWorkspaceRefId: h.workerRef.id, expectedRelationship: h.workerRelationship,
      });
      const direct = await h.directCopyPreview(input);
      expect(direct).toMatchObject({ ok: false, errorCode: 'workspace_copy_not_owned' });
      expect(await h.runOriginalCli(input)).toEqual({ ok: true, result: direct });
    } finally { await h.close(); }
  });

  it.each(['ui', 'cli'] as const)('preserves personal admission for same-Machine copy review through installed %s requester admission', async surface => {
    const h = await createHarness('projects.worker.copy.inspect', 'allowed', false, 'srv_portableHome', undefined, true, true);
    try {
      const input = getActionSpec('projects.worker.copy.inspect').inputSchema.parse({
        kind: 'preview', workspace: { serverId: h.ref.serverId, refId: h.ref.id },
        machineId: h.ref.machineId, targetMachineId: h.workerRef.machineId,
        targetWorkspaceRefId: h.workerRef.id, expectedRelationship: h.workerRelationship,
      });
      const direct = await h.directCopyPreview(input);
      // This fixture adopts an existing directory, so it has no owned-copy
      // deletion custody. Both entry points must reach Sync's same refusal.
      expect(direct).toMatchObject({ ok: false, errorCode: 'workspace_copy_not_owned' });
      const result = await h.run(input, surface, false, 'present_user');
      expect(result.ok ? undefined : result.errorCode, 'owned-copy Action refusal').toBeUndefined();
      expect(result).toEqual({ ok: true, result: direct });
    } finally { await h.close(); }
  });

  it('retains the deciding human only for the installed token requester continuation', async () => {
    const h = await createHarness('account.apiTokens.create');
    const cancellation = new AbortController();
    const request = vi.mocked(axios.request).getMockImplementation()!;
    const tokenId = randomUUID();
    const input = { tokenId, label: 'Reviewed token', grant: API_TOKEN_FULL_GRANT_V1 };
    const output = AccountApiTokensCreateActionOutputV1Schema.parse({ token: `hap_v1_${tokenId}_${'a'.repeat(43)}`,
      apiToken: { tokenId, label: input.label, displayPrefix: `hap_v1_${tokenId.slice(0, 8)}`,
        createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null,
        hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: input.grant,
        parentTokenId: null, activeChildCount: 0, embedConfig: null } });
    let minted = 0;
    vi.mocked(axios.request).mockImplementation(async config => {
      if (new URL(String(config.url)).pathname !== '/v1/auth/api-tokens/create') return request(config);
      // Home transport boundary: the original signed requester root cannot
      // create credentials. Only the admitted human's native effect can.
      if (config.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) return { status: 401, data: { error: 'invalid_token' } };
      expect(h.humanToken).not.toBe(h.installedToken);
      expect(config.headers?.Authorization).toBe(`Bearer ${h.humanToken}`);
      expect(config.data).toEqual(input); minted++;
      return { status: 200, data: output };
    });
    const invocation = h.run(input, 'ui', false, 'present_user', 'account.apiTokens.create',
      'original-token-request', cancellation.signal);
    let stopped: Awaited<typeof invocation> | undefined;
    void invocation.then(result => { stopped = result; });
    try {
      await vi.waitFor(() => {
        if (stopped && !stopped.ok) throw new Error(`token_request_stopped:${stopped.errorCode}`);
        expect(h.hasApproval()).toBe(true);
      });
      expect(minted).toBe(0);
      const decided = await h.decide('approve');
      expect(decided).toMatchObject({ ok: true });
      expect(await invocation).toEqual({ ok: true, result: output });
      expect(minted).toBe(1);
      expect(JSON.stringify(decided)).not.toContain(output.token);
      expect(JSON.stringify(await h.approval())).not.toContain(output.token);
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      expect(minted).toBe(1);
    } finally { cancellation.abort(); await invocation; await h.close(); }
  });
  it.each(['reviewed child', 'other material', 'changed envelope', 'other destination'] as const)(
    'admits only the reviewed child of a V2 Move through the real requester opener: %s', async variant => {
      const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
      try {
        await h.prepareSignedMove({ protectedInput: variant === 'other material' ? 'other material' : 'requester material',
          inspectRequester: async ({ authorization, envelope }) => {
            expect(envelope.v).toBe(2);
            const original = variant === 'changed envelope' ? { ...envelope, requestId: 'another-move' } : envelope;
            const machineId = variant === 'other destination' ? 'another-machine' : h.workerRef.machineId;
            const params = getActionSpec('projects.worker.status').inputSchema.parse({
              workspace: { serverId: h.ref.serverId, refId: h.ref.id },
              destination: { kind: 'machine', machineId }, purpose: 'service-start',
            });
            const opened = await readReviewedServiceMoveInput({ authorization, envelope: original });
            if (variant === 'other material' || variant === 'changed envelope') expect(opened).toBeNull();
            else expect(opened).toMatchObject({ workspace: { serverId: h.ref.serverId, refId: h.ref.id },
              serviceName: 'web', selectedTarget: { machineId: h.workerRef.machineId } });
            expect(await isReviewedServiceMoveChild({ authorization, envelope: original,
              actionId: 'projects.worker.status', machineId, params })).toBe(variant === 'reviewed child');
            if (variant === 'reviewed child') {
              for (const ref of [h.ref, h.workerRef]) {
                const workspace = { serverId: ref.serverId, machineId: ref.machineId, workspaceId: ref.id, rootPath: ref.rootPath };
                const inspect = (value: typeof workspace) => isReviewedServiceMoveChild({ authorization, envelope: original,
                  actionId: 'projects.inspect', machineId: ref.machineId, params: { workspace: value, reviewSetupConsent: true } });
                expect(await inspect(workspace)).toBe(true);
                expect(await inspect({ ...workspace, rootPath: h.directory })).toBe(false);
                expect(await inspect({ ...workspace, workspaceId: 'another-checkout' })).toBe(false);
              }
            }
          } });
        expect(h.copies()).toBe(0);
      } finally { await h.close(); }
    });
  it.each(['reviewed destination', 'other material', 'changed reviewed destination'] as const)(
    'opens a protected Service Move root through real requester custody at the Sync controller: %s', async variant => {
      const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
      try {
        const prepare = h.prepareSignedMove({ protectedInput: variant === 'other material' ? 'other material' : 'requester material',
          ...(variant === 'changed reviewed destination' ? { selectedMachineId: 'another-reviewed-machine' } : {}) });
        if (variant === 'reviewed destination') {
          await expect(prepare).resolves.toMatchObject({ ok: true });
          expect(h.copies()).toBe(1);
          expect(await readFile(join(h.workerRef.rootPath, 'original'))).toEqual(bytes);
          expect(h.rpcOutcomes).toContainEqual(expect.objectContaining({ phase: 'installed.sourceDelivery',
            method: 'source-machine:daemon.workspaceSync.prepareBetween.v1', originalEnvelopeVersion: 2 }));
        } else {
          await expect(prepare).rejects.toMatchObject({ code: 'project_workspace_changed' });
          expect(h.copies()).toBe(0);
        }
      } finally { await h.close(); }
    });
  it.each(['reviewed destination', 'another source ref', 'another destination ref', 'another destination Machine'] as const)(
    'prepares reviewed Service Move through the signed installed SOURCE transport: %s', async variant => {
      const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
      try {
        const prepare = h.prepareSignedMove({
          ...(variant === 'another source ref' ? { sourceWorkspaceRefId: h.workerRef.id } : {}),
          ...(variant === 'another destination ref' ? { targetWorkspaceRefId: h.ref.id } : {}),
          ...(variant === 'another destination Machine' ? { selectedMachineId: 'unrelated-machine' } : {}),
        });
        if (variant === 'reviewed destination') {
          await expect(prepare).resolves.toMatchObject({ ok: true });
          expect(h.copies()).toBe(1);
          expect(await readFile(join(h.workerRef.rootPath, 'original'))).toEqual(bytes);
          expect(h.rpcOutcomes).toContainEqual(expect.objectContaining({ phase: 'installed.sourceDelivery',
            method: 'source-machine:daemon.workspaceSync.prepareBetween.v1' }));
        } else {
          await expect(prepare).rejects.toMatchObject({ code: 'project_workspace_changed' });
          expect(h.copies()).toBe(0);
        }
      } finally { await h.close(); }
    });
  it('verifies the original installed Script root across approval and native execution', async () => {
    const h = await createHarness('projects.script.run', 'ask', false, 'srv_portableHome');
    const post = vi.mocked(axios.post).getMockImplementation()!;
    const verifies: { phase: string; authorization: unknown }[] = [];
    let phase = 'request';
    vi.mocked(axios.post).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/projects.script.run/execution-authorization/verify')) {
        verifies.push({ phase, authorization: args[2]?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] });
      }
      return await post(...args);
    });
    try {
      const workspace = { serverId: h.ref.serverId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath };
      const requested = await h.run({ workspace, selection: { kind: 'named', name: 'lint' }, choice: { kind: 'primary' } }, 'ui', false, 'present_user');
      expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      phase = 'approval';
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      phase = 'native';
      const accepted = (await h.approval()).execution;
      expect(accepted).toMatchObject({ ok: true });
      const output = ProjectCommandActionOutputV1Schema.parse(accepted && 'result' in accepted ? accepted.result : undefined);
      const native = await Promise.race([
        h.waitForSpawn(0).then(pty => ({ kind: 'spawned' as const, pty })),
        h.waitForTerminal(output.operation.operationId).then(operation => ({ kind: 'terminal' as const, operation })),
      ]);
      expect(native, JSON.stringify({ native, verifies })).toMatchObject({ kind: 'spawned' });
      if (native.kind !== 'spawned') throw new Error('Script settled without native start');
      const pty = native.pty;
      pty.exit(0);
      expect(await h.waitForTerminal(output.operation.operationId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
      expect(new Set(verifies.map(value => value.phase))).toEqual(new Set(['request', 'approval', 'native']));
      expect(new Set(verifies.map(value => value.authorization))).toEqual(new Set(['synthetic-home-root']));
    } finally { await h.close(); }
  });
  it.each([
    ['projects.script.run', false, false, 0, false], ['projects.script.run', true, false, 0, false],
    ['projects.compute.exec', false, false, 0, false], ['projects.compute.exec', true, false, 0, false],
    ['projects.script.run', true, true, 0, false], ['projects.compute.exec', true, true, 0, false],
    ['projects.script.run', true, true, 7, false], ['projects.compute.exec', true, true, 7, false],
    ['projects.script.run', true, true, 0, true],
  ] as const)('executes signed portable worker %s through the installed factory (replay=%s, same Machine=%s, exit=%s, Home unavailable at exit=%s)', async (actionId, replay, sameMachineWorker, exitCode, homeUnavailableAtExit) => {
    const h = await createHarness(actionId, replay ? 'ask' : 'allowed', false, 'srv_portableHome', undefined, true, sameMachineWorker);
    try {
      const workspace = { serverId: h.ref.serverId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath };
      const input = { workspace, choice: { kind: 'workers', destination: { kind: 'machine', machineId: h.workerRef.machineId } },
        ...(actionId === 'projects.script.run' ? { selection: { kind: 'named', name: 'lint' } }
          : { executable: '/managed/make', argv: ['check'], cwd: h.rootPath }) };
      PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
      const result = await h.run(input, 'ui', false, 'present_user');
      if (replay) {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        expect(await h.decide('approve')).toMatchObject({ ok: true });
      }
      const settled = replay ? await h.approval() : null;
      if (settled) {
        expect(settled.status, `execution error: ${settled.execution?.errorCode ?? 'none'}`).toBe('executed');
        expect(settled.executionOriginV1).not.toHaveProperty('originalActionEnvelope');
      }
      const accepted = replay ? settled?.execution : result;
      expect(accepted, JSON.stringify({ accepted, networkPaths: [...new Set(h.networkPaths)], rpcOutcomes: h.rpcOutcomes,
        finiteIngress: h.finiteIngress })).toMatchObject({ ok: true });
      if (!accepted || !('result' in accepted)) throw new Error('Expected an accepted Project command result');
      const output = ProjectCommandActionOutputV1Schema.parse(accepted.result);
      // Sync's exact-Machine owner reuses SOURCE when that Machine was selected.
      const destination = sameMachineWorker ? h.ref : h.workerRef;
      expect(output.operation.domainRef).toMatchObject({ machineId: destination.machineId, workspaceRefId: destination.id,
        sourceWorkspace: workspace });
      const started = await Promise.race([
        h.waitForSpawn(0).then(() => ({ kind: 'spawned' as const })),
        h.waitForTerminal(output.operation.operationId).then(operation => ({ kind: 'terminal' as const, operation })),
      ]);
      expect(started, JSON.stringify({ operation: started, rpcOutcomes: h.rpcOutcomes, networkPaths: [...new Set(h.networkPaths)] }))
        .toMatchObject({ kind: 'spawned' });
      expect(h.spawned).toHaveLength(1);
      expect(h.spawned[0]!.cwd).toBe(destination.rootPath);
      expect(h.copies()).toBe(sameMachineWorker ? 0 : 1);
      expect(await readFile(join(destination.rootPath, 'original'))).toEqual(bytes);
      expect(await readFile(join(destination.rootPath, 'Makefile'), 'utf8')).toBe('check:\n\t@echo replay-admitted\n');
      if (!sameMachineWorker) expect(h.networkPaths).toContain('POST /v1/actions/projects.inspect');
      if (homeUnavailableAtExit) {
        const post = vi.mocked(axios.post).getMockImplementation()!;
        vi.mocked(axios.post).mockImplementation(async (...args) => {
          if (String(args[0]).endsWith('/projects.script.run/execution-authorization/verify')) {
            throw new Error('Home unavailable after native launch');
          }
          return await post(...args);
        });
      }
      h.spawned[0]!.exit(exitCode);
      const terminal = ActionOperationGetV1ResponseSchema.parse(await h.waitForTerminal(output.operation.operationId));
      expect(terminal, terminal.kind === 'found' ? terminal.operation.error?.errorCode : terminal.kind)
        .toMatchObject({ kind: 'found', operation: { operationId: output.operation.operationId,
          state: exitCode === 0 ? 'succeeded' : 'failed', domainRef: { exitCode },
          ...(exitCode === 0 ? {} : { error: { errorCode: 'project_command_step_failed' } }),
        } });
      if (terminal.kind === 'found' && exitCode === 0) {
        const result = getActionSpec(actionId).outputSchema!.parse(terminal.operation.result);
        expect(ProjectCommandActionOutputV1Schema.parse(result).operation).toMatchObject({
          operationId: output.operation.operationId, actionId, domainRef: { terminalId: terminal.operation.domainRef?.kind === 'projectCommand'
            ? terminal.operation.domainRef.terminalId : undefined, exitCode: 0 },
        });
      }
    } finally { await h.close(); }
  });

  it.each([0, 7])('executes a signed plain worker Script without spending the worker root on SOURCE inspection (exit %s)', async exitCode => {
    const h = await createHarness('projects.script.run', 'ask', false, 'srv_portableHome', undefined, true);
    try {
      await writeFile(join(h.rootPath, '.happier/project.json'), JSON.stringify({ version: 1,
        scripts: { ok: { execution: 'portable', source: { kind: 'command', command: 'echo worker-admitted' } } } }));
      const get = vi.mocked(axios.get).getMockImplementation()!;
      let refusedSourceReads = 0;
      vi.mocked(axios.get).mockImplementation(async (...args) => {
        // Real Home purpose admission permits a signed root to read its bound
        // execution Machine, not another Machine. SOURCE's passive inspection
        // belongs to the captured requester, with its own projects.inspect root.
        const headers = args[1]?.headers;
        const encodedTarget = headers?.[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER];
        const target = typeof encodedTarget === 'string' ? decodeExternalActionResolvedTargetV1(encodedTarget) : null;
        if (String(args[0]).endsWith('/v1/machines/source-machine')
          && headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]
          && (target?.kind !== 'machine' || target.machineId !== h.ref.machineId)) {
          refusedSourceReads++;
          throw Object.assign(new Error('execution_authorization_invalid'), { response: { status: 403 } });
        }
        return await get(...args);
      });
      const workspace = { serverId: h.ref.serverId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath };
      expect(await h.run({ workspace, selection: { kind: 'named', name: 'ok' },
        choice: { kind: 'workers', destination: { kind: 'machine', machineId: h.workerRef.machineId } } },
      'ui', false, 'present_user')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      const receipt = await h.approval();
      expect(receipt, JSON.stringify({ refusedSourceReads, code: receipt.execution?.errorCode,
        paths: h.networkPaths.slice(-12) })).toMatchObject({ status: 'executed', execution: { ok: true } });
      const output = ProjectCommandActionOutputV1Schema.parse(receipt.execution?.result);
      expect(output.operation.domainRef).toMatchObject({ machineId: h.workerRef.machineId, workspaceRefId: h.workerRef.id,
        sourceWorkspace: workspace });
      const observed = ActionOperationGetV1ResponseSchema.parse(await h.readOperation(output.operation.operationId));
      expect(observed).toMatchObject({ kind: 'found' });
      if (observed.kind === 'found') expect(observed.operation.setupReview).toBeUndefined();
      const started = await Promise.race([
        h.waitForSpawn(0).then(() => ({ kind: 'spawned' as const })),
        h.waitForTerminal(output.operation.operationId).then(operation => ({ kind: 'terminal' as const, operation })),
      ]);
      expect(started).toMatchObject({ kind: 'spawned' });
      expect(h.spawned).toHaveLength(1);
      expect(h.spawned[0]!.cwd).toBe(h.workerRef.rootPath);
      expect(h.copies()).toBe(1);
      expect(h.networkPaths).toContain('POST /v1/actions/projects.inspect');
      expect(refusedSourceReads).toBe(0);
      h.spawned[0]!.emitBytes(Buffer.from('worker-output\r\n'));
      h.spawned[0]!.exit(exitCode);
      expect(await h.waitForTerminal(output.operation.operationId)).toMatchObject({ kind: 'found',
        operation: { state: exitCode === 0 ? 'succeeded' : 'failed', domainRef: { exitCode },
          ...(exitCode === 0 ? {} : { error: { errorCode: 'project_command_step_failed' } }) } });
      const post = vi.mocked(axios.post).getMockImplementation()!;
      let outputCatalogReads = 0;
      vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
        if (new URL(String(url)).pathname === '/v1/account/project-rows/list') {
          // Home's isProjectAccountMetadataHttpPurpose does not grant an output
          // root catalog access. The real terminal owner must use the admitted
          // requester's private Account read custody, as it does in the app.
          if (config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) {
            return { status: 401, data: { error: 'invalid_token' } };
          }
          outputCatalogReads++;
        }
        return post(url, body, config);
      });
      const address = { serverId: h.ref.serverId, machineId: h.workerRef.machineId, operationId: output.operation.operationId, byteOffset: 0 };
      const read = await h.runOriginalCli(address, 'projects.execution.output.read');
      expect(read, JSON.stringify(read)).toMatchObject({ ok: true, result: { ok: true, done: true } });
      if (!read.ok) throw new Error(read.errorCode);
      assertActionOutputContract('projects.execution.output.read', read.result);
      const stream = TerminalStreamReadResponseSchema.parse(read.result);
      if (!stream.ok) throw new Error(stream.code);
      expect(Buffer.concat(stream.frames.flatMap(frame => frame.t === 'bytes'
        ? [Buffer.from(decodeTerminalStreamBytesFrame(frame))] : [])).toString()).toBe('worker-output\r\n');
      expect(stream.frames).toContainEqual(expect.objectContaining({ t: 'exit', exitCode }));
      expect(await h.runOriginalCli(address, 'projects.execution.output.copy'))
        .toMatchObject({ ok: true, result: { kind: 'bytes', output: read.result } });
      expect(outputCatalogReads).toBeGreaterThan(0);
      await h.changeRequesterWorkerRoot();
      expect(await h.run(address, 'cli', false, 'present_user', 'projects.execution.output.read', 'cli-worker-output-after-root-change'))
        .toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
    } finally { await h.close(); }
  });

  it.each(['uncoded', 'rpc', 'malformed', 'oversized', 'secret'] as const)('preserves a %s worker preparation failure in the recorded operation', async kind => {
    const h = await createHarness('projects.script.run', 'ask', false, 'srv_portableHome', undefined, true);
    try {
      const message = 'SOURCE metadata refresh is unavailable';
      const error = kind === 'rpc' ? new RpcError(message, RPC_ERROR_CODES.FORBIDDEN)
        : kind === 'malformed' ? { message: 'Untrusted error object', request: { headers: { Authorization: 'private-fixture-value' } } }
          : new Error(kind === 'oversized' ? message.repeat(1_000)
            : kind === 'secret' ? `${message}; Authorization: Bearer private-fixture-value` : message);
      const get = vi.mocked(axios.get).getMockImplementation()!;
      vi.mocked(axios.get).mockImplementation(async (...args) => {
        // Fail the real Home boundary only after the installed finite owner
        // hands preparation to Sync; initial SOURCE inspection still succeeds.
        if (String(args[0]).endsWith('/v1/machines/source-machine')
          && h.rpcOutcomes.some(outcome => typeof outcome === 'object' && outcome !== null
            && 'phase' in outcome && outcome.phase === 'installed.prepareBetween')) throw error;
        return await get(...args);
      });
      expect(await h.run({ workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id,
        machineId: h.ref.machineId, rootPath: h.rootPath }, selection: { kind: 'named', name: 'lint' },
      choice: { kind: 'workers', destination: { kind: 'machine', machineId: h.workerRef.machineId } } },
      'ui', false, 'present_user')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      const receipt = await h.approval();
      expect(receipt).toMatchObject({ status: 'executed', execution: { ok: true } });
      const output = ProjectCommandActionOutputV1Schema.parse(receipt.execution?.result);
      const terminal = ActionOperationGetV1ResponseSchema.parse(await h.waitForTerminal(output.operation.operationId));
      expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'failed', progress: { phase: 'copying' },
        error: { errorCode: kind === 'rpc' ? RPC_ERROR_CODES.FORBIDDEN : 'workspace_sync_prepare_failed',
          error: kind === 'malformed' ? 'Workspace preparation failed'
            : kind === 'oversized' ? 'Workspace preparation failed; the diagnostic exceeds the operation error format'
              : kind === 'secret' ? expect.stringContaining(message) : message } } });
      expect(JSON.stringify(terminal)).not.toContain('private-fixture-value');
      expect(h.spawned).toHaveLength(0);
    } finally { await h.close(); }
  });

  it.each(['foreign Source Account', 'retired requester'] as const)('refuses portable worker execution for %s through installed requester custody', async reason => {
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
    try {
      if (reason === 'foreign Source Account') h.foreignSource(); else h.retireAfterCopy();
      const result = await h.run({ workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath },
        selection: { kind: 'named', name: 'lint' }, choice: { kind: 'workers', destination: { kind: 'machine', machineId: h.workerRef.machineId } } },
        'ui', false, 'present_user');
      if (reason === 'foreign Source Account') {
        expect(result).toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
        expect(h.copies()).toBe(0);
      } else {
        expect(result).toMatchObject({ ok: true });
        const operation = ProjectCommandActionOutputV1Schema.parse(result.ok ? result.result : null).operation;
        expect(await h.waitForTerminal(operation.operationId)).toMatchObject({ kind: 'found', operation: { state: 'failed' } });
        expect(h.copies(), JSON.stringify({ operation: await h.readOperation(operation.operationId), rpcOutcomes: h.rpcOutcomes,
          networkPaths: [...new Set(h.networkPaths)] })).toBe(1);
      }
      expect(h.spawned).toEqual([]);
    } finally { await h.close(); }
  });
  it('does not lend the installed Account relationship when the requester target root changes before preparation', async () => {
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
    try {
      await h.changeRequesterWorkerRoot('beforePreparation');
      const result = await h.run({ workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath },
        selection: { kind: 'named', name: 'lint' }, choice: { kind: 'workers', destination: { kind: 'machine', machineId: h.workerRef.machineId } } },
        'ui', false, 'present_user');
      expect(result, JSON.stringify({ result, rpcOutcomes: h.rpcOutcomes })).toMatchObject({ ok: true });
      const output = ProjectCommandActionOutputV1Schema.parse(result.ok ? result.result : null);
      expect(await h.waitForTerminal(output.operation.operationId)).toMatchObject({ kind: 'found', operation: { state: 'failed' } });
      expect(h.copies(), JSON.stringify({ operation: await h.readOperation(output.operation.operationId), rpcOutcomes: h.rpcOutcomes,
        networkPaths: [...new Set(h.networkPaths)] })).toBe(0);
      expect(h.spawned).toEqual([]);
    } finally { await h.close(); }
  });
  it.each([false, true])('runs reviewed This time setup and resumes the held script without remembered trust through the installed executor (unsigned UI: %s)', async unsignedUi => {
    const h = await createHarness('projects.script.run', 'allowed', true, unsignedUi ? 'srv_portableHome' : 'srv_n2');
    let operationId: string | undefined;
    try {
      const workspace = { serverId: h.ref.serverId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath };
      const inspected = await h.run({ workspace }, 'ui', false, 'present_user', 'projects.inspect', 'setup-inspection');
      expect(inspected, JSON.stringify(inspected)).toMatchObject({ ok: true });
      const before = ProjectDefinitionInspectOutputSchema.parse(inspected.ok ? inspected.result : null);
      expect(before).toMatchObject({ setupReadiness: { kind: 'unprepared' }, setupReview: {
        reviewedEffect: { commands: [{ kind: 'command', command: 'echo setup-reviewed' }] },
      } });
      expect(h.spawned).toEqual([]);
      const run = await h.run({ workspace, selection: { kind: 'named', name: 'lint' } }, 'ui', false, 'present_user');
      if (!run.ok) throw new Error(run.errorCode);
      const accepted = PROJECT_ACTION_OUTPUT_SCHEMAS_V1['projects.script.run'].parse(run.result);
      if (!('operation' in accepted)) throw new Error('Missing accepted script');
      operationId = accepted.operation.operationId;
      await expect.poll(() => h.readOperation(operationId!)).toMatchObject({ kind: 'found', operation: { setupReview: { code: 'project_setup_consent_required' } } });
      const held = ActionOperationGetV1ResponseSchema.parse(await h.readOperation(operationId));
      if (held.kind !== 'found' || !held.operation.setupReview) throw new Error('Missing actual held review');
      const changed = await h.run({ workspace, phase: 'setup', expectedEffectDigest: 'stale-review', consentScope: 'thisTime' },
        'ui', unsignedUi ? 'unsigned-ui' : false, 'present_user', 'projects.prepare', 'changed-setup-review');
      expect(changed).toMatchObject({ ok: false, errorCode: 'project_setup_effect_changed' });
      expect(h.hasApproval()).toBe(false);
      const setup = await h.run({ workspace, phase: 'setup', expectedEffectDigest: held.operation.setupReview.reviewedEffectDigest,
        consentScope: 'thisTime' }, 'ui', unsignedUi ? 'unsigned-ui' : false, 'present_user', 'projects.prepare', 'this-time-setup');
      expect(setup, JSON.stringify(setup)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'projects.prepare' } });
      expect(ActionApprovalRequestCreatedResultSchema.parse(setup.ok ? setup.result : null).actionId).toBe('projects.prepare');
      expect((await h.approval()).preview).toMatchObject({ setupReview: before.setupReview });
      const decision = await h.decide('approve');
      expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
      const prepared = (await h.approval()).execution;
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, result: { operation: { actionId: 'projects.prepare' } } });
      if (!prepared?.ok) throw new Error('Missing approved setup execution');
      const setupOperation = ProjectCommandActionOutputV1Schema.parse(prepared.result).operation;
      (await h.waitForSpawn(0)).exit(0);
      expect(await h.waitForTerminal(setupOperation.operationId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
      // Native completion must wake the held owner without a client's extra
      // Get/Wait accidentally providing the missing lifecycle notification.
      await expect.poll(() => h.spawned.length, { timeout: 5_000 }).toBe(2);
      h.spawned[1]!.exit(1);
      expect(await h.waitForTerminal(operationId)).toMatchObject({ kind: 'found', operation: { state: 'failed', domainRef: { exitCode: 1 } } });
      expect(h.spawned).toHaveLength(2);
      expect(h.networkPaths).not.toContain('POST /v1/account/project-trust/mutate');
    } finally { if (operationId) await h.cancelOperation(operationId); await h.close(); }
  });
  it('returns admitted setup-held snapshots while the real review producer is awaiting Home instead of expiring read admission', async () => {
    const h = await createHarness('projects.script.run', 'allowed', true);
    let operationId: string | undefined;
    let release = () => {};
    try {
      const run = await h.run({ workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath },
        selection: { kind: 'named', name: 'lint' } }, 'ui', false, 'present_user');
      if (!run.ok) throw new Error(run.errorCode);
      const accepted = PROJECT_ACTION_OUTPUT_SCHEMAS_V1['projects.script.run'].parse(run.result);
      if (!('operation' in accepted)) throw new Error('Missing accepted script');
      operationId = accepted.operation.operationId;
      await expect.poll(() => h.readOperation(operationId!)).toMatchObject({ kind: 'found', operation: { setupReview: { code: 'project_setup_consent_required' } } });
      const before = ActionOperationGetV1ResponseSchema.parse(await h.readReviewedOperation(operationId));
      const unchanged = ActionOperationGetV1ResponseSchema.parse(await h.readReviewedOperation(operationId));
      if (before.kind !== 'found' || unchanged.kind !== 'found') throw new Error('Missing retained review');
      expect.soft(unchanged.operation.revision).toBe(before.operation.revision);
      release = h.holdTrustRead();
      const pending = h.readTransportOperation(operationId, 100);
      // Model the transport owner's real deadline while the Home boundary is delayed.
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      release();
      const response = await pending;
      expect(response).toMatchObject({ kind: 'found', operation: { operationId } });
      expect(ActionOperationGetV1ResponseSchema.safeParse(response).success).toBe(true);
      await h.readReviewedOperation(operationId);
      release = h.holdTrustRead();
      let reviewed = false;
      const fresh = h.readReviewedOperation(operationId).then(value => { reviewed = true; return value; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(reviewed).toBe(false);
      release();
      expect(ActionOperationGetV1ResponseSchema.safeParse(await fresh).success).toBe(true);
      expect(h.spawned).toEqual([]);
      expect(await h.cancelOperation(operationId)).toEqual({ kind: 'requested' });
      await expect.poll(() => h.readOperation(operationId!)).toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
    } finally { release(); if (operationId) await h.cancelOperation(operationId); await h.close(); }
  });
  it('settles Stop on an approved setup-held Project Run through installed operation wiring', async () => {
    const h = await createHarness('projects.script.run', 'ask', true, 'srv_portableHome');
    let operationId: string | undefined;
    try {
      const input = { workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id,
        machineId: h.ref.machineId, rootPath: h.rootPath }, selection: { kind: 'named', name: 'lint' } };
      expect(await h.run(input, 'ui')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const decision = await h.decide('approve');
      expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
      const execution = (await h.approval()).execution;
      expect(execution).toMatchObject({ ok: true, result: { operation: { state: 'accepted' } } });
      const parsed = PROJECT_ACTION_OUTPUT_SCHEMAS_V1['projects.script.run'].parse(execution?.result);
      if (!('operation' in parsed)) throw new Error('Missing accepted finite operation');
      operationId = parsed.operation.operationId;
      await expect.poll(() => h.readOperation(operationId!)).toMatchObject({ kind: 'found', operation: {
        setupReview: { code: 'project_setup_consent_required' }, progress: { phase: 'setup' } } });
      // A verified peer grant is a different ingress from this installed
      // approval's private requester custody; it must not authorize Stop.
      expect(await h.unadmittedPeerCancel(operationId)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(await h.readOperation(operationId)).toMatchObject({ kind: 'found', operation: { setupReview: {
        code: 'project_setup_consent_required' } } });
      const stop = await h.run({ serverId: h.ref.serverId, machineId: h.ref.machineId, operationId }, 'ui', 'unsigned-ui',
        'present_user', 'action.operations.cancel', 'stop-request');
      expect(stop).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(ActionApprovalRequestCreatedResultSchema.parse(stop.ok ? stop.result : null).actionId).toBe('action.operations.cancel');
      const stopped = await h.decide('approve');
      expect(stopped).toMatchObject({ ok: true });
      const stoppedExecution = (await h.approval()).execution;
      expect(stoppedExecution, JSON.stringify(stoppedExecution)).toMatchObject({ ok: true, result: { kind: 'requested' } });
      await expect.poll(() => h.readOperation(operationId!)).toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
    } finally {
      if (operationId) await h.cancelOperation(operationId);
      await h.close();
    }
  });
  it.each([false, true])('reviews declared Machine Service before Artifact publication and replays the approved effect (setup=%s)', async setup => {
    const h = await createHarness('localServices.launcher.start', 'ask', setup);
    try {
      const input = await h.serviceInput();
      const proposal = await h.run(input, 'ui', 'unsigned-ui', 'present_user');
      expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const approval = await h.approval();
      expect(approval).toMatchObject({ actionArgs: input, preview: { serviceStartReview: {
        request: input, target: { machineId: input.machineId, rootPath: h.rootPath }, reviewedEffectDigest: expect.any(String),
      } } });
      expect(h.spawned).toEqual([]);
      expect(h.serviceInstances()).toEqual([]);
      const decided = h.decide('approve');
      if (setup) (await h.waitForSpawn(0)).exit(0);
      expect(await decided).toMatchObject({ ok: true });
      expect((await h.approval()).execution).toMatchObject({ ok: true, result: { status: 'succeeded' } });
      expect(h.serviceInstances()).toHaveLength(1);
    } finally {
      await Promise.all(h.serviceInstances().map(service => service.stop()));
      await h.close();
      expect(h.serviceInstances()).toEqual([]);
    }
  });
  it('refuses changed Service bytes when replaying the CLI native review Artifact', async () => {
    const h = await createHarness('localServices.launcher.start', 'ask');
    try {
      expect(await h.runOriginalCli(await h.serviceInput(), 'localServices.launcher.start')).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created' } });
      const file = join(h.rootPath, '.happier/project.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      manifest.services.checked.source.command = 'echo changed';
      await writeFile(file, JSON.stringify(manifest));
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      expect((await h.approval()).execution).toMatchObject({ ok: true,
        result: { status: 'denied', reasonCode: 'project_service_effect_changed' } });
      expect(h.spawned).toEqual([]);
      expect(h.serviceInstances()).toEqual([]);
    } finally { await h.close(); }
  });
  it('refuses a worker-status child delivered to a Machine conflicting with its semantic destination', async () => {
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_n2', undefined, true);
    try {
      expect(await h.run({ workspace: { serverId: h.ref.serverId, refId: h.ref.id },
        destination: { kind: 'machine', machineId: h.ref.machineId }, purpose: 'finite' },
      'cli', false, 'present_user', 'projects.worker.status'))
        .toMatchObject({ ok: false, errorCode: 'target_not_local' });
      expect(h.hasApproval()).toBe(false);
      expect(h.spawned).toEqual([]);
      expect(h.copies()).toBe(0);
    } finally { await h.close(); }
  });
  it('routes a standalone CLI Script worker-status child from SOURCE to its nested semantic Machine target', async () => {
    const h = await createHarness('projects.script.run', 'ask', false, 'srv_n2', undefined, true);
    try {
      const input = { workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id,
        machineId: h.ref.machineId, rootPath: h.rootPath }, selection: { kind: 'named', name: 'lint' },
        choice: { kind: 'workers', destination: { kind: 'machine', machineId: h.workerRef.machineId } } };
      const proposal = await h.runStandaloneCli(input);
      expect(h.rpcOutcomes).toContainEqual({ phase: 'original.hostChild', actionId: 'projects.worker.status',
        machineId: h.workerRef.machineId, target: { kind: 'machine', machineId: h.workerRef.machineId } });
      expect(proposal, JSON.stringify({ proposal, paths: h.networkPaths, outcomes: h.rpcOutcomes }))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(h.networkPaths).toContain('POST /v1/actions/projects.worker.status');
      expect(h.spawned).toEqual([]);
      const approval = await h.approval();
      expect(approval.actionArgs).toEqual(input);
      expect(approval.executionOriginV1).toMatchObject({ machineId: h.workerRef.machineId });
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      const settled = await h.approval();
      expect(settled.execution).toMatchObject({ ok: true });
      const output = ProjectCommandActionOutputV1Schema.parse(settled.execution?.ok ? settled.execution.result : null);
      const launched = await Promise.race([h.waitForSpawn(0), h.waitForTerminal(output.operation.operationId).then(terminal => {
        throw new Error('Standalone Script settled before native launch: ' + JSON.stringify(terminal));
      })]);
      expect(launched.cwd).toBe(h.workerRef.rootPath);
      launched.exit(0);
      expect(await h.waitForTerminal(output.operation.operationId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
    } finally { await h.close(); }
  });
  it.each(['denied', 'Home admission unavailable'] as const)('refuses original CLI Project Run before Ask or native execution: %s', async refusal => {
    const h = await createHarness('projects.script.run', refusal === 'denied' ? 'denied' : 'ask');
    const post = vi.mocked(axios.post).getMockImplementation()!;
    if (refusal !== 'denied') vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
      if (String(url).endsWith('/projects.script.run/execution-authorization')) return {
        status: 503, data: { error: 'execution_authorization_unavailable' },
      };
      return post(url, body, config);
    });
    try {
      const input = { workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id,
        machineId: h.ref.machineId, rootPath: h.rootPath }, selection: { kind: 'named', name: 'lint' }, choice: { kind: 'primary' } };
      expect(await h.run(input, 'cli', true)).toMatchObject({ ok: false });
      expect(h.hasApproval()).toBe(false);
      expect(h.spawned).toEqual([]);
      expect(h.networkPaths).not.toContain('POST /v1/actions/projects.script.run');
    } finally { await h.close(); }
  });
  it.each((['cli', 'ui'] as const).flatMap(surface => [false, true].map(worker => ({ surface, worker,
    authentication: surface === 'cli' ? 'terminal' as const : 'account' as const, askWithUiWaiver: false })))
    .concat([false, true].map(worker => ({ surface: 'cli' as const, worker, authentication: 'account' as const, askWithUiWaiver: true }))))
  ('admits approved Machine Project Run replay from $surface (worker=$worker, authentication=$authentication, UI waiver=$askWithUiWaiver) with the original requester custody through the installed executor', async ({ surface, worker, authentication, askWithUiWaiver }) => {
    const h = await createHarness('projects.script.run', 'ask', false, 'srv_n2', undefined, worker, false,
      { authentication, askWithUiWaiver });
    try {
      const input = { workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id,
        machineId: h.ref.machineId, rootPath: h.rootPath },
        selection: surface === 'cli' && !worker ? { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } }
          : { kind: 'named', name: 'lint' },
        ...(worker ? { choice: { kind: 'workers', destination: { kind: 'machine', machineId: h.workerRef.machineId } } }
          : surface === 'ui' ? { choice: { kind: 'primary' } } : {}) };
      const proposal = await h.run(input, surface, surface === 'cli', 'account_automation');
      expect(proposal, JSON.stringify({ proposal, finiteIngress: h.finiteIngress, rpcOutcomes: h.rpcOutcomes, networkPaths: h.networkPaths }))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const beforeReplay = [...h.finiteIngress];
      expect(h.spawned).toEqual([]);
      const approval = await h.approval();
      expect(approval.status).toBe('open');
      expect(approval.execution).toBeUndefined();
      expect(PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse(approval.actionArgs)).toEqual(input);
      expect(requiresExactDaemonApprovalReplay(approval)).toBe(true);
      if (surface === 'cli') {
        if (!worker) expect(beforeReplay).toContainEqual({ rootActionId: 'projects.inspect', accountId: 'account', homeId: 'srv_n2',
          installationId: h.installation.installationId, current: true });
        expect(h.networkPaths).toContain('POST /v1/actions/projects.inspect');
        expect(h.networkPaths).toContain('POST /v1/actions/projects.script.run');
        expect(approval.executionOriginV1).toMatchObject({ actionId: 'projects.script.run', surface: 'cli',
          accountId: 'account', machineId: worker ? h.workerRef.machineId : h.ref.machineId });
        expect(approval.executionOriginV1.externalActionExecutionAuthorization?.binding).toMatchObject({
          actionId: 'projects.script.run', authentication: { kind: authentication }, accountId: 'account',
          machineId: worker ? h.workerRef.machineId : h.ref.machineId, installationId: h.installation.installationId });
      }
      expect(await (surface === 'cli' ? h.decideFromCli() : h.decide('approve'))).toMatchObject({ ok: true });
      const settled = await h.approval();
      expect(settled.execution, JSON.stringify(settled.execution)).toMatchObject({ ok: true,
        result: { operation: { actionId: 'projects.script.run', state: 'accepted',
          scope: { accountId: 'account', machineId: worker ? h.workerRef.machineId : h.ref.machineId } } } });
      const operation = ProjectCommandActionOutputV1Schema.parse(settled.execution?.ok ? settled.execution.result : null).operation;
      const launched = await Promise.race([h.waitForSpawn(0), h.waitForTerminal(operation.operationId).then(terminal => {
        throw new Error('Finite replay settled before native launch: ' + JSON.stringify({ terminal, rpcOutcomes: h.rpcOutcomes }));
      })]);
      expect(launched.cwd).toBe(worker ? h.workerRef.rootPath : h.ref.rootPath);
      if (surface === 'ui') {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({ artifactId: 'approval-seam', actionId: 'projects.script.run',
          scope: { serverId: h.ref.serverId, accountId: 'account' }, expectedInput: input, onSucceeded, onFailed });
        await continuation.onExecuted({ id: 'approval-seam', title: null, header: buildApprovalRequestArtifactHeaderV1(settled),
          body: JSON.stringify(settled), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true });
        expect(onFailed).not.toHaveBeenCalled();
        expect(onSucceeded).toHaveBeenCalledWith(settled.execution?.result);
      }
      expect(h.finiteIngress).toHaveLength(beforeReplay.length + 1);
      expect(h.finiteIngress).toMatchObject([...beforeReplay, { accountId: 'account', homeId: 'srv_n2', current: true,
        rootActionId: 'projects.script.run',
        installationId: h.installation.installationId }]);
      // Unadmitted local invocation remains refused at the actual receiver.
      expect(await h.localFinite(input)).toMatchObject({ ok: false, errorCode: 'machine_admission_required' });
    } finally { await h.close(); }
  });
  it.each(['waived', 'unavailable'] as const)('refuses a host-only finite CLI Ask that Account policy cannot retain through admission (%s)', async hostOnlyAsk => {
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_n2', undefined, false, false,
      { authentication: 'account', hostOnlyAsk });
    try {
      const input = { workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id,
        machineId: h.ref.machineId, rootPath: h.rootPath }, selection: { kind: 'named', name: 'lint' } };
      expect(await h.run(input, 'cli', true)).toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
      expect(h.hasApproval()).toBe(false);
      expect(h.spawned).toEqual([]);
      expect(h.networkPaths).not.toContain('POST /v1/actions/projects.script.run');
    } finally { await h.close(); }
  });
  it('refuses finite CLI admission when installation sealing cannot preserve its surface', async () => {
    const h = await createHarness('projects.script.run', 'ask', false, 'srv_n2', undefined, false, false,
      { authentication: 'account', askWithUiWaiver: true });
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      const response = await get(url, config);
      if (new URL(String(url)).pathname !== '/v1/machines/machine') return response;
      if (!response || typeof response !== 'object' || !('data' in response)) throw new Error('Expected HTTP response');
      const data = response.data;
      if (!data || typeof data !== 'object' || !('machine' in data)) throw new Error('Expected Machine response');
      const machine = MachinePublishedRowV1Schema.parse(data.machine);
      return { ...response, data: { ...data, machine: { ...machine, installationPublicKey: null } } };
    });
    try {
      const input = { workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id,
        machineId: h.ref.machineId, rootPath: h.rootPath }, selection: { kind: 'named', name: 'lint' }, choice: { kind: 'primary' } };
      expect(await h.run(input, 'cli', true)).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
      expect(h.hasApproval()).toBe(false);
      expect(h.spawned).toEqual([]);
      expect(h.networkPaths).not.toContain('POST /v1/actions/projects.script.run');
    } finally { await h.close(); }
  });
  it.each(filesystemIds.flatMap(actionId => (['ui', 'cli'] as const).flatMap(surface =>
    (['approve', 'reject'] as const).map(decision => ({ actionId, surface, decision })))))
  ('retains exact $actionId from $surface through $decision using production composition', async ({ actionId, surface, decision }) => {
    const h = await createHarness(actionId);
    const input = actionId === 'daemon.filesystem.rename' ? { rootPath: h.rootPath, from: 'original', to: 'renamed', overwrite: false }
      : actionId === 'daemon.filesystem.delete' ? { rootPath: h.rootPath, path: 'original', recursive: false }
      : actionId === 'daemon.filesystem.writeFile' ? { rootPath: h.rootPath, path: 'binary', content: bytes.toString('base64'), expectedHash: null }
      : actionId === 'daemon.filesystem.readFile' ? { rootPath: h.rootPath, path: 'original' }
      : actionId === 'daemon.filesystem.createDirectory' ? { rootPath: h.rootPath, path: 'folder' }
      : { rootPath: h.rootPath, path: '.', ...(actionId === 'daemon.filesystem.getDirectoryTree' ? { maxDepth: 1 } : {}) };
    try {
      expect(await h.run(input, surface)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId } });
      const checkoutName = basename(h.rootPath);
      const expectedSummary = actionId === 'daemon.filesystem.writeFile' ? `Write binary in ${checkoutName}`
        : actionId === 'daemon.filesystem.createDirectory' ? `Create the folder folder in ${checkoutName}`
        : actionId === 'daemon.filesystem.rename' ? `Rename original to renamed in ${checkoutName}`
        : actionId === 'daemon.filesystem.delete' ? `Delete original from ${checkoutName}`
        : null;
      expect(await h.approval()).toMatchObject({ status: 'open', actionArgs: input,
        ...(expectedSummary ? { summary: `${expectedSummary}.`, preview: { summary: `${expectedSummary}.` } } : {}),
        executionOriginV1: { requestId: 'original-request', surface, authority: 'account_automation', accountId: 'account',
          externalActionInputSignature: expect.any(String) } });
      expect(await readdir(h.rootPath)).toEqual(['original']);
      expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
      const decided = await h.decide(decision);
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: decision === 'reject' ? 'rejected' : 'executed' } });
      if (decision === 'reject') {
        expect(await h.replay()).toMatchObject({ ok: false, errorCode: 'approval_not_approved' });
        expect(await readdir(h.rootPath)).toEqual(['original']);
        expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
      } else {
        const result = (await h.approval()).execution?.result;
        if (actionId === 'daemon.filesystem.readFile') expect(result).toEqual({ success: true, content: bytes.toString('base64') });
        else if (actionId === 'daemon.filesystem.listDirectory') expect(result).toMatchObject({ success: true,
          entries: [expect.objectContaining({ name: 'original', type: 'file' })] });
        else if (actionId === 'daemon.filesystem.getDirectoryTree') expect(result).toMatchObject({ success: true,
          tree: { children: [expect.objectContaining({ name: 'original' })] } });
        else if (actionId === 'daemon.filesystem.delete') expect(await readdir(h.rootPath)).toEqual([]);
        else if (actionId === 'daemon.filesystem.createDirectory') expect((await stat(join(h.rootPath, 'folder'))).isDirectory()).toBe(true);
        else expect(await readFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'))).toEqual(bytes);
        if (actionId === 'daemon.filesystem.writeFile') expect(result).toMatchObject({ hash: createHash('sha256').update(bytes).digest('hex') });
        // An intervening edit distinguishes repeated effects from durable observation.
        const keptPath = join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed'
          : actionId === 'daemon.filesystem.delete' || actionId === 'daemon.filesystem.readFile' ? 'original' : 'binary');
        await writeFile(keptPath, 'subsequent user edit');
        if (actionId === 'daemon.filesystem.createDirectory') await rm(join(h.rootPath, 'folder'), { recursive: true });
        expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(await readFile(keptPath, 'utf8')).toBe('subsequent user edit');
        expect((await h.approval()).execution?.result).toEqual(result);
        if (actionId === 'daemon.filesystem.createDirectory') await expect(stat(join(h.rootPath, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(join(h.directory, 'outside'), 'utf8')).toBe('outside unchanged');
    } finally { await h.close(); }
  });

  it.each((['daemon.filesystem.writeFile', 'daemon.filesystem.createDirectory', 'daemon.filesystem.rename', 'daemon.filesystem.delete'] as const)
    .flatMap(actionId => (['approve', 'reject', 'cancel'] as const).map(decision => ({ actionId, decision }))))
  ('retains the raw no-signal UI $actionId request id through $decision', async ({ actionId, decision }) => {
    const h = await createHarness(actionId);
    const input = actionId === 'daemon.filesystem.writeFile' ? { rootPath: h.rootPath, path: 'binary', content: bytes.toString('base64'), expectedHash: null }
      : actionId === 'daemon.filesystem.createDirectory' ? { rootPath: h.rootPath, path: 'folder' }
      : actionId === 'daemon.filesystem.rename' ? { rootPath: h.rootPath, from: 'original', to: 'renamed', overwrite: false }
      : { rootPath: h.rootPath, path: 'original', recursive: false };
    try {
      expect(await h.raw(input)).toMatchObject({ kind: 'approval_request_created' });
      expect(await h.approval()).toMatchObject({ status: 'open', executionOriginV1: { surface: 'rpc', requestId: 'original-request' } });
      expect(await h.decide('approve', 'account_automation')).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(await h.approval()).toMatchObject({ status: 'open' });
      expect(await readdir(h.rootPath)).toEqual(['original']);
      const decided = await h.decide(decision);
      expect(decided, JSON.stringify({ decided, networkPaths: h.networkPaths })).toMatchObject({ ok: true, result: { status: decision === 'approve' ? 'executed'
        : decision === 'reject' ? 'rejected' : 'canceled' } });
      if (decision !== 'approve') {
        expect(await h.replay()).toMatchObject({ ok: false, errorCode: 'approval_not_approved' });
        expect(await readdir(h.rootPath)).toEqual(['original']);
        expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
      } else {
        if (actionId === 'daemon.filesystem.delete') expect(await readdir(h.rootPath)).toEqual([]);
        else if (actionId === 'daemon.filesystem.createDirectory') expect((await stat(join(h.rootPath, 'folder'))).isDirectory()).toBe(true);
        else expect(await readFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'))).toEqual(bytes);
        await writeFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'), 'subsequent user edit');
        expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(await readFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'), 'utf8')).toBe('subsequent user edit');
      }
    } finally { await h.close(); }
  });

  it.each(['ui', 'cli'] as const)('opens an issuer-approved folder from %s through authenticated Machine ingress', async surface => {
    const h = await createHarness('projects.open', 'ask');
    const input = { serverId: 'srv_n2', machineId: 'machine', source: { kind: 'folder', path: h.rootPath }, materialization: { kind: 'attach' } };
    try {
      const initialRows = JSON.stringify(h.rows);
      expect(await h.run(input, surface, surface === 'ui' ? 'unsigned-ui' : true, 'present_user'))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(JSON.stringify(h.rows)).toBe(initialRows);
      const result = await h.decide('approve');
      expect(result, JSON.stringify({ result, rpcOutcomes: h.rpcOutcomes })).toMatchObject({ ok: true, result: {
        status: 'executed', execution: { ok: true, result: { kind: 'opened', directory: h.rootPath,
          workspace: { serverId: 'srv_n2', machineId: 'machine', rootPath: h.rootPath } } },
      } });
      expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
    } finally { await h.close(); }
  });

  it.each((['ui', 'cli'] as const).flatMap(surface => (['ask', 'allowed'] as const).map(approval => ({ surface, approval }))))
  ('opens a real folder from $surface under $approval policy and retains its accepted row', async ({ surface, approval }) => {
    const h = await createHarness('projects.open', approval);
    const input = { serverId: 'srv_n2', machineId: 'machine', source: { kind: 'folder', path: h.rootPath }, materialization: { kind: 'attach' } };
    try {
      const initialRows = JSON.stringify(h.rows);
      const invocation = await h.run(input, surface);
      if (approval === 'ask') {
        expect(JSON.stringify(h.rows)).toBe(initialRows);
        expect((await h.approval()).executionOriginV1.originalActionEnvelope).toMatchObject({
          v: 1, requestId: 'original-request', target: { kind: 'machine', machineId: h.ref.machineId }, input,
        });
      }
      const result = approval === 'ask' ? await h.decide('approve') : invocation;
      if (approval === 'ask') expect(invocation).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const opened = { kind: 'opened', directory: h.rootPath, workspace: { serverId: 'srv_n2', machineId: 'machine', rootPath: h.rootPath } };
      expect(result, JSON.stringify({ result, rpcOutcomes: h.rpcOutcomes })).toMatchObject(approval === 'ask'
        ? { ok: true, result: { status: 'executed', execution: { ok: true, result: opened } } } : { ok: true, result: opened });
      const accepted = JSON.stringify(h.rows);
      if (approval === 'ask') expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(JSON.stringify(h.rows)).toBe(accepted);
      expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
      if (approval === 'allowed') {
        h.disconnectInstalledMachine();
        expect(await h.run(input, surface, false, 'account_automation', 'projects.open', 'disconnected-open'))
          .toMatchObject({ ok: true, result: { kind: 'outcomeUnknown' } });
        expect(JSON.stringify(h.rows)).toBe(accepted);
      }
    } finally { await h.close(); }
  });

  it.each((['ui', 'cli'] as const).flatMap(surface => (['projects.list', 'projects.workspace.update', 'projects.workspace.forget',
    'projects.visibility.set', 'projects.context.update', 'projects.sources.list', 'projects.sources.read', 'projects.sources.create', 'projects.sources.update',
    'projects.sources.delete'] as const).flatMap(actionId => (['ask', 'allowed'] as const).map(approval => ({ actionId, surface, approval })))))
  ('admits $actionId Account custody from $surface under $approval policy and returns the real row or metadata outcome', async ({ actionId, surface, approval }) => {
    const h = await createHarness(actionId, approval);
    const input = actionId === 'projects.workspace.update' ? { serverId: 'srv_n2', workspaceId: h.ref.id, label: 'Renamed workspace' }
      : actionId === 'projects.workspace.forget' ? { serverId: 'srv_n2', workspaceId: h.ref.id }
      : actionId === 'projects.visibility.set' ? { target: { serverId: 'srv_n2', projectKey: 'project' }, expectedRevision: 2, hidden: true }
      : actionId === 'projects.context.update' ? { target: { serverId: 'srv_n2', projectKey: 'project' }, expectedRevision: 2,
        intent: { kind: 'detach', entryId: 'context-entry' } }
      : actionId === 'projects.sources.read' ? { serverId: 'srv_n2', sourceId: 'source' }
      : actionId === 'projects.sources.create' ? { serverId: 'srv_n2', requestKey: 'new-source', name: 'New source', repository }
      : actionId === 'projects.sources.update' ? { serverId: 'srv_n2', sourceId: 'source', expectedRevision: 2, patch: { name: 'Renamed source' } }
      : actionId === 'projects.sources.delete' ? { serverId: 'srv_n2', sourceId: 'source', expectedRevision: 2 }
      : { serverId: 'srv_n2' };
    try {
      const initialRows = JSON.stringify(h.rows); const initialSource = JSON.stringify(h.source());
      const pending = await h.run(input, surface);
      if (approval === 'ask') {
        expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        // These are original signed Account/terminal proposals, not the
        // Agent-Session or unsigned host-CLI proposals replayed by the app.
        expect(requiresExactDaemonApprovalReplay(await h.approval())).toBe(true);
        expect(JSON.stringify(h.rows)).toBe(initialRows);
        expect(JSON.stringify(h.source())).toBe(initialSource);
      }
      const result = approval === 'ask' ? await h.decide('approve') : pending;
      expect(result, JSON.stringify(result)).toMatchObject(approval === 'ask'
        ? { ok: true, result: { status: 'executed', execution: { ok: true } } } : { ok: true });
      const outcome = approval === 'ask' ? (await h.approval()).execution?.result : result.ok ? result.result : null;
      if (actionId === 'projects.list') expect(outcome).toMatchObject({ items: [expect.objectContaining({ rootPath: h.rootPath })] });
      else if (actionId === 'projects.workspace.update') expect(outcome).toMatchObject({ workspaceRef: { id: h.ref.id, label: 'Renamed workspace' } });
      else if (actionId === 'projects.workspace.forget') expect(h.rows.find(row => row.key.kind === 'workspace-ref')?.content).toBeNull();
      else if (actionId === 'projects.visibility.set') expect(outcome).toMatchObject({ row: { hidden: true }, revision: 3 });
      else if (actionId === 'projects.context.update') expect(outcome).toMatchObject({ row: { promptStack: [], hidden: false, pinned: false }, revision: 3 });
      else if (actionId === 'projects.sources.list') expect(outcome).toMatchObject({ sources: [{ id: 'source' }] });
      else if (actionId === 'projects.sources.read') expect(outcome).toMatchObject({ source: { id: 'source', name: 'App' } });
      else if (actionId === 'projects.sources.delete') expect(h.source()).toBeNull();
      else expect(h.source()).toMatchObject({ name: actionId === 'projects.sources.create' ? 'New source' : 'Renamed source' });
      const settledRows = JSON.stringify(h.rows); const settledSource = JSON.stringify(h.source());
      if (approval === 'ask') expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(JSON.stringify(h.rows)).toBe(settledRows); expect(JSON.stringify(h.source())).toBe(settledSource);
      expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
    } finally { await h.close(); }
  });
});
