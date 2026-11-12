import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { ExecFileTerminationError } from '@happier-dev/cli-common/process';
import { hasAgentCliManagedInstallForRuntime, installAgentCliForRuntime, removeAgentCliManagedInstallForRuntime, resolvePlatformFromNodePlatform, type AgentInstallProgressCallback } from '@happier-dev/cli-common/agents';
import { AGENT_INSTALL_JOB_VERIFY_STEP_ID, buildAgentInstallJobCliStepId } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { PluginAgentCliInstallMetadataSchema } from '@happier-dev/protocol/plugins/contributions/agentCliMetadata';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AgentInstallJobEvent, AgentInstallJobFailureCode, AgentInstallJobOutcome, DaemonAgentInstallStartRequest } from '@happier-dev/protocol';
import { invalidateCliSnapshots, probeAgentCliForInstall } from '@/capabilities/snapshots/cliSnapshot';
import { withAgentCliUpdates } from '@/capabilities/cliUpdate/agentCliUpdates';
import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import { resolveAgentRuntimeManagedDependencyId, resolveExecutableManagedDependenciesRegistry, selectExecutableManagedDependencies } from '@/plugins/projection/registry/managedDependencyExecutables';
import { executeInstallCommand } from './executeInstallCommand';
import { resolveAgentSetupPlatform } from '@happier-dev/protocol/agents/setup';
import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { getAcpArchiveInstallableDescriptor, getAcpNpmRuntimeSpec, getAcpUvRuntimeSpec, installAcpLaunch, resolveAcpLaunch, type AcpLaunchInstallResult } from '@/agent/acp/catalog/configured/resolveAcpLaunch';
import { hasPinnedArchiveManagedInstall } from '@/packagedRuntime/installables/sourceAdapters/pinnedArchive';
import { removeManagedAcpInstall } from '@/agent/acp/catalog/registry/managedAgentInstalls';
import type { AgentInstallJobRegistry, MemberAgentInstallOperation } from './agentInstallJobOwner';

export type AgentInstallExecutionOptions = Readonly<{
  accountId?: string;
  registry: AgentInstallJobRegistry;
  agent: AgentInstallJobRegistry['agents'][number];
  definition?: AcpBackendDefinitionV1;
  env: ProcessEnvInput;
  platform: NodeJS.Platform;
  arch: string;
  installerDeps?: Parameters<typeof installAgentCliForRuntime>[0]['deps'];
  admittedOperation?: Pick<MemberAgentInstallOperation, 'runtimeManagedDependencyId'>;
  isTargetInUse: () => boolean;
  onEvent: (event: AgentInstallJobEvent) => void;
}>;

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

