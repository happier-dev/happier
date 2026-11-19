import { expect, it, vi } from 'vitest';

const { createBundledPluginPublicationFsFixture } = await vi.hoisted(async () => (
  import('@/plugins/projection/registry/builtIn/locators.testkit')
));
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { withAdmittedSessionRun } from './testkit/admittedSessionRun';
import { createNativeSessionBoundary } from './testkit/nativeSessionContext';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { buildExecutionRunProfileStartParams, runWithScmExecutionRunAccountScope } from './profileStart';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunNativeOperation } from '@/daemon/agentRuntime/executionRunNativeOperation';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { captureScmComparison, hostScmComparisonShelf, readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { runWithScmAccountScope, readScmExecutionAuthorization, resolveScmAccountStorageDirectory } from '@/scm/accountScope';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitScmBackendRuntimeRegistration } from '../../../../../../../packages/plugins/scm-git/src/backend';
import { createScmHostingProviderRuntimeServicesForTest } from '../../../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { configuration } from '@/configuration';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { buildPendingScmDiffSummaryOutput } from './kinds/scmDiffSummary/publishSavedScmDiffSummaryTurn';
import { createReviewRunCommentService } from '@/agent/executionRuns/profiles/review/reviewComments';
import { createInMemoryReviewRecordPortV1 } from '../../../../../../../packages/protocol/src/reviews/reviewArtifactV1.testkit';
import { createExecutionRunRpcActionDeps, createExecutionRunRpcActionExecutor } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { createMachineExecutionRunAgentStartContextResolver } from '@/api/machine/resolveExecutionRunAgentStartContext';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import type { ResolvedRolesSnapshotV1 } from '@happier-dev/protocol';
import { ExecutionRunActionResponseSchema } from '@happier-dev/protocol/execution/runs/index';
import type { RoleArtifactV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerExecutionRunActionRpcHandlers } from '@/rpc/handlers/executionRuns/actionRpcRegistration';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import nacl from 'tweetnacl';

