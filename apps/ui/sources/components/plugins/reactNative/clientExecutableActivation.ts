import type { PluginContributionClientPlatform } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { PluginAccountApi, PluginClientApi } from '@happier-dev/plugin-sdk';

import {
    getInstalledPluginReactNativeBundleCache,
} from './bundleCache';
import {
    getPluginUiClientExecutableComposition,
    type PluginUiClientExecutableActivation,
    type PluginUiClientExecutableAdmission,
    type PluginUiClientExecutableComposition,
    type PluginUiClientExecutableCompositionAttempt,
    type PluginUiClientExecutableDerivedScope,
    type PluginUiClientExecutableRegistrationScope,
    type PluginUiClientExecutableFailure,
} from './clientExecutableContributions';
import {
    getInstalledPluginUiExecutableModuleHost,
    type PluginUiExecutableModuleHost,
} from './executableModuleHost';
import { loadPluginReactNativeBundleExport, type PluginReactNativeLoaderBackend } from './loader';
import { createLazyAccountExecutable } from './lazyAccountExecutable';
import { resolveDefaultReactNativeLoaderBackend } from './resolveDefaultReactNativeLoaderBackend';
import {
    resolveProjectedPluginUiClientExecutables,
    type PluginUiClientExecutableProjectionSource,
    type PluginUiProjectedClientExecutableTarget,
} from './clientExecutableProjection';
import {
    acquirePluginReactNativeArtifactAvailability,
} from '@/sync/domains/plugins/availability/reactNativeArtifactAvailability';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/**
 * Family adapters receive an already-normalized generic target and can only
 * add their own derived runtime projection to its one registration scope.
 * They cannot parse, acquire, activate, or reconcile executable targets.
 */
export type PluginUiClientExecutableDerivedScopeFactory = (input: Readonly<{
    target: PluginUiProjectedClientExecutableTarget;
    registrationScope: PluginUiClientExecutableRegistrationScope<PluginClientApi | PluginAccountApi>;
}>) => PluginUiClientExecutableDerivedScope | null | undefined;

export type PluginUiClientExecutableReconciliationAttempt = Readonly<{
    activation: PluginUiClientExecutableAdmission;
    result: PluginUiClientExecutableCompositionAttempt['result'];
    reused: boolean;
}>;

function isCurrent(input: Readonly<{
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    isCurrent?: () => boolean;
}>): boolean {
    try {
        return (input.accountLifetime?.isCurrent() ?? true) && (input.isCurrent?.() ?? true);
    } catch {
        return false;
    }
}

function release(releaseResource: () => void): void {
    try {
        releaseResource();
    } catch {
        // Artifact retirement cannot retain a generic registration: the host
        // synchronously withdraws that index before asynchronous cleanup.
    }
}

function targetAdmission(target: PluginUiProjectedClientExecutableTarget): PluginUiClientExecutableAdmission {
    return {
        pluginId: target.pluginId,
        ...(target.pluginVersion === undefined ? {} : { pluginVersion: target.pluginVersion }),
        contributes: target.contributes,
        target: target.target,
        executionOrigin: target.executionOrigin,
        occurrenceId: target.occurrenceId,
        hostUiApiRange: target.artifactGraph.hostUiApiRange,
        identity: target.cacheIdentity,
        moduleReference: target.moduleReference,
        authority: target.authority,
    };
}

/** Same normalization and composition fingerprint as adoption, without acquiring bytes. */
export function retainProjectedPluginUiClientExecutables(input: Readonly<{
    actionProjection?: PluginUiClientExecutableProjectionSource | null;
    voiceProjection?: PluginUiClientExecutableProjectionSource | null;
    voiceProviderIds?: ReadonlySet<string>;
    platform: PluginContributionClientPlatform;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    executableHost?: PluginUiExecutableModuleHost;
}>): Promise<void> {
    const composition = getPluginUiClientExecutableComposition(input.executableHost ?? getInstalledPluginUiExecutableModuleHost());
    const targets = input.accountLifetime?.isCurrent()
        ? resolveProjectedPluginUiClientExecutables(input)
        : [];
    return composition.retain(targets.map(targetAdmission));
}

