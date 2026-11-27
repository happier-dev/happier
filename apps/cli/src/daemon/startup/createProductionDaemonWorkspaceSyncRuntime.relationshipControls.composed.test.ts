import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { decodeBase64, FeaturesResponseSchema } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import {
  openExternalActionRequesterAccountContextV1,
  openManagedControllerActionCodecV1,
} from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import {
  WorkspaceSyncRelationshipCreateResultV1Schema,
  WorkspaceSyncRelationshipDisableActionOutputV1Schema,
  WorkspaceSyncRelationshipEnableActionOutputV1Schema,
  WorkspaceSyncRelationshipFlushActionOutputV1Schema,
  WorkspaceSyncRelationshipTerminateActionOutputV1Schema,
} from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { workspaceCheckoutNativeBoundary as native } from '@/workspaces/activation/workspaceCheckoutNative.testkit';
import { createRequesterWorkspaceSyncFixture } from './createRequesterWorkspaceSyncFixture.testkit';

const socketIo = vi.hoisted(() => vi.fn());
const executionBoundary = vi.hoisted(() => ({ member: false }));
vi.mock('socket.io-client', () => ({ io: socketIo }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const { requesterWorkspaceSyncInstallationFilesystemBoundary } = await import('./requesterWorkspaceSyncFilesystem.testkit');
  return requesterWorkspaceSyncInstallationFilesystemBoundary(actual);
});
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  const { workspaceCheckoutFilesystemBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
  return workspaceCheckoutFilesystemBoundary(actual);
});
vi.mock('../../../../../packages/cli-common/src/process/execFileWithDeadline', async original => {
  const actual = await original<typeof import('../../../../../packages/cli-common/src/process/execFileWithDeadline')>();
  const { requesterWorkspaceSyncExecBoundary } = await import('./requesterWorkspaceSyncProcess.testkit');
  return {
    ...actual,
    execFileWithDeadline: (...args: Parameters<typeof actual.execFileWithDeadline>) =>
      requesterWorkspaceSyncExecBoundary(actual, args),
  };
});
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { spawnRequesterWorkspaceSyncProcessBoundary } = await import('./requesterWorkspaceSyncProcess.testkit');
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) =>
      spawnRequesterWorkspaceSyncProcessBoundary(actual, command, args, options, executionBoundary.member),
  };
});

beforeEach(() => {
  native.reset();
  vi.restoreAllMocks();
  executionBoundary.member = false;
});

function readApprovalRequestFromArtifact(artifact: Record<string, unknown> | undefined) {
  expect(artifact).toBeDefined();
  const decoded = decodePlainArtifactStoredContent(String(artifact?.body ?? ''));
  expect(decoded).not.toBeNull();
  const payload = decoded && typeof decoded === 'object' && 'body' in decoded && typeof decoded.body === 'string'
    ? JSON.parse(decoded.body)
    : decoded;
  return ApprovalRequestV2Schema.parse(payload);
}

async function signInCustodianWithDefaultSettings(
  setup: Awaited<ReturnType<typeof createRequesterWorkspaceSyncFixture>>,
) {
  // Sign in the foreign controller daemon as its own custodian with a terminal-provenance
  // stored session token and default empty settings (ZERO approvalWaivedSurfaces).
  const token = `e30.eyJzdWIiOiJyZXF1ZXN0ZXIiLCJ0b2tlbkVwb2NoIjowLCJwcm92ZW5hbmNlIjp7InYiOjEsImtpbmQiOiJ0ZXJtaW5hbCIsImF1dGhvcml0eSI6ImFjY291bnRfYXV0b21hdGlvbiJ9fQ.signature`;
  await writeStoredCredentialsForServerId(setup.installed.serverId, {
    ...setup.installed.bootstrap.credentials,
    token,
  });
  const sessionCredentials = await readStoredCredentialsForServerId(setup.installed.serverId);
  if (!sessionCredentials) throw new Error('Expected installed custodian stored session credentials');
  await runWithServerHttpBaseUrl(setup.installed.serverHttpBaseUrl, () =>
    bootstrapAccountSettingsContext({
      credentials: sessionCredentials,
      mode: 'blocking',
    }),
  );
}