/** Finite installer effects; admission, job identity and retained state belong to the host. */
export async function executeAgentInstall(input: DaemonAgentInstallStartRequest, signal: AbortSignal,
  options: AgentInstallExecutionOptions): Promise<Readonly<{ outcome: AgentInstallJobOutcome; cleanupError: ExecFileTerminationError | null }>> {
  const { registry, agent, env, onEvent: emit } = options;
  const host = { platform: options.platform, architecture: options.arch };
  const installerDeps = { execFileWithDeadline: executeInstallCommand, ...options.installerDeps };
  const { isTargetInUse } = options;
  const progressFor = (stepId: string): AgentInstallProgressCallback => event => {
    emit(event.t === 'progress' ? { ...event, stepId } : event);
  };
  let cleanupError: ExecFileTerminationError | null = null;
  const runDefinition = async (definition: AcpBackendDefinitionV1 | undefined): Promise<AgentInstallJobOutcome> => {
    const stepId = buildAgentInstallJobCliStepId(input);
    const label = definition?.title ?? 'Remove managed Agent';
    emit({ t: 'step', stepId, label, state: 'running' });
    const fail = (code: AgentInstallJobFailureCode, message: string): AgentInstallJobOutcome => ({ kind: 'failed', code, stepId, message });
    let result: AgentInstallJobOutcome;
    try {
      signal.throwIfAborted();
      if ((input.intent === 'uninstall' || input.force) && isTargetInUse()) {
        result = fail('in_use', 'Stop the sessions using this Agent before changing its managed installation.');
      } else if (input.intent === 'uninstall') {
        const removed = await removeManagedAcpInstall({ accountId: options.accountId, definitionId: input.definitionId!, env, signal,
          isDefinitionInUse: () => isTargetInUse() });
        result = removed.ok ? { kind: 'succeeded', version: null }
          : fail(removed.code, removed.code === 'in_use' ? 'The Agent is in use.' : 'The Agent is not installed through Happier.');
      } else if (!definition || definition.launch.kind === 'command') {
        result = fail('install_not_available', 'This definition has no managed installation.');
      } else {
        const params = { accountId: options.accountId, definition, env, platform: host.platform, arch: host.architecture, signal,
          onProgress: progressFor(stepId), intent: input.intent, force: input.force };
        const archive = getAcpArchiveInstallableDescriptor(definition, options.accountId!);
        const npm = getAcpNpmRuntimeSpec(definition, options.accountId!);
        const uv = getAcpUvRuntimeSpec(definition, options.accountId!);
        const resolutionBeforeInstall = await resolveAcpLaunch(params);
        const retained = archive
          ? await hasPinnedArchiveManagedInstall({ installId: archive.capabilityId, env })
          : (npm ?? uv) !== null && await hasAgentCliManagedInstallForRuntime({ runtimeSpec: (npm ?? uv)!, env });
        // A pin change acquires another root. Repair/removal of this exact version still needs live-use evidence.
        const needsRemoval = retained && (input.force || resolutionBeforeInstall.kind !== 'ready');
        const replacingInUse = needsRemoval && isTargetInUse();
        if (replacingInUse) {
          result = fail('in_use', 'Stop the sessions using this Agent before replacing its managed installation.');
        } else {
          const removed = needsRemoval ? await removeManagedAcpInstall({ accountId: options.accountId,
            definitionId: definition.id, version: definition.launch.version, env, signal, isDefinitionInUse: () => isTargetInUse() }) : { ok: true as const };
          const installed: AcpLaunchInstallResult = removed.ok ? await installAcpLaunch(params, { installerDeps })
            : { ok: false, errorCode: removed.code, errorMessage: 'The retained version cannot be removed for repair.', logPath: null };
          if (!installed.ok) {
            if (installed.errorCode === 'termination-failed') cleanupError = new ExecFileTerminationError(new Error(installed.errorMessage));
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
      if (terminationFailed) cleanupError = error;
      const cancelled = signal.aborted && (error === signal.reason || error instanceof Error && error.name === 'AbortError');
      result = fail(cancelled && !terminationFailed ? 'cancelled' : 'install_failed', error instanceof Error ? error.message : 'Agent installation failed.');
    }
    emit({ t: 'step', stepId, label, state: result.kind === 'succeeded' ? 'done' : 'failed' });
    return result;
  };

  const run = async (): Promise<AgentInstallJobOutcome> => {
    const spec = agent.runtimeSpec;
    if (!spec) throw new Error('Admitted Agent has no CLI runtime');
    let stepId = buildAgentInstallJobCliStepId({ agentId: agent.id });
    let label = spec.title;
    const begin = (id: string, title: string) => {
      signal.throwIfAborted();
      stepId = id;
      label = title;
      emit({ t: 'step', stepId, label, state: 'running' });
    };
    const done = () => emit({ t: 'step', stepId, label, state: 'done' });
    const fail = (code: AgentInstallJobFailureCode, message: string): AgentInstallJobOutcome => ({
      kind: 'failed', code, stepId, message,
      ...(code === 'install_not_available' && (spec.installGuideUrl ?? spec.docsUrl)
        ? { guideUrl: spec.installGuideUrl ?? spec.docsUrl ?? undefined } : {}),
    });
    let result: AgentInstallJobOutcome;
    try {
      begin(stepId, label);
      if ((input.intent === 'update' || input.intent === 'uninstall' || input.force) && isTargetInUse()) {
        result = fail('in_use', 'Stop the sessions using this Agent before changing its managed installation.');
        emit({ t: 'step', stepId, label, state: 'failed' });
        return result;
      }
      if (input.intent === 'uninstall') {
        const removed = spec.managedInstall ? await removeAgentCliManagedInstallForRuntime({ runtimeSpec: spec, env, signal })
          : { ok: false as const, code: 'not_managed' as const };
        result = removed.ok ? { kind: 'succeeded', version: null } : fail(removed.code, 'The Agent is not installed through Happier.');
        if (removed.ok) done();
        return result;
      }
      const platform = resolvePlatformFromNodePlatform(host.platform);
      if (!platform) {
        result = fail('unsupported_platform', `Agent installation is not supported on ${host.platform}.`);
      } else {
        // Resolve all declared dependencies before any acquisition starts. A
        // request-only or unsupported declaration cannot silently disappear.
        const dependencyId = options.admittedOperation ? options.admittedOperation.runtimeManagedDependencyId : resolveAgentRuntimeManagedDependencyId(agent);
        const required = new Set(dependencyId ? [dependencyId] : []);
        const contributions = registry.managedDependencies ?? [];
        const dependencyRegistry = resolveExecutableManagedDependenciesRegistry(contributions, host);
        const declarations = options.admittedOperation ? contributions : contributions.filter((candidate) => candidate.pluginId
          && required.has(buildQualifiedPluginContributionKey({ pluginId: candidate.pluginId, localId: candidate.definition.id })));
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
        } else if (input.intent === 'install' && isTargetInUse()
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
              detect: () => probeAgentCliForInstall({ runtimeSpec: spec, env, signal, execFile: installerDeps.execFileWithDeadline,
                sourcePolicy: options.admittedOperation ? 'member' : undefined }),
            }, agent.id, {
              env, nodePlatform: host.platform, signal, onProgress: progressFor(stepId), installerDeps,
              sourcePolicy: options.admittedOperation ? 'member' : undefined,
              resolveRuntimeSpec: () => spec,
              buildContext: async () => ({ cliSnapshot: null }),
            });
            const updated = await capability.invoke?.({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: input.consent.vendorRecipe }, signal });
            if (!updated?.ok) {
              const code = updated?.error.code ?? 'install-failed';
              if (code === 'termination-failed') cleanupError = new ExecFileTerminationError(new Error(updated?.error.message));
              cliFailure = fail(failureCode(code), updated?.error.message ?? 'Agent update failed.');
            }
          } else {
            const installed = await installAgentCliForRuntime({
              runtimeSpec: spec, platform, env, skipIfInstalled: !input.force,
              sourcePolicy: options.admittedOperation ? 'member' : undefined,
              allowVendorRecipeExecution: input.consent.vendorRecipe, signal,
              onProgress: progressFor(stepId), deps: installerDeps,
            });
            if (!installed.ok) {
              if (installed.errorCode === 'termination-failed') cleanupError = new ExecFileTerminationError(new Error(installed.errorMessage));
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
              const installed = await adapter.installOrUpgrade({ signal, onProgress: progressFor(stepId), env });
              if (!installed.ok) {
                if (installed.errorCode === 'termination-failed') cleanupError = new ExecFileTerminationError(new Error(installed.errorMessage));
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
              begin(AGENT_INSTALL_JOB_VERIFY_STEP_ID, 'Check it runs');
              invalidateCliSnapshots();
              const verified = await probeAgentCliForInstall({ runtimeSpec: spec, env, signal, execFile: installerDeps.execFileWithDeadline,
                sourcePolicy: options.admittedOperation ? 'member' : undefined });
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
      if (terminationFailed) cleanupError = error;
      const cancelled = signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'));
      result = fail(cancelled && !terminationFailed ? 'cancelled' : 'install_failed', error instanceof Error ? error.message : 'Agent installation failed.');
    }
    if (result.kind === 'failed') emit({ t: 'step', stepId, label, state: 'failed' });
    return result;
  };

  const outcome = await (input.definitionId === undefined ? run() : runDefinition(options.definition));
  return { outcome, cleanupError };
}
