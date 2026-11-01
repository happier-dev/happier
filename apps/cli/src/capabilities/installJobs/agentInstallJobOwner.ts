import { randomUUID } from 'node:crypto';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { ExecFileTerminationError } from '@happier-dev/cli-common/process';
import { hasAgentCliManagedInstallForRuntime, installAgentCliForRuntime, removeAgentCliManagedInstallForRuntime, resolvePlatformFromNodePlatform, type AgentInstallProgressCallback } from '@happier-dev/cli-common/agents';
import { DaemonAgentInstallStartRequestSchema, DaemonAgentInstallReadRequestSchema, DaemonAgentInstallCancelRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { PluginAgentCliInstallMetadataSchema } from '@happier-dev/protocol/plugins/contributions/agentCliMetadata';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AgentInstallJob, AgentInstallJobEvent, AgentInstallJobFailureCode, AgentInstallJobOutcome, DaemonAgentInstallStartRequest, DaemonAgentInstallReadRequest, DaemonAgentInstallCancelRequest, DaemonAgentInstallStartResponse, DaemonAgentInstallReadResponse, DaemonAgentInstallCancelResponse, DaemonAgentInstallListResponse } from '@happier-dev/protocol';
import type { ResolvedAgentContribution, ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { invalidateCliSnapshots, probeAgentCliForInstall } from '@/capabilities/snapshots/cliSnapshot';
import { withAgentCliUpdates } from '@/capabilities/cliUpdate/agentCliUpdates';
import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import { resolveAgentRuntimeManagedDependencyId, resolveExecutableManagedDependenciesRegistry, selectExecutableManagedDependencies } from '@/plugins/projection/registry/managedDependencyExecutables';
import { executeInstallCommand } from './executeInstallCommand';
import { resolveAgentSetupPlatform } from '@happier-dev/protocol/agents/setup';
import type { LiveWorkItemV1, LiveWorkProducerV1 } from '@/daemon/lifecycle/managedActivity';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, isCustomAcpAgentContributionIdentityV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { getAcpArchiveInstallableDescriptor, getAcpNpmRuntimeSpec, getAcpUvRuntimeSpec, installAcpLaunch, resolveAcpLaunch, type AcpLaunchInstallResult } from '@/agent/acp/catalog/configured/resolveAcpLaunch';
import { hasPinnedArchiveManagedInstall } from '@/packagedRuntime/installables/sourceAdapters/pinnedArchive';
import { isAgentInstallTargetInUse, removeManagedAcpInstall } from '@/agent/acp/catalog/registry/managedAgentInstalls';
import type { TrackedSession } from '@/daemon/types';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities/machineAgentInventory';

export type AgentInstallJobRegistry = Readonly<{
  agents: readonly Pick<ResolvedAgentContribution, 'id' | 'identity' | 'runtimeSpec' | 'pluginId' | 'richDefinition' | 'hostAccess' | 'cliMetadata'>[];
  managedDependencies?: readonly ResolvedInstallableContribution[];
}>;

export type AgentInstallJobOwnerOptions = Readonly<{
  accountId?: string;
  readRegistry?: () => AgentInstallJobRegistry;
  env?: ProcessEnvInput;
  platform?: NodeJS.Platform;
  arch?: string;
  installerDeps?: Parameters<typeof installAgentCliForRuntime>[0]['deps'];
  admissionDrain?: Pick<DaemonAdmissionDrain, 'isQuiescing' | 'isFinalShutdown'>;
  readAcpCatalog?: () => AcpCatalogSnapshotV1 | undefined;
  readTrackedSessions?: () => Iterable<TrackedSession>;
}>;

type JobRecord = {
  accountId?: string;
  activeKey: string;
  recentKey: string;
  snapshot: AgentInstallJob;
  events: AgentInstallJobEvent[];
  controller: AbortController;
  completion: Promise<void>;
  cleanupError: ExecFileTerminationError | null;
};

function failureCode(code: string): AgentInstallJobFailureCode {
  switch (code) {
    case 'in_use': return 'in_use';
    case 'not_managed': return 'not_managed';
    case 'vendor-recipe-disallowed': return 'consent_required';
    case 'install-confirmation-required': return 'consent_required';
    case 'unsupported-platform': return 'unsupported_platform';
    case 'no-recipe': return 'install_not_available';
    case 'install-not-available': return 'install_not_available';
    case 'archive-expanded-byte-limit': return 'archive_expanded_byte_limit';
    case 'download-failed': return 'download_failed';
    case 'rate-limited': return 'rate_limited';
    case 'verification-failed':
    case 'update-not-verified': return 'verification_failed';
    case 'command-timed-out': return 'timeout';
    case 'update-not-available': return 'update_not_available';
    default: return 'install_failed';
  }
}

export function createAgentInstallJobOwner(options: AgentInstallJobOwnerOptions = {}) {
  let accountId = options.accountId;
  let admissionDrain = options.admissionDrain;
  let readTrackedSessions = options.readTrackedSessions;
  let readAcpCatalog = options.readAcpCatalog ?? (() => getActiveAccountSettingsSnapshot()?.acpCatalog);
  const readRegistry = options.readRegistry ?? readCurrentContributionRegistry;
  const env = options.env ?? process.env;
  const installerDeps = { execFileWithDeadline: executeInstallCommand, ...options.installerDeps };
  const host = { platform: options.platform ?? process.platform, architecture: options.arch ?? process.arch };
  const jobs = new Map<string, JobRecord>();
  const activeByAgent = new Map<string, JobRecord>();
  // Reconnection needs the active job and the latest completed attempt, not an
  // unbounded daemon-lifetime audit trail. Each target retains one terminal job.
  const recentByAgent = new Map<string, JobRecord>();
  const activityListeners = new Set<() => void>();
  const notifyActivity = (): void => {
    for (const listener of activityListeners) {
      try { listener(); } catch { /* Observation cannot alter installer custody. */ }
    }
  };
  const activity: LiveWorkProducerV1 = {
    read: () => ({ coverage: 'complete', items: [...jobs.values()].map((job): LiveWorkItemV1 => ({
      category: 'setup', ownerRef: job.snapshot.jobId, attribution: { kind: 'unknown' },
      // A public terminal result is not process-terminal evidence when the
      // actual installer owner retained a failed-containment writer.
      state: job.cleanupError ? 'unknown' : job.snapshot.done ? 'settled' : 'active',
    })) }),
    subscribe: listener => {
      activityListeners.add(listener);
      return () => { activityListeners.delete(listener); };
    },
  };
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

  const targetKey = (target: Pick<DaemonAgentInstallStartRequest, 'agentId' | 'definitionId'>, account?: string) =>
    JSON.stringify([target.definitionId === undefined ? null : account, buildMachineAgentInventoryKey(target)]);
  const inUse = (target: Pick<DaemonAgentInstallStartRequest, 'agentId' | 'definitionId'>): boolean => {
    try { return !readTrackedSessions || isAgentInstallTargetInUse(target, readTrackedSessions()); }
    catch { return true; }
  };
  const settle = (job: JobRecord, result: AgentInstallJobOutcome) => {
    invalidateCliSnapshots();
    job.snapshot.outcome = result;
    job.snapshot.done = true;
    const key = job.recentKey;
    // A failed-containment writer remains excluded even after its public terminal outcome.
    if (!job.cleanupError) activeByAgent.delete(job.activeKey);
    const previous = recentByAgent.get(key);
    if (previous && !previous.cleanupError) jobs.delete(previous.snapshot.jobId);
    recentByAgent.set(key, job);
    notifyActivity();
  };
  const runDefinition = async (job: JobRecord, input: DaemonAgentInstallStartRequest, definition: AcpBackendDefinitionV1 | undefined) => {
    const signal = job.controller.signal;
    const stepId = `cli.${input.agentId}.${input.definitionId}`;
    const label = definition?.title ?? 'Remove managed Agent';
    emit(job, { t: 'step', stepId, label, state: 'running' });
    const fail = (code: AgentInstallJobFailureCode, message: string): AgentInstallJobOutcome => ({ kind: 'failed', code, stepId, message });
    let result: AgentInstallJobOutcome;
    try {
      signal.throwIfAborted();
      if ((input.intent === 'uninstall' || input.force) && inUse(input)) {
        result = fail('in_use', 'Stop the sessions using this Agent before changing its managed installation.');
      } else if (input.intent === 'uninstall') {
        const removed = await removeManagedAcpInstall({ accountId: job.accountId, definitionId: input.definitionId!, env, signal,
          isDefinitionInUse: () => inUse(input) });
        result = removed.ok ? { kind: 'succeeded', version: null }
          : fail(removed.code, removed.code === 'in_use' ? 'The Agent is in use.' : 'The Agent is not installed through Happier.');
      } else if (!definition || definition.launch.kind === 'command') {
        result = fail('install_not_available', 'This definition has no managed installation.');
      } else {
        const params = { accountId: job.accountId, definition, env, platform: host.platform, arch: host.architecture, signal,
          onProgress: progressFor(job, stepId), intent: input.intent, force: input.force };
        const archive = getAcpArchiveInstallableDescriptor(definition, job.accountId!);
        const npm = getAcpNpmRuntimeSpec(definition, job.accountId!);
        const uv = getAcpUvRuntimeSpec(definition, job.accountId!);
        const resolutionBeforeInstall = await resolveAcpLaunch(params);
        const retained = archive
          ? await hasPinnedArchiveManagedInstall({ installId: archive.capabilityId, env })
          : (npm ?? uv) !== null && await hasAgentCliManagedInstallForRuntime({ runtimeSpec: (npm ?? uv)!, env });
        // A pin change acquires another root. Repair/removal of this exact version still needs live-use evidence.
        const needsRemoval = retained && (input.force || resolutionBeforeInstall.kind !== 'ready');
        const replacingInUse = needsRemoval && inUse(input);
        if (replacingInUse) {
          result = fail('in_use', 'Stop the sessions using this Agent before replacing its managed installation.');
        } else {
          const removed = needsRemoval ? await removeManagedAcpInstall({ accountId: job.accountId,
            definitionId: definition.id, version: definition.launch.version, env, signal, isDefinitionInUse: () => inUse(input) }) : { ok: true as const };
          const installed: AcpLaunchInstallResult = removed.ok ? await installAcpLaunch(params, { installerDeps })
            : { ok: false, errorCode: removed.code, errorMessage: 'The retained version cannot be removed for repair.', logPath: null };
          if (!installed.ok) {
            if (installed.errorCode === 'termination-failed') job.cleanupError = new ExecFileTerminationError(new Error(installed.errorMessage));
            result = fail(failureCode(installed.errorCode ?? 'install-failed'), installed.errorMessage);
          } else {
            signal.throwIfAborted();
            const resolution = await resolveAcpLaunch(params);
            signal.throwIfAborted();
            result = resolution.kind === 'ready' ? { kind: 'succeeded', version: definition.launch.version,
              ...(installed.checksum ? { checksum: installed.checksum } : {}) }
              : fail('verification_failed', 'The installed definition does not resolve to a ready launch.');
          }
        }
      }
    } catch (error) {
      const terminationFailed = error instanceof ExecFileTerminationError;
      if (terminationFailed) job.cleanupError = error;
      const cancelled = signal.aborted && (error === signal.reason || error instanceof Error && error.name === 'AbortError');
      result = fail(cancelled && !terminationFailed ? 'cancelled' : 'install_failed', error instanceof Error ? error.message : 'Agent installation failed.');
    }
    emit(job, { t: 'step', stepId, label, state: result.kind === 'succeeded' ? 'done' : 'failed' });
    settle(job, result);
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
      if ((input.intent === 'update' || input.intent === 'uninstall' || input.force) && inUse(input)) {
        result = fail('in_use', 'Stop the sessions using this Agent before changing its managed installation.');
        emit(job, { t: 'step', stepId, label, state: 'failed' });
        settle(job, result);
        return;
      }
      if (input.intent === 'uninstall') {
        const removed = spec.managedInstall ? await removeAgentCliManagedInstallForRuntime({ runtimeSpec: spec, env, signal })
          : { ok: false as const, code: 'not_managed' as const };
        result = removed.ok ? { kind: 'succeeded', version: null } : fail(removed.code, 'The Agent is not installed through Happier.');
        if (removed.ok) done();
        settle(job, result);
        return;
      }
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
        } else if (input.intent === 'install' && inUse(input)
          && (spec.managedInstall && await hasAgentCliManagedInstallForRuntime({ runtimeSpec: spec, env })
            || await (async () => {
              for (const dependency of dependencies) {
                const descriptor = dependency.definition;
                if (descriptor.source.kind === 'pinned_archive') {
                  if (await hasPinnedArchiveManagedInstall({ installId: descriptor.capabilityId, env })) return true;
                } else {
                  const adapter = await getRuntimeInstallableAdapter(descriptor.key, { installablesRegistry: dependencyRegistry });
                  const command = await adapter.resolveLaunchCommand?.({ env });
                  if (command?.ok && command.source === 'managed') return true;
                }
              }
              return false;
            })())) {
          result = fail('in_use', 'Stop the sessions using this Agent before replacing its managed installation.');
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
    settle(job, result);
  };

  return {
    activity,
    isDefinitionJob(jobId: string): boolean { return jobs.get(jobId)?.snapshot.definitionId !== undefined; },
    bindAccountId(id: string): void { accountId = id; },
    bindAdmissionDrain(drain: NonNullable<AgentInstallJobOwnerOptions['admissionDrain']>): void {
      admissionDrain = drain;
    },
    bindTrackedSessions(reader: NonNullable<AgentInstallJobOwnerOptions['readTrackedSessions']>): void {
      readTrackedSessions = reader;
    },
    bindAcpCatalog(reader: NonNullable<AgentInstallJobOwnerOptions['readAcpCatalog']>): void {
      readAcpCatalog = reader;
    },
    start(input: DaemonAgentInstallStartRequest, account?: Readonly<{ accountId: string; catalog: AcpCatalogSnapshotV1 }>): DaemonAgentInstallStartResponse {
      const parsed = DaemonAgentInstallStartRequestSchema.safeParse(input);
      if (!parsed.success || parsed.data.expectedDefinitionVersion !== undefined
        && (parsed.data.definitionId === undefined || parsed.data.intent === 'uninstall')) {
        return { ok: false, errorCode: 'invalid_request', error: 'Invalid install request.' };
      }
      if (shuttingDown) return { ok: false, errorCode: 'install_unavailable', error: 'The daemon is shutting down.' };
      const active = input.definitionId === undefined ? activeByAgent.get(targetKey(input)) : undefined;
      if (active?.cleanupError) return { ok: false, errorCode: 'install_unavailable', error: 'The previous install process cleanup could not be verified.' };
      if (active) return { ok: true, jobId: active.snapshot.jobId };
      let registry: AgentInstallJobRegistry;
      try { registry = readRegistry(); } catch {
        return { ok: false, errorCode: 'install_unavailable', error: 'The agent registry is unavailable.' };
      }
      const currentAgentIds = new Set(registry.agents.map((agent) => agent.id));
      for (const [key, previous] of recentByAgent) {
        if (!currentAgentIds.has(previous.snapshot.agentId) && ![...activeByAgent.values()].some(active => active.recentKey === key)) {
          recentByAgent.delete(key);
          jobs.delete(previous.snapshot.jobId);
        }
      }
      const identity = parseQualifiedPluginContributionKey(input.agentId)
        ?? (input.agentId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId ? CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 : null);
      const routingId = identity ? readAgentRoutingIdForContributionIdentity(indexAgentRoutingIdsByContributionIdentity(registry.agents), identity) : null;
      const agent = registry.agents.find(candidate => candidate.id === (routingId ?? input.agentId));
      if (!agent || input.definitionId !== undefined && !isCustomAcpAgentContributionIdentityV1(agent.identity)
        || input.definitionId === undefined && !agent.runtimeSpec) return { ok: false, errorCode: 'install_unavailable', error: 'The agent has no registered CLI runtime.' };
      const request = { ...parsed.data, agentId: agent.id };
      if ((request.intent === 'uninstall' || request.force || request.definitionId === undefined && request.intent === 'update') && inUse(request)) {
        return { ok: false, errorCode: 'in_use', error: 'Stop the sessions using this Agent before changing its managed installation. Session use must be known.' };
      }
      let definition: AcpBackendDefinitionV1 | undefined;
      const requestedAccountId = request.definitionId === undefined ? undefined : account?.accountId ?? accountId;
      if (request.definitionId !== undefined && !requestedAccountId) return { ok: false, errorCode: 'install_unavailable', error: 'The configured Agent Account is unavailable.' };
      if (request.definitionId !== undefined && request.intent !== 'uninstall') {
        const catalog = account?.catalog ?? readAcpCatalog();
        if (catalog?.status !== 'ready') return { ok: false, errorCode: 'install_unavailable', error: 'The configured Agent catalog is unavailable.' };
        const captured = catalog.record.definitions.find(entry => entry.id === request.definitionId);
        definition = captured && structuredClone(captured);
        if (!definition) return { ok: false, errorCode: 'install_unavailable', error: 'The configured Agent definition is unavailable.' };
        if (request.expectedDefinitionVersion !== undefined
          && (definition.launch.kind === 'command' || definition.launch.version !== request.expectedDefinitionVersion)) {
          return { ok: false, errorCode: 'definition_version_changed', error: 'The configured Agent version changed after review.' };
        }
      }
      const recentKey = targetKey(request, requestedAccountId);
      const activeKey = request.definitionId === undefined ? recentKey : JSON.stringify([recentKey,
        definition?.launch.kind !== 'command' ? definition?.launch.version ?? null : null]);
      const canonicalActive = activeByAgent.get(activeKey) ?? [...activeByAgent.values()].find(active =>
        active.recentKey === recentKey && (request.intent === 'uninstall' || active.snapshot.intent === 'uninstall'));
      if (canonicalActive?.cleanupError) return { ok: false, errorCode: 'install_unavailable', error: 'The previous install process cleanup could not be verified.' };
      if (canonicalActive) return { ok: true, jobId: canonicalActive.snapshot.jobId };
      if (admissionDrain?.isQuiescing()) return { ok: false, errorCode: 'install_unavailable',
        error: admissionDrain.isFinalShutdown() ? 'The daemon is shutting down.' : 'The daemon is draining.' };
      const job: JobRecord = {
        accountId: requestedAccountId, activeKey, recentKey,
        snapshot: { jobId: randomUUID(), agentId: agent.id, ...(request.definitionId === undefined ? {} : { definitionId: request.definitionId }),
          intent: request.intent, startedAt: Date.now(), steps: [], progress: [], done: false, outcome: null },
        events: [], controller: new AbortController(), completion: Promise.resolve(), cleanupError: null,
      };
      jobs.set(job.snapshot.jobId, job);
      activeByAgent.set(activeKey, job);
      // Start on the next microtask so admission publishes the active record
      // before even a synchronously rejected install can settle.
      job.completion = Promise.resolve().then(() => request.definitionId === undefined ? run(job, request, registry, agent)
        : runDefinition(job, request, definition));
      notifyActivity();
      return { ok: true, jobId: job.snapshot.jobId };
    },
    read(input: DaemonAgentInstallReadRequest, requestedAccountId = accountId): DaemonAgentInstallReadResponse {
      if (!DaemonAgentInstallReadRequestSchema.safeParse(input).success) return { ok: false, errorCode: 'invalid_request', error: 'Invalid install read request.' };
      const job = jobs.get(input.jobId);
      if (!job || job.accountId && requestedAccountId !== undefined && job.accountId !== requestedAccountId) return { ok: false, errorCode: 'job_not_found', error: 'Install job not found.' };
      if (input.cursor > job.events.length) return { ok: false, errorCode: 'invalid_request', error: 'Install cursor is beyond the available events.' };
      return { ok: true, events: structuredClone(job.events.slice(input.cursor)), nextCursor: job.events.length,
        steps: structuredClone(job.snapshot.steps), progress: structuredClone(job.snapshot.progress),
        done: job.snapshot.done, outcome: structuredClone(job.snapshot.outcome) };
    },
    async cancel(input: DaemonAgentInstallCancelRequest, requestedAccountId = accountId): Promise<DaemonAgentInstallCancelResponse> {
      if (!DaemonAgentInstallCancelRequestSchema.safeParse(input).success) return { ok: false, errorCode: 'invalid_request', error: 'Invalid install cancellation request.' };
      const job = jobs.get(input.jobId);
      if (!job || job.accountId && requestedAccountId !== undefined && job.accountId !== requestedAccountId) return { ok: false, errorCode: 'job_not_found', error: 'Install job not found.' };
      if (!job.snapshot.done) job.controller.abort();
      await job.completion;
      if (job.cleanupError) return { ok: false, errorCode: 'install_unavailable', error: job.cleanupError.message };
      return { ok: true };
    },
    list(requestedAccountId = accountId): DaemonAgentInstallListResponse { return { ok: true, jobs: [...jobs.values()]
      .filter(job => job.accountId === undefined || requestedAccountId === undefined || job.accountId === requestedAccountId)
      .map((job) => structuredClone(job.snapshot)) }; },
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
export function getDaemonAgentInstallJobOwner(options?: Pick<AgentInstallJobOwnerOptions, 'accountId' | 'admissionDrain' | 'readTrackedSessions' | 'readAcpCatalog'>): AgentInstallJobOwner {
  const owner = daemonOwner ??= createAgentInstallJobOwner(options);
  if (options?.accountId) owner.bindAccountId(options.accountId);
  if (options?.admissionDrain) owner.bindAdmissionDrain(options.admissionDrain);
  if (options?.readTrackedSessions) owner.bindTrackedSessions(options.readTrackedSessions);
  if (options?.readAcpCatalog) owner.bindAcpCatalog(options.readAcpCatalog);
  return owner;
}
