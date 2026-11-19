import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AccountSettingsSchema,
  createActionExecutor,
  FeaturesResponseSchema,
  getActionSpec,
} from '@happier-dev/protocol';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { registerProjectFiniteRpcHandlers } from '@/rpc/handlers/projects/registerProjectFiniteRpcHandlers';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { WorkflowAcceptedAuthorizationV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { createTestGitScmBackendRegistry, runGit } from '@/scm/rpc/__tests__/testRpcHarness';
import { ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { ListAccountSessionFollowsResponseV1Schema, SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createCliMachineActionTransport } from '@/session/actions/cliActionDeps/machineTransport';
import { buildWorkflowActionContext } from './workflowActionContext';
import { createWorkflowRunMachineTransport } from './workflowMachineTransport';

// Socket.IO is the Account currentness observation transport boundary.
const mocks = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mocks.io }));

describe('Workflow Run native Machine admission', () => {
  let releaseHome = () => {};
  afterEach(() => {
    releaseHome();
    vi.restoreAllMocks();
    resetInMemoryAccountSettingsContextForTests();
  });

  // A Workflow step reaches the same installed receivers as the directly invoked
  // Action. The Run's Home-admitted Machine access is the receiving admission;
  // Home's published Machine access row is the external boundary.
  it.each(['owner', 'refused', 'guest'] as const)(
    'spends the claimed Run Machine admission at native receivers (%s)',
    async (access) => {
      const accountId = 'workflow-requester',
        machineId = 'workflow-machine';
      const custodianAccountId =
        access === 'guest' ? 'machine-custodian' : accountId;
      const installationId = 'workflow-installation';
      const runId = '6c0f4f0e-6f5f-4c1a-9a35-1e1d3c1f2a10';
      const home = 'http://127.0.0.1:43188',
        homeId = 'srv_workflow_admission';
      const serverId = configuration.activeServerId;
      releaseHome = publishServerHttpRuntimeOrigin(home, 'https');
      const root = await createTempDir('workflow-native-admission-');
      onTestFinished(async () => {
        await removeTempDir(root);
      });
      await seedTestServerProfile({ id: serverId, serverUrl: home, homeId });
      const credentials = {
        token: `fixture.${Buffer.from(
          JSON.stringify({
            sub: accountId,
            tokenEpoch: 0,
            provenance: {
              v: 1,
              kind: 'terminal',
              authority: 'account_automation',
            },
          }),
        ).toString('base64url')}.signature`,
        encryption: null,
        credentialProvenance: 'stored_session' as const,
      };
      const publishedMachine = MachinePublishedRowV1Schema.parse({
        id: machineId,
        managedMachineRef: null,
        metadata: null,
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        storageMode: 'plain',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        installationId,
        access: {
          custodian: {
            accountId: custodianAccountId,
            displayName: 'Machine custodian',
          },
          role: access === 'guest' ? 'use' : 'manage',
          resourceMode: 'plain',
          accessState: access === 'refused' ? 'refused' : 'ready',
        },
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response(
            JSON.stringify(
              FeaturesResponseSchema.parse({
                features: {},
                capabilities: { serverIdentity: { serverIdentityId: homeId } },
              }),
            ),
            { status: 200 },
          ),
      );
      let machineAccessReads = 0;
      const unhandledHttp: string[] = [];
      vi.spyOn(axios, 'get').mockImplementation(async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile')
          return { status: 200, data: { id: accountId } };
        if (path === `/v1/machines/${machineId}`) {
          machineAccessReads++;
          return { status: 200, data: { machine: publishedMachine } };
        }
        if (path === '/v1/account/encryption')
          return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v1/account/encryption/currentness')
          return {
            status: 200,
            data: AccountEncryptionCurrentnessResponseSchema.parse({
              mode: 'plain',
              version: 1,
              settingsVersion: 1,
              signingKeyFingerprint: null,
              contentKeyFingerprint: null,
              updatedAt: 1,
            }),
          };
        if (path === '/v2/account/settings')
          return {
            status: 200,
            data: {
              content: { t: 'plain', v: AccountSettingsSchema.parse({}) },
              version: 1,
            },
          };
        if (path === SESSION_FOLLOW_HTTP_PATHS_V1.otherSource)
          return { status: 200, data: ListAccountSessionFollowsResponseV1Schema.parse({ follows: [] }) };
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1)
          return { status: 200, data: { status: 'listed', rows: [] } };
        unhandledHttp.push(`GET ${path}`);
        throw new Error(`Unexpected Workflow admission HTTP read ${path}`);
      });

      vi.spyOn(axios, 'request').mockImplementation(async (request) => {
      unhandledHttp.push(`${request.method} ${new URL(String(request.url)).pathname}`);
      throw new Error('Unexpected Workflow admission HTTP request');
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url) => {
      unhandledHttp.push(`POST ${new URL(String(url)).pathname}`);
      throw new Error('Unexpected Workflow admission HTTP mutation');
    });

    bindApiSessionSocketMock(mocks.io, createApiSessionSocketStub());

    // The installed receiver: real RPC admission and the real registrars. Native
      // launch is the system boundary below the admission gates under test.
      const finiteAdmissions: unknown[] = [];
      const reboots: Readonly<Record<string, unknown>>[] = [];
      let runStarts = 0;
      let scmAdmissionReads = 0;
      const rpc = new RpcHandlerManager({
        scopePrefix: machineId,
        encryptionMode: 'plain',
        authorizeRequest: (request) =>
          authorizeMachineRpcRequest(request, {
            machineId,
            resolveCustodianAccountId: async () => custodianAccountId,
            resolveInstallationId: () => installationId,
            // Home's signed currentness read is the external boundary.
            verifyMachineAdmission: async ({ method }) => {
              if (method === `${machineId}:${RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE}`) scmAdmissionReads++;
              return true;
            },
          }),
      });
      const scmRegistry = createTestGitScmBackendRegistry();
      const requesterAdmission = createFilesystemEffectAdmission({
        resolveHomeServerIdentityId: async () => homeId,
        resolveHostIdentity: async () => ({ custodianAccountId, machineId, installationId }),
      });
      let nativePreparations = 0;
      let memberFolderAvailable = true;
      registerScmHandlers(rpc, root, { machineId, registry: scmRegistry,
        resolveRequester: requesterAdmission.resolveRpcRequester,
        actionExecutor: createActionExecutor({ scmActionExecute: args => executeScmActionOperation({
          ...args, actionContext: args.context, workingDirectory: root, registry: scmRegistry,
        }) }),
        nativeOperationRuntime: {
          readMemberFolderOwner: async () => {
            if (!memberFolderAvailable) throw new Error('Fixture member binding unavailable');
            return null;
          },
          prepareNativeOperation: request => {
            nativePreparations++;
            return prepareRequesterNativeOperation(request, {
              machine: { read: () => undefined }, homeServerIdentityId: homeId, machineId, installationId,
            });
          },
        },
      });
      registerProjectFiniteRpcHandlers(rpc, {
        serverId: homeId,
        machineId,
        runtime: async () =>
          ({ serverId: homeId, machineId }) as ProjectFiniteActionRuntime,
        createActionExecutor: (_runtime, ingress) => ({
          execute: async () => {
            finiteAdmissions.push(ingress.machineAdmission);
            return { ok: true, result: { launched: true } };
          },
        }),
      });
      registerActionSpecRpcHandlers<'execution.run.start'>({
        rpcHandlerManager: rpc,
        targetMachineId: machineId,
        actionIds: ['execution.run.start'],
        actionExecutor: {
          execute: async () => {
            runStarts++;
            return {
              ok: false,
              errorCode: 'native_launch_boundary',
              error: 'native_launch_boundary',
            };
          },
        },
      });

      const requesterWorkAttributionV1 = {
        serverId,
        accountId,
        machineId,
        installationId,
      };
      let currentRun = true;
      const workflowTransport = createWorkflowRunMachineTransport({
        runId,
        credentials,
        requesterWorkAttributionV1,
        isCurrent: async () => currentRun,
        boundary: {
          serverId,
          serverHttpBaseUrl: home,
          happyHomeDir: root,
          getObservedServerIdentityId: () => homeId,
        },
        machineAdmissionBoundary: {
          machineId,
          daemonToken: 'custodian-daemon-token',
          isHomeCurrent: () => true,
          readInstallation: () => ({
            installationId,
            privateKey: nacl.sign.keyPair().secretKey,
          }),
          getObservedServerIdentityId: () => homeId,
        },
        transport: {
          machineId,
          invoke: (method, request, options) =>
            rpc.invokeLocal(method, request, options),
          // The installed reboot lifecycle owner (apiMachine.executeMachineRebootAction)
          // is the receiver; its caller-Run exclusion reads the stamped Run id.
          machineReboot: async (request) => {
            reboots.push(request.context);
            return { kind: 'accepted', bootedAt: 1 };
          },
        },
      });
      onTestFinished(async () => {
        await workflowTransport.dispose();
      });

      const localActionContext = (attempt: number) => ({
        localActionContext: {
          executionRunWorkflowRunId: runId,
          requesterWorkAttributionV1,
          authority: 'account_automation' as const,
          actionRequestId: `${runId}/step/${attempt}`,
        },
      });
      const finiteStep = (attempt: number) =>
        workflowTransport.transport.invoke(
          getActionSpec('projects.script.run').bindings!.rpcMethod!,
          {
            workspace: {
              serverId: homeId,
              workspaceId: 'workspace',
              machineId,
              rootPath: root,
            },
            selection: { kind: 'named', name: 'fail-once' },
            choice: { kind: 'primary' },
          },
          localActionContext(attempt),
        );
      const runStep = (attempt: number) =>
        workflowTransport.transport.invoke(
          getActionSpec('execution.run.start').bindings!.rpcMethod!,
          {
            intent: 'delegate',
            backendTarget: {
              kind: 'backend',
              backendId: 'codex',
              sourceKind: 'built_in',
            },
            instructions: 'Summarize recent changes.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
          },
          localActionContext(attempt),
        );
      const comparisonInput = { cwd: root, source: { kind: 'workingTree' } };
      const comparisonRequest = (targetMachineId = machineId, input: unknown = comparisonInput) => createTargetedActionRpcRequestV1(input,
        { kind: 'machine', machineId: targetMachineId, project: { machineId: targetMachineId, directory: root } });
      const compare = (callerRunId: string, targetMachineId = machineId, input?: unknown,
        principal: WorkflowAcceptedAuthorizationV1['principal'] = { kind: 'host' }) => workflowTransport.transport.invoke(
        RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE,
        comparisonRequest(targetMachineId, input), {
          localActionContext: {
            ...localActionContext(4).localActionContext,
            actionCaller: { kind: 'workflowRun', runId: callerRunId,
              authorization: { admittedPermissionCeiling: 'default', principal } },
          },
        },
      );

      // REBOOT-RECIPE: a Restart-when-needed step reboots its own Machine through
      // the installed lifecycle owner, never back over Machine RPC, which drops
      // the Run identity that excludes this Run's own live work.
      const rebootStep = (attempt: number, stepRunId = runId) =>
        workflowTransport.transport.machineReboot!({
          input: { serverId: homeId, machineId, expectedInstallationId: installationId },
          context: { ...localActionContext(attempt).localActionContext, executionRunWorkflowRunId: stepRunId },
        });

      onTestFinished(() => { expect(unhandledHttp).toEqual([]); });
      expect(await rebootStep(90, crypto.randomUUID())).toEqual({ kind: 'unavailable', reason: 'admission_unavailable' });
      expect(reboots).toEqual([]);
    if (access === 'refused') {
        expect(await rebootStep(91)).toEqual({ kind: 'unavailable', reason: 'admission_unavailable' });
        expect(reboots).toEqual([]);
        expect(await finiteStep(0)).toMatchObject({
          ok: false,
          errorCode: 'project_requester_credentials_unavailable',
        });
        expect(await runStep(1)).toMatchObject({
          ok: false,
          errorCode: 'project_requester_credentials_unavailable',
        });
        expect(await compare(runId)).toMatchObject({ errorCode: 'project_requester_credentials_unavailable' });
        expect(finiteAdmissions).toEqual([]);
        expect(runStarts).toBe(0);
      } else if (access === 'owner') {
        expect(await finiteStep(0)).toMatchObject({ launched: true });
        expect(await finiteStep(1)).toMatchObject({ launched: true });
        expect(finiteAdmissions).toEqual([
          expect.objectContaining({
            actorAccountId: accountId,
            custodianAccountId: accountId,
            machineId,
            installationId,
            role: 'manage',
          }),
          expect.objectContaining({
            actorAccountId: accountId,
            machineId,
            installationId,
          }),
        ]);
        expect(await runStep(2)).toMatchObject({
          ok: false,
          errorCode: 'native_launch_boundary',
        });
        expect(runStarts).toBe(1);
        expect(await compare(crypto.randomUUID())).toMatchObject({ errorCode: 'agent_isolation_unavailable', effectAttempted: false,
          failureCause: { phase: 'rpc.admission.requester_execution_isolation', errorCode: 'agent_isolation_unavailable' } });
        const { callMachineAction } = createCliMachineActionTransport({ credentials, serverId, serverIdentityId: homeId,
          serverHttpBaseUrl: home, machineActionDirectTargetTransport: workflowTransport.transport });
        runGit(root, ['init']);
        runGit(root, ['config', 'user.email', 'fixture@example.test']);
        runGit(root, ['config', 'user.name', 'SCM fixture']);
        await writeFile(join(root, 'review.txt'), 'before\n');
        runGit(root, ['add', 'review.txt']);
        runGit(root, ['commit', '-m', 'base']);
        await writeFile(join(root, 'review.txt'), 'after\n');
        const result = await callMachineAction({ machineId, method: RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE, request: comparisonRequest(),
          effectActionId: 'scm.diffSummary.capture', exactMachine: true,
          context: buildWorkflowActionContext({ runId, authorization: { admittedPermissionCeiling: 'default',
            principal: { kind: 'host' } } }, requesterWorkAttributionV1) });
        expect(result).toMatchObject({ success: true, comparison: { inventory: { files: [expect.objectContaining({ path: 'review.txt' })] } } });
        expect(ScmComparisonCaptureOutputSchema.safeParse(result).success).toBe(true);
        expect(nativePreparations).toBe(0);
        memberFolderAvailable = false;
        expect(ScmComparisonCaptureOutputSchema.parse(await compare(runId))).toMatchObject({
          success: false, errorCode: 'DIFF_UNAVAILABLE', effectAttempted: false,
          failureCause: { phase: 'scm.requester.member_folder', errorCode: 'agent_isolation_unavailable' },
        });
        expect(scmAdmissionReads).toBe(1); // Only the unattached caller was checked for a fresh admission.
        expect(await compare(runId, machineId, { cwd: root, source: { kind: 'session', sessionId: 'source-session' } }))
          .toMatchObject({ effectAttempted: false, failureCause: { phase: 'rpc.admission.requester_execution_isolation' } });
        for (const principal of [
          { kind: 'session', sessionId: 'source-session' },
          { kind: 'api', accountId, principalId: 'automation-api', credentialId: 'automation-token' },
        ] as const) {
          expect(await compare(runId, machineId, comparisonInput, principal))
            .toMatchObject({ effectAttempted: false, failureCause: { phase: 'rpc.admission.requester_execution_isolation' } });
        }
        expect(await compare(runId, 'other-machine')).toMatchObject({ effectAttempted: false });
        expect(await rebootStep(3)).toEqual({ kind: 'accepted', bootedAt: 1 });
        expect(reboots).toEqual([expect.objectContaining({
          executionRunWorkflowRunId: runId,
          machineAdmission: expect.objectContaining({ actorAccountId: accountId, custodianAccountId: accountId,
            machineId, installationId, role: 'manage' }),
          verifyMachineAdmissionCurrent: expect.any(Function),
        })]);
      } else {
        // A guest's Run keeps its own requester custody; it never borrows the
        // custodian's Account for the work it starts on the shared Machine.
        expect(await runStep(0)).toMatchObject({
          ok: false,
          errorCode: 'native_launch_boundary',
        });
        expect(runStarts).toBe(1);
        expect(await compare(runId)).toMatchObject({ errorCode: 'machine_manage_required', effectAttempted: false });
      }
      currentRun = false;
      expect(await compare(runId)).toMatchObject({ errorCode: 'project_requester_credentials_unavailable' });
      // The Run's Machine access is read once at capture, never per step.
      expect(machineAccessReads).toBe(1);
      expect(unhandledHttp).toEqual([]);
    },
  );
});
