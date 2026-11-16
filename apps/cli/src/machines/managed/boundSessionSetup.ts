import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import type { ManagedNativeBootstrapIO } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { findBuiltinNativeToolchainAdapterV1 } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';
import { machineSetupSourceOriginKeyV1, projectMachineSetupSourceChangeExecutionV1,
    selectMachineSetupRecipeItemsV1,
    type MachineSetupSourceV1, type MachineSetupSourceFactsMapV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { PluginProjectedMachineRecipeEntryV1 } from '@happier-dev/protocol/daemon/machineSetupProjection';
import { applyBoundMachineSetup, createBoundMachineSetupTarget, prepareBoundMachineSetupRecipePlans } from '../setup/boundMachineSetup';
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { ManagedMachineControllerError } from './controllerErrors';
import { observeMachineSetupInitialPresence } from '../setup/initialPresence';
import { prepareMachineSetupSecretEnvironment, type MachineSetupSecretCustody } from '../setup/secretEnvironment';
import { isMachineSetupResultUnsettled } from '../setup/applyMachineSetup';

/** The Session's admitted transport owns every observation and effect. No
 * controller filesystem, environment, tool resolution or guest enrollment. */
export async function runBoundSessionSetup(input: Readonly<{
    machine: ManagedMachineFullV1; setup: MachineSetupV1; sessionId: string; requesterAccountId: string;
    transport: ManagedNativeBootstrapIO; binaryPath: string;
    ensureRecipeInterpreter?(): Promise<string>;
    platform: Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64'; home: string }>;
    recipes: readonly Pick<PluginProjectedMachineRecipeEntryV1, 'pluginId' | 'definition'>[];
    sourceFacts?: MachineSetupSourceFactsMapV1;
    savedSecrets?: MachineSetupSecretCustody;
    operation: ProjectSetupOperationContext; signal: AbortSignal;
    report(state: 'running' | 'succeeded' | 'failed', sourceFacts: MachineSetupSourceFactsMapV1, errorCode?: string): Promise<void>;
}>) {
    const { machine, signal, operation, platform } = input;
    if (!machine.preset || !machine.controller) throw new ManagedMachineControllerError('admission_unavailable');
    const operationId = operation.operationAcceptance?.operationId ?? operation.actionRequestId;
    if (!operationId) throw new ManagedMachineControllerError('admission_unavailable');
    const basis = { kind: 'boundSetup' as const, managedId: machine.id, sessionId: input.sessionId, operationId };
    const sources: MachineSetupSourceV1 = [{ kind: 'accountPreset', presetId: machine.preset.id,
        presetRevision: machine.preset.revision, contentEncryptionMode: machine.preset.contentEncryptionMode, setup: input.setup }];
    const execution = projectMachineSetupSourceChangeExecutionV1(sources, sources, input.setup, [],
        { currentSourceFacts: input.sourceFacts, mode: 'recovery' });
    if (!execution.ok) throw new ManagedMachineControllerError(execution.errorCode);
    const sourceFacts = { ...input.sourceFacts };
    const completedScripts = new Set<number>();
    const origin = machineSetupSourceOriginKeyV1(sources[0]!);
    await input.report('running', sourceFacts);
    let settled = false;
    let secrets: Awaited<ReturnType<typeof prepareMachineSetupSecretEnvironment>> | undefined;
    try {
        // App Setup currently requires accepted deployment children at the
        // enrolled Machine owner. A Session binding cannot supply those facts.
        if (execution.sources.some(setup => setup.items?.some(item => item.kind === 'app'))) {
            throw new ManagedMachineControllerError('machine_setup_app_preparation_unavailable');
        }
        const needsInterpreter = selectMachineSetupRecipeItemsV1([input.setup], [], execution.sources).some(entry => entry.execute);
        const binaryPath = needsInterpreter && input.ensureRecipeInterpreter ? await input.ensureRecipeInterpreter() : input.binaryPath;
        const target = createBoundMachineSetupTarget({ transport: input.transport, administrator: true,
            effectCli: { binaryPath, operationId } });
        const recipePlans = await prepareBoundMachineSetupRecipePlans({ transport: input.transport, binaryPath,
            basis, sources: [input.setup], executionSources: execution.sources, recipes: input.recipes, signal });
        const observed = observeMachineSetupInitialPresence(sources, recipePlans);
        sourceFacts[origin] = { ...observed[origin], ...sourceFacts[origin] };
        if (input.savedSecrets) secrets = await prepareMachineSetupSecretEnvironment({ ...input.savedSecrets,
            sources: execution.sources, signal, isCurrent: async () => !signal.aborted });
        operation.operationOwnerUpdate.update({ progress: { phase: 'setup', label: 'Running setup' } });
        const result = await applyBoundMachineSetup({ homeId: machine.homeId, controllerMachineId: machine.controller.machineId,
            requesterAccountId: input.requesterAccountId, userHomeDirectory: platform.home, setup: input.setup, recipePlans,
            sourceChange: { currentSources: sources, sources, currentExclusions: [], currentSourceFacts: input.sourceFacts, mode: 'recovery' },
            target, basis, operation, signal, hostEnvironment: { HOME: platform.home }, platform: platform.os,
            ...(secrets?.environment ? { secretEnvironment: secrets.environment } : {}),
            environmentIo: { run: target.run, resolveTool: async (tool, toolSignal) => {
                const adapter = findBuiltinNativeToolchainAdapterV1(tool, platform.os);
                if (!adapter || adapter.architecture !== platform.arch) return null;
                const resolved = await input.transport.exec({ command: `command -v ${safeBashSingleQuote(adapter.executable)}`, signal: toolSignal });
                const executablePath = resolved.stdout.trim();
                if (resolved.status !== 0 || !executablePath.startsWith('/') || executablePath.includes('\n')) return null;
                const version = await target.run({ command: executablePath, args: adapter.versionArgs,
                    cwd: platform.home, env: { HOME: platform.home }, signal: toolSignal });
                const value = version.exitCode === 0 ? new RegExp(adapter.versionPattern).exec(version.stdout)?.[1] : undefined;
                return value ? { executablePath, args: [], version: value } : null;
            } },
            onScriptCompleted: index => { completedScripts.add(index); },
            onSetupApplied: (plans, result) => {
                if (!result.initialPresence) return;
                const actual = observeMachineSetupInitialPresence(sources, recipePlans.map(entry => ({ ...entry,
                    initialPresence: result.initialPresence![plans.indexOf(entry.plan)] ?? 'unknown' })));
                sourceFacts[origin] = { ...sourceFacts[origin], firstPresence: {
                    ...actual[origin]?.firstPresence, ...sourceFacts[origin]?.firstPresence,
                } };
            },
            isCurrent: async () => !signal.aborted,
        });
        if (!result.ok && isMachineSetupResultUnsettled(result)) {
            settled = true;
            throw new ManagedMachineControllerError(result.errorCode ?? 'outcome_uncertain');
        }
        if (result.ok || completedScripts.size || result.errorCode === 'machine_setup_setup_failed') {
            sourceFacts[origin] = { ...sourceFacts[origin], pendingScripts: execution.sources[0]?.scripts?.flatMap((script, index) =>
                script.body && !completedScripts.has(index) ? [index] : []) ?? [] };
        }
        signal.throwIfAborted();
        await input.report(result.ok ? 'succeeded' : 'failed', sourceFacts, result.ok ? undefined : result.errorCode);
        settled = true;
        if (!result.ok) throw new ManagedMachineControllerError(result.errorCode ?? 'target_unavailable');
    } catch (error) {
        if (!settled && !signal.aborted) await input.report('failed', sourceFacts,
            error instanceof ManagedMachineControllerError ? error.code : 'machine_setup_apply_failed');
        throw error;
    } finally {
        secrets?.dispose();
    }
}
