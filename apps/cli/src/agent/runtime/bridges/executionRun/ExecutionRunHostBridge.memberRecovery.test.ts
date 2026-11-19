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
