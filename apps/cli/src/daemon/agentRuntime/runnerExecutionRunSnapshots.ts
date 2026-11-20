import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PluginError } from '@happier-dev/plugin-sdk';
import { acquireExecutionRunRuntimeSnapshot } from '@/rpc/handlers/executionRuns/acquireExecutionRunRuntimeSnapshot';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { RunnerExecutionRunSnapshotV1Schema } from '@/agent/runtime/session/process/executionRunSnapshotProtocol';
import type { AgentRuntimeDaemonServiceRoutes } from '@/daemon/controlServer';
import type { TrackedSession } from '@/daemon/types';
import { resolveReviewScmScope } from '@/agent/reviews/scope/resolve';
import { resolveDefaultScmBackendRegistry } from '@/scm/scmBackendCatalog';
import { loadScmCommitMessageContext } from '@/agent/runtime/bridges/executionRun/kinds/scmCommitMessage/loadScmCommitMessageContext';
import { captureScmComparisonCommitTarget } from '@/scm/comparisons/captureScmComparison';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import type { ExecutionRunProviderLaunchRequest, PreparedExecutionRunProviderLaunch } from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';
import { createRunnerExecutionRunProviderLaunchServices, projectRunnerExecutionRunProviderLaunch,
  type RunnerExecutionRunProviderPreparation } from './runnerExecutionRunProviderLaunch';