it.each([
  { ambientAccountId: undefined, machineIngress: false, cliIngress: false },
  { ambientAccountId: 'custodian', machineIngress: false, cliIngress: false },
  { ambientAccountId: 'custodian', machineIngress: true, cliIngress: false },
  { ambientAccountId: 'custodian', machineIngress: true, cliIngress: true },
])('starts a new Review round with retained requester and authored Role under ambient Account $ambientAccountId (Machine ingress $machineIngress, CLI $cliIngress)', async ({ ambientAccountId, machineIngress, cliIngress }) => {
  const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-review-round-account-' });
  const records = createInMemoryReviewRecordPortV1();
  const comments = createReviewRunCommentService({ cwd: repository.rootPath,
    scope: { workspace: { machineId: 'machine', path: repository.rootPath } }, reviewRecords: records,
    // Comment HTTP is unused while preparing a round; records and SCM owners remain real.
    execute: async () => { throw new Error('Unexpected comment publication during round preparation'); } });
  const roleArtifact = { name: 'Writable review', instructions: 'Inspect the selected comparison.',
    runsAs: { kind: 'background_run', intent: 'review' }, workspaceWrites: 'allow', secondOpinion: 'off', enabled: true } satisfies RoleArtifactV1;
  let roleAvailable = true;
  try {
    await withAdmittedSessionRun({ directOwner: true, reviewComments: comments,
      readRoleArtifact: artifactId => artifactId === 'custom-review' && roleAvailable ? roleArtifact : null, run: async fixture => {
      const requester = fixture.requesterWorkAttributionV1;
      const role = resolveRoleSelectionV1({ roleId: 'custom-review', settingsRoles: { 'custom-review': {
        name: 'Writable review', instructions: 'Inspect the selected comparison.', runsAs: { kind: 'background_run', intent: 'review' },
        workspaceWrites: 'allow', secondOpinion: 'off', enabled: true,
      } } });
      if (!role.ok) throw new Error('Fixture custom Review Role is unavailable');
      const sessionId = ambientAccountId && !machineIngress ? fixture.session.sessionId : null;
      const captured = await runWithScmAccountScope(requester.accountId, () => captureScmComparison({
        cwd: repository.rootPath, ...(sessionId ? { sessionId } : {}), source: { kind: 'workingTree' } }));
      const reviewRound = await records.start({ reviewId: 'requester-round-review', title: 'Review', subjectKind: 'comparison',
        sourceKind: 'direct', reviewerIds: ['reviewer-1'], comparisonId: captured.comparison.id, startedAt: 1 });
      const started = await fixture.start({ sessionId, intent: 'review', cwd: repository.rootPath,
        modelId: 'review-fixture-model',
        requesterWorkAttributionV1: requester, roleId: role.selection.roleId, resolvedRole: role.selection,
        intentInput: { instructions: 'Inspect.', reviewers: [{ kind: 'engine', engineId: `${fixture.agentIdentity.pluginId}/${fixture.agentIdentity.localId}` }],
          comparisonId: captured.comparison.id, reviewRound, reviewReviewerId: 'reviewer-1' } });
      await fixture.bridge!.stop(started.runId);
      await fixture.bridge!.waitForTerminal(started.runId);
      await writeFile(join(repository.rootPath, repository.trackedPath), 'A fresh comparison for round two.\n');
      let currentRoles: ResolvedRolesSnapshotV1 = { [role.selection.roleId]: role.selection };
      const actions = createExecutionRunRpcActionDeps({ manager: fixture.bridge!, policy: resolveExecutionRunPolicy(),
        isExecutionRunsEnabled: () => true, context: { sessionId, cwd: repository.rootPath,
          // Account Role content and Session metadata are storage snapshots;
          // the real Role/context resolver and every child-start owner run below.
          resolveAgentStartContext: async context => resolveCliAgentStartContextV1({ sessionId: fixture.session.sessionId,
            machineId: requester.machineId, directory: repository.rootPath, metadata: {}, roles: currentRoles,
            backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: `${fixture.agentIdentity.pluginId}/${fixture.agentIdentity.localId}` }),
            callerPermissionMode: context.callerPermissionMode ?? 'read-only', starterDepth: 0, turnDepth: 0, settings: null }),
        } });
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-round', binding: {
        accountId: requester.accountId, custodianAccountId: requester.accountId, authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', serverIdentityId: 'fixture-home', machineId: requester.machineId, installationId: requester.installationId,
        actionId: 'execution.run.action', requestId: 'next-round', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: requester.machineId },
      } });
      const custody = machineIngress ? await admitRequesterAccountActionContext({ authorization, credentials: fixture.credentials,
        serverId: requester.serverId, serverIdentityId: 'fixture-home', serverHttpBaseUrl: fixture.serverHttpBaseUrl,
        isCurrent: async () => true }) : null;
      if (machineIngress && !custody) throw new Error('Requester Account custody was not admitted');
      let restoreTransport: (() => void) | undefined;
      try {
        const machineActions = createExecutionRunRpcActionExecutor({ manager: fixture.bridge!, policy: resolveExecutionRunPolicy(),
          isExecutionRunsEnabled: () => true, context: { sessionId: null, cwd: repository.rootPath, serverId: requester.serverId,
            resolveAgentStartContext: createMachineExecutionRunAgentStartContextResolver({ machineId: requester.machineId, cwd: repository.rootPath }) } });
        const request = { runId: started.runId, actionId: 'review.new_round', input: { fresh: true } };
        const rpc = new RpcHandlerManager({ scopePrefix: requester.machineId, localMachineId: requester.machineId, encryptionMode: 'plain' });
        registerExecutionRunActionRpcHandlers(rpc, { executor: machineActions, defaultSessionId: null,
          machineId: requester.machineId, serverId: requester.serverId });
        const cli = cliIngress ? createCliActionDeps({ token: fixture.credentials.token, credentials: fixture.credentials,
          sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: requester.serverId,
          serverHttpBaseUrl: fixture.serverHttpBaseUrl, serverIdentityId: 'fixture-home',
          externalActionMachineInstallationId: requester.installationId,
          externalActionMachineRequestPrivateKey: nacl.sign.keyPair().secretKey }) : null;
        // Machine RPC is the OS/network boundary. Only the real caller's signed
        // requester context reaches the registered receiver; bare RPC has none.
        const transport = cliIngress ? vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async input => await rpc.invokeLocal(input.method, input.request, {
          rpcContext: { callerAuthority: 'present_user',
            ...(input.externalAction?.context.externalActionExecutionAuthorization
              ? { callerInputAuthorization: input.externalAction.context.externalActionExecutionAuthorization } : {}) },
          localActionContext: { surface: 'rpc' },
        })) : null;
        restoreTransport = () => transport?.mockRestore();
        // The real RPC adapter continues the admitted root and projects its
        // private requester into the public executor's ordinary authorization.
        const startRound = async () => cliIngress ? await cli!.executionRunAction!(null, request, {
          surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: 'next-round',
          serverId: requester.serverId, exactMachineId: requester.machineId, runtimeAccountId: requester.accountId,
          externalActionExecutionAuthorization: custody!.authorization,
          externalActionTarget: { kind: 'machine', machineId: requester.machineId },
        }) : machineIngress ? await machineActions.execute('execution.run.action', request, {
          ...buildActionExecutorContextForRpc({ actionId: 'execution.run.action', serverId: requester.serverId,
            callerAuthority: 'present_user', callerInputAuthorization: custody!.authorization,
            localActionContext: { surface: 'rpc' } }),
          executionRunTargetMachineId: requester.machineId,
        }) : actions.executionRunAction!(sessionId, request, {
          requesterWorkAttributionV1: requester,
          ...(sessionId ? { authority: 'account_automation' as const, surface: 'agent' as const,
            actionCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } }
            : { authority: 'present_user' as const, surface: 'rpc' as const }),
        });
        const executeRound = async () => {
          const result = await (ambientAccountId ? runWithScmAccountScope(ambientAccountId, startRound) : startRound());
          if (machineIngress && !cliIngress && result && typeof result === 'object' && 'ok' in result && result.ok && 'result' in result) return result.result;
          return result;
        };
        const next = ExecutionRunActionResponseSchema.parse(await executeRound());
        expect(next, JSON.stringify(next)).toMatchObject({ ok: true, result: { runId: expect.any(String), reviewRound: { reviewId: reviewRound.reviewId, roundOrdinal: 2 } } });
        if (!next.ok || !next.result || typeof next.result !== 'object' || !('runId' in next.result) || typeof next.result.runId !== 'string') {
          throw new Error('New round did not return its Run');
        }
        const child = fixture.bridge!.get(next.result.runId);
        expect(child).toMatchObject({ requesterWorkAttributionV1: requester, roleId: role.selection.roleId, workspaceWrites: 'allow',
          intentInput: { reviewRound: { reviewId: reviewRound.reviewId, roundOrdinal: 2 }, comparison: { id: expect.any(String) } } });
        await fixture.bridge!.stop(next.result.runId);
        await fixture.bridge!.waitForTerminal(next.result.runId);
        const input = child?.intentInput;
        if (!input || typeof input !== 'object' || !('comparisonId' in input) || typeof input.comparisonId !== 'string') throw new Error('Child comparison is missing');
        const comparisonId = input.comparisonId;
        await expect(runWithScmAccountScope(requester.accountId, () => readCapturedScmComparison({
          cwd: repository.rootPath, ...(sessionId ? { sessionId } : {}), comparisonId }))).resolves.toMatchObject({ comparison: { id: comparisonId } });
        if (machineIngress) {
          const unavailable = () => machineActions.execute('execution.run.action', request, {
            ...buildActionExecutorContextForRpc({ actionId: 'execution.run.action', serverId: requester.serverId,
              callerAuthority: 'present_user', callerInputAuthorization: authorization, localActionContext: { surface: 'rpc' } }),
            executionRunTargetMachineId: requester.machineId,
          });
          expect(await runWithScmAccountScope('custodian', unavailable)).toMatchObject({ ok: false, errorCode: 'target_unavailable',
            details: { executionRunStart: { runCreation: 'noRunCreated', refusal: { code: 'agent_start_context_unavailable' } } } });
        }
        currentRoles = {};
        roleAvailable = false;
        expect(await executeRound()).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      } finally {
        restoreTransport?.();
        await custody?.dispose();
      }
    } });
  } finally {
    await rm(repository.rootPath, { recursive: true, force: true });
  }
});

