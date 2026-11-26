import axios from 'axios';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { buildSessionProjectFilesSourceOpenInputV1, SESSION_PROJECT_FILES_OPEN_CHILDREN_V1 } from '@happier-dev/protocol/sessions/creation/sessionProjectFilesOpenV1';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import { authorizeMachineRpcRequest, type MachineRpcAdmissionBoundary } from '@/api/machine/machineRpcAuthorization';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { encodeBase64 } from '@/api/encryption';
import * as installationStore from '@/daemon/identity/store';
import { encodeStoredCredentials } from '@/persistence';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';

const { openProject } = await import('./openProject');

const temporaryRoots: string[] = [];

async function mockBoatHomeHttp(rows: ProjectAccountRowV1[], boatInstallationId: string) {
  const projectRowsHttp = createProjectAccountRowsHttpBoundary(rows);
  vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'person' } };
    if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (url.includes('/v1/machines/')) {
      const id = url.slice(url.lastIndexOf('/') + 1);
      return {
        status: 200,
        data: {
          machine: {
            id,
            active: true,
            installationId: id === 'boat' ? boatInstallationId : 'other-installation',
            metadataVersion: 1,
            daemonStateVersion: 0,
            daemonState: null,
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            metadata: encodePlainMachineStoredContent({
              host: id,
              platform: 'linux',
              homeDir: '/home/user',
              happyCliVersion: 'test',
              happyHomeDir: '/home/user/.happier',
            }),
          },
        },
      };
    }
    return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url: string, body?: unknown) => {
    if (url.includes('/v1/account/project-rows/')) return await projectRowsHttp(url, body);
    if (url.endsWith('/v1/account/project-trust/list') || url.endsWith('/v1/account/project-trust/read')) {
      return { status: 200, data: { rows: [], records: [] } };
    }
    if (url.endsWith('/v1/projects/execution/config/read')) {
      return { status: 200, data: { config: null } };
    }
    return { status: 200, data: { ok: true } };
  });
}