describe('Workspace Sync relationship control CLI/MCP parity under default unwaived approval policy', () => {
  it.skipIf(process.platform !== 'linux').each([
    { role: 'use' as const, surface: 'cli' as const, rewriteWorkerOnTerminate: false },
    { role: 'manage' as const, surface: 'cli' as const, rewriteWorkerOnTerminate: true },
    { role: 'use' as const, surface: 'mcp' as const, rewriteWorkerOnTerminate: false },
  ])(
    'executes disable, enable, flush, and terminate for $role via $surface through requester-owned approval without exposing requester credentials',
    async ({ role, surface, rewriteWorkerOnTerminate }) => {
      const setup = await createRequesterWorkspaceSyncFixture({
        role,
        isolationOff: true,
        gitReplica: 'existing',
        remoteTarget: true,
        remoteSeed: true,
        originalActionHomeHttp: true,
        socketIo,
        allowRelationshipAction: true,
        isolateInstalledProjectRows: true,
        // Intentionally NO allowRelationshipControls and NO approvalWaivedSurfaces for disable/enable/flush/terminate!
      });
      await signInCustodianWithDefaultSettings(setup);
      runScmExecutable(setup.sourcePath, 'git', ['clone', '-q', '.', setup.targetPath]);
      const created = await setup.executeNativeRelationshipAction();
      expect(
        created,
        JSON.stringify({ created, refusals: setup.homeActionRefusals, rpc: setup.rpcDiagnostics, target: setup.targetRpcDiagnostics }),
      ).toMatchObject({
        ok: true,
        result: { created: true },
      });
      if (!created.ok) throw new Error('Expected initial Git Replica creation to succeed');
      const { relationshipId } = WorkspaceSyncRelationshipCreateResultV1Schema.parse(created.result);

      const executor = createCliActionExecutorFromCredentials({
        credentials: { ...setup.credentials, credentialProvenance: 'stored_session' },
        externalActionClient: true,
        serverId: setup.installed.serverId,
        serverIdentityId: setup.installed.homeServerIdentityId,
        serverApiUrl: setup.installed.serverHttpBaseUrl,
        actionsSettingsProvider: createActionSettingsProvider({
          // Default policy: ZERO approvalWaivedSurfaces
          allowEnvironmentOverride: false,
          accountSettings: accountSettingsParse({}),
        }),
        resolveServerFeaturesSnapshot: () => ({
          status: 'ready',
          provenance: 'authenticated',
          features: FeaturesResponseSchema.parse({
            features: {},
            capabilities: { serverIdentity: { serverIdentityId: setup.installed.homeServerIdentityId } },
          }),
        }),
      });

      const runDeferredControl = async <T>(
        actionId:
          | 'workspace.sync.relationship.disable'
          | 'workspace.sync.relationship.enable'
          | 'workspace.sync.relationship.flush'
          | 'workspace.sync.relationship.terminate',
        input: Record<string, unknown>,
        parseOutput: (raw: unknown) => T,
      ): Promise<T> => {
        // Security invariant: requesterCredentials MUST remain none
        expect(getActionSpec(actionId).originalExecution).toMatchObject({
          accountRoot: 'allowed',
          requesterCredentials: 'none',
        });

        const dispatchesBefore = setup.homeActionRequests.length;
        const asked = await executor.execute(actionId, input, { surface, authority: 'present_user' });
        expect(
          asked,
          JSON.stringify({ actionId, surface, asked, routes: setup.homeActionRoutes, refusals: setup.homeActionRefusals }),
        ).toMatchObject({
          ok: true,
          result: { kind: 'approval_request_created', artifactId: expect.any(String) },
        });
        // Zero dispatches to the foreign controller Machine before explicit approval
        expect(setup.homeActionRequests).toHaveLength(dispatchesBefore);

        if (!asked.ok || !asked.result || typeof asked.result !== 'object' || !('artifactId' in asked.result)) {
          throw new Error(`Expected approval_request_created for ${actionId}`);
        }
        const artifactId = String(asked.result.artifactId);
        const artifact = setup.approvalArtifacts.get(artifactId);
        expect(artifact?.ownerAccountId).toBe('member-a');
        const approval = readApprovalRequestFromArtifact(artifact);
        expect(approval.actionId).toBe(actionId);
        expect(approval.executionOriginV1.machineId).toBeUndefined();
        expect(approval.executionOriginV1.target).toBeUndefined();
        expect(approval.executionOriginV1.externalActionExecutionAuthorization).toBeUndefined();
        expect(approval.actionArgs).toMatchObject({
          relationshipId,
          controllerMachineId: setup.installed.machineId,
        });

        // Approve on requester CLI executor (default policy, no waivers)
        const decided = await executor.execute(
          'approval.request.decide',
          { artifactId, decision: 'approve' },
          { surface: 'cli', authority: 'present_user' },
        );
        expect(
          decided,
          JSON.stringify({ actionId, decided, routes: setup.homeActionRoutes, refusals: setup.homeActionRefusals }),
        ).toMatchObject({
          ok: true,
          result: {
            ok: true,
            status: 'executed',
            execution: { ok: true },
          },
        });
        if (
          !decided.ok
          || !decided.result
          || typeof decided.result !== 'object'
          || !('execution' in decided.result)
          || !decided.result.execution
          || typeof decided.result.execution !== 'object'
          || !('result' in decided.result.execution)
        ) {
          throw new Error(`Expected executed approval result for ${actionId}`);
        }

        // Exactly one dispatch reached the foreign controller Machine, using managed_controller_codec
        // with ZERO requester credentials attached.
        expect(setup.homeActionRequests).toHaveLength(dispatchesBefore + 1);
        const dispatch = setup.homeActionRequests.at(-1)!;
        expect(dispatch.actionId).toBe(actionId);
        expect(dispatch.placement.machineId).toBe(setup.installed.machineId);
        const opening = {
          authorization: dispatch.executionAuthorization!,
          machineId: setup.installed.machineId,
          installationId: setup.installed.installation.installationId,
          serverIdentityId: setup.installed.homeServerIdentityId,
          installationPrivateKey: decodeBase64(setup.installed.installation.privateKey, 'base64url'),
        };
        const openedCodec = openManagedControllerActionCodecV1({ ...opening, includeInvocation: true });
        expect(openedCodec).not.toBeNull();
        expect(openedCodec?.invocation?.presentUserConfirmation?.actionId).toBe(actionId);
        expect(openExternalActionRequesterAccountContextV1({ ...opening, purpose: { kind: 'external_action' } })).toBeNull();
        // Zero custodian-owned approval artifacts created on the foreign controller
        for (const stored of setup.approvalArtifacts.values()) {
          expect(stored.ownerAccountId).toBe('member-a');
        }

        return parseOutput(decided.result.execution.result);
      };

      const disabled = await runDeferredControl(
        'workspace.sync.relationship.disable',
        { relationshipId, controllerMachineId: setup.installed.machineId },
        raw => WorkspaceSyncRelationshipDisableActionOutputV1Schema.parse(raw),
      );
      expect(disabled).toEqual({ v: 1, relationshipId, enabled: false });

      const enabled = await runDeferredControl(
        'workspace.sync.relationship.enable',
        { relationshipId, controllerMachineId: setup.installed.machineId },
        raw => WorkspaceSyncRelationshipEnableActionOutputV1Schema.parse(raw),
      );
      expect(enabled).toEqual({ v: 1, relationshipId, enabled: true });

      const flushed = await runDeferredControl(
        'workspace.sync.relationship.flush',
        { relationshipId, controllerMachineId: setup.installed.machineId },
        raw => WorkspaceSyncRelationshipFlushActionOutputV1Schema.parse(raw),
      );
      expect(flushed).toMatchObject({ v: 1, relationshipId, status: { relationshipId } });

      const terminated = await runDeferredControl(
        'workspace.sync.relationship.terminate',
        rewriteWorkerOnTerminate
          ? { relationshipId, controllerMachineId: setup.targetRef.machineId }
          : { relationshipId, controllerMachineId: setup.installed.machineId },
        raw => WorkspaceSyncRelationshipTerminateActionOutputV1Schema.parse(raw),
      );
      expect(terminated).toEqual({ v: 1, relationshipId, terminated: true });
    },
    60_000,
  );

  it.skipIf(process.platform !== 'linux')(
    'refuses to execute an unconfirmed CLI disable dispatch sent directly to the foreign controller without waivers',
    async () => {
      const setup = await createRequesterWorkspaceSyncFixture({
        role: 'use',
        isolationOff: true,
        gitReplica: 'existing',
        remoteTarget: true,
        remoteSeed: true,
        originalActionHomeHttp: true,
        socketIo,
        allowRelationshipAction: true,
        isolateInstalledProjectRows: true,
      });
      await signInCustodianWithDefaultSettings(setup);
      runScmExecutable(setup.sourcePath, 'git', ['clone', '-q', '.', setup.targetPath]);
      const created = await setup.executeNativeRelationshipAction();
      expect(created, JSON.stringify({ created, refusals: setup.homeActionRefusals })).toMatchObject({
        ok: true,
        result: { created: true },
      });
      if (!created.ok) throw new Error('Expected initial Git Replica creation to succeed');
      const { relationshipId } = WorkspaceSyncRelationshipCreateResultV1Schema.parse(created.result);

      const setEnabledSpy = vi.spyOn(setup.fixture.parent.workspaceSync.relationshipOwner, 'setEnabled');
      const direct = await dispatchOriginalAccountAction({
        actionId: 'workspace.sync.relationship.disable',
        input: { relationshipId, controllerMachineId: setup.installed.machineId },
        requestId: 'unconfirmed-cli-disable-1',
        target: { kind: 'machine', machineId: setup.installed.machineId },
        credentials: setup.credentials,
        serverHttpBaseUrl: setup.installed.serverHttpBaseUrl,
        serverIdentityId: setup.installed.homeServerIdentityId,
        authority: 'present_user',
        invocation: {
          caller: { kind: 'host' },
          surface: 'cli',
          authority: 'present_user',
        },
      });
      // Must NOT execute the disable side effect without presentUserConfirmation or waivers,
      // and must not merely fail due to missing custodian daemon authentication.
      if (direct.ok) {
        expect(direct.result).not.toMatchObject({ enabled: false });
        expect(direct.result).toMatchObject({ kind: 'approval_request_created' });
      } else {
        expect(direct.errorCode).not.toBe('not_authenticated');
      }
      expect(setEnabledSpy).not.toHaveBeenCalled();
    },
    60_000,
  );
});
