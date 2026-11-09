import axios from 'axios';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { type ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { resolveApprovalExecutor } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import type { SessionCreationTargetPreparationRequestV1, SessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';

// HTTP, device credential storage and Socket.IO are the only substituted boundaries.
vi.mock('socket.io-client', async importOriginal => (await import(
  '@/dev/testkit/harness/serverAccountConnectionHarness'
)).createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let preparedDirectory: Extract<SessionCreationTargetPreparationResultV1, { ok: true }>;
const socketUpdates = new Set<(update: unknown) => void>();
installDisconnectedServerSocketBoundary(socket => {
  socketUpdates.add(update => { for (const listener of socket.listeners('update')) listener(update); });
  configureConnectedServerSocketBoundary(socket);
  vi.spyOn(socket, 'timeout').mockReturnValue(socket);
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
    if (event === SOCKET_RPC_EVENTS.CALL) {
      if (!payload.method.endsWith(`:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`)) throw new Error('Unexpected machine RPC');
      return { ok: true, result: preparedDirectory };
    }
    return { ok: true };
  });
});
// Load the UI graph before the timed case, as in its owning approval suite.
await import('@/sync/syncEngine');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
// Keep CLI owners in their own compiler program, as the shared Home harness does.
const currentnessSource = '../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
const { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } = await vi.importActual<{
  createDaemonApprovalExecutionOriginCurrentnessFromCredentials(input: Readonly<{
    credentials: { token: string; encryption: null }; serverId: string; serverApiUrl: string; machineId: string;
    resolveCurrentMachineExecutionOriginContext(): Promise<{ serverIdentityId: string; machineId: string }>;
  }>): ActionExecutorDeps['isApprovalExecutionOriginCurrent'];
}>(currentnessSource);
const preparationSource = '../../../../../cli/src/session/creation/prepareSessionCreationTarget';
const { prepareSessionCreationTarget } = await vi.importActual<{
  prepareSessionCreationTarget(input: { request: SessionCreationTargetPreparationRequestV1; signal?: AbortSignal }): Promise<SessionCreationTargetPreparationResultV1>;
}>(preparationSource);
const cliDepsSource = '../../../../../cli/src/session/actions/createCliActionDeps';
const { createCliActionDeps } = await vi.importActual<{
  createCliActionDeps(input: {
    token: string; credentials: { token: string; encryption: null }; sessionId: string; mode: 'plain'; ctx: null;
    serverId: string; serverHttpBaseUrl: string;
    sessionSpawnDirectTargetTransport: {
      machineId: string;
      prepare(request: SessionCreationTargetPreparationRequestV1, options?: { signal?: AbortSignal }): Promise<SessionCreationTargetPreparationResultV1>;
      spawnedSession: { spawn(): Promise<never>; resolveSpawnSessionByNonce(): Promise<never> };
    };
  }): Pick<ActionExecutorDeps, 'sessionSpawnNewDirectoryApprovalPreflight'>;
}>(cliDepsSource);
const installationSource = '../../../../../cli/src/daemon/identity/store';
const installationStore = await vi.importActual<{ readInstallationIdentityIfExistsSync(): unknown }>(installationSource);

afterEach(() => { vi.restoreAllMocks(); });

it.each(['available', 'rate_limited', 'account_changed', 'home_changed', 'machine_changed', 'revoked', 'missing_directory', 'settings_advanced'] as const)(
  'rechecks unsigned UI spawn approval currentness (%s)', async scenario => {
  socketUpdates.clear();
  const webLocks = installWebLockManagerMock();
  const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
  setRuntimeFetch(homes.request);
  const { getStorage } = await import('@/sync/domains/state/storage');
  const initialState = getStorage().getState();
  const homeId = await homes.addHome({ name: 'Approval', serverUrl: 'https://ui-spawn.test',
    serverIdentityId: 'srv_spawn', accountId: 'spawn-account', currentAccount: true });
  const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'srv_spawn' } } });
  homes.answer(homeId, '/v1/features', { body: features });
  homes.answer(homeId, '/v1/features/authenticated', { body: features });
  const credential = homes.findByServerUrl('https://ui-spawn.test')?.token;
  if (!credential) throw new Error('Fixture credential missing');
  const connection = await restoreServerAccountForTest({ serverUrl: 'https://ui-spawn.test',
    serverIdentityId: 'srv_spawn', accountId: 'spawn-account', request: homes.request, credentials: { token: credential } });
  const { captureLazyActionAccountContext } = await import('./actionAccountContext');
  const { writeApprovalRequestArtifact } = await import('./approvalArtifactWriter');
  const account = await captureLazyActionAccountContext(homeId);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'approvalstale-c2-'));
  try {
    // Installation key storage is a real OS boundary; no machine secrets are read.
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(null);
    getStorage().getState().applySettingsForScope({ serverId: connection.serverId, accountId: 'spawn-account' },
      getStorage().getState().settings, 0);
    await homes.requireUiApproval(homeId, 'session.spawn_new');
    let currentHome = 'srv_spawn';
    let currentMachine = 'spawn-machine';
    // Both clients hold the same valid Account credential. Token management
    // eligibility is independent of that Account's authenticated profile.
    const { AccountProfileSchema } = await import('@happier-dev/protocol/account/profile');
    let accountId = 'spawn-account';
    let revoked = false;
    let settingsVersion = 1;
    const profileRead = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: settingsVersion, settingsVersion, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
      } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: {
        content: { t: 'plain', v: {} }, version: settingsVersion,
      } };
      if (!String(url).endsWith('/v1/account/profile')) throw new Error('Unexpected Account proof endpoint');
      return revoked ? { status: 401, data: { error: 'invalid_token' } }
        : { status: 200, data: AccountProfileSchema.parse({ id: accountId }) };
    });
    const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
      credentials: { token: credential, encryption: null }, serverId: 'daemon-profile', serverApiUrl: 'https://ui-spawn.test',
      machineId: 'spawn-machine', resolveCurrentMachineExecutionOriginContext: async () => ({
        serverIdentityId: currentHome, machineId: currentMachine,
      }),
    });
    if (!currentness) throw new Error('Currentness owner missing');
    const path = scenario === 'missing_directory' ? join(temporaryRoot, 'new-directory') : temporaryRoot;
    const targetPreparation = await prepareSessionCreationTarget({ request: { directory: { kind: 'path', path } } });
    if (!targetPreparation.ok) throw new Error('Target preparation failed');
    preparedDirectory = targetPreparation;
    const tokenManagement = vi.spyOn(axios, 'request').mockResolvedValue(scenario === 'available'
      ? { status: 200, data: { tokens: [] } }
      : { status: 429, data: { error: 'rate_limit_exceeded' } });
    const spawned: unknown[] = [];
    const cli = createCliActionDeps({ token: credential, credentials: { token: credential, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'daemon-profile', serverHttpBaseUrl: 'https://ui-spawn.test',
      sessionSpawnDirectTargetTransport: {
        machineId: 'spawn-machine', prepare: (request, options) => prepareSessionCreationTarget({ request, ...options }),
        spawnedSession: {
          spawn: async () => { throw new Error('Unexpected native spawn during read-only preparation'); },
          resolveSpawnSessionByNonce: async () => { throw new Error('Unexpected native Session lookup during preparation'); },
        },
      },
    });
    const read = (artifactId: string) => account.fetchArtifact(artifactId);
    const daemon = createActionExecutor(createActionExecutorBoundaryFixture({
      approvalsGet: async ({ artifactId }) => {
        const artifact = await read(artifactId);
        if (!artifact?.header || typeof artifact.body !== 'string') return null;
        const matched = approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body);
        return matched?.family === 'built_in' ? matched.request : null;
      },
      approvalsUpdate: async ({ artifactId, request }) => {
        const result = await writeApprovalRequestArtifact({ artifactId, request, read,
          write: (basis, header, body) => account.updateArtifact(artifactId, header, body, basis) });
        if (result.ok && scenario === 'settings_advanced') {
          settingsVersion++;
          // Reproduce Account/Settings publication during the approval write,
          // through the external Socket boundary and real currentness owners.
          const update = UpdateContainerSchema.parse({ id: `approval-write-${settingsVersion}`, seq: settingsVersion, createdAt: settingsVersion,
            body: { t: 'update-account', id: 'spawn-account', settingsV2: { content: { t: 'plain', v: {} }, version: settingsVersion },
              encryptionCurrentness: { mode: 'plain', version: settingsVersion, settingsVersion, updatedAt: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null } } });
          for (const deliver of socketUpdates) deliver(update);
        }
        return result;
      },
      isApprovalExecutionOriginCurrent: currentness,
      sessionSpawnNewDirectoryApprovalPreflight: cli.sessionSpawnNewDirectoryApprovalPreflight,
      sessionSpawnNew: async args => {
        spawned.push(args);
        return SessionSpawnNewResultV1Schema.parse({ type: 'success', disposition: 'created',
          sessionId: 'c111111111111111111111111', executionTarget: args.executionTarget,
          organizationPlacement: args.organizationPlacement, initialInput: { status: 'accepted', localId: 'fixture-initial' } });
      },
    }));
    homes.answer(homeId, '/v1/actions/approval.request.decide', { select: async body => {
      const { ExternalActionRequestEnvelopeV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
      const carried = ExternalActionRequestEnvelopeV1Schema.parse(body);
      const execution = await daemon.execute('approval.request.decide', carried.input, {
        surface: 'ui', authority: 'present_user', serverId: 'daemon-profile', serverIdentityId: 'srv_spawn',
        runtimeAccountId: 'spawn-account',
      });
      return { body: { v: 1, actionId: 'approval.request.decide', requestId: carried.requestId, execution } };
    } });
    const { createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const machine = createPlainMachineRowFixture({ id: 'spawn-machine', accountId: 'spawn-account' });
    homes.answer(homeId, '/v1/machines', { body: [machine] });
    homes.answer(homeId, '/v1/machines/spawn-machine', { body: { machine } });
    const app = createDefaultActionExecutor();
    const input = getActionSpec('session.spawn_new').inputSchema.parse({ creationKey: 'approval-stale-fixture',
      executionTarget: { serverId: homeId, machineId: 'spawn-machine' }, directory: { kind: 'path', path },
      organizationPlacement: { sectionId: 'section-1', tagIds: [] },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      initialInput: { text: 'Fixture' },
    });
    const proposed = await app.execute('session.spawn_new', input, { surface: 'ui', authority: 'present_user', serverId: homeId });
    expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: expect.any(String) } });
    if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object' || !('artifactId' in proposed.result)
      || typeof proposed.result.artifactId !== 'string') throw new Error('Expected approval');
    const artifactId = proposed.result.artifactId;
    const stored = () => ApprovalRequestV2Schema.parse(JSON.parse(homes.artifacts(homeId).readPlainBody(artifactId) ?? 'null'));
    expect(stored()).toMatchObject({ status: 'open', executionOriginV1: { surface: 'ui', authority: 'present_user',
      caller: { kind: 'host' }, accountId: 'spawn-account', machineId: 'spawn-machine' } });
    expect(resolveApprovalExecutor(stored())).toEqual({ kind: 'daemon', machineId: 'spawn-machine' });
    if (scenario === 'missing_directory') expect(stored().sessionCreationDirectoryApproval).toEqual({
      v: 1, executionTarget: input.executionTarget, directory: targetPreparation.directory,
    });
    expect(spawned).toEqual([]);
    if (scenario === 'home_changed') currentHome = 'other-home';
    if (scenario === 'machine_changed') currentMachine = 'other-machine';
    if (scenario === 'account_changed') accountId = 'other-account';
    if (scenario === 'revoked') revoked = true;
    const approved = await app.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', serverId: homeId,
    });
    expect(tokenManagement).not.toHaveBeenCalled();
    if (scenario !== 'available' && scenario !== 'rate_limited' && scenario !== 'missing_directory' && scenario !== 'settings_advanced') {
      expect(stored()).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
      expect(stored().execution).toBeUndefined();
      expect(approved).toMatchObject({ ok: false, errorCode: 'approval_stale', effectAttempted: false });
      expect(spawned).toEqual([]);
      return;
    }
    expect(profileRead).toHaveBeenCalled();
    expect(stored(), JSON.stringify({ errorCode: stored().execution?.errorCode, spawned: spawned.length }))
      .toMatchObject({ status: 'executed', execution: { ok: true } });
    expect(approved).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(spawned).toHaveLength(1);
    await app.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', serverId: homeId,
    });
    expect(spawned).toHaveLength(1);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    account.dispose();
    await connection.dispose();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    await homes.reset(); resetRuntimeFetch(); getStorage().setState(initialState, true); webLocks.restore();
  }
});