async function createProjectedClientExecutableActivation(input: Readonly<{
    target: PluginUiProjectedClientExecutableTarget;
    composition: PluginUiClientExecutableComposition;
    cache: ReturnType<typeof getInstalledPluginReactNativeBundleCache>;
    backend: PluginReactNativeLoaderBackend;
    reader: PluginAccountAvailabilityReader | null | undefined;
    accountLifetime: ActiveServerAccountScopeLifetime | null | undefined;
    isCurrent?: () => boolean;
    retainCommittedActivation?: boolean;
    createDerivedScope?: PluginUiClientExecutableDerivedScopeFactory;
}>): Promise<Readonly<{
    activation: PluginUiClientExecutableActivation;
    release: () => void;
}> | Readonly<{ refusal: PluginUiClientExecutableFailure }> | null> {
    const { target, accountLifetime } = input;
    if (!accountLifetime || !input.reader || !target.authority.serverId || !isCurrent(input)) return null;
    if ('kind' in target.authority && (target.authority.accountId !== accountLifetime.scope.accountId
        || target.authority.serverId !== accountLifetime.scope.serverId)) return null;
    if (target.target.realm !== 'account') return createAcquiredClientExecutableActivation(input);
    let claimed = false;
    let accountRetirement: Readonly<{ dispose(): void }> | undefined;
    let acquired: Awaited<ReturnType<typeof createAcquiredClientExecutableActivation>>;
    let activation: PluginUiClientExecutableActivation;
    const scopeIsCurrent = () => accountLifetime.isCurrent() && (claimed
        ? input.composition.isCurrentActivation(activation) : isCurrent(input));
    const lazy = createLazyAccountExecutable({ pluginId: target.pluginId, contributes: target.contributes,
        target: target.target, isCurrent: scopeIsCurrent,
        async load() {
            if (!acquired || 'refusal' in acquired) {
                acquired = await createAcquiredClientExecutableActivation({ ...input, isCurrent: scopeIsCurrent,
                    retainCommittedActivation: false });
            }
            if (!acquired) throw Object.assign(new Error('client_executable_activation_retired'), { code: 'plugin_action_generation_retired' });
            if ('refusal' in acquired) throw Object.assign(new Error(acquired.refusal.code), acquired.refusal);
            return loadPluginReactNativeBundleExport({ cache: input.cache, identity: target.cacheIdentity,
                moduleReference: target.moduleReference, backend: input.backend, hostPlatform: target.target.platform });
        } });
    const releaseAcquisition = () => {
        accountRetirement?.dispose();
        if (acquired && !('refusal' in acquired)) acquired.release();
    };
    activation = { ...targetAdmission(target), accountLifetime, cache: input.cache, backend: input.backend,
        isCurrent: scopeIsCurrent,
        loadExport: async () => ({ ok: true, exported: lazy.activate }),
        prepareRegistration: lazy.prepareRegistration,
        createScope(registrationScope) {
            claimed = true;
            accountRetirement = accountLifetime.onRetire(() => { void input.composition.invalidatePlugin(target.pluginId); });
            return { commit: () => registrationScope.commit(), isCurrent: scopeIsCurrent,
                unwind: async () => releaseAcquisition() };
        },
    };
    return { activation, release: releaseAcquisition };
}

async function createAcquiredClientExecutableActivation(input: Readonly<{
    target: PluginUiProjectedClientExecutableTarget;
    composition: PluginUiClientExecutableComposition;
    cache: ReturnType<typeof getInstalledPluginReactNativeBundleCache>;
    backend: PluginReactNativeLoaderBackend;
    reader: PluginAccountAvailabilityReader | null | undefined;
    accountLifetime: ActiveServerAccountScopeLifetime | null | undefined;
    isCurrent?: () => boolean;
    retainCommittedActivation?: boolean;
    createDerivedScope?: PluginUiClientExecutableDerivedScopeFactory;
}>): Promise<Readonly<{ activation: PluginUiClientExecutableActivation; release: () => void }>
    | Readonly<{ refusal: PluginUiClientExecutableFailure }> | null> {
    const { accountLifetime, reader, target } = input;
    const serverId = target.authority.serverId;
    if (!reader || !accountLifetime || !serverId || !isCurrent(input)) return null;
    let claimedByComposition = false;
    let activation: PluginUiClientExecutableActivation;
    const scopeIsCurrent = () => accountLifetime.isCurrent() && (
        claimedByComposition && input.retainCommittedActivation
            ? input.composition.isCurrentActivation(activation)
            : isCurrent(input)
    );

    const acquired = await acquirePluginReactNativeArtifactAvailability({
        reader,
        executionOrigin: target.executionOrigin,
        artifactGraph: target.artifactGraph,
        cacheIdentity: target.cacheIdentity,
        accountLifetime,
        // Machine contributions retain their daemon byte route; Account
        // custody uses the same Availability owner's hosted/bundled sources.
        ...(!('kind' in target.authority) ? { daemon: {
            machineId: target.authority.machineId,
            serverId,
        } } : {}),
        ...(target.artifactSelectionOwner === 'daemonProjection' && target.pluginVersion
            ? {
                daemonProjectionSelection: {
                    occurrenceId: target.occurrenceId,
                    contributionId: target.cacheIdentity.contributionId,
                    releaseVersion: target.pluginVersion,
                    isCurrent: scopeIsCurrent,
                },
            }
            : {}),
        isCurrent: scopeIsCurrent,
    });
    if (acquired.kind !== 'available') {
        if (!isCurrent(input)) return null;
        const refusal: PluginUiClientExecutableFailure = Object.freeze({ ok: false, code: acquired.code,
            layer: acquired.layer, phase: acquired.phase, retryable: acquired.retryable, diagnostics: Object.freeze([acquired.code]) });
        input.composition.refuse(targetAdmission(target), refusal);
        return { refusal };
    }
    if (!acquired.isCurrent() || !isCurrent(input)) {
        acquired.dispose();
        return null;
    }

    let released = false;
    let artifactRevocation: Readonly<{ dispose: () => void }> | null = null;
    let accountRetirement: Readonly<{ dispose: () => void }> | null = null;
    const releaseLease = (): void => {
        if (released) return;
        released = true;
        artifactRevocation?.dispose();
        accountRetirement?.dispose();
        acquired.dispose();
    };
    artifactRevocation = acquired.onRevoke(() => {
        void input.composition.invalidatePlugin(target.pluginId);
    });
    // Deferred Account targets already bind retirement at descriptor admission.
    if (target.target.realm !== 'account') {
        accountRetirement = accountLifetime.onRetire(() => {
            void input.composition.invalidatePlugin(target.pluginId);
        });
    }
    if (!acquired.isCurrent() || !isCurrent(input)) {
        releaseLease();
        return null;
    }

    activation = Object.freeze({
        ...targetAdmission(target),
        accountLifetime,
        cache: input.cache,
        backend: input.backend,
        isCurrent: () => scopeIsCurrent() && acquired.isCurrent(),
        createScope: (registrationScope) => {
            // The complete-set composition claims this exact target before
            // creating its scope. Equivalent inventory updates retain that
            // claim even while foreign activation is still preparing.
            claimedByComposition = true;
            const derivedScope = input.createDerivedScope?.({ target, registrationScope }) ?? null;
            let unwound = false;
            return Object.freeze({
                commit: async () => {
                    if (!scopeIsCurrent() || !acquired.isCurrent()) throw new Error('client_executable_activation_retired');
                    if (derivedScope) await derivedScope.commit();
                    else registrationScope.commit();
                    if (!scopeIsCurrent()) throw new Error('client_executable_activation_retired');
                },
                isCurrent: () => (
                    scopeIsCurrent()
                    && acquired.isCurrent()
                    && (derivedScope?.isCurrent?.() ?? true)
                ),
                unwind: async () => {
                    if (unwound) return;
                    unwound = true;
                    try {
                        await derivedScope?.unwind();
                    } finally {
                        releaseLease();
                    }
                },
            });
        },
    });
    return Object.freeze({ activation, release: releaseLease });
}

