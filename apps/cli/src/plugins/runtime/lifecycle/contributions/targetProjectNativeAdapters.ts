import { ProjectDefinitionDetectionV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import {
    PluginProjectNativeCommandResultV1Schema,
    PluginProjectNativeEnvironmentResultV1Schema,
    type PluginProjectNativeAdapterContributionV1,
    type ProjectNativeAdapterRoleV1,
} from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginProjectNativeAdapterRuntimeV1, PluginProjectNativeInspectionV1, PluginProjectNativeCommandRequestV1, PluginProjectNativeEnvironmentRequestV1, PluginProjectNativeCommandResultV1, PluginProjectNativeEnvironmentResultV1, PluginProjectNativeFailureV1 } from '@happier-dev/plugin-sdk';
import type { PluginCancellationOptions, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ManagedServiceNativeInstanceV1, ManagedServiceNativeLifecycleV1 } from '@happier-dev/plugin-sdk/managed-services';
import type { ActivatedPluginRuntimeRegistry } from '../manager';
import type { ActivationTarget } from '../activation/targets';
import { readPluginExecProcessCustodyForHost, type PluginExecProcessCustodyForHost } from '../../invocation/services/exec';

export type ProjectNativeAdapterLeaseV1 = Readonly<{
    declaration: PluginProjectNativeAdapterContributionV1;
    pluginVersion: string;
    occurrenceId: string;
    runtime: Pick<PluginProjectNativeAdapterRuntimeV1, 'detect'>;
    /** Captured once by managed service admission; only its exact resource may settle after retirement. */
    captureNativeServiceLifecycle(instance: ManagedServiceNativeInstanceV1): ProjectNativeServiceLifecycleCaptureV1;
    /** Retained by host final-launch custody, never supplied by a plugin Action. */
    acquireProduction(input: ProjectNativeAdapterProductionInputV1): ProjectNativeAdapterProductionResultV1;
    isCurrent(): boolean;
}>;
export type ProjectNativeAdapterProductionInputV1 = Readonly<{
    root: string;
    environment?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
}>;
export type ProjectNativeAdapterProductionV1 = Readonly<{
    /** Selected installed plugin provenance, not an installed native-tool version. */
    pluginVersion: string;
    exec: PluginInvocationContext['services']['exec'];
    resolveCommand(request: PluginProjectNativeCommandRequestV1, options?: PluginCancellationOptions): Promise<PluginProjectNativeCommandResultV1>;
    produceEnvironment(request: PluginProjectNativeEnvironmentRequestV1, options?: PluginCancellationOptions): Promise<PluginProjectNativeEnvironmentResultV1>;
    isCurrent(): boolean;
    /** Operates only on resources already captured by this selected invocation. */
    requestStop(): Promise<void>;
    waitForSettlement(): Promise<void>;
    onOutcomeUncertain(listener: (error: unknown) => void): () => void;
    /** Call only after no-launch or actual process settlement; uncertainty retains it. */
    release(): Promise<void>;
}>;
export type ProjectNativeAdapterProductionResultV1 = Readonly<{
    kind: 'ready'; production: ProjectNativeAdapterProductionV1;
}> | PluginProjectNativeFailureV1;
export type ProjectNativeServiceLifecycleCaptureV1 = Readonly<{ kind: 'ready'; lifecycle: ManagedServiceNativeLifecycleV1 }> | Readonly<{
    kind: 'refused';
    code: 'native_adapter_retired' | 'native_adapter_unsupported' | 'native_adapter_reference_mismatch';
}>;
export type ProjectNativeAdapterInvocationContextFactoryV1 = (input: Readonly<{
    occurrenceId: string;
    root: string;
    environment?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    isCurrent(): boolean;
}>) => Readonly<{ context: PluginInvocationContext; complete(): void }>;
export type ProjectNativeAdapterResolutionV1 = Readonly<{ kind: 'ready'; lease: ProjectNativeAdapterLeaseV1 }> | Readonly<{
    kind: 'refused';
    code: 'native_adapter_unavailable' | 'native_adapter_unsupported' | 'native_adapter_retired' | 'native_adapter_activation_failed';
}>;

export class ProjectNativeAdapterInvocationError extends Error {
    constructor(readonly code: 'native_adapter_retired' | 'native_adapter_cancelled' | 'native_adapter_result_invalid' | 'native_adapter_reference_mismatch') {
        super(code);
    }
}

export function isProjectNativeProcessUncertain(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'plugin_exec_termination_incomplete';
}

export function preserveUnconfirmedNativeProcess(error: unknown): void {
    if (isProjectNativeProcessUncertain(error)) {
        // Invocation retirement/cancellation cannot settle an owned native process.
        // Its environment producer translates this process-owner fact safely.
        throw error;
    }
}

