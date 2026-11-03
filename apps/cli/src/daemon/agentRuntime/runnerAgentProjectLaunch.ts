import { PluginError } from '@happier-dev/plugin-sdk';
import { performance } from 'node:perf_hooks';
import { SecretReferenceOverlayV1Schema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import type { SecretReferenceOverlayV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { runWithRequesterSessionCurrentnessCheckpoint } from "@/daemon/sessionEncryption/requesterCurrentness";
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { createProjectAgentNativeLaunchOwner } from '@/workspaces/projectSetup/projectAgentNativeLaunch';
import type { HostAgentNativeLaunchPreparation } from '@/plugins/runtime/invocation/services/exec';
import { readSavedSecretMaterializerForOperation } from "@/settings/secrets/savedSecretCatalogRead";
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readAccountLaunchProfiles, readProfileSettingsFromAccountSnapshot } from '@/settings/profiles/readProfilesFromAccountSettings';
import { resolveEffectiveLaunchProfileSecretBindings } from './resolveForegroundProfileSavedSecretEnvironment';
import { readSavedSecretRevisionsFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { createExecutionRunProjectSetupProjection, createExecutionRunProjectSetupProjectionOwner, projectExecutionRunSetupBase } from '@/agent/runtime/bridges/executionRun/executionRunProjectSetup';
import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { logger } from '@/utils/logger';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/** The retained producer owns review; its runner controller owns lifecycle and Stop. */
function retainRunSetup(input: Readonly<{
    runId: string;
    sessionId?: string;
    signal: AbortSignal;
    runtime: ProjectFiniteActionRuntime;
    control: RetainedExecutionRunControl;
}>) {
    const attach = input.runtime.operationRuntime.attachOwner;
    if (!attach) return undefined;
    let disposed = false;
    const listeners = new Set<(id: string) => void>();
    const publish = () => { for (const listener of listeners) listener(input.runId); };
    const scope = { accountId: input.runtime.accountId, machineId: input.runtime.machineId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
    const setup = createExecutionRunProjectSetupProjection({ runId: input.runId, scope, signal: input.signal, publish,
        readBaseSnapshot: () => null });
    const owner = createExecutionRunProjectSetupProjectionOwner({
        getSetup: id => !disposed && id === input.runId ? setup : undefined,
        async readSnapshot(projection) {
            const run = await input.control.read();
            if (disposed || run.runId !== input.runId) return null;
            const snapshot = projection.snapshot(projectExecutionRunSetupBase(run, scope));
            return snapshot?.domainRef ? snapshot : null;
        },
        stop: () => input.control.stop(),
        listIds: () => [input.runId],
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async waitForChange(_id, signal) {
            signal?.throwIfAborted();
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => { listeners.delete(changed); signal?.removeEventListener('abort', abort); };
                const changed = () => { cleanup(); resolve(); };
                const abort = () => { cleanup(); reject(signal?.reason); };
                listeners.add(changed);
                signal?.addEventListener('abort', abort, { once: true });
            });
        },
    });
    const detach = attach(owner);
    return { context: setup.context, dispose() { disposed = true; publish(); detach(); listeners.clear(); } };
}

export type RetainedExecutionRunControl = Readonly<{
    read(): Promise<ExecutionRunPublicState>;
    stop(): Promise<{ ok: boolean }>;
}>;

/** The ordinary retained-runner composition binds Project preparation to its captured Account.
 * Construction and generic Exec/probes are passive; only a qualified cold launch demands it.
 */
export function createRunnerAgentProjectLaunchInvocation(input: Readonly<{
    cwd: string;
    signal: AbortSignal;
    sessionId?: string;
    requester?: Pick<RequesterSessionRuntimeContext, 'bootstrap' | 'isCurrent'>;
    references?: Readonly<{ profileId?: string; secretReferenceOverlay?: SecretReferenceOverlayV1 }>;
    ingress?: RpcHandlerContext;
    /** Original startup/Run occurrence, retained by its existing lifecycle owner. */
    operation?: ProjectSetupOperationContext;
    /** Host-authored identity and control of the existing Session-owned Run. */
    executionRun?: RetainedExecutionRunControl & Readonly<{ runId: string }>;
    isCurrent(): boolean | Promise<boolean>;
    resolveRuntime(ingress: RpcHandlerContext): Promise<ProjectFiniteActionRuntime | null>;
    /** The native invocation's already-qualified installed Account Agent.
     * This is not a substitute for unknown or unrecovered private birth. */
    resolveInstalledAccountRuntime?: (signal: AbortSignal) => Promise<ProjectFiniteActionRuntime | null>;
}>) {
    let owner: ReturnType<typeof createProjectAgentNativeLaunchOwner> | undefined;
    let runSetup: ReturnType<typeof retainRunSetup>;
    let disposed = false;
    // Attribute the private authorization wait without recording paths, launch
    // values, Account data or exception contents. These are nested spans.
    const observe = async <T>(phase: 'requester_currentness' | 'runtime_resolution' | 'runtime_currentness' | 'project_preparation',
        work: () => Promise<T>): Promise<T> => {
        const startedAt = performance.now();
        let status: 'completed' | 'failed' = 'failed';
        try { const result = await work(); status = 'completed'; return result; }
        finally {
            logger.debug('[PluginExec] Native launch preparation phase', { phase, status,
                ...(phase === 'project_preparation' && status === 'failed' ? owner?.readPreparationDiagnostic() : {}),
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                ...(input.executionRun ? { executionRunId: input.executionRun.runId } : {}),
                durationMs: Math.round(performance.now() - startedAt) });
        }
    };
    const unavailable = (code: string, reason?: 'invocation_retired' | 'runner_authority_unavailable' | 'requester_not_current'
        | 'ingress_missing' | 'settings_context_missing' | 'settings_scope_unavailable' | 'finite_runtime_unavailable'): never => {
        if (reason) logger.debug('[PluginExec] Native launch requester refusal', { reason, ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
        throw new PluginError({ code, message: 'Project native launch context is unavailable' });
    };
    const assertCurrent = async () => {
        input.signal.throwIfAborted();
        if (disposed) unavailable('project_requester_credentials_unavailable', 'invocation_retired');
        if (!await input.isCurrent()) unavailable('project_requester_credentials_unavailable', 'runner_authority_unavailable');
        if (input.requester && !await observe('requester_currentness', () => input.requester!.isCurrent())) unavailable('project_requester_credentials_unavailable', 'requester_not_current');
        input.signal.throwIfAborted();
    };
    const ingress: RpcHandlerContext = input.ingress ?? { signal: input.signal,
        ...(input.requester ? { requesterSessionBootstrap: input.requester.bootstrap } : {}) };
    const prepare: HostAgentNativeLaunchPreparation = async (signal, cwd, environment) => {
        await assertCurrent();
        if (!owner) {
            const installedAccount = !ingress.requesterSessionBootstrap && !ingress.callerInputAuthorization && !ingress.machineAdmission;
            const runtime = await observe('runtime_resolution', () => installedAccount
                ? input.resolveInstalledAccountRuntime?.(signal) ?? Promise.resolve(null) : input.resolveRuntime(ingress));
            await assertCurrent();
            if (!runtime) return installedAccount
                ? unavailable('project_requester_credentials_unavailable', 'ingress_missing')
                : unavailable('project_finite_execution_unavailable', 'finite_runtime_unavailable');
            let installedSecretOperation: Promise<SavedSecretOperationContextV1> | undefined;
            if (!input.operation && input.executionRun) runSetup = retainRunSetup({ runId: input.executionRun.runId,
                control: input.executionRun, signal: input.signal, runtime, ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
            const operation = input.operation ?? runSetup?.context;
            owner = createProjectAgentNativeLaunchOwner({ runtime: { ...runtime, isCurrent: async () => {
                await assertCurrent();
                const current = !runtime.isCurrent || await observe('runtime_currentness', () => runtime.isCurrent!());
                await assertCurrent();
                return current;
            } }, ingress, cwd: input.cwd,
                ...(operation ? { operation } : {}),
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                async resolveSecretInputs() {
                    await assertCurrent();
                    const selected = input.references ?? {};
                    let operationContext = input.requester?.bootstrap.savedSecretOperationContext
                        ?? (runtime.accountAuthorization ? readRequesterAccountActionContext(runtime.accountAuthorization)?.savedSecretOperationContext : undefined);
                    const installedCredentials = runtime.credentials;
                    if (!operationContext && installedAccount && installedCredentials) {
                        // Association is already established by the canonical
                        // preparer before it demands secrets. Capture only this
                        // qualified runtime's Account; never publish or borrow an
                        // ambient settings source, or manufacture Session birth.
                        installedSecretOperation ??= runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl, async () => {
                            const credentials = installedCredentials;
                            const snapshot = await bootstrapAccountSettingsContext({ credentials, signal,
                                mode: 'blocking', publication: 'invocation', honorAccountSettingsModeEnv: false });
                            await assertCurrent();
                            if (runtime.isCurrent && !await runtime.isCurrent()) return unavailable('project_requester_credentials_unavailable', 'requester_not_current');
                            return createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
                                secretSources: runtime.plugins?.secretSources,
                                serverHttpBaseUrl: runtime.serverHttpBaseUrl, isCurrent: async () => {
                                    await assertCurrent();
                                    return !runtime.isCurrent || await runtime.isCurrent();
                                } });
                        });
                        operationContext = await installedSecretOperation;
                    }
                    if (!operationContext) return unavailable('project_requester_credentials_unavailable', 'settings_context_missing');
                    const credentials = operationContext.credentials;
                    const snapshot = operationContext.readSnapshot();
                    if (!credentials || !snapshot || snapshot.scopeKey !== runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl,
                        () => resolveAccountSettingsScopeKey(credentials))) {
                        return unavailable('project_requester_credentials_unavailable', 'settings_scope_unavailable');
                    }
                    let bindings = selected.secretReferenceOverlay?.bindings ?? {};
                    if (selected.profileId) {
                        const profiles = await readAccountLaunchProfiles(readProfileSettingsFromAccountSnapshot(snapshot), credentials,
                            signal, snapshot.profileCatalog, operationContext);
                        await assertCurrent();
                        const profile = profiles.visibleProfiles.find(profile => profile.id === selected.profileId && profile.enabled !== false);
                        if (!profile) return unavailable('profile_catalog_unavailable');
                        bindings = resolveEffectiveLaunchProfileSecretBindings({ profile,
                            accountSettings: readProfileSettingsFromAccountSnapshot(operationContext.readSnapshot() ?? snapshot) ?? {},
                            ...(selected.secretReferenceOverlay ? { secretReferenceOverlay: selected.secretReferenceOverlay } : {}) });
                    }
                    const { snapshot: current, materializer } = await readSavedSecretMaterializerForOperation({ expectedScopeKey: snapshot.scopeKey,
                        secretSources: runtime.plugins?.secretSources,
                        references: Object.values(bindings), signal, operationContext });
                    await assertCurrent();
                    // Only Profile defaults may acquire their current shared revision.
                    // An explicitly selected revision is retained for stale-ref refusal.
                    const unversioned = Object.entries(bindings).filter(([name, binding]) => binding.revision === undefined
                        && !Object.hasOwn(selected.secretReferenceOverlay?.bindings ?? {}, name)
                        && parseSavedSecretRefV1(binding.ref).kind === 'shared_resource');
                    const revisions = readSavedSecretRevisionsFromSnapshotV1(current, unversioned.map(([, binding]) => binding.ref),
                        { isCurrent: () => operationContext.readSnapshot() === current });
                    if (unversioned.length && revisions.status !== 'ready') return unavailable('project_environment_binding_unavailable');
                    const exact = Object.fromEntries(Object.entries(bindings).map(([name, binding]) => {
                        const revision = revisions.status === 'ready' && unversioned.some(([defaultName]) => defaultName === name)
                            ? revisions.resourcesByRef.get(binding.ref)?.revision : undefined;
                        return [name, revision === undefined ? binding : { ...binding, revision }];
                    }));
                    return { secretEnvironment: { accountSettings: current.rawSettings ?? current.settings,
                        savedSecretMaterializer: materializer,
                        settingsSecretsReadKeys: current.settingsSecretsReadKeys,
                        ...(current.savedSecretResources ? { savedSecretResources: current.savedSecretResources } : {}) },
                        ...(Object.keys(exact).length ? { environmentBindings: SecretReferenceOverlayV1Schema.parse({ v: 1, bindings: exact }) } : {}) };
                },
            });
        }
        return await observe('project_preparation', () => owner!.prepare(signal, cwd, environment));
    };
    // One original occurrence owns one setup reservation and review producer.
    // Multiple qualified children keep their own tuples, but cannot overwrite
    // that occurrence's pending setup or race the lazy owner construction.
    let preparation = Promise.resolve();
    const prepareAgentNativeLaunch: HostAgentNativeLaunchPreparation = (signal, cwd, environment) => {
        const next = preparation.then(() => runWithRequesterSessionCurrentnessCheckpoint(() => prepare(signal, cwd, environment)));
        preparation = next.then(() => undefined, () => undefined);
        return next;
    };
    return Object.freeze({ prepareAgentNativeLaunch,
        async disposeProjectAgentLaunch() {
            disposed = true;
            try { await owner?.dispose(); } finally { runSetup?.dispose(); }
        },
    });
}
