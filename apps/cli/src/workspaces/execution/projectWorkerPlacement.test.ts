import axios from 'axios';
import nacl from 'tweetnacl';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMachineFinitePolicyV1 } from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import { computeWorkspaceSyncPolicyDigest, ProjectWorkerActionInputSchemasV1, type WorkspaceSyncRelationshipV1, type WorkspaceSyncStatusV1 } from '@happier-dev/protocol';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { deriveWorkspaceSyncRelationshipId, projectWorkspaceSyncAdmissionInputV1 } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import * as machineRpcTransport from '@/session/transport/rpc/machineRpc';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from './projectWorkerAdmission';
import { createProjectWorkerAction } from './projectWorkerAction';

// Home publishes the receiving installation key so original CLI invocation custody can be sealed.
const installationKey = nacl.sign.keyPair();

function accountHttpFixture(url: string | undefined) {
  if (url === 'https://home.invalid/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
  if (url === 'https://home.invalid/v1/account/encryption/currentness') return { status: 200, data: AccountEncryptionCurrentnessResponseSchema.parse({
    mode: 'plain', version: 1, updatedAt: 0, signingKeyFingerprint: null, contentKeyFingerprint: null,
    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
  }) };
  if (url === `https://home.invalid${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`) return { status: 200,
    data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
  return undefined;
}

function publishedMachineFixture(id: string) {
  return MachinePublishedRowV1Schema.parse({ id, kind: 'persistent', installationId: `${id}-installation`, active: true,
    installationPublicKey: Buffer.from(installationKey.publicKey).toString('base64'),
    metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: id, platform: process.platform,
      happyCliVersion: '1.0.0', homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier' })),
    metadataVersion: 1, daemonState: null, daemonStateVersion: 1, storageMode: 'plain',
    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
    access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
}

function controllerStatus(relationship: WorkspaceSyncRelationshipV1): WorkspaceSyncStatusV1 {
  return { relationshipId: relationship.relationshipId, controllerMachineId: relationship.controllerMachineId,
    state: 'watching', alphaPath: '/source', betaPath: '/target', mode: relationship.mode, conflictCount: 0,
    lastCycleObservedAtMs: null, endpointStates: {
      alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } } };
}

afterEach(() => vi.restoreAllMocks());

describe('worker pool placement through the real target admission', () => {
  it.each([
    { name: 'saved exact worker', destination: 'machine', execution: 'portable', expectedMachine: 'target' },
    { name: 'saved automatic pool with a full worker', destination: 'automatic', execution: 'portable', expectedMachine: 'target' },
    { name: 'ask pool without a submitted exact choice', destination: 'ask', execution: 'portable', errorCode: 'choice_required' },
    { name: 'unavailable saved pool with fail policy', destination: 'unavailable-fail', execution: 'portable', errorCode: 'no_available_machine' },
    { name: 'unavailable saved pool needing admitted primary fallback', destination: 'unavailable-primary', execution: 'portable', errorCode: 'choice_required' },
    { name: 'unavailable saved pool needing a fresh choice', destination: 'unavailable-ask', execution: 'portable', errorCode: 'choice_required' },
    { name: 'unobserved pool worker is not confirmed no acceptance', destination: 'unknown-status', execution: 'portable', errorCode: 'choice_required' },
    { name: 'unavailable memory observation is not confirmed no acceptance', destination: 'unknown-memory', execution: 'portable', errorCode: 'choice_required' },
    { name: 'saved exact worker refusing new work needs admitted primary fallback', destination: 'unavailable-machine-primary', execution: 'portable', errorCode: 'choice_required' },
    { name: 'invalid saved policy', destination: 'invalid', execution: 'portable', errorCode: 'preferences_unavailable' },
    { name: 'primary-only declaration despite saved worker policy', destination: 'machine', execution: 'primary', expectedMachine: 'primary' },
    { name: 'frozen Workflow worker ahead of saved primary policy', destination: 'primary', execution: 'portable', expectedMachine: 'target', baseline: 'target' },
    { name: 'unreviewed override of the frozen Workflow worker', destination: 'machine', execution: 'portable', errorCode: 'override_requires_review', baseline: 'frozen' },
  ] as const)('carries $name through the current semantic owners before exact dispatch', async scenario => {
    const rootPath = await mkdtemp(join(tmpdir(), 'worker-dispatch-'));
    // The Home authentication boundary publishes the current Account token
    // provenance/epoch; the real original-Account admission still validates it.
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null,
      credentialProvenance: 'stored_session' as const };
    const serverIdentityId = 'home-identity';
    const installedMachines = ['primary', 'target'].map(publishedMachineFixture);
    const finiteCalls: { machineId: string; input: unknown }[] = [];
    const source = { id: 'primary-copy', serverId: 'home', machineId: 'primary', rootPath: '/source-only', createdAtMs: 1 };
    const target = { ...source, id: 'worker-copy', machineId: 'target', rootPath };
    const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationships = [{ v: 1 as const, relationshipId: 'primary-worker', controllerMachineId: 'primary',
      alphaWorkspaceRefId: source.id, betaWorkspaceRefId: target.id, mode: 'keep_synced' as const,
      provenance: { kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: source.id, targetWorkspaceRefId: target.id },
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      enabled: true, createdAtMs: 1, updatedAtMs: 1 }];
    const bytes = JSON.stringify({ version: 1, workspace: { memoryDemand: { bytes: 1024, basis: { kind: 'declared' } } },
      scripts: { build: { source: { kind: 'command', command: 'build' }, execution: scenario.execution,
        memoryDemand: { bytes: 4096, basis: { kind: 'declared' } } } } });
    const definition = { basis: { kind: 'present', hash: createHash('sha256').update(bytes).digest('hex') },
      document: readProjectManifestDocument(bytes) };
    const unexpectedRequests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input);
      unexpectedRequests.push(`FETCH ${url}`);
      throw new Error(`Unexpected worker-dispatch Fetch: ${url}`);
    });
    expect(definition.document.status).toBe('valid');
    const destination = scenario.destination === 'machine' || scenario.destination === 'unavailable-machine-primary' ? { kind: 'machine', machineId: 'target' }
      : { kind: 'pool', poolId, selection: scenario.destination === 'ask' ? 'ask' : 'automatic' };
    const settings = { enabled: scenario.destination !== 'primary', destination,
      unavailable: scenario.destination === 'unavailable-ask' ? 'ask'
        : scenario.destination === 'unavailable-primary' || scenario.destination === 'unavailable-machine-primary'
          || scenario.destination === 'unknown-status' || scenario.destination === 'unknown-memory' ? 'primary' : 'fail',
      allowAdHoc: true, scriptOverrides: {}, services: {} };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const account = accountHttpFixture(url);
      if (account) return account;
      if (url === 'https://home.invalid/v1/machines') return { status: 200, data: installedMachines };
      const installed = installedMachines.find(machine => url === `https://home.invalid/v1/machines/${machine.id}`);
      if (installed) return { status: 200, data: { machine: publishedMachineFixture(installed.id) } };
      unexpectedRequests.push(`GET ${url}`);
      throw new Error(`Unexpected worker-dispatch GET: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (url === 'https://home.invalid/v1/actions/projects.worker.status') {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
        expect(request.executionAuthorization?.binding).toMatchObject({ actionId: 'projects.worker.status',
          serverIdentityId, machineId: 'target', installationId: 'target-installation',
          requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) });
        statusInputs.push(envelope.input);
        if (scenario.destination === 'unknown-status') throw new Error('Worker status transport unavailable');
        const result = await worker({ actionId: 'projects.worker.status',
          input: ProjectWorkerActionInputSchemasV1['projects.worker.status'].parse(envelope.input),
          context: { surface: 'rpc', serverId: 'home', runtimeAccountId: 'owner', authority: 'account_automation' } });
        return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.worker.status',
          requestId: envelope.requestId, execution: { ok: true, result } }) };
      }
      const authorizedAction = (['projects.worker.status', 'projects.inspect', 'projects.script.run'] as const)
        .find(actionId => url === `https://home.invalid${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`);
      if (authorizedAction) {
        expect(config?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const installed = installedMachines.find(machine => machine.id === request.machineId);
        if (!installed) throw new Error('Unexpected finite admission target');
        const workspaceSync = request.envelope.v === 1
          ? projectWorkspaceSyncAdmissionInputV1(authorizedAction, request.envelope.input) : request.envelope.workspaceSyncAdmission;
        const syncSource = workspaceSync ? installedMachines.find(machine => machine.id === workspaceSync.sourceMachineId) : undefined;
        const sourceAccess = syncSource?.access;
        if (workspaceSync && (!syncSource || !sourceAccess)) throw new Error('Unexpected finite Sync source');
        return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-finite-authorization',
          binding: { accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId,
            machineId: installed.id, custodianAccountId: 'owner', installationId: installed.installationId,
            accountEncryptionMode: 'plain', actionId: authorizedAction, requestId: request.envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target: request.envelope.target,
            ...(workspaceSync && syncSource && sourceAccess ? { workspaceSyncAdmission: {
              relationshipId: workspaceSync.relationshipId ?? deriveWorkspaceSyncRelationshipId(request.envelope.requestId),
              sourceWorkspaceRefId: workspaceSync.sourceWorkspaceRefId,
              source: { actorAccountId: 'owner', custodianAccountId: sourceAccess.custodian.accountId,
                machineId: syncSource.id, installationId: syncSource.installationId,
                role: sourceAccess.role, encryptionMode: sourceAccess.resourceMode },
            } } : {}),
          },
        }) };
      }
      if (url === 'https://home.invalid/v1/actions/projects.inspect') {
        expect(config?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
        expect(request.machineId).toBe('primary');
        expect(envelope.target).toEqual({ kind: 'machine', machineId: 'primary' });
        return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect',
          requestId: envelope.requestId, execution: { ok: true, result: {
            definition, detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
          } } }) };
      }
      if (url === 'https://home.invalid/v1/actions/projects.script.run') {
        expect(config?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
        const installed = installedMachines.find(machine => machine.id === request.machineId);
        if (!installed) throw new Error('Unexpected finite Action target');
        expect(envelope.target).toEqual({ kind: 'machine', machineId: installed.id });
        expect(request.executionAuthorization?.binding).toMatchObject({ serverIdentityId, machineId: installed.id,
          installationId: installed.installationId, requestId: envelope.requestId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target });
        finiteCalls.push({ machineId: installed.id, input: envelope.input });
        // The actual Home Action boundary returns receiving setup consent;
        // admission is not supplied by a direct finite-RPC mock or caller grant.
        return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.script.run',
          requestId: envelope.requestId, execution: { ok: true, result: {
            kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed',
          } } }) };
      }
      if (url !== `https://home.invalid${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
        unexpectedRequests.push(`POST ${url}`);
        throw new Error(`Unexpected worker-dispatch POST: ${url}`);
      }
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [...[source, target].map(value => {
        const key = { kind: 'workspace-ref', serverId: 'home', id: value.id };
        return { key, revision: 0, content: { t: 'plain', v: { key, value } } };
      }), { key: { kind: 'relationship-graph' }, revision: 0,
        content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships } } } }] } };
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      expect(config.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
      const account = accountHttpFixture(config.url);
      if (account) return account;
      if (config.url === 'https://home.invalid/v1/machines/managed/actions/list') {
        // These are persistent Machines, not retained managed allocations.
        return { status: 200, data: { machines: [] } };
      }
      if (config.url === `https://home.invalid${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) {
        expect(config.data).toEqual({ address: { serverId: 'home', refId: source.id } });
        return { status: 200, data: { status: 'present', revision: 3,
          content: scenario.destination === 'invalid' ? { t: 'plain', v: { invalid: true } } : { t: 'plain', v: settings } } };
      }
      if (config.url === 'https://home.invalid/v1/machines/pools/get') return { status: 200, data: {
        pool: { id: poolId, name: { kind: 'available', label: { content: { t: 'plain', v: 'Full worker' }, recipientEnvelope: null } },
          description: null, revision: 0, createdAt: 1, updatedAt: 1,
          members: [{ machineId: 'target', priorityTier: 0, enabled: true,
            state: scenario.destination.startsWith('unavailable-') ? 'offline' : 'connected' }] },
        availability: { state: 'known', connectedCount: scenario.destination.startsWith('unavailable-') ? 0 : 1, enabledCount: 1 },
      } };
      unexpectedRequests.push(`${config.method} ${config.url}`);
      throw new Error(`Unexpected worker-dispatch request: ${config.method} ${config.url}`);
    });
    let accepting = true;
    const admission = createProjectWorkerAdmission({ machineId: 'target', admissionDrain: createDaemonAdmissionDrain(),
      readMemory: () => scenario.destination === 'unknown-memory' ? null : { totalBytes: 1024 * 1024, availableBytes: 512 * 1024 },
      readPolicy: () => getMachineFinitePolicyV1({ read: async () => ({ status: 'ready', metadataVersion: accepting ? 1 : 2,
        metadata: { finitePolicyV1: { accepting, runAtMost: 1 } } }),
        compareAndSwap: async () => ({ status: 'unavailable' }) }),
    });
    const worker = createProjectWorkerAction({ machineId: 'target', serverId: 'home', accountId: 'owner',
      serverHttpBaseUrl: 'https://home.invalid', credentials, admission, isFiniteExecutionLive: () => true });
    const statusInputs: unknown[] = [];
    // Current copy usability is observed at the controller RPC boundary.
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockImplementation(async request => {
      expect(request.machineId).toBe(source.machineId);
      expect(request.method).toBe(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST);
      return { statuses: relationships.map(controllerStatus) };
    });
    vi.spyOn(machineRpcTransport, 'callExactMachineRpc').mockImplementation(async request => {
      if (request.method === 'daemon.projects.inspect.v1') {
        throw new Error('Original Account inspection must enter its Home Action front door');
      }
      if (request.method === 'projects.worker.status') throw new Error('Original Account worker status must enter its Home Action front door');
      if (request.method === 'daemon.projects.script.run.v1') throw new Error('Original Account finite execution must enter its Home Action front door');
      throw new Error(`Unexpected worker-dispatch RPC: ${request.method}`);
    });
    const params = { credentials, token: credentials.token, mode: 'plain' as const, ctx: null, sessionId: 'worker-dispatch',
      serverId: 'home', serverIdentityId, serverHttpBaseUrl: 'https://home.invalid' };
    const executor = createCliActionExecutor({ ...params, pluginActionExecutionOwner: 'current_process',
      accountServerActionDeps: createAccountServerActionDeps(params) });
    const input = { workspace: { serverId: 'home', workspaceId: source.id, machineId: source.machineId, rootPath: source.rootPath },
      selection: { kind: 'named', name: 'build' }, memoryDemand: { bytes: 2048, basis: { kind: 'declared' } },
      ...(scenario.name === 'unreviewed override of the frozen Workflow worker' ? { choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'target' } } } : {}) };
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const held = admission.execute({ operationId: 'occupied', workspaceRefId: target.id, signal: controller.signal,
      accept() {},
      run: async () => { started(); await gate; return { kind: 'process_settled', result: { ok: true, result: null } }; } });
    await running;
    if (scenario.destination === 'unavailable-machine-primary') accepting = false;
    try {
      const result = await executor.execute('projects.script.run', input, {
        surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'projects.script.run' },
        actionRequestId: 'original-finite-request', ...('baseline' in scenario ? { executionRunTargetMachineId: scenario.baseline } : {}),
      });
      expect(unexpectedRequests).toEqual([]);
      if ('errorCode' in scenario) {
        expect(result, JSON.stringify(result, null, 2)).toMatchObject({ ok: false, errorCode: scenario.errorCode });
        expect(finiteCalls).toEqual([]);
        if (scenario.destination.startsWith('unavailable-')) {
          expect(result).toMatchObject({ details: { kind: 'no_worker_can_accept', unavailable: settings.unavailable,
            reason: scenario.destination === 'unavailable-machine-primary' ? 'not_accepting' : 'no_available_machine' } });
        } else if (scenario.destination === 'unknown-status' || scenario.destination === 'unknown-memory' || scenario.destination === 'ask') {
          expect(result).not.toHaveProperty('details.kind', 'no_worker_can_accept');
        }
      } else {
        expect(result, JSON.stringify(result, null, 2)).toMatchObject({ ok: true, result: { kind: 'pendingApproval' } });
        // Address resolution does not become caller-authored invocation intent:
        // the receiver rechecks the original default/pool and exact admitted member.
        expect(finiteCalls).toEqual([{ machineId: scenario.expectedMachine, input }]);
      }
      if (scenario.destination === 'automatic') expect(statusInputs).toEqual([{
        workspace: { serverId: 'home', refId: source.id }, destination: { kind: 'machine', machineId: 'target' },
        purpose: 'finite', memoryDemand: { bytes: 4096, basis: { kind: 'declared' } },
      }]);
      else if (scenario.destination === 'ask' || scenario.destination === 'invalid') expect(statusInputs).toEqual([]);
      expect(admission.dependencies()).toMatchObject([{ operationId: 'occupied', state: 'reserved' }]);
    } finally {
      release(); await held; await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('selects a full worker and accepts its next job without launching it during status', async () => {
    const boundaryErrors: string[] = [];
    let workerStatusObservation: unknown;
    const rootPath = await mkdtemp(join(tmpdir(), 'worker-placement-'));
    // A boundary fixture token whose current owner is decoded by the real CLI host.
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null,
      credentialProvenance: 'stored_session' as const };
    const ref = { id: 'worker-copy', serverId: 'home', machineId: 'target', rootPath, createdAtMs: 1 };
    const key = { kind: 'workspace-ref', serverId: 'home', id: ref.id };
    // The requested primary root does not exist on this worker. Its current
    // Sync route, not path coincidence or a consumer-made target ref, grants the copy basis.
    const source = { ...ref, id: 'primary-copy', machineId: 'primary', rootPath: join(rootPath, 'not-local-primary') };
    const sourceKey = { kind: 'workspace-ref', serverId: 'home', id: source.id };
    const graphKey = { kind: 'relationship-graph' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'primary-worker', controllerMachineId: source.machineId,
      alphaWorkspaceRefId: source.id, betaWorkspaceRefId: ref.id, mode: 'keep_synced' as const,
      provenance: { kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: source.id, targetWorkspaceRefId: ref.id },
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      enabled: true, createdAtMs: 1, updatedAtMs: 1 };
    let relationships = [relationship];
    // Only Home HTTP and the Machine metadata carrier are substituted; the
    // Action, row opener, filesystem, queue, policy and selector remain real.
    const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
    const serverIdentityId = 'home-identity';
    const poolView = {
      pool: { id: poolId, name: { kind: 'available', label: { content: { t: 'plain', v: 'Full worker' }, recipientEnvelope: null } },
        description: null, revision: 0, createdAt: 1, updatedAt: 1,
        members: [{ machineId: 'target', priorityTier: 0, enabled: true, state: 'connected' }] },
      availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
    };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const account = accountHttpFixture(url);
      if (account) return account;
      if (url === 'https://home.invalid/v1/machines') return { status: 200, data: ['primary', 'target'].map(publishedMachineFixture) };
      const machineId = ['primary', 'target'].find(id => url === `https://home.invalid/v1/machines/${id}`);
      if (machineId) return { status: 200, data: { machine: publishedMachineFixture(machineId) } };
      boundaryErrors.push(`GET ${url}`);
      throw new Error(`Unexpected worker-placement GET: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url === `https://home.invalid${bindExternalActionExecutionAuthorizationHttpPathV1('projects.worker.status')}`) {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-status-authorization',
          binding: { accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId,
            machineId: 'target', custodianAccountId: 'owner', installationId: 'target-installation',
            accountEncryptionMode: 'plain', actionId: 'projects.worker.status', requestId: request.envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target: request.envelope.target } }) };
      }
      if (url === 'https://home.invalid/v1/actions/projects.worker.status') {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
        expect(request.executionAuthorization?.binding).toMatchObject({ actionId: 'projects.worker.status',
          serverIdentityId, machineId: 'target', installationId: 'target-installation',
          requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) });
        const result = await worker({ actionId: 'projects.worker.status',
          input: ProjectWorkerActionInputSchemasV1['projects.worker.status'].parse(envelope.input),
          context: { surface: 'rpc', serverId: 'home', runtimeAccountId: 'owner', authority: 'account_automation' } });
        workerStatusObservation = result;
        return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.worker.status',
          requestId: envelope.requestId, execution: { ok: true, result } }) };
      }
      if (url === `https://home.invalid${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return { status: 200, data: { status: 'listed', coverage: 'complete',
        rows: [{ key, revision: 0, content: { t: 'plain', v: { key, value: ref } } },
          { key: sourceKey, revision: 0, content: { t: 'plain', v: { key: sourceKey, value: source } } },
          { key: graphKey, revision: 0, content: { t: 'plain', v: { key: graphKey, value: { relationships } } } }] } };
      boundaryErrors.push(`POST ${url}`);
      throw new Error(`Unexpected worker-placement POST: ${url}`);
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      const account = accountHttpFixture(config.url);
      if (account) return account;
      if (config.method === 'POST' && config.url === 'https://home.invalid/v1/machines/pools/get') {
        expect(config.data).toEqual({ poolId });
        expect(config.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
        return { status: 200, data: poolView };
      }
      boundaryErrors.push(`${config.method} ${config.url}`);
      throw new Error(`Unexpected worker-placement request: ${config.method} ${config.url}`);
    });
    const admission = createProjectWorkerAdmission({ machineId: 'target', admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: () => getMachineFinitePolicyV1({ read: async () => ({ status: 'ready', metadataVersion: 1,
        metadata: { finitePolicyV1: { accepting: true, runAtMost: 1 } } }),
        compareAndSwap: async () => ({ status: 'unavailable' }) }),
    });
    const worker = createProjectWorkerAction({ machineId: 'target', serverId: 'home', accountId: 'owner',
      serverHttpBaseUrl: 'https://home.invalid', credentials, admission, isFiniteExecutionLive: () => true });
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockImplementation(async request => {
      expect(request.machineId).toBe(source.machineId);
      expect(request.method).toBe(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST);
      return { statuses: relationships.map(controllerStatus) };
    });
    // Only the addressed Machine network is replaced. It invokes the real
    // receiving producer; the requester CLI Account/Action/RPC adapters stay real.
    vi.spyOn(machineRpcTransport, 'callExactMachineRpc').mockImplementation(async request => {
      if (request.machineId !== 'target' || request.method !== 'projects.worker.status') {
        boundaryErrors.push(`RPC ${request.machineId} ${request.method}`);
      }
      expect(request.machineId).toBe('target');
      expect(request.method).toBe('projects.worker.status');
      const result = await worker({ actionId: 'projects.worker.status', input: ProjectWorkerActionInputSchemasV1['projects.worker.status'].parse(request.request), signal: request.signal,
        context: { surface: 'rpc', serverId: 'home', runtimeAccountId: 'owner', authority: 'account_automation' } });
      workerStatusObservation = result;
      return result;
    });
    const params = { credentials, token: credentials.token, mode: 'plain' as const, ctx: null, sessionId: 'worker-placement',
      serverId: 'home', serverIdentityId, serverHttpBaseUrl: 'https://home.invalid' };
    const executor = createCliActionExecutor({ ...params, pluginActionExecutionOwner: 'current_process',
      accountServerActionDeps: createAccountServerActionDeps(params) });
    const context = { surface: 'cli' as const, serverId: 'home', authority: 'account_automation' as const };
    const firstController = new AbortController();
    const nextController = new AbortController();
    let finishFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { finishFirst = resolve; });
    let firstAccepted!: () => void;
    const accepted = new Promise<void>(resolve => { firstAccepted = resolve; });
    let starts = 0;
    const first = admission.execute({ operationId: 'first', workspaceRefId: ref.id, signal: firstController.signal,
      accept: () => firstAccepted(), run: async () => {
        starts++; await firstGate; return { kind: 'process_settled', result: { ok: true, result: null } };
      } });
    await accepted;
    await admission.notifyChanged();
    let next: ReturnType<typeof admission.execute> | undefined;
    try {
      expect(starts).toBe(1);
      const status = await executor.execute('projects.worker.status', {
        workspace: { serverId: 'home', refId: source.id }, destination: { kind: 'machine', machineId: 'target' }, purpose: 'finite',
      }, context);
      expect(status, JSON.stringify(status)).toMatchObject({ ok: true, result: { eligible: true } });
      const selected = await executor.execute('machines.pools.resolve', {
        poolId, requestKey: 'run-next', purpose: 'finite', workspace: { serverId: 'home', refId: source.id },
      }, context);
      expect(boundaryErrors).toEqual([]);
      expect(selected.ok, JSON.stringify(selected, null, 2)).toBe(true);
      expect(selected, JSON.stringify({ selected, workerStatusObservation,
        rpc: vi.mocked(machineRpcTransport.callExactMachineRpc).mock.calls.map(([request]) => ({
          machineId: request.machineId, method: request.method, input: request.request,
        })) })).toMatchObject({
        ok: true, result: { kind: 'resolved', poolId, machineId: 'target', priorityTier: 0 },
      });
      expect(starts).toBe(1);
      let nextAccepted!: () => void;
      const queued = new Promise<void>(resolve => { nextAccepted = resolve; });
      next = admission.execute({ operationId: 'next', workspaceRefId: ref.id, signal: nextController.signal,
        accept: () => nextAccepted(), run: async () => {
          starts++; return { kind: 'no_launch', result: { ok: true, result: null } };
        } });
      await queued;
      await admission.notifyChanged();
      expect(starts).toBe(1);
      expect(admission.dependencies()).toMatchObject([
        { operationId: 'first', state: 'reserved' }, { operationId: 'next', state: 'queued' },
      ]);
      relationships = [];
      const withdrawn = await executor.execute('machines.pools.resolve', {
        poolId, requestKey: 'run-after-route-withdrawal', purpose: 'finite', workspace: { serverId: 'home', refId: source.id },
      }, context);
      expect(withdrawn.ok, JSON.stringify(withdrawn, null, 2)).toBe(true);
      expect(withdrawn).toMatchObject({
        ok: true, result: { kind: 'unavailable', poolId, reason: 'no_available_machine' },
      });
      expect(starts).toBe(1);
    } finally {
      nextController.abort();
      finishFirst();
      await first;
      await next;
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