import { readNativeExecutionRunOfferedModel } from '@/agent/runtime/bridges/executionRun/structuredOutputAdmission';
import { areExecutionRunBackendTargetsEqual } from '@/agent/runtime/bridges/executionRun/backendTargets';
import { convertBackendTargetRefV2ToV1 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

type Context = Parameters<AgentRuntimeDaemonServiceRoutes['dispatch']>[1];
type Request = Parameters<AgentRuntimeDaemonServiceRoutes['dispatch']>[0];
type Held = Readonly<{ context: Context;
  snapshot: Awaited<ReturnType<typeof acquireExecutionRunRuntimeSnapshot>>;
  projection: ReturnType<typeof RunnerExecutionRunSnapshotV1Schema.parse>;
  backendTarget?: ExecutionRunProviderLaunchRequest['backendTarget'];
  provider: { resources: ReturnType<typeof createProviderLaunchResourceScope>; retired: boolean;
    request?: ExecutionRunProviderLaunchRequest; preparation?: Promise<PreparedExecutionRunProviderLaunch> };
}>;

/** Custody of the canonical producer's leases, never a second Run or catalog registry. */
export function createRunnerExecutionRunSnapshots(input: Readonly<{ machineId: string; controller?: PluginReloadController;
  resolveProviderPreparation?(request: ExecutionRunProviderLaunchRequest, context: Context): Promise<RunnerExecutionRunProviderPreparation | null>;
  withNativeModelAccount?<T>(context: Context, read: (account: Pick<Parameters<typeof readNativeExecutionRunOfferedModel>[0],
    'accountSettings' | 'promptCredentials' | 'preflightDependencies'>) => Promise<T>): Promise<T>;
}>) {
  const held = new Map<string, Held>();
  const unavailable = () => { throw new PluginError({ code: 'execution_run_contribution_snapshot_unavailable',
    message: 'Execution Run executable snapshot is unavailable' }); };
  const read = (snapshotId: string, context: Pick<Context, 'sessionId' | 'runner' | 'retainedAgent'>) => {
    const value = held.get(snapshotId);
    return value && value.context.sessionId === context.sessionId
      && isDeepStrictEqual(value.context.runner, context.runner)
      && isDeepStrictEqual(value.context.retainedAgent, context.retainedAgent) ? value : null;
  };
  const release = async (snapshotId: string) => {
    const value = held.get(snapshotId);
    if (!value) return;
    value.provider.retired = true;
    await value.provider.preparation?.catch(() => undefined);
    await value.provider.resources.release();
    await value.snapshot.release();
    held.delete(snapshotId);
  };
  return Object.freeze({
    read,
    async dispatch(request: Request, context: Context) {
      const operation = request.operation;
      if (operation.kind === 'execution_run.snapshot.acquire_v1') {
        if (!context.trackedSession || !await context.isCurrent()) return unavailable();
        context.signal?.throwIfAborted();
        const snapshot = await acquireExecutionRunRuntimeSnapshot({ sessionId: context.sessionId,
          machineId: input.machineId }, input.controller);
        try {
          const backendId = operation.backendTarget?.backendId ?? null;
          const descriptor = backendId ? await resolveRunnerAgentSessionDescriptorForLease({
            target: operation.backendTarget!, lease: snapshot.runtimeRegistryLease }) : null;
          const registration = descriptor ? snapshot.runtimeRegistry.agentRuntimesByAgentId.get(descriptor.agentId) : null;
          const binding = registration?.hasPrimaryRuntime ? registration.sessionRunnerFactoryBinding : undefined;
          if (operation.backendTarget && (!descriptor || !binding || !registration?.isCurrent())) return unavailable();
          const projection = RunnerExecutionRunSnapshotV1Schema.parse({ kind: 'execution_run.snapshot', snapshotId: randomUUID(),
            ...(descriptor && binding ? { agent: { descriptor, binding } } : {}),
            profiles: [...snapshot.profileCatalog.profileDescriptorsById.values()].flatMap(profile =>
              profile.pluginId && profile.sourceCustody ? [{ pluginId: profile.pluginId,
                sourceCustody: profile.sourceCustody, definition: profile.definition }] : []),
          });
          context.signal?.throwIfAborted();
          if (!await context.isCurrent()) return unavailable();
          held.set(projection.snapshotId, { context, snapshot, projection,
            ...(operation.backendTarget ? { backendTarget: operation.backendTarget } : {}),
            provider: { resources: createProviderLaunchResourceScope(), retired: false } });
          return { ok: true as const, result: projection };
        } catch (error) {
          await snapshot.release();
          throw error;
        }
      }
      if (operation.kind === 'execution_run.snapshot.release_v1') {
        if (!read(operation.snapshotId, context)) return unavailable();
        await release(operation.snapshotId);
        return { ok: true as const, result: { kind: 'execution_run.snapshot.released' as const } };
      }
      if (operation.kind === 'execution_run.native_offered_model.read_v1') {
        const snapshotId = request.context.executionRunSnapshotId;
        const retained = snapshotId ? read(snapshotId, context) : null;
        const agent = retained?.projection.agent;
        if (!retained?.backendTarget || !agent || !input.withNativeModelAccount || !context.trackedSession
          || !areExecutionRunBackendTargetsEqual(retained.backendTarget, operation.backendTarget)) return unavailable();
        const registration = retained.snapshot.runtimeRegistry.agentRuntimesByAgentId.get(agent.descriptor.agentId);
        const isCurrent = async () => read(snapshotId!, context) === retained && await context.isCurrent()
          && isDeepStrictEqual(agent.binding, registration?.sessionRunnerFactoryBinding) && registration?.isCurrent();
        if (!await isCurrent()) return unavailable();
        const catalogEntry = await retained.snapshot.runtimeRegistry.acquireAgentCatalogEntry?.(agent.descriptor.agentId);
        if (!catalogEntry || !await isCurrent()) return unavailable();
        const model = await input.withNativeModelAccount(context, async account => await readNativeExecutionRunOfferedModel({
          ...operation, backendTarget: convertBackendTargetRefV2ToV1(operation.backendTarget),
          ...account, catalogEntry, registrySnapshot: retained.snapshot.runtimeRegistry.contributes,
          runtimeCacheKey: retained.snapshot.runtimeRegistry.readPluginOccurrenceId?.(agent.binding.pluginId) ?? undefined,
          createAgentInvocationServices: retained.snapshot.runtimeRegistry.createAgentInvocationServices,
          isCurrent: () => read(snapshotId!, context) === retained && registration?.isCurrent() === true,
          ...(context.signal ? { signal: context.signal } : {}),
        }));
        if (!await isCurrent()) return unavailable();
        return { ok: true as const, result: { kind: 'execution_run.native_offered_model' as const, model: model ?? null } };
      }
      if (operation.kind === 'execution_run.provider.admit_v1' || operation.kind === 'execution_run.provider.prepare_v1'
        || operation.kind === 'execution_run.provider.revalidate_v1' || operation.kind === 'execution_run.provider.release_v1') {
        const snapshotId = request.context.executionRunSnapshotId;
        const retained = snapshotId ? read(snapshotId, context) : null;
        if (!retained || !context.trackedSession || !await context.isCurrent()) return unavailable();
        context.signal?.throwIfAborted();
        const provider = retained.provider;
        if (operation.kind === 'execution_run.provider.release_v1') {
          provider.retired = true;
          await provider.preparation?.catch(() => undefined);
          await provider.resources.release();
          return { ok: true as const, result: { kind: 'execution_run.provider.released' as const } };
        }
        if (provider.retired) return unavailable();
        if (operation.kind === 'execution_run.provider.admit_v1') {
          // Older surviving Session runners send this preflight. Acknowledge
          // the active snapshot; only prepare_v1 authorizes the actual launch.
          return { ok: true as const, result: { kind: 'execution_run.provider.admitted' as const, ok: true as const } };
        }
        if (operation.kind === 'execution_run.provider.revalidate_v1') {
          if (!provider.preparation) return unavailable();
          const prepared = await provider.preparation;
          const result = await prepared.revalidateBeforeCommit(context.signal);
          if (read(snapshotId!, context) !== retained || !await context.isCurrent()) return unavailable();
          return { ok: true as const, result: { kind: 'execution_run.provider.revalidated' as const, result } };
        }
        if (!input.resolveProviderPreparation || !retained.backendTarget) return unavailable();
        const { kind: _kind, ...providerRequest } = operation;
        const services = createRunnerExecutionRunProviderLaunchServices({ agent: retained.projection.agent,
          backendTarget: retained.backendTarget, runtimeRegistryLease: retained.snapshot.runtimeRegistryLease,
          retainCleanup: provider.resources.register,
          resolvePreparation: async value => {
            const preparation = await input.resolveProviderPreparation!(value, context);
            if (!preparation) return null;
            return { ...preparation, signal: context.signal, readCurrentnessRefusal: async () => {
              if (provider.retired) return 'run_snapshot_retired';
              if (read(snapshotId!, context) !== retained) return 'run_snapshot_replaced';
              return await preparation.readCurrentnessRefusal();
            } };
          },
        });
        try {
          if (provider.request && !isDeepStrictEqual(provider.request, providerRequest)) return unavailable();
          provider.request ??= providerRequest;
          provider.preparation ??= services.prepareLaunch(providerRequest);
          const prepared = await provider.preparation;
          context.signal?.throwIfAborted();
          if (provider.retired || read(snapshotId!, context) !== retained || !await context.isCurrent()) {
            await provider.resources.release();
            return unavailable();
          }
          return { ok: true as const, result: { kind: 'execution_run.provider.prepared' as const,
            ...projectRunnerExecutionRunProviderLaunch(prepared) } };
        } catch (error) {
          const details = error && typeof error === 'object' && 'details' in error ? error.details : null;
          const parsed = ProviderErrorV1Schema.safeParse(details && typeof details === 'object' && 'providerError' in details ? details.providerError : error);
          if (!parsed.success) throw error;
          return { ok: true as const, result: { kind: 'execution_run.provider.prepared' as const,
            ok: false as const, providerError: parsed.data,
            childChoiceRequired: Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'execution_run_child_choice_required') } };
        }
      }
      if (operation.kind === 'execution_run.review_scm_scope.resolve_v1'
        || operation.kind === 'execution_run.commit_message_context.resolve_v1'
        || operation.kind === 'execution_run.scm_commit_target.capture_v1') {
        const snapshotId = request.context.executionRunSnapshotId;
        const retained = snapshotId ? read(snapshotId, context) : null;
        if (!retained || !context.trackedSession || !await context.isCurrent()) return unavailable();
        context.signal?.throwIfAborted();
        const registry = await resolveDefaultScmBackendRegistry({ pluginRuntimeRegistry: retained.snapshot.runtimeRegistry });
        const result = operation.kind === 'execution_run.review_scm_scope.resolve_v1'
          ? { kind: 'execution_run.review_scm_scope' as const,
            scope: await resolveReviewScmScope({ cwd: operation.cwd, intentInput: operation.intentInput, registry }) }
          : operation.kind === 'execution_run.commit_message_context.resolve_v1'
            ? { kind: 'execution_run.commit_message_context' as const,
              context: await loadScmCommitMessageContext({ ...operation, registry }).then(context => context.ok
                ? { ...context, diffsByPath: [...context.diffsByPath] } : context) }
            : { kind: 'execution_run.scm_commit_target' as const,
              capture: await captureScmComparisonCommitTarget({ cwd: operation.cwd, registry }) };
        context.signal?.throwIfAborted();
        if (read(snapshotId!, context) !== retained || !await context.isCurrent()) return unavailable();
        return { ok: true as const, result };
      }
      return unavailable();
    },
    async releaseForRunnerExit(tracked: TrackedSession) {
      await Promise.all([...held].filter(([, value]) => value.context.trackedSession === tracked)
        .map(([snapshotId]) => release(snapshotId)));
    },
    async dispose() { await Promise.all([...held.keys()].map(release)); },
  });
}
