import { randomUUID } from 'node:crypto';
import { resolveCanonicalAgentIdFromFlavor } from '@happier-dev/agents';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { ExecFileTerminationError } from '@happier-dev/cli-common/process';
import { installAgentCliForRuntime } from '@happier-dev/cli-common/agents';
import { buildAgentInstallJobCliStepId, DaemonAgentInstallStartRequestSchema, DaemonAgentInstallReadRequestSchema, DaemonAgentInstallCancelRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AgentInstallJob, AgentInstallJobEvent, AgentInstallJobOutcome, DaemonAgentInstallStartRequest, DaemonAgentInstallReadRequest, DaemonAgentInstallCancelRequest, DaemonAgentInstallStartResponse, DaemonAgentInstallReadResponse, DaemonAgentInstallCancelResponse, DaemonAgentInstallListResponse } from '@happier-dev/protocol';
import type { ResolvedAgentContribution, ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { invalidateCliSnapshots } from '@/capabilities/snapshots/cliSnapshot';
import { resolveAgentRuntimeManagedDependencyId, selectExecutableManagedDependencies } from '@/plugins/projection/registry/managedDependencyExecutables';
import type { LiveWorkItemV1, LiveWorkProducerV1 } from '@/daemon/lifecycle/managedActivity';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { buildConfiguredAcpAgentSelectionV1, isCustomAcpAgentContributionIdentityV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { isAgentInstallTargetInUse } from '@/agent/acp/catalog/registry/managedAgentInstalls';
import type { TrackedSession } from '@/daemon/types';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { executeAgentInstall } from './executeAgentInstall';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';

export type AgentInstallJobRegistry = Readonly<{
  agents: readonly Pick<ResolvedAgentContribution, 'id' | 'identity' | 'runtimeSpec' | 'pluginId' | 'richDefinition' | 'hostAccess' | 'cliMetadata'>[];
  managedDependencies?: readonly ResolvedInstallableContribution[];
}>;

export type MemberAgentInstallOperation = Readonly<{
  request: DaemonAgentInstallStartRequest;
  accountId: string;
  registry: AgentInstallJobRegistry;
  definition?: AcpBackendDefinitionV1;
  targetInUse: boolean;
  runtimeManagedDependencyId: string | null;
}>;
export type MemberAgentInstallExecutor = (operation: MemberAgentInstallOperation,
  signal: AbortSignal, onEvent: (event: AgentInstallJobEvent) => void) => Promise<AgentInstallJobOutcome>;

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
  invalidateInventory?: () => void;
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

export function createAgentInstallJobOwner(options: AgentInstallJobOwnerOptions = {}) {
  let accountId = options.accountId;
  let admissionDrain = options.admissionDrain;
  let readTrackedSessions = options.readTrackedSessions;
  let readAcpCatalog = options.readAcpCatalog ?? (() => getActiveAccountSettingsSnapshot()?.acpCatalog);
  let invalidateInventory = options.invalidateInventory;
  const readRegistry = options.readRegistry ?? readCurrentContributionRegistry;
  const env = options.env ?? process.env;
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
  const targetKey = (target: Pick<DaemonAgentInstallStartRequest, 'agentId' | 'definitionId'>, account?: string) =>
    JSON.stringify([account, buildMachineAgentInventoryKey(target)]);
  const inUse = (target: Pick<DaemonAgentInstallStartRequest, 'agentId' | 'definitionId'>, memberAccountId?: string): boolean => {
    try {
      if (!readTrackedSessions) return true;
      const sessions = readTrackedSessions();
      return isAgentInstallTargetInUse(target, memberAccountId === undefined ? sessions
        : [...sessions].filter(session => (session.requesterWorkAttributionV1
          ?? session.spawnOptions?.requesterWorkAttributionV1)?.accountId === memberAccountId));
    }
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
    // The daemon's existing Machine projection push renews every inventory
    // consumer, including clients that never observed this install job.
    if (result.kind === 'succeeded') invalidateInventory?.();
    notifyActivity();
  };
  function read(input: DaemonAgentInstallReadRequest & { waitForTerminal: true }, requestedAccountId?: string): DaemonAgentInstallReadResponse | Promise<DaemonAgentInstallReadResponse>;
  function read(input: DaemonAgentInstallReadRequest & { waitForTerminal?: false }, requestedAccountId?: string): DaemonAgentInstallReadResponse;
  function read(input: DaemonAgentInstallReadRequest, requestedAccountId?: string): DaemonAgentInstallReadResponse | Promise<DaemonAgentInstallReadResponse>;
  function read(input: DaemonAgentInstallReadRequest, requestedAccountId = accountId): DaemonAgentInstallReadResponse | Promise<DaemonAgentInstallReadResponse> {
    if (!DaemonAgentInstallReadRequestSchema.safeParse(input).success) return { ok: false, errorCode: 'invalid_request', error: 'Invalid install read request.' };
    const job = jobs.get(input.jobId);
    if (!job || job.accountId !== requestedAccountId) return { ok: false, errorCode: 'job_not_found', error: 'Install job not found.' };
    if (input.cursor > job.events.length) return { ok: false, errorCode: 'invalid_request', error: 'Install cursor is beyond the available events.' };
    const snapshot = (): DaemonAgentInstallReadResponse => ({ ok: true, events: structuredClone(job.events.slice(input.cursor)), nextCursor: job.events.length,
      steps: structuredClone(job.snapshot.steps), progress: structuredClone(job.snapshot.progress),
      done: job.snapshot.done, outcome: structuredClone(job.snapshot.outcome) });
    return input.waitForTerminal ? job.completion.then(snapshot) : snapshot();
  }

  return {
    activity,
    isDefinitionJob(jobId: string): boolean { return jobs.get(jobId)?.snapshot.definitionId !== undefined; },
    bindAccountId(id: string): void { accountId = id; },
    bindInventoryInvalidation(invalidate: () => void): void { invalidateInventory = invalidate; },
    bindAdmissionDrain(drain: NonNullable<AgentInstallJobOwnerOptions['admissionDrain']>): void {
      admissionDrain = drain;
    },
    bindTrackedSessions(reader: NonNullable<AgentInstallJobOwnerOptions['readTrackedSessions']>): void {
      readTrackedSessions = reader;
    },
    bindAcpCatalog(reader: NonNullable<AgentInstallJobOwnerOptions['readAcpCatalog']>): void {
      readAcpCatalog = reader;
    },
    start(input: DaemonAgentInstallStartRequest, account?: Readonly<{ accountId: string; catalog?: AcpCatalogSnapshotV1;
      executeMember?: MemberAgentInstallExecutor }>): DaemonAgentInstallStartResponse {
      const parsed = DaemonAgentInstallStartRequestSchema.safeParse(input);
      if (!parsed.success || parsed.data.expectedDefinitionVersion !== undefined
        && (parsed.data.definitionId === undefined || parsed.data.intent === 'uninstall')) {
        return { ok: false, errorCode: 'invalid_request', error: 'Invalid install request.' };
      }
      if (shuttingDown) return { ok: false, errorCode: 'install_unavailable', error: 'The daemon is shutting down.' };
      let registry: AgentInstallJobRegistry;
      try { registry = readRegistry(); } catch {
        return { ok: false, errorCode: 'install_unavailable', error: 'The agent registry is unavailable.' };
      }
      const currentAgentIds = new Set(registry.agents.flatMap(agent => [agent.id,
        ...(agent.identity ? [buildQualifiedPluginContributionKey(agent.identity)] : [])]));
      for (const [key, previous] of recentByAgent) {
        if (!currentAgentIds.has(previous.snapshot.agentId) && ![...activeByAgent.values()].some(active => active.recentKey === key)) {
          recentByAgent.delete(key);
          jobs.delete(previous.snapshot.jobId);
        }
      }
      const identity = parseQualifiedPluginContributionKey(input.agentId);
      const routingId = identity ? readAgentRoutingIdForContributionIdentity(indexAgentRoutingIdsByContributionIdentity(registry.agents), identity) : null;
      const requestedId = routingId ?? input.agentId;
      const canonicalId = resolveCanonicalAgentIdFromFlavor(requestedId);
      const agent = registry.agents.find(candidate => candidate.id === requestedId)
        ?? (canonicalId ? registry.agents.find(candidate => candidate.id === canonicalId) : undefined);
      if (!agent || input.definitionId !== undefined && !isCustomAcpAgentContributionIdentityV1(agent.identity)
        || input.definitionId === undefined && !agent.runtimeSpec) return { ok: false, errorCode: 'install_unavailable', error: 'The agent has no registered CLI runtime.' };
      const selection = input.definitionId === undefined ? undefined : buildConfiguredAcpAgentSelectionV1(input.definitionId);
      const request = { ...parsed.data, agentId: selection?.agentId ?? agent.id };
      const requestedAccountId = account?.accountId ?? accountId;
      const targetInUse = inUse(request, account?.executeMember ? requestedAccountId : undefined);
      if ((request.intent === 'uninstall' || request.force || request.definitionId === undefined && request.intent === 'update') && targetInUse) {
        return { ok: false, errorCode: 'in_use', error: 'Stop the sessions using this Agent before changing its managed installation. Session use must be known.' };
      }
      let definition: AcpBackendDefinitionV1 | undefined;
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
      if (canonicalActive) return { ok: true, jobId: canonicalActive.snapshot.jobId, executionScope: canonicalActive.snapshot.executionScope };
      if (admissionDrain?.isQuiescing()) return { ok: false, errorCode: 'install_unavailable',
        error: admissionDrain.isFinalShutdown() ? 'The daemon is shutting down.' : 'The daemon is draining.' };
      const job: JobRecord = {
        accountId: requestedAccountId, activeKey, recentKey,
        snapshot: { jobId: randomUUID(), agentId: request.agentId, ...(request.definitionId === undefined ? {} : { definitionId: request.definitionId }),
          intent: request.intent, executionScope: account?.executeMember ? 'member' : 'machine', startedAt: Date.now(), steps: [], progress: [], done: false, outcome: null },
        events: [], controller: new AbortController(), completion: Promise.resolve(), cleanupError: null,
      };
      jobs.set(job.snapshot.jobId, job);
      activeByAgent.set(activeKey, job);
      // Start on the next microtask so admission publishes the active record
      // before even a synchronously rejected install can settle.
      job.completion = Promise.resolve().then(async () => {
        if (!account?.executeMember) {
          const result = await executeAgentInstall(request, job.controller.signal, {
            accountId: requestedAccountId, registry, agent, definition, env,
            platform: host.platform, arch: host.architecture, installerDeps: options.installerDeps,
            isTargetInUse: () => inUse(request), onEvent: event => emit(job, event),
          });
          job.cleanupError = result.cleanupError;
          settle(job, result.outcome);
          return;
        }
        try {
          const runtimeManagedDependencyId = resolveAgentRuntimeManagedDependencyId(agent);
          // Runtime declarations are trusted code. Private host access and plugin
          // configuration never cross into the member process.
          const declarations = registry.managedDependencies?.filter(dependency => dependency.pluginId
            && runtimeManagedDependencyId === buildQualifiedPluginContributionKey({ pluginId: dependency.pluginId, localId: dependency.definition.id })) ?? [];
          // Select using the original declaration and manifest qualification.
          // The child receives only these admitted executable descriptors; their
          // install IDs can differ from the original dependency reference.
          const dependencies = selectExecutableManagedDependencies(declarations, host)
            .map(({ definition, pluginId, source, provenance }) => ({ definition, pluginId, source, provenance }));
          const outcome = await account.executeMember({ request, accountId: requestedAccountId!,
            registry: { agents: [{ id: agent.id, identity: agent.identity, pluginId: agent.pluginId,
              runtimeSpec: agent.runtimeSpec, cliMetadata: agent.cliMetadata }], managedDependencies: dependencies },
            ...(definition ? { definition } : {}), targetInUse, runtimeManagedDependencyId }, job.controller.signal, event => emit(job, event));
          settle(job, outcome);
        } catch (error) {
          if (error instanceof ExecFileTerminationError) job.cleanupError = error;
          const nativeCode = isPluginError(error) && (error.code === 'agent_isolation_unavailable'
            || error.code === 'requester_material_cleanup_failed') ? error.code : null;
          const details = nativeCode && isPluginError(error) ? error.details : undefined;
          const detailPhase = isJsonObject(details) ? details.phase : undefined;
          const phase = detailPhase === 'native_execution_preparation' || detailPhase === 'native_identity_binding'
            || detailPhase === 'native_execution_admission' || detailPhase === 'requester_material_cleanup' ? detailPhase : null;
          settle(job, { kind: 'failed', code: job.controller.signal.aborted && !job.cleanupError ? 'cancelled' : 'install_failed',
            stepId: buildAgentInstallJobCliStepId(request), message: nativeCode
              ? `Native Agent installation failed (${nativeCode}${phase ? `, ${phase}` : ''}).` : 'Native Agent installation failed.' });
        }
      });
      notifyActivity();
      return { ok: true, jobId: job.snapshot.jobId, executionScope: job.snapshot.executionScope };
    },
    read,
    async cancel(input: DaemonAgentInstallCancelRequest, requestedAccountId = accountId): Promise<DaemonAgentInstallCancelResponse> {
      if (!DaemonAgentInstallCancelRequestSchema.safeParse(input).success) return { ok: false, errorCode: 'invalid_request', error: 'Invalid install cancellation request.' };
      const job = jobs.get(input.jobId);
      if (!job || job.accountId !== requestedAccountId) return { ok: false, errorCode: 'job_not_found', error: 'Install job not found.' };
      if (!job.snapshot.done) job.controller.abort();
      await job.completion;
      if (job.cleanupError) return { ok: false, errorCode: 'install_unavailable', error: job.cleanupError.message };
      return { ok: true };
    },
    list(requestedAccountId = accountId): DaemonAgentInstallListResponse { return { ok: true, jobs: [...jobs.values()]
      .filter(job => job.accountId === requestedAccountId)
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
export function getDaemonAgentInstallJobOwner(options?: Pick<AgentInstallJobOwnerOptions, 'accountId' | 'admissionDrain' | 'readTrackedSessions' | 'readAcpCatalog' | 'invalidateInventory'>): AgentInstallJobOwner {
  const owner = daemonOwner ??= createAgentInstallJobOwner(options);
  if (options?.accountId) owner.bindAccountId(options.accountId);
  if (options?.admissionDrain) owner.bindAdmissionDrain(options.admissionDrain);
  if (options?.readTrackedSessions) owner.bindTrackedSessions(options.readTrackedSessions);
  if (options?.readAcpCatalog) owner.bindAcpCatalog(options.readAcpCatalog);
  if (options?.invalidateInventory) owner.bindInventoryInvalidation(options.invalidateInventory);
  return owner;
}
