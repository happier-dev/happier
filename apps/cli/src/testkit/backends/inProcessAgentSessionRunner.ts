import { SessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { runHostSessionRuntimePlan } from '@/agent/runtime/session/loop/plan';
import type { HostSessionRuntimeConfig } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import {
    buildPluginHostSessionRuntimeOptions,
    type PluginSessionBindingInput,
} from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol';

/**
 * Runs the same bridge, retained Agent source, native adapter and host loop as
 * a daemon-spawned CLI child. The containing composed harness supplies the real
 * daemon listener and private bootstrap files, and owns the simulated OS child.
 * No Session/input/transcript or internal preparation owner is substituted.
 */
export async function startInProcessAgentSessionRunner(input: Readonly<{
    backendId: string;
    agentTarget: AgentExecutionTargetV1;
    happyHomeDir: string;
    binding: PluginSessionBindingInput;
    bootstrapFilePath: string;
    authorityFilePath: string;
    onSessionInitialized: NonNullable<NonNullable<HostSessionRuntimeConfig['lifecycleHooks']>['onSessionInitialized']>;
    onStage?: (stage: 'runtime_plan' | 'session_initialized' | 'runner_settled', elapsedMs: number) => void;
}>) {
    const startedAt = performance.now();
    const stage = (name: 'runtime_plan' | 'session_initialized' | 'runner_settled') => {
        input.onStage?.(name, performance.now() - startedAt);
    };
    const bridge = new SessionHostBridge();
    const plan = await bridge.createSessionRuntime(input.backendId, {
        ...buildPluginHostSessionRuntimeOptions(input.binding),
        agentTarget: input.agentTarget,
        happyHomeDir: input.happyHomeDir,
    }, {
        agentRuntimeRunnerBootstrapFilePath: input.bootstrapFilePath,
        agentRuntimeDaemonServiceAuthorityFilePath: input.authorityFilePath,
    });
    stage('runtime_plan');

    let requestStop: (() => Promise<void>) | undefined;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    // Callers may await the outer spawn before awaiting readiness. Preserve a
    // startup failure without creating an unhandled-rejection race meanwhile.
    void ready.catch(() => undefined);
    const run = runHostSessionRuntimePlan({
        ...plan,
        config: {
            ...plan.config,
            processLifecycleOwnership: 'caller',
            shouldRenderTerminalDisplay: () => false,
            onRuntimeStopReady: stop => {
                plan.config.onRuntimeStopReady?.(stop);
                requestStop = stop;
            },
            lifecycleHooks: {
                ...plan.config.lifecycleHooks,
                onSessionInitialized: async params => {
                    await plan.config.lifecycleHooks?.onSessionInitialized?.(params);
                    await input.onSessionInitialized(params);
                    stage('session_initialized');
                    resolveReady();
                },
            },
        },
    });
    let settled = false;
    void run.then(() => {
        settled = true;
        stage('runner_settled');
    }, error => {
        settled = true;
        rejectReady(error);
    });
    // Keep the terminal result available to the caller even when startup fails
    // before it can register cleanup for the returned runner handle.
    void run.catch(() => undefined);
    return {
        ready,
        run,
        async stop() {
            if (!settled && requestStop) await Promise.race([requestStop(), run]);
            await run;
        },
    };
}