/**
 * The sole client executable complete-set reconciliation point. It owns raw
 * Action+Voice projection normalization, one Artifact lease per exact target,
 * activation currentness, and the generic registration transaction.
 */
export async function reconcileProjectedPluginUiClientExecutables(input: Readonly<{
    actionProjection?: PluginUiClientExecutableProjectionSource | null;
    voiceProjection?: PluginUiClientExecutableProjectionSource | null;
    voiceProviderIds?: ReadonlySet<string>;
    platform: PluginContributionClientPlatform;
    executableHost?: PluginUiExecutableModuleHost;
    loaderBackend?: PluginReactNativeLoaderBackend;
    reader?: PluginAccountAvailabilityReader | null;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    isCurrent?: () => boolean;
    /** AppShell publishes every latest exact target set before independent preparation. */
    retainCommittedActivation?: boolean;
    createDerivedScope?: PluginUiClientExecutableDerivedScopeFactory;
}>): Promise<readonly PluginUiClientExecutableReconciliationAttempt[]> {
    const executableHost = input.executableHost ?? getInstalledPluginUiExecutableModuleHost();
    const composition = getPluginUiClientExecutableComposition(executableHost);
    const targets = resolveProjectedPluginUiClientExecutables({
        actionProjection: input.actionProjection,
        voiceProjection: input.voiceProjection,
        voiceProviderIds: input.voiceProviderIds,
        platform: input.platform,
    });
    const cache = getInstalledPluginReactNativeBundleCache();
    const backend = input.loaderBackend ?? resolveDefaultReactNativeLoaderBackend();
    // Retain the complete rights set synchronously. Each exact target can then
    // prepare and publish without joining a peer's bytes or plugin cleanup.
    // retain owns withdrawal; adopt cannot revive a target it has withdrawn.
    const retention = composition.retain(isCurrent(input) ? targets.map(targetAdmission) : []);
    const preparations = targets.map(async (target) => {
        const candidate = await createProjectedClientExecutableActivation({
            target,
            composition,
            cache,
            backend,
            reader: input.reader,
            accountLifetime: input.accountLifetime,
            isCurrent: input.isCurrent,
            retainCommittedActivation: input.retainCommittedActivation,
            createDerivedScope: input.createDerivedScope,
        });
        if (!candidate) return [];
        if ('refusal' in candidate) return [{ activation: targetAdmission(target), result: candidate.refusal, reused: false }];
        try {
            const attempts = await composition.adopt([candidate.activation]);
            if (!attempts[0]?.result.ok || attempts[0]?.reused) release(candidate.release);
            return attempts;
        } catch (error) {
            release(candidate.release);
            throw error;
        }
    });
    const [attempts] = await Promise.all([Promise.all(preparations), retention]);
    return isCurrent(input) ? Object.freeze(attempts.flat()) : Object.freeze([]);
}
