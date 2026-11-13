import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRunnerExecutionRunProfileCatalog } from '@/agent/runtime/session/process/runnerExecutionRunSnapshot';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { reloadConfiguration } from '@/configuration';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { AgentRuntimeDaemonServiceRoutes } from '@/daemon/controlServer';
import { createRunnerExecutionRunSnapshots } from './runnerExecutionRunSnapshots';
import { assertExecutionRunStructuredOutputModelAllowed } from '@/agent/runtime/bridges/executionRun/structuredOutputAdmission';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('runner execution-run snapshot SCM preparation', () => {
  it('reads declared model variants through one retained snapshot and refuses unavailable configured targets', async () => {
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
      // This RPC fixture owns one Agent; retain real physical admission without
      // projecting the unrelated bundled contribution universe.
      resolveContributes: async happyHomeDir => createResolvedContributionRegistry(await resolvePluginContributes({
        happyHomeDir, agentIdentity: { pluginId: 'acme.snapshot-model', localId: 'agent' },
      })),
      plugins: [{
      manifest: createPluginManifestV2Fixture({ id: 'acme.snapshot-model', contributes: { agents: [{
        id: 'agent', title: 'Snapshot model Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      }] } }),
      files: {
        'agent.mjs': `export function createRuntime() { return { sessions: { open() { throw new Error('No Session open during model discovery'); } } }; }`,
        'daemon.mjs': `import { createRuntime } from './agent.mjs';
          export function activate(api) { api.agents.register('agent', createRuntime, {
            sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            preflightSessionControls: { probeModels: () => ({ source: 'static', refreshError: true,
              availableModels: [{ id: 'default', name: 'Native default',
                contextWindowTokens: 32768, capabilities: { structuredOutput: 'unknown' } },
                { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', contextWindowTokens: 200000,
                  extendedContextModelId: 'claude-sonnet-4-6[1m]', capabilities: { structuredOutput: 'supported' } }] }) }
          }); }`,
      },
    }] });
    const agentId = 'acme.snapshot-model/agent';
    const retainedAgent = runtime.registry.agentRuntimesByAgentId.get(agentId)?.sessionRunnerFactoryBinding;
    if (!retainedAgent) throw new Error('Missing admitted model Agent binding');
    const context: Parameters<AgentRuntimeDaemonServiceRoutes['dispatch']>[1] = {
      sessionId: 'model-session', runner: { pid: 123, processStartTimeMs: 1,
        processCommandHash: 'a'.repeat(64), snapshotIdentity: 'model-snapshot' }, retainedAgent,
      invocationContext: { cwd: runtime.happyHomeDir, environment: {}, providerBindingActive: false },
      trackedSession: { trackingKey: legacyPidSessionTrackingKey(123), pid: 123, startedBy: 'daemon', happySessionId: 'model-session' },
      isCurrent: async () => true,
    };
    let modelAccountReads = 0;
    const snapshots = createRunnerExecutionRunSnapshots({ machineId: 'machine-1', controller: runtime.controller,
      withNativeModelAccount: async (_context, read) => { modelAccountReads += 1; return await read({ accountSettings: {} }); },
    });
    const dispatch = async (operation: unknown, snapshotId?: string) => AgentRuntimeDaemonServiceResponseV1Schema.parse(
      await snapshots.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
        context: { token: 'A'.repeat(43), sessionId: context.sessionId,
          ...(snapshotId ? { executionRunSnapshotId: snapshotId } : {}) }, operation }), context));
    try {
      for (const backendTarget of [
        { kind: 'backend', backendId: agentId },
        { kind: 'backend', backendId: agentId, sourceKind: 'configured', configuredBackendId: 'absent-definition' },
      ] as const) {
        const readsBeforeAcquisition = modelAccountReads;
        const acquisition = dispatch({ kind: 'execution_run.snapshot.acquire_v1', backendTarget });
        if ('sourceKind' in backendTarget && backendTarget.sourceKind === 'configured') {
          // A definition belongs to its declared Agent, never the unrelated
          // Agent whose routing id happened to accompany the retained ref.
          await expect(acquisition).rejects.toThrow();
          expect(modelAccountReads).toBe(readsBeforeAcquisition);
          continue;
        }
        const acquired = await acquisition;
        if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot') throw new Error('Missing model snapshot');
        const snapshotId = acquired.result.snapshotId;
        const result = dispatch({ kind: 'execution_run.native_offered_model.read_v1', backendTarget,
          modelId: 'default', cwd: runtime.happyHomeDir }, acquired.result.snapshotId);
        await expect(result).resolves.toMatchObject({ ok: true,
          result: { kind: 'execution_run.native_offered_model', model: { id: 'default',
            contextWindowTokens: 32768, capabilities: { structuredOutput: 'unknown' } } } });
        await expect(assertExecutionRunStructuredOutputModelAllowed({
          backendTarget: { kind: 'builtInAgent', agentId }, modelId: 'default', cwd: runtime.happyHomeDir,
          readNativeOfferedModel: async () => {
            const response = await dispatch({ kind: 'execution_run.native_offered_model.read_v1', backendTarget,
              modelId: 'default', cwd: runtime.happyHomeDir }, snapshotId);
            if (!response.ok || response.result.kind !== 'execution_run.native_offered_model') throw new Error('Missing model fact');
            return response.result.model ?? undefined;
          },
        })).rejects.toMatchObject({ code: 'model_structured_output_unsupported' });
        const modelSnapshotId = acquired.result.snapshotId;
        const readModel = async (modelId: string) => {
          const response = await dispatch({ kind: 'execution_run.native_offered_model.read_v1', backendTarget,
            modelId, cwd: runtime.happyHomeDir }, modelSnapshotId);
          if (!response.ok || response.result.kind !== 'execution_run.native_offered_model') throw new Error('Missing model fact');
          return response.result.model ?? undefined;
        };
        // A stale refresh retains both the base model and its explicitly declared
        // variant. Undeclared bracket suffixes must not borrow that evidence.
        await expect(readModel('claude-sonnet-4-6[1m]')).resolves.toMatchObject({
          id: 'claude-sonnet-4-6[1m]', capabilities: { structuredOutput: 'supported' },
        });
        expect(await readModel('claude-sonnet-4-6[1m]')).not.toHaveProperty('contextWindowTokens');
        await expect(readModel('claude-sonnet-4-6')).resolves.toMatchObject({ contextWindowTokens: 200000 });
        await expect(assertExecutionRunStructuredOutputModelAllowed({
          backendTarget: { kind: 'builtInAgent', agentId }, modelId: 'claude-sonnet-4-6[1m]',
          cwd: runtime.happyHomeDir, readNativeOfferedModel: ({ modelId }) => readModel(modelId),
        })).resolves.toBeUndefined();
        await expect(readModel('claude-sonnet-4-6[2m]')).rejects.toMatchObject({ code: 'model_catalog_unavailable' });
        await dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId: acquired.result.snapshotId });
      }
    } finally {
      await snapshots.dispose();
      await runtime.dispose();
    }
  });

  it('prepares commit-message evidence through the retained daemon registry without a runner singleton', async () => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-commit-runner-scm-' });
    const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
    const snapshots = createRunnerExecutionRunSnapshots({ machineId: 'machine-1', controller: runtime.controller });
    const retainedAgent = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.agent', pluginVersion: '1.0.0',
      agentId: 'commit-agent', localAgentId: 'commit-agent', sourceCustody: {
        kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'npm',
      }, locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/runtime.mjs', loadMode: 'immutable-js' });
    const context: Parameters<AgentRuntimeDaemonServiceRoutes['dispatch']>[1] = {
      sessionId: 'commit-session', runner: { pid: 123, processStartTimeMs: 1,
        processCommandHash: 'a'.repeat(64), snapshotIdentity: 'commit-snapshot' }, retainedAgent,
      invocationContext: { cwd: repository.rootPath, environment: {}, providerBindingActive: false },
      trackedSession: { trackingKey: legacyPidSessionTrackingKey(123), pid: 123, startedBy: 'daemon', happySessionId: 'commit-session' },
      isCurrent: async () => true,
    };
    const dispatch = async (operation: unknown, snapshotId?: string, activeContext = context) => {
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
        context: { token: 'A'.repeat(43), sessionId: activeContext.sessionId,
          ...(snapshotId ? { executionRunSnapshotId: snapshotId } : {}) }, operation });
      return AgentRuntimeDaemonServiceResponseV1Schema.parse(await snapshots.dispatch(request, activeContext));
    };
    try {
      vi.stubEnv('HAPPIER_HOME_DIR', runtime.happyHomeDir);
      reloadConfiguration();
      expect(pluginReloadController.getState().activeRegistry).toBeNull();
      await writeFile(join(repository.rootPath, repository.trackedPath), 'retained-commit-context-evidence\n');
      await writeFile(join(repository.rootPath, 'unselected.txt'), 'unselected-commit-evidence\n');
      const acquired = await dispatch({ kind: 'execution_run.snapshot.acquire_v1' });
      if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot') throw new Error('Snapshot unavailable');
      const snapshotId = acquired.result.snapshotId;
      const retained = snapshots.read(snapshotId, context);
      if (!retained) throw new Error('Snapshot not retained');
      const profileCatalog = createRunnerExecutionRunProfileCatalog({ snapshot: acquired.result,
        sessionId: context.sessionId, engineRegistry: retained.snapshot.engineRegistry,
        dispatch: async operation => {
          const response = await dispatch(operation, snapshotId);
          if (!response.ok) throw new Error('Commit evidence unavailable');
          return response.result;
        } });
      const patch = await profileCatalog.builtInProfilesByIntent.get('scm_commit_message')!.prepareStartParams!({
        cwd: repository.rootPath, sessionId: context.sessionId,
        request: { intent: 'scm_commit_message', backendTarget: { kind: 'builtInAgent', agentId: 'commit-agent' },
          instructions: '', intentInput: { scope: { kind: 'paths', include: [repository.trackedPath] } },
          permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' },
      });
      expect(patch).toMatchObject({ permissionMode: 'no_tools', instructions: expect.stringContaining('retained-commit-context-evidence') });
      expect(patch?.instructions).not.toContain('unselected-commit-evidence');
      const summary = await profileCatalog.builtInProfilesByIntent.get('scm_diff_summary')!.prepareStartParams!({
        cwd: repository.rootPath, sessionId: context.sessionId,
        request: { intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'commit-agent' },
          instructions: '', intentInput: { cwd: repository.rootPath, source: { kind: 'workingTree' }, outputs: ['summary'] },
          permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' },
      });
      expect(summary).toMatchObject({ intentInput: { comparison: {
        commitTarget: { headOid: repository.headCommit, ref: `refs/heads/${repository.branchName}` },
        inventory: { state: 'complete' },
      } } });
      expect(pluginReloadController.getState().activeRegistry).toBeNull();
      const operation = { kind: 'execution_run.commit_message_context.resolve_v1', workingDirectory: repository.rootPath,
        maxFiles: 20, maxTotalDiffChars: 60_000 };
      for (const [id, activeContext] of [[undefined, context], [snapshotId, { ...context, sessionId: 'foreign-session' }],
        [snapshotId, { ...context, isCurrent: async () => false }]] as const) {
        await expect(dispatch(operation, id, activeContext)).rejects.toMatchObject({ code: 'execution_run_contribution_snapshot_unavailable' });
      }
      await dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId });
      await expect(dispatch(operation, snapshotId)).rejects.toMatchObject({ code: 'execution_run_contribution_snapshot_unavailable' });
    } finally {
      await snapshots.dispose();
      await runtime.dispose();
      vi.unstubAllEnvs();
      reloadConfiguration();
      await rm(repository.rootPath, { recursive: true, force: true });
    }
  });

  it('prepares runner reviews through the retained daemon SCM producer and rejects retired or foreign snapshots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-runner-scm-'));
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: 'acme.review-scm', contributes: {
        scmBackends: [{ id: 'review', title: 'Review SCM', kind: 'review', capabilities: ['detect', 'status'] }],
      } }), files: { 'daemon.mjs': `export function activate(api) {
        api.scm.registerBackend('review', {
          runtime: { repoModes: ['.git'], capabilities: {
            detection: { repository: { support: 'supported' } }, read: { status: { support: 'supported' } },
            changeSet: { model: 'working-copy', diffAreas: ['pending'] }, commit: {}, remote: {}, branch: {},
            worktree: {}, lifecycle: {}, hosting: {}, checkpoints: {}, workspaceIntegration: {}, tooling: {}, freshness: {}
          }, commands: [] },
          handlers: { detection: { detectRepo: async ({cwd}) => ({ isRepo: true, rootPath: cwd, mode: '.git' }) },
            read: { statusSnapshot: async () => ({ success: false, error: 'retained SCM status unavailable' }) } }
        });
      }` } }],
    });
    const snapshots = createRunnerExecutionRunSnapshots({ machineId: 'machine-1', controller: runtime.controller });
    const retainedAgent = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.agent', pluginVersion: '1.0.0',
      agentId: 'review-agent', localAgentId: 'review-agent', sourceCustody: {
        kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'npm',
      }, locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/runtime.mjs', loadMode: 'immutable-js' });
    const context: Parameters<AgentRuntimeDaemonServiceRoutes['dispatch']>[1] = {
      sessionId: 'review-session', runner: { pid: 123, processStartTimeMs: 1,
        processCommandHash: 'a'.repeat(64), snapshotIdentity: 'review-snapshot' }, retainedAgent,
      invocationContext: { cwd, environment: {}, providerBindingActive: false },
      trackedSession: { trackingKey: legacyPidSessionTrackingKey(123), pid: 123, startedBy: 'daemon', happySessionId: 'review-session' },
      isCurrent: async () => true,
    };
    const dispatch = async (operation: unknown, snapshotId?: string, activeContext = context) => {
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
        context: { token: 'A'.repeat(43), sessionId: activeContext.sessionId,
          ...(snapshotId ? { executionRunSnapshotId: snapshotId } : {}) }, operation });
      return AgentRuntimeDaemonServiceResponseV1Schema.parse(await snapshots.dispatch(request, activeContext));
    };
    try {
      const acquired = await dispatch({ kind: 'execution_run.snapshot.acquire_v1' });
      if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot') throw new Error('Snapshot unavailable');
      const snapshotId = acquired.result.snapshotId;
      const retained = snapshots.read(snapshotId, context);
      if (!retained) throw new Error('Snapshot not retained');
      const profileCatalog = createRunnerExecutionRunProfileCatalog({ snapshot: acquired.result,
        sessionId: context.sessionId, engineRegistry: retained.snapshot.engineRegistry,
        dispatch: async operation => {
          const response = await dispatch(operation, snapshotId);
          if (!response.ok) throw new Error('Scope unavailable');
          return response.result;
        } });
      const patch = await profileCatalog.builtInProfilesByIntent.get('review')!.prepareStartParams!({
        cwd, sessionId: context.sessionId, request: { intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'review-agent' },
          instructions: 'Review', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' },
      });
      expect(patch).toMatchObject({ intentInput: { scmReviewScope: { status: 'unsupported', diagnostics: [{
        code: 'scm_status_unavailable', message: 'retained SCM status unavailable',
      }] } } });
      const operation = { kind: 'execution_run.review_scm_scope.resolve_v1', cwd, intentInput: {} };
      await expect(dispatch(operation)).rejects.toMatchObject({ code: 'execution_run_contribution_snapshot_unavailable' });
      await expect(dispatch(operation, snapshotId, { ...context, isCurrent: async () => false })).rejects.toMatchObject({
        code: 'execution_run_contribution_snapshot_unavailable',
      });
      await expect(dispatch(operation, snapshotId, { ...context, sessionId: 'foreign-session' })).rejects.toMatchObject({
        code: 'execution_run_contribution_snapshot_unavailable',
      });
      await dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId });
      await expect(dispatch(operation, snapshotId)).rejects.toMatchObject({ code: 'execution_run_contribution_snapshot_unavailable' });
    } finally {
      await snapshots.dispose();
      await runtime.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
