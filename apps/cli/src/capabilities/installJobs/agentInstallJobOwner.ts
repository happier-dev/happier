import { randomUUID } from 'node:crypto';
import { ExecFileTerminationError } from '@happier-dev/cli-common/process';
import { installAgentCliForRuntime, resolvePlatformFromNodePlatform, type AgentInstallProgressCallback } from '@happier-dev/cli-common/agents';
import { DaemonAgentInstallStartRequestSchema, DaemonAgentInstallReadRequestSchema, DaemonAgentInstallCancelRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { PluginAgentCliInstallMetadataSchema } from '@happier-dev/protocol/plugins/contributions/agentCliMetadata';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AgentInstallJob, AgentInstallJobEvent, AgentInstallJobFailureCode, AgentInstallJobOutcome, DaemonAgentInstallStartRequest, DaemonAgentInstallReadRequest, DaemonAgentInstallCancelRequest, DaemonAgentInstallStartResponse, DaemonAgentInstallReadResponse, DaemonAgentInstallCancelResponse, DaemonAgentInstallListResponse } from '@happier-dev/protocol';
import type { ResolvedAgentContribution, ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { invalidateCliSnapshots, probeAgentCliForInstall } from '@/capabilities/snapshots/cliSnapshot';
import { withAgentCliUpdates } from '@/capabilities/cliUpdate/agentCliUpdates';
import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import { resolveAgentRuntimeManagedDependencyId, resolveExecutableManagedDependenciesRegistry, selectExecutableManagedDependencies } from '@/plugins/projection/registry/managedDependencyExecutables';
import { executeInstallCommand } from './executeInstallCommand';
import { resolveAgentSetupPlatform } from '@happier-dev/protocol/agents/setup';

export type AgentInstallJobRegistry = Readonly<{
  agents: readonly Pick<ResolvedAgentContribution, 'id' | 'runtimeSpec' | 'pluginId' | 'richDefinition' | 'hostAccess' | 'cliMetadata'>[];
  managedDependencies?: readonly ResolvedInstallableContribution[];
}>;

export type AgentInstallJobOwnerOptions = Readonly<{
  readRegistry?: () => AgentInstallJobRegistry;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  installerDeps?: Parameters<typeof installAgentCliForRuntime>[0]['deps'];
}>;

type JobRecord = {
  snapshot: AgentInstallJob;
  events: AgentInstallJobEvent[];
  controller: AbortController;
  completion: Promise<void>;
  cleanupError: ExecFileTerminationError | null;
};

function failureCode(code: string): AgentInstallJobFailureCode {
  switch (code) {
    case 'vendor-recipe-disallowed': return 'consent_required';
    case 'install-confirmation-required': return 'consent_required';
    case 'unsupported-platform': return 'unsupported_platform';
    case 'no-recipe': return 'install_not_available';
    case 'install-not-available': return 'install_not_available';
    case 'download-failed': return 'download_failed';
    case 'verification-failed':
    case 'update-not-verified': return 'verification_failed';
    case 'command-timed-out': return 'timeout';
    case 'update-not-available': return 'update_not_available';
    default: return 'install_failed';
  }
}

export function createAgentInstallJobOwner(options: AgentInstallJobOwnerOptions = {}) {
  const readRegistry = options.readRegistry ?? readCurrentContributionRegistry;
  const env = options.env ?? process.env;
  const installerDeps = { execFileWithDeadline: executeInstallCommand, ...options.installerDeps };
  const host = { platform: options.platform ?? process.platform, architecture: options.arch ?? process.arch };
  const jobs = new Map<string, JobRecord>();
  const activeByAgent = new Map<string, JobRecord>();
  // Reconnection needs the active job and the latest completed attempt, not an
  // unbounded daemon-lifetime audit trail. Each agent retains one terminal job.
  const recentByAgent = new Map<string, JobRecord>();
  let shuttingDown = false;

  const emit = (job: JobRecord, event: AgentInstallJobEvent) => {
    job.events.push(event);
    if (event.t === 'step') {
      job.snapshot.steps = [...job.snapshot.steps.filter((step) => step.stepId !== event.stepId), {
        stepId: event.stepId, label: event.label, state: event.state,
      }];
    } else if (event.t === 'progress') {
      job.snapshot.progress = [...job.snapshot.progress.filter((progress) => progress.stepId !== event.stepId), {
        stepId: event.stepId, bytesDone: event.bytesDone, bytesTotal: event.bytesTotal,
      }];
    }
  };
  const progressFor = (job: JobRecord, stepId: string): AgentInstallProgressCallback => (event) => {
    emit(job, event.t === 'progress' ? { ...event, stepId } : event);
  };

  const run = async (job: JobRecord, input: DaemonAgentInstallStartRequest, registry: AgentInstallJobRegistry, agent: AgentInstallJobRegistry['agents'][number]) => {
    const spec = agent.runtimeSpec;
    if (!spec) return;
    const signal = job.controller.signal;
    let stepId = `cli.${agent.id}`;
    let label = spec.title;
    const begin = (id: string, title: string) => {
      signal.throwIfAborted();
      stepId = id;
      label = title;
      emit(job, { t: 'step', stepId, label, state: 'running' });
    };
    const done = () => emit(job, { t: 'step', stepId, label, state: 'done' });
    const fail = (code: AgentInstallJobFailureCode, message: string): AgentInstallJobOutcome => ({
      kind: 'failed', code, stepId, message,
      ...(code === 'install_not_available' && (spec.installGuideUrl ?? spec.docsUrl)
        ? { guideUrl: spec.installGuideUrl ?? spec.docsUrl ?? undefined } : {}),
    });
    let result: AgentInstallJobOutcome;
    try {
      begin(stepId, label);
      const platform = resolvePlatformFromNodePlatform(host.platform);
      if (!platform) {
        result = fail('unsupported_platform', `Agent installation is not supported on ${host.platform}.`);
      } else {
        // Resolve all declared dependencies before any acquisition starts. A
        // request-only or unsupported declaration cannot silently disappear.
        const dependencyId = resolveAgentRuntimeManagedDependencyId(agent);
        const required = new Set(dependencyId ? [dependencyId] : []);
        const contributions = registry.managedDependencies ?? [];
        const dependencyRegistry = resolveExecutableManagedDependenciesRegistry(contributions, host);
        const declarations = contributions.filter((candidate) => candidate.pluginId && required.has(buildQualifiedPluginContributionKey({ pluginId: candidate.pluginId, localId: candidate.definition.id })));
        const support = resolveAgentSetupPlatform({
          cli: agent.cliMetadata ?? { install: PluginAgentCliInstallMetadataSchema.parse({ managed: spec.managedInstall, manual: spec.manualInstallKind === 'none'
            ? { kind: 'none' } : { kind: spec.manualInstallKind, recipes: spec.manualInstallRecipes ?? undefined } }) },
          dependencies: declarations.flatMap((candidate) => 'version' in candidate.definition ? [] : [candidate.definition]),
          platform: host.platform, arch: host.architecture,
        });
        const dependencies = selectExecutableManagedDependencies(declarations, host);
        const unresolved = dependencyId && dependencies.length === 0 ? dependencyId : null;
        if (!support.supported) {
          result = fail('unsupported_platform', 'The agent or its required dependency does not support this host platform.');
        } else if (unresolved) {
          result = fail('install_not_available', `Required dependency ${unresolved} is not installable on this host.`);
        } else {
          let cliFailure: AgentInstallJobOutcome | null = null;
          if (input.intent === 'update') {
            const capability = withAgentCliUpdates({
              descriptor: { id: `cli.${agent.id}`, kind: 'cli', title: spec.title, methods: { install: { title: 'Install' } } },
              detect: () => probeAgentCliForInstall({ runtimeSpec: spec, env, signal, execFile: installerDeps.execFileWithDeadline }),
            }, agent.id, {
              env, nodePlatform: host.platform, signal, onProgress: progressFor(job, stepId), installerDeps,
              resolveRuntimeSpec: () => spec,
              buildContext: async () => ({ cliSnapshot: null }),
            });
            const updated = await capability.invoke?.({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: input.consent.vendorRecipe }, signal });
            if (!updated?.ok) {
              const code = updated?.error.code ?? 'install-failed';
              if (code === 'termination-failed') job.cleanupError = new ExecFileTerminationError(new Error(updated?.error.message));
              cliFailure = fail(failureCode(code), updated?.error.message ?? 'Agent update failed.');
            }
          } else {
            const installed = await installAgentCliForRuntime({
              runtimeSpec: spec, platform, env, skipIfInstalled: !input.force,
              allowVendorRecipeExecution: input.consent.vendorRecipe, signal,
              onProgress: progressFor(job, stepId), deps: installerDeps,
            });
            if (!installed.ok) {
              if (installed.errorCode === 'termination-failed') job.cleanupError = new ExecFileTerminationError(new Error(installed.errorMessage));
              cliFailure = fail(failureCode(installed.errorCode), installed.errorMessage);
            }
          }
          if (cliFailure) {
            result = cliFailure;
          } else {
            signal.throwIfAborted();
            done();
            for (const dependency of dependencies) {
              const descriptor = dependency.definition;
              begin(descriptor.capabilityId, descriptor.display.name);
              const adapter = await getRuntimeInstallableAdapter(descriptor.key, { installablesRegistry: dependencyRegistry });
              const installed = await adapter.installOrUpgrade({ signal, onProgress: progressFor(job, stepId), env });
              if (!installed.ok) {
                if (installed.errorCode === 'termination-failed') job.cleanupError = new ExecFileTerminationError(new Error(installed.errorMessage));
                cliFailure = fail(failureCode(installed.errorCode ?? 'install-failed'), installed.errorMessage);
                break;
              }
              signal.throwIfAborted();
              const detected = await adapter.detectLaunchResolution({ env });
              signal.throwIfAborted();
              if (!detected.availability.ok) {
                cliFailure = fail('verification_failed', detected.availability.errorMessage);
                break;
              }
              done();
            }
            if (cliFailure) {
              result = cliFailure;
            } else {
              begin('verify', 'Check it runs');
              invalidateCliSnapshots();
              const verified = await probeAgentCliForInstall({ runtimeSpec: spec, env, signal, execFile: installerDeps.execFileWithDeadline });
              signal.throwIfAborted();
              if (!verified.available || !verified.version) {
                result = fail('verification_failed', 'The installed agent did not report a version.');
              } else {
                done();
                result = { kind: 'succeeded', version: verified.version };
              }
            }
          }
        }
      }
    } catch (error) {
      const terminationFailed = error instanceof ExecFileTerminationError;
      if (terminationFailed) job.cleanupError = error;
      const cancelled = signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'));
      result = fail(cancelled && !terminationFailed ? 'cancelled' : 'install_failed', error instanceof Error ? error.message : 'Agent installation failed.');
    }
    if (result.kind === 'failed') emit(job, { t: 'step', stepId, label, state: 'failed' });
    invalidateCliSnapshots();
    job.snapshot.outcome = result;
    job.snapshot.done = true;
    // Failed containment is still an excluded writer: don't allow another
    // install to race a command whose process cleanup could not be verified.
    if (!job.cleanupError) activeByAgent.delete(agent.id);
    const previous = recentByAgent.get(agent.id);
    if (previous) jobs.delete(previous.snapshot.jobId);
    recentByAgent.set(agent.id, job);
  };

  return {
    start(input: DaemonAgentInstallStartRequest): DaemonAgentInstallStartResponse {
      const parsed = DaemonAgentInstallStartRequestSchema.safeParse(input);
      if (!parsed.success) return { ok: false, errorCode: 'invalid_request', error: 'Invalid install request.' };
      if (shuttingDown) return { ok: false, errorCode: 'install_unavailable', error: 'The daemon is shutting down.' };
      const active = activeByAgent.get(input.agentId);
      if (active?.cleanupError) return { ok: false, errorCode: 'install_unavailable', error: 'The previous install process cleanup could not be verified. Stop that process manually and restart the daemon before retrying.' };
      if (active) return { ok: true, jobId: active.snapshot.jobId };
      let registry: AgentInstallJobRegistry;
      try { registry = readRegistry(); } catch {
        return { ok: false, errorCode: 'install_unavailable', error: 'The agent registry is unavailable.' };
      }
      const currentAgentIds = new Set(registry.agents.map((agent) => agent.id));
      for (const [agentId, previous] of recentByAgent) {
        if (!currentAgentIds.has(agentId) && !activeByAgent.has(agentId)) {
          recentByAgent.delete(agentId);
          jobs.delete(previous.snapshot.jobId);
        }
      }
      const agent = registry.agents.find((candidate) => candidate.id === input.agentId);
      if (!agent?.runtimeSpec) return { ok: false, errorCode: 'install_unavailable', error: 'The agent has no registered CLI runtime.' };
      const job: JobRecord = {
        snapshot: { jobId: randomUUID(), agentId: agent.id, intent: input.intent, startedAt: Date.now(), steps: [], progress: [], done: false, outcome: null },
        events: [], controller: new AbortController(), completion: Promise.resolve(), cleanupError: null,
      };
      jobs.set(job.snapshot.jobId, job);
      activeByAgent.set(agent.id, job);
      // Start on the next microtask so admission publishes the active record
      // before even a synchronously rejected install can settle.
      job.completion = Promise.resolve().then(() => run(job, parsed.data, registry, agent));
      return { ok: true, jobId: job.snapshot.jobId };
    },
    read(input: DaemonAgentInstallReadRequest): DaemonAgentInstallReadResponse {
      if (!DaemonAgentInstallReadRequestSchema.safeParse(input).success) return { ok: false, errorCode: 'invalid_request', error: 'Invalid install read request.' };
      const job = jobs.get(input.jobId);
      if (!job) return { ok: false, errorCode: 'job_not_found', error: 'Install job not found.' };
      if (input.cursor > job.events.length) return { ok: false, errorCode: 'invalid_request', error: 'Install cursor is beyond the available events.' };
      return { ok: true, events: structuredClone(job.events.slice(input.cursor)), nextCursor: job.events.length,
        steps: structuredClone(job.snapshot.steps), progress: structuredClone(job.snapshot.progress),
        done: job.snapshot.done, outcome: structuredClone(job.snapshot.outcome) };
    },
    async cancel(input: DaemonAgentInstallCancelRequest): Promise<DaemonAgentInstallCancelResponse> {
      if (!DaemonAgentInstallCancelRequestSchema.safeParse(input).success) return { ok: false, errorCode: 'invalid_request', error: 'Invalid install cancellation request.' };
      const job = jobs.get(input.jobId);
      if (!job) return { ok: false, errorCode: 'job_not_found', error: 'Install job not found.' };
      if (!job.snapshot.done) job.controller.abort();
      await job.completion;
      if (job.cleanupError) return { ok: false, errorCode: 'install_unavailable', error: job.cleanupError.message };
      return { ok: true };
    },
    list(): DaemonAgentInstallListResponse { return { ok: true, jobs: [...jobs.values()].map((job) => structuredClone(job.snapshot)) }; },
    async shutdown(): Promise<void> {
      shuttingDown = true;
      const active = [...activeByAgent.values()];
      for (const job of active) job.controller.abort();
      await Promise.all(active.map((job) => job.completion));
      const failedCleanup = active.find((job) => job.cleanupError)?.cleanupError;
      if (failedCleanup) throw failedCleanup;
    },
  };
}

export type AgentInstallJobOwner = ReturnType<typeof createAgentInstallJobOwner>;
let daemonOwner: AgentInstallJobOwner | null = null;
export function getDaemonAgentInstallJobOwner(): AgentInstallJobOwner {
  return daemonOwner ??= createAgentInstallJobOwner();
}