describe('openProject as a forwarded session_project_files_source child on Boat', () => {
  beforeEach(async () => {
    await seedTestServerProfile({
      id: 'srv_home',
      homeId: 'srv_home',
      serverUrl: 'https://home.invalid',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  async function buildBoatFixture(options?: Readonly<{
    boatCustodianAccountId?: string;
    boatRole?: 'manage' | 'use';
    tamperFolder?: boolean;
  }>) {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'happier-boat-source-attach-')));
    temporaryRoots.push(folder);
    await writeFile(join(folder, 'README.md'), 'boat source folder\n');

    const homeId = 'srv_home';
    const boatCustodian = options?.boatCustodianAccountId ?? 'person';
    const boatRole = options?.boatRole ?? 'manage';
    const controllerTarget = { kind: 'machine' as const, machineId: 'controller' };
    const spawnInput = SessionSpawnNewInputV2Schema.parse({
      executionTarget: { serverId: homeId, machineId: 'controller' },
      directory: { kind: 'path', path: folder },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      sessionPlacement: {
        kind: 'machine',
        target: { serverId: homeId, machineId: 'controller' },
        projectFilesSource: { target: { serverId: homeId, machineId: 'boat' }, directory: folder },
        projectFiles: { kind: 'copy_once' },
      },
    });
    const sourceOpenInput = buildSessionProjectFilesSourceOpenInputV1(spawnInput.sessionPlacement!)!;
    const params = options?.tamperFolder
      ? { ...sourceOpenInput, source: { kind: 'folder' as const, path: join(folder, 'tampered') } }
      : sourceOpenInput;
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({
      v: 1, requestId: 'spawn-request', target: controllerTarget, input: spawnInput,
    });
    const controllerKey = tweetnacl.sign.keyPair();
    const boatKey = tweetnacl.sign.keyPair();
    const boatInstallationId = 'boat-installation';
    const reviewedChild = {
      actionId: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.action,
      role: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.role,
      inputDigest: computeActionInputApprovalDigestV1('projects.open', sourceOpenInput),
    };
    const credentials = {
      token: `header.${Buffer.from(JSON.stringify({ sub: 'person' })).toString('base64url')}.signature`,
      encryption: null,
    };
    const authorizationBase = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1, token: 'home-root', binding: {
        accountId: 'person', custodianAccountId: 'person',
        authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', serverIdentityId: homeId,
        machineId: 'controller', installationId: 'controller-installation',
        actionId: 'session.spawn_new', requestId: 'spawn-request',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        target: controllerTarget,
      },
    });
    const authorization = sealExternalActionRequesterAccountContextV1({
      authorization: authorizationBase,
      purpose: {
        kind: 'machine_rpc',
        method: RPC_METHODS.PROJECTS_OPEN,
        params: sourceOpenInput,
        recipient: { machineId: 'boat', installationId: boatInstallationId },
        reviewedChild,
      },
      credentials: encodeStoredCredentials(credentials),
      installationPublicKey: boatKey.publicKey,
      randomBytes: tweetnacl.randomBytes,
    });
    const requesterAccountContext = authorization.requesterAccountContext;
    const method = `boat:${RPC_METHODS.PROJECTS_OPEN}`;
    const requestId = 'req-boat-open';
    const execution = {
      method,
      requestId,
      params,
      originalActionEnvelope: envelope,
      externalActionExecution: {
        v: 1 as const,
        authorization,
        effectActionId: 'projects.open',
        target: controllerTarget,
        installationId: 'controller-installation',
        reviewedChild,
        machineSignature: signExternalActionMachineRpcRequestV1({
          authorizationToken: authorization.token,
          effectActionId: 'projects.open',
          target: controllerTarget,
          installationId: 'controller-installation',
          method,
          requestId,
          params,
          reviewedChild,
          requesterAccountContext,
          privateKey: controllerKey.secretKey,
        }),
      },
    };
    const rows: ProjectAccountRowV1[] = [];
    const currentness = await createRequesterCurrentnessSocketHarness();
    onTestFinished(async () => { await currentness.close(); });
    await mockBoatHomeHttp(rows, boatInstallationId);
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
      version: 1,
      installationId: boatInstallationId,
      createdAt: 1,
      publicKey: encodeBase64(boatKey.publicKey, 'base64url'),
      privateKey: encodeBase64(boatKey.secretKey, 'base64url'),
    });

    let capturedProjection: NonNullable<typeof authorization.requesterHttpProjection> | undefined;
    let liveBoatHeaders: Record<string, string> | null | undefined;
    let liveOtherHeaders: Record<string, string> | null | undefined;
    const boundary: MachineRpcAdmissionBoundary = {
      machineId: 'boat',
      resolveInstallationId: () => boatInstallationId,
      resolveCustodianAccountId: async () => boatCustodian,
      resolveHomeServerIdentityId: async () => homeId,
      verifyMachineAdmission: async () => true,
    };
    const rpc = new RpcHandlerManager({
      scopePrefix: 'boat',
      localMachineId: 'boat',
      encryptionMode: 'plain',
      logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, boundary),
      prepareRequesterAccountContext: async req => await prepareRequesterAccountActionContext({
        ...req,
        machineId: 'boat',
        installationId: boatInstallationId,
        installationPrivateKey: boatKey.secretKey,
        serverId: homeId,
        serverIdentityId: homeId,
        serverHttpBaseUrl: 'https://home.invalid',
        isCurrent: async () => true,
        createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'forbidden', error: 'forbidden' }) }),
      }),
    });
    let handlerCalls = 0;
    rpc.registerHandler(RPC_METHODS.PROJECTS_OPEN, async (rawParams, context) => {
      handlerCalls++;
      capturedProjection = context.callerInputAuthorization?.requesterHttpProjection;
      liveBoatHeaders = await capturedProjection?.createRequestHeaders({
        method: 'GET', path: '/v1/machines/boat', effectActionId: 'projects.open',
      });
      liveOtherHeaders = await capturedProjection?.createRequestHeaders({
        method: 'GET', path: '/v1/machines/other', effectActionId: 'projects.open',
      });
      return await openProject(
        rawParams as typeof sourceOpenInput,
        {
          serverId: homeId,
          serverHttpBaseUrl: 'https://home.invalid',
          machineId: 'boat',
          accountId: boatCustodian,
          readCredentials: async () => null,
        },
        context,
      );
    });
    const response = await rpc.handleRequest({
      method,
      requestId,
      params,
      machineAdmission: {
        actorAccountId: 'person',
        custodianAccountId: boatCustodian,
        machineId: 'boat',
        installationId: boatInstallationId,
        role: boatRole,
        encryptionMode: 'plain',
      },
      callerAuthority: 'present_user',
      callerInputAuthorization: authorization,
      originalActionEnvelope: envelope,
      workspaceSyncSourceExecution: execution,
    });
    return { folder, response, handlerCalls, capturedProjection, liveBoatHeaders, liveOtherHeaders };
  }

  it('opens an ordinary Boat source folder through RpcHandlerManager and pins /v1/machines/<boat> read custody', async () => {
    const { folder, response, handlerCalls, capturedProjection, liveBoatHeaders, liveOtherHeaders } = await buildBoatFixture();
    expect(handlerCalls, JSON.stringify(response)).toBe(1);
    expect(response, JSON.stringify(response)).toMatchObject({
      kind: 'opened',
      directory: folder,
      workspace: {
        serverId: 'srv_home',
        machineId: 'boat',
        rootPath: folder,
      },
    });
    expect(capturedProjection).toBeDefined();
    expect(liveBoatHeaders).toEqual({ Authorization: expect.stringMatching(/^Bearer /) });
    expect(liveOtherHeaders).toBeNull();
    // Custody is disposed immediately once the RPC handler settles.
    expect(await capturedProjection!.createRequestHeaders({
      method: 'GET', path: '/v1/machines/boat', effectActionId: 'projects.open',
    })).toBeNull();
  });

  it('preserves Boat isolation when Boat belongs to another custodian and requester only holds Use', async () => {
    const { response, handlerCalls } = await buildBoatFixture({
      boatCustodianAccountId: 'boat-owner',
      boatRole: 'use',
    });
    expect(handlerCalls, JSON.stringify(response)).toBe(1);
    expect(response, JSON.stringify(response)).toMatchObject({
      kind: 'refused',
      code: 'workspace_private_checkout_required',
    });
  });

  it('refuses a tampered folder operand at Boat RPC admission before running openProject', async () => {
    const { response, handlerCalls } = await buildBoatFixture({ tamperFolder: true });
    expect(handlerCalls).toBe(0);
    expect(response, JSON.stringify(response)).toMatchObject({
      errorCode: 'RPC_FORBIDDEN',
    });
  });
});