// Only installed-plugin publication and the native Agent are external fixtures.
// The registry, bridge, sealed recovery, profile scope and comparison owners stay real.
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return createBundledPluginPublicationFsFixture(actual);
});

it.each([undefined, 'custodian'])('prepares a captured Review as its requester with ambient Account %s', async ambientAccountId => {
  await withAdmittedSessionRun({ directOwner: true, run: async fixture => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-review-account-' });
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
      executableDefinition: registration.runtime!, registration,
      hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
    })]);
    const requester = fixture.requesterWorkAttributionV1;
    let comparisonId: string | undefined;
    try {
      await writeFile(join(repository.rootPath, repository.trackedPath), 'A captured change for the reviewer.\n');
      const captured = await runWithScmAccountScope(requester.accountId, () => captureScmComparison({
        cwd: repository.rootPath, sessionId: fixture.session.sessionId, source: { kind: 'workingTree' }, registry,
      }));
      comparisonId = captured.comparison.id;
      const role = resolveRoleSelectionV1({ roleId: 'reviewer' });
      if (!role.ok) throw new Error('Fixture reviewer role is unavailable');
      const start = () => fixture.start({ intent: 'review', cwd: repository.rootPath,
        requesterWorkAttributionV1: requester, intentInput: { comparisonId }, resolvedRole: role.selection });
      const started = await (ambientAccountId ? runWithScmAccountScope(ambientAccountId, start) : start());
      expect(started.runId).toEqual(expect.any(String));
      expect(fixture.bridge!.get(started.runId)).toMatchObject({ requesterWorkAttributionV1: requester,
        intentInput: { comparisonId, comparison: { id: comparisonId } } });
      const saved = await runWithScmAccountScope(requester.accountId, () => readCapturedScmComparison({
        cwd: repository.rootPath, sessionId: fixture.session.sessionId, comparisonId: captured.comparison.id }));
      expect(saved.comparison.id).toBe(comparisonId);
      // Preparation is the contract here; the composed gate owns native launch.
      await fixture.bridge!.stop(started.runId);
      await fixture.bridge!.waitForTerminal(started.runId);
    } finally {
      if (comparisonId) await runWithScmAccountScope(requester.accountId, () => hostScmComparisonShelf.remove({
        comparisonId: comparisonId!, sessionId: fixture.session.sessionId }));
      await rm(repository.rootPath, { recursive: true, force: true });
    }
  } });
});

