import type { PluginContributionClientPlatform } from '@happier-dev/protocol';
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
} from './clientExecutableContributions';
import {
    getInstalledPluginUiExecutableModuleHost,
    type PluginUiExecutableModuleHost,
} from './executableModuleHost';
import type { PluginReactNativeLoaderBackend } from './loader';
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

export type PluginUiClientExecutableReconciliationAttempt = PluginUiClientExecutableCompositionAttempt;

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
}> | null> {
    const { accountLifetime, reader, target } = input;
    const serverId = target.authority.serverId;
    if (!reader || !accountLifetime || !serverId || !isCurrent(input)) return null;
    if ('kind' in target.authority && (target.authority.accountId !== accountLifetime.scope.accountId
        || target.authority.serverId !== accountLifetime.scope.serverId)) return null;
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
    if (acquired.kind !== 'available') return null;
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
    accountRetirement = accountLifetime.onRetire(() => {
        void input.composition.invalidatePlugin(target.pluginId);
    });
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
    /** AppShell publishes every latest exact target set before queued preparation. */
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
    // Byte preparation is independent; settlement preserves target order for
    // the one registration transaction and cleanup of every acquired lease.
    const preparations = await Promise.allSettled(targets.map((target) => (
        createProjectedClientExecutableActivation({
            target,
            composition,
            cache,
            backend,
            reader: input.reader,
            accountLifetime: input.accountLifetime,
            isCurrent: input.isCurrent,
            retainCommittedActivation: input.retainCommittedActivation,
            createDerivedScope: input.createDerivedScope,
        })
    )));
    const prepared = preparations.flatMap((result) => (
        result.status === 'fulfilled' && result.value ? [result.value] : []
    ));
    const failed = preparations.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
        for (const candidate of prepared) release(candidate.release);
        throw failed.reason;
    }
    if (!isCurrent(input)) {
        for (const candidate of prepared) release(candidate.release);
        // AppShell has already published the latest complete-set retention.
        // An obsolete preparation request cannot withdraw its newer owner.
        if (!input.retainCommittedActivation) await composition.reconcile([]);
        return Object.freeze([]);
    }

    let attempts: readonly PluginUiClientExecutableCompositionAttempt[];
    try {
        attempts = await composition.reconcile(prepared.map((candidate) => candidate.activation));
    } catch (error) {
        for (const candidate of prepared) release(candidate.release);
        throw error;
    }
    for (const [index, attempt] of attempts.entries()) {
        const candidate = prepared[index];
        if (candidate && (!attempt.result.ok || attempt.reused)) release(candidate.release);
    }
    return attempts;
}