/** Uses the admitted catalog and existing lifecycle; saved refs never become occurrence ids. */
export async function resolveProjectNativeAdapter(params: Readonly<{
    reference: PluginContributionIdentityV1;
    role: ProjectNativeAdapterRoleV1;
    targets: readonly ActivationTarget[];
    registry: Pick<ActivatedPluginRuntimeRegistry, 'activateContributionsOnDemand' | 'targetRegistrations' | 'readPluginOccurrenceId' | 'isPluginOccurrenceCurrent'>;
    isAdmitted?: () => boolean;
    createInvocationContext?: ProjectNativeAdapterInvocationContextFactoryV1;
}>): Promise<ProjectNativeAdapterResolutionV1> {
    const { reference, registry } = params;
    const target = params.targets.find(candidate => candidate.pluginId === reference.pluginId);
    const declaration = target?.manifest.contributes.projectNativeAdapters.find(candidate => candidate.id === reference.localId);
    if (!declaration) return { kind: 'refused', code: 'native_adapter_unavailable' };
    if (!declaration.roles.includes(params.role)) return { kind: 'refused', code: 'native_adapter_unsupported' };
    const occurrenceId = registry.readPluginOccurrenceId(reference.pluginId);
    const isCurrent = () => occurrenceId !== null
        && registry.isPluginOccurrenceCurrent(reference.pluginId, occurrenceId)
        && (params.isAdmitted?.() ?? true);
    if (!isCurrent()) return { kind: 'refused', code: 'native_adapter_retired' };
    try {
        await registry.activateContributionsOnDemand([{ ...reference, family: 'projectNativeAdapters' }]);
    } catch {
        return { kind: 'refused', code: isCurrent() ? 'native_adapter_activation_failed' : 'native_adapter_retired' };
    }
    if (!isCurrent()) return { kind: 'refused', code: 'native_adapter_retired' };
    const registration = registry.targetRegistrations.find(entry => entry.pluginId === reference.pluginId
        && entry.occurrenceId === occurrenceId && entry.registration.family === 'projectNativeAdapters'
        && entry.registration.localId === reference.localId);
    if (!registration || registration.registration.family !== 'projectNativeAdapters') return { kind: 'refused', code: 'native_adapter_activation_failed' };
    const current = () => isCurrent() && registry.targetRegistrations.includes(registration);
    const registered = registration.registration.value;
    const matches = (identity: PluginContributionIdentityV1) => identity.pluginId === reference.pluginId && identity.localId === reference.localId;
    const matchesContext = (context: PluginInvocationContext) => context.plugin.id === reference.pluginId
        && context.contribution.id === reference.localId
        && context.contribution.qualifiedId === `${reference.pluginId}/projectNativeAdapters/${reference.localId}`;
    const runtime: PluginProjectNativeAdapterRuntimeV1 = Object.freeze({
        ...(registered.detect ? { async detect(request: PluginProjectNativeInspectionV1, options?: PluginCancellationOptions) {
            if (!current()) throw new ProjectNativeAdapterInvocationError('native_adapter_retired');
            if (options?.signal?.aborted) throw new ProjectNativeAdapterInvocationError('native_adapter_cancelled');
            if (!matches(request.adapter)) throw new ProjectNativeAdapterInvocationError('native_adapter_reference_mismatch');
            let result: unknown;
            try { result = await registered.detect!(request, options); }
            finally { if (!current()) throw new ProjectNativeAdapterInvocationError('native_adapter_retired'); }
            if (options?.signal?.aborted) throw new ProjectNativeAdapterInvocationError('native_adapter_cancelled');
            const admitted = ProjectDefinitionDetectionV1Schema.safeParse(result);
            if (!admitted.success) throw new ProjectNativeAdapterInvocationError('native_adapter_result_invalid');
            const parsed = admitted.data;
            const references = [...parsed.entries.map(entry => entry.source), ...parsed.environments];
            if (references.some(ref => ('adapter' in ref) && !matches(ref.adapter))) throw new ProjectNativeAdapterInvocationError('native_adapter_reference_mismatch');
            return parsed;
        } } : {}),
        ...(registered.resolveCommand ? { async resolveCommand(request: PluginProjectNativeCommandRequestV1, context: PluginInvocationContext, options?: PluginCancellationOptions) {
            if (!current()) return { kind: 'unavailable' as const, code: 'native_adapter_retired' };
            if (context.signal.aborted || options?.signal?.aborted) return { kind: 'cancelled' as const, code: 'native_adapter_cancelled' };
            if (!matchesContext(context) || !matches(request.adapter) || !matches(request.source.adapter)) return { kind: 'failed' as const, code: 'native_adapter_reference_mismatch' };
            let result: unknown;
            try { result = await registered.resolveCommand!(request, context, options); }
            catch (error) {
                preserveUnconfirmedNativeProcess(error);
                if (!current()) return { kind: 'unavailable' as const, code: 'native_adapter_retired' };
                return context.signal.aborted || options?.signal?.aborted
                    ? { kind: 'cancelled' as const, code: 'native_adapter_cancelled' }
                    : { kind: 'failed' as const, code: 'native_adapter_failed' };
            }
            if (!current()) return { kind: 'unavailable' as const, code: 'native_adapter_retired' };
            if (context.signal.aborted || options?.signal?.aborted) return { kind: 'cancelled' as const, code: 'native_adapter_cancelled' };
            const admitted = PluginProjectNativeCommandResultV1Schema.safeParse(result);
            if (!admitted.success) return { kind: 'failed' as const, code: 'native_adapter_result_invalid' };
            if (admitted.data.kind === 'resolved' && admitted.data.nativeInstance) {
                if (!matches(admitted.data.nativeInstance.adapter)) return { kind: 'failed' as const, code: 'native_adapter_reference_mismatch' };
                if (!declaration.roles.includes('nativeServiceLifecycle') || !registered.nativeServiceLifecycle) return { kind: 'unsupported' as const, code: 'native_adapter_unsupported' };
            }
            return admitted.data;
        } } : {}),
        ...(registered.produceEnvironment ? { async produceEnvironment(request: PluginProjectNativeEnvironmentRequestV1, context: PluginInvocationContext, options?: PluginCancellationOptions) {
            if (!current()) return { kind: 'unavailable' as const, code: 'native_adapter_retired' };
            if (context.signal.aborted || options?.signal?.aborted) return { kind: 'cancelled' as const, code: 'native_adapter_cancelled' };
            if (!matchesContext(context) || !matches(request.adapter) || !matches(request.selection.adapter)) return { kind: 'failed' as const, code: 'native_adapter_reference_mismatch' };
            let result: unknown;
            try { result = await registered.produceEnvironment!(request, context, options); }
            catch (error) {
                preserveUnconfirmedNativeProcess(error);
                if (!current()) return { kind: 'unavailable' as const, code: 'native_adapter_retired' };
                return context.signal.aborted || options?.signal?.aborted
                    ? { kind: 'cancelled' as const, code: 'native_adapter_cancelled' }
                    : { kind: 'failed' as const, code: 'native_adapter_failed' };
            }
            if (!current()) return { kind: 'unavailable' as const, code: 'native_adapter_retired' };
            if (context.signal.aborted || options?.signal?.aborted) return { kind: 'cancelled' as const, code: 'native_adapter_cancelled' };
            const admitted = PluginProjectNativeEnvironmentResultV1Schema.safeParse(result);
            return admitted.success ? admitted.data : { kind: 'failed' as const, code: 'native_adapter_result_invalid' };
        } } : {}),
    });
    const acquireProduction = (input: ProjectNativeAdapterProductionInputV1): ProjectNativeAdapterProductionResultV1 => {
        const root = input.root;
        if (!current()) return { kind: 'unavailable', code: 'native_adapter_retired' };
        if (input.signal?.aborted) return { kind: 'cancelled', code: 'native_adapter_cancelled' };
        if (!params.createInvocationContext) return { kind: 'unavailable', code: 'native_adapter_invocation_unavailable' };
        let invocation: ReturnType<ProjectNativeAdapterInvocationContextFactoryV1>;
        try {
            invocation = params.createInvocationContext({ occurrenceId: occurrenceId!, root,
                environment: input.environment, signal: input.signal, isCurrent: current });
        } catch {
            return !current() ? { kind: 'unavailable', code: 'native_adapter_retired' }
                : input.signal?.aborted ? { kind: 'cancelled', code: 'native_adapter_cancelled' }
                : { kind: 'unavailable', code: 'native_adapter_invocation_unavailable' };
        }
        if (!matchesContext(invocation.context) || invocation.context.plugin.version !== target!.manifest.version) {
            invocation.complete();
            return { kind: 'failed', code: 'native_adapter_reference_mismatch' };
        }
        if (!current() || invocation.context.signal.aborted) {
            invocation.complete();
            return !current() ? { kind: 'unavailable', code: 'native_adapter_retired' }
                : { kind: 'cancelled', code: 'native_adapter_cancelled' };
        }
        let custody: PluginExecProcessCustodyForHost;
        try { custody = readPluginExecProcessCustodyForHost(invocation.context.services.exec); }
        catch { invocation.complete(); return { kind: 'unavailable', code: 'native_adapter_invocation_unavailable' }; }
        let released = false;
        let stopRequested = false;
        let releasePromise: Promise<void> | undefined;
        const invoke = async <Request extends PluginProjectNativeInspectionV1, Result extends PluginProjectNativeCommandResultV1 | PluginProjectNativeEnvironmentResultV1>(
            request: Request,
            handler: ((request: Request, context: PluginInvocationContext, options?: PluginCancellationOptions) => Promise<Result>) | undefined,
            options?: PluginCancellationOptions,
        ): Promise<Result | PluginProjectNativeFailureV1> => {
            if (released || !current()) return { kind: 'unavailable', code: 'native_adapter_retired' };
            if (stopRequested || invocation.context.signal.aborted || options?.signal?.aborted) return { kind: 'cancelled', code: 'native_adapter_cancelled' };
            if (request.root !== root) return { kind: 'failed', code: 'native_adapter_reference_mismatch' };
            if (!handler) return { kind: 'unsupported', code: 'native_adapter_unsupported' };
            // The validated callback's native process uncertainty propagates;
            // only the host process owner can decide when to release this capture.
            try { return await handler(request, invocation.context, options); }
            catch (error) {
                if (!isProjectNativeProcessUncertain(error)) throw error;
                // Keep the original preparation pending and observable. Public
                // Stop retries the same Exec resources; root exit is not proof.
                await custody.waitForSettlement();
                return stopRequested || invocation.context.signal.aborted || options?.signal?.aborted
                    ? { kind: 'cancelled', code: 'native_adapter_cancelled' }
                    : { kind: 'failed', code: 'native_adapter_failed' };
            }
        };
        return { kind: 'ready', production: Object.freeze({
            pluginVersion: target!.manifest.version,
            exec: invocation.context.services.exec,
            resolveCommand: (request: PluginProjectNativeCommandRequestV1, options?: PluginCancellationOptions) => invoke(request, runtime.resolveCommand, options),
            produceEnvironment: (request: PluginProjectNativeEnvironmentRequestV1, options?: PluginCancellationOptions) => invoke(request, runtime.produceEnvironment, options),
            isCurrent: () => !released && !stopRequested && !invocation.context.signal.aborted && current(),
            requestStop() { stopRequested = true; return custody.requestStop(); },
            waitForSettlement: custody.waitForSettlement,
            onOutcomeUncertain: custody.onOutcomeUncertain,
            release() {
                if (releasePromise) return releasePromise;
                released = true;
                if (!custody.hasUnsettledProcesses()) {
                    invocation.complete();
                    releasePromise = Promise.resolve();
                } else {
                    releasePromise = (async () => {
                        await custody.requestStop();
                        await custody.waitForSettlement();
                        invocation.complete();
                    })();
                    const attempt = releasePromise;
                    void attempt.catch(() => { if (releasePromise === attempt) releasePromise = undefined; });
                }
                return releasePromise;
            },
        }) };
    };
    const passiveRuntime = Object.freeze({ ...(runtime.detect ? { detect: runtime.detect } : {}) });
    return { kind: 'ready', lease: Object.freeze({ declaration, pluginVersion: target!.manifest.version, occurrenceId: occurrenceId!, runtime: passiveRuntime, isCurrent: current, acquireProduction,
        captureNativeServiceLifecycle(instance: ManagedServiceNativeInstanceV1): ProjectNativeServiceLifecycleCaptureV1 {
            if (!current()) return { kind: 'refused', code: 'native_adapter_retired' };
            if (!matches(instance.adapter)) return { kind: 'refused', code: 'native_adapter_reference_mismatch' };
            const lifecycle = registered.nativeServiceLifecycle;
            if (!lifecycle) return { kind: 'refused', code: 'native_adapter_unsupported' };
            const retained = Object.freeze({ adapter: Object.freeze({ ...instance.adapter }), nativeResourceId: instance.nativeResourceId });
            const matchesInstance = (candidate: ManagedServiceNativeInstanceV1) => matches(candidate.adapter) && candidate.nativeResourceId === retained.nativeResourceId;
            return { kind: 'ready', lifecycle: Object.freeze({
                async inspect(candidate: ManagedServiceNativeInstanceV1, options?: PluginCancellationOptions) {
                    if (!current()) throw new ProjectNativeAdapterInvocationError('native_adapter_retired');
                    if (!matchesInstance(candidate)) throw new ProjectNativeAdapterInvocationError('native_adapter_reference_mismatch');
                    const result = await lifecycle.inspect(retained, options);
                    if (!current()) throw new ProjectNativeAdapterInvocationError('native_adapter_retired');
                    return result;
                },
                async stop(candidate: ManagedServiceNativeInstanceV1, options?: PluginCancellationOptions) {
                    if (!matchesInstance(candidate)) return { status: 'unsupported' as const };
                    // The incumbent service supervisor owns settlement, not adapter currentness.
                    return await lifecycle.stop(retained, options);
                },
            }) };
        },
    }) };
}