it('restores member evidence and requester publication authority after sealed Run recovery', async () => {
  await withAdmittedSessionRun({ resume: true, run: async fixture => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-member-resume-' });
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
      executableDefinition: registration.runtime!, registration,
      hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
    })]);
    const requester = { serverId: 'home', accountId: 'member-recovery-requester', machineId: 'machine', installationId: 'installation' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fresh-admitted-resume', binding: {
      serverIdentityId: 'home', accountId: requester.accountId, custodianAccountId: 'custodian', accountEncryptionMode: 'plain',
      authentication: { kind: 'account', tokenEpoch: 0 }, machineId: requester.machineId, installationId: requester.installationId,
      actionId: 'execution.run.ensure', requestId: 'resume-request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: requester.machineId },
    } });
    const nativeBoundary = createNativeSessionBoundary();
    fixture.nativeOpen.mockImplementation(nativeBoundary.open);
    const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.admittedRuntime.registry });
    const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({ resolveAgentIdentity: () => fixture.agentIdentity });
    const backendId = `${fixture.agentIdentity.pluginId}/${fixture.agentIdentity.localId}`;
    const backendTarget = { kind: 'builtInAgent' as const, agentId: backendId };
    const bridge = new ExecutionRunHostBridge({ parentProvider: backendId as never, cwd: repository.rootPath,
      sendAcp: async () => {}, resolveExecutionRunProfileCatalog: async () => ({ engineRegistry, profileCatalog }),
      sessionInteractionHost: { session: fixture.session, machineId: requester.machineId,
        permissionHandler: new ProviderEnforcedPermissionHandler(fixture.session, { logPrefix: '[member recovery]' }) },
    });
    let comparisonId: string | undefined;
    try {
      const captured = await runWithScmAccountScope(requester.accountId, () => captureScmComparison({
        cwd: repository.rootPath, sessionId: fixture.session.sessionId, source: { kind: 'workingTree' }, registry,
      }));
      comparisonId = captured.comparison.id;
      const intentInput = { cwd: repository.rootPath, source: captured.comparison.source,
        sourceKey: comparisonId, comparison: captured.comparison, metadata: captured.metadata, outputs: ['summary'] };
      const saved = await runWithScmAccountScope(requester.accountId, () => scmDiffSummaryResultStore.create({
        cwd: repository.rootPath, sessionId: fixture.session.sessionId, output: buildPendingScmDiffSummaryOutput(intentInput),
      }));
      const run: ExecutionRunState = { runId: 'recovered-member-run', callId: 'call', sidechainId: 'sidechain', depth: 0,
        sessionId: fixture.session.sessionId, intent: 'scm_diff_summary', backendId, backendTarget,
        instructions: 'Continue the saved comparison', intentInput: { ...intentInput, resultId: saved.resultId },
        requesterWorkAttributionV1: requester, permissionMode: 'read_only', retentionPolicy: 'resumable',
        runClass: 'long_lived', ioMode: 'streaming', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
        launch: { cwd: repository.rootPath }, resumeHandle: { kind: 'provider_session.v1',
          backendTarget: readBackendTargetRefV2(backendTarget), providerSessionId: 'registry-native-session' } };
      await retainExecutionRunState(run);
      await bridge.recoverRetainedRuns();
      const requesterIdentity = { kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: 'home',
        requester: { ...requester, accountId: 'folder-member' } };
      const memberIdentity = { ...deriveAgentIsolationMemberIdentity(requesterIdentity),
        workspaceRoot: repository.rootPath, agentUid: process.getuid?.() ?? 1000, agentGid: process.getgid?.() ?? 1000 };
      // This OS launch capability is unavailable. Restored member reads must
      // visibly refuse; using daemon filesystem authority would incorrectly succeed.
      const native: ExecutionRunNativeOperation = { requesterIdentity, memberIdentity, workingDirectory: repository.rootPath,
        signal: new AbortController().signal, materialTarget: { runtimeHome: join(fixture.directory, 'operation'), memberIdentity },
        agentIsolation: { requesterIdentity, read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux' },
          workspaceRoots: [repository.rootPath], memberIdentity }) }, async dispose() {} };
      expect(await bridge.ensure(run.runId, { resume: true, projectLaunchContext: {
        ingress: { callerInputAuthorization: authorization }, isCurrent: () => true,
        resolveRuntime: async () => null, prepareNativeOperation: async () => native,
      } })).toMatchObject({ ok: true });
      const recovered = bridge.get(run.runId);
      if (!recovered) throw new Error('Recovered Run is missing');
      const profileStart = buildExecutionRunProfileStartParams(recovered);
      // Same lifecycle binder used by completion hooks. The actual saved shelf
      // remains requester-owned, while captured evidence must use the member port.
      await expect(runWithScmAccountScope('custodian', () => runWithScmExecutionRunAccountScope(profileStart,
        () => readCapturedScmComparison({ cwd: repository.rootPath, sessionId: fixture.session.sessionId,
          comparisonId: captured.comparison.id, source: captured.comparison.source })))).rejects.toMatchObject({
        data: { code: 'agent_isolation_unavailable' },
      });
      const publication = await runWithScmAccountScope('custodian', () => runWithScmExecutionRunAccountScope(profileStart,
        async () => ({ authorization: readScmExecutionAuthorization()?.token,
          result: await scmDiffSummaryResultStore.read({ cwd: repository.rootPath,
            sessionId: fixture.session.sessionId, resultId: saved.resultId }) })));
      expect(publication).toMatchObject({ authorization: authorization.token, result: { success: true } });
    } finally {
      await bridge.dispose();
      if (comparisonId) await runWithScmAccountScope(requester.accountId, () => hostScmComparisonShelf.remove({
        comparisonId: comparisonId!, sessionId: fixture.session.sessionId }));
      await rm(resolveScmAccountStorageDirectory(join(configuration.activeServerDir, 'runtime', 'scm', 'results'), requester.accountId),
        { recursive: true, force: true });
      await rm(repository.rootPath, { recursive: true, force: true });
    }
  } });
});
