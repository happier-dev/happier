import * as React from 'react';

import {
    arePluginMachineExecutionOriginsEqual,
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    derivePluginClientContributionRegistrationRights,
    PluginMachineExecutionOriginV1Schema,
    type PluginContributionClientPlatform,
    type PluginContributionRegistrationRight,
    type PluginMachineExecutionOriginV1,
    type PluginProjectedActionV2,
} from '@happier-dev/protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import {
    createPluginRegistrationScope,
    type PluginRuntimeRegistration,
} from '@happier-dev/plugin-sdk/host/registration';

import type { PluginReactNativeBundleCache } from './bundleCache';
import {
    createPluginUiExecutableModuleHost,
    getInstalledPluginUiExecutableModuleHost,
    type PluginUiExecutableAuthority,
    type PluginUiExecutableModuleActivationResult,
    type PluginUiExecutableModuleHost,
} from './executableModuleHost';
import type {
    PluginReactNativeLoaderBackend,
    RepackInstalledArtifactModuleReference,
} from './loader';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import { isPluginProjectedActionExecutable } from '@/sync/domains/plugins/ui/projection';

export type PluginUiClientExecutableTarget = Readonly<{
    artifactId: string;
    modulePath: string;
    exportName: string;
    platform: PluginContributionClientPlatform;
}>;

export type PluginUiClientExecutableRegistrationAddress = Readonly<{
    family: PluginRuntimeRegistration['family'];
    pluginId: string;
    localId: string;
    target: PluginUiClientExecutableTarget;
    executionOrigin: PluginMachineExecutionOriginV1;
    projectionGeneration: number;
}>;

/** One host-owned activation lifetime, never reconstructed by a family consumer. */
export type PluginUiClientExecutableRegistrationLifecycle = Readonly<{
    signal: AbortSignal;
    isCurrent: () => boolean;
}>;

/** One immutable client registration from one exact target/origin/generation. */
export type PluginUiClientExecutableRegistration = Readonly<{
    contribution: Readonly<{
        pluginId: string;
        localId: string;
    }>;
    right: PluginContributionRegistrationRight;
    registration: PluginRuntimeRegistration;
    target: PluginUiClientExecutableTarget;
    executionOrigin: PluginMachineExecutionOriginV1;
    projectionGeneration: number;
    /** Exact installed package identity supplied by the activated projection. */
    pluginVersion?: string;
    lifecycle: PluginUiClientExecutableRegistrationLifecycle;
}>;

/** Read-only seam shared by the generic index and its installed composition. */
export type PluginUiClientExecutableRegistrationReader = Readonly<{
    read(address: PluginUiClientExecutableRegistrationAddress): PluginUiClientExecutableRegistration | null;
}>;

/**
 * One committed client Action registration that is safe for both presentation
 * eligibility and dispatch. The generic index remains its lifecycle owner.
 */
export type PluginUiClientActionRegistration = Readonly<{
    registration: PluginUiClientExecutableRegistration;
    pluginVersion: string;
    handler: PluginClientActionHandler;
}>;

export type PluginUiClientExecutableRegistrationScope = Readonly<{
    /** The client realm exposes no daemon-only activation capabilities. */
    api: PluginClientApi;
    commit(): void;
    registrations(): readonly PluginRuntimeRegistration[];
    /** Current both before and after commit until this exact scope retires. */
    isCurrent(): boolean;
    /** Starts with synchronous generic-index withdrawal. */
    unwind(): Promise<void>;
}>;

/** A family-specific runtime projection layered on the one generic transaction. */
export type PluginUiClientExecutableDerivedScope = Readonly<{
    commit: () => void | Promise<void>;
    unwind: () => void | Promise<void>;
    isCurrent?: () => boolean;
}>;

export type PluginUiClientExecutableRegistrationIndex = Readonly<{
    createScope(input: Readonly<{
        pluginId: string;
        /** Every compatible declaration the shared module must register. */
        contributes: Readonly<Record<string, unknown>>;
        /**
         * The exact authority-owned declarations this activation may publish.
         * Omitted only when one activation owns the whole declaration set.
         */
        publishedContributes?: Readonly<Record<string, unknown>>;
        target: PluginUiClientExecutableTarget;
        executionOrigin: PluginMachineExecutionOriginV1;
        projectionGeneration: number;
        /** Optional for non-Action client families; Actions fail closed without it. */
        pluginVersion?: string;
        lifecycle: PluginUiClientExecutableRegistrationLifecycle;
    }>): PluginUiClientExecutableRegistrationScope;
    read(address: PluginUiClientExecutableRegistrationAddress): PluginUiClientExecutableRegistration | null;
    revision(): number;
    subscribe(listener: () => void): () => void;
}>;

type IndexedRegistration = Readonly<{
    ownerToken: object;
    registration: PluginUiClientExecutableRegistration;
}>;

type RegistrationSnapshot = Readonly<Record<string, IndexedRegistration>>;

function freezeTarget(target: PluginUiClientExecutableTarget): PluginUiClientExecutableTarget {
    return Object.freeze({
        artifactId: target.artifactId,
        modulePath: target.modulePath,
        exportName: target.exportName,
        platform: target.platform,
    });
}

function freezeExecutionOrigin(origin: PluginMachineExecutionOriginV1): PluginMachineExecutionOriginV1 {
    return Object.freeze({
        serverIdentityId: origin.serverIdentityId,
        materializationRef: Object.freeze({ ...origin.materializationRef }),
    });
}

function sameTarget(
    left: PluginUiClientExecutableTarget,
    right: PluginUiClientExecutableTarget,
): boolean {
    return left.artifactId === right.artifactId
        && left.modulePath === right.modulePath
        && left.exportName === right.exportName
        && left.platform === right.platform;
}

function isLifecycleCurrent(lifecycle: PluginUiClientExecutableRegistrationLifecycle): boolean {
    try {
        return !lifecycle.signal.aborted && lifecycle.isCurrent();
    } catch {
        return false;
    }
}

function registrationIndexKey(input: Readonly<{
    family: string;
    pluginId: string;
    localId: string;
}>): string {
    return [
        input.family,
        buildQualifiedPluginContributionKey(createPluginContributionIdentity({
            pluginId: input.pluginId,
            localId: input.localId,
        })),
    ].join('\u0000');
}

function validateScopeInput(input: Readonly<{
    pluginId: string;
    target: PluginUiClientExecutableTarget;
    executionOrigin: PluginMachineExecutionOriginV1;
    projectionGeneration: number;
    pluginVersion?: string;
}>): Readonly<{
    target: PluginUiClientExecutableTarget;
    executionOrigin: PluginMachineExecutionOriginV1;
    pluginVersion?: string;
}> {
    if (!Number.isInteger(input.projectionGeneration) || input.projectionGeneration < 0) {
        throw new Error('client_executable_projection_generation_required');
    }
    const parsedOrigin = PluginMachineExecutionOriginV1Schema.safeParse(input.executionOrigin);
    if (!parsedOrigin.success || parsedOrigin.data.materializationRef.pluginId !== input.pluginId) {
        throw new Error('client_executable_origin_mismatch');
    }
    if (
        !input.target.artifactId
        || !input.target.modulePath.startsWith('./')
        || !input.target.exportName
    ) {
        throw new Error('client_executable_target_invalid');
    }
    if (input.pluginVersion !== undefined && input.pluginVersion.trim().length === 0) {
        throw new Error('client_executable_plugin_version_invalid');
    }
    return Object.freeze({
        target: freezeTarget(input.target),
        executionOrigin: freezeExecutionOrigin(parsedOrigin.data),
        ...(input.pluginVersion === undefined ? {} : { pluginVersion: input.pluginVersion }),
    });
}

/**
 * The one client-side registration transaction and immutable lookup owner.
 * It never derives rights at a family consumer and withdraws its index before
 * executable-host cleanup reaches plugin code.
 */
export function createPluginUiClientExecutableRegistrationIndex(): PluginUiClientExecutableRegistrationIndex {
    let snapshot: RegistrationSnapshot = Object.freeze({});
    let revision = 0;
    const listeners = new Set<() => void>();

    const publish = (next: RegistrationSnapshot): void => {
        snapshot = Object.freeze(next);
        revision += 1;
        for (const listener of listeners) listener();
    };

    const read = (address: PluginUiClientExecutableRegistrationAddress): PluginUiClientExecutableRegistration | null => {
        let key: string;
        try {
            key = registrationIndexKey(address);
        } catch {
            return null;
        }
        const indexed = snapshot[key];
        if (!indexed) return null;
        const registration = indexed.registration;
        return registration.projectionGeneration === address.projectionGeneration
            && sameTarget(registration.target, address.target)
            && arePluginMachineExecutionOriginsEqual(registration.executionOrigin, address.executionOrigin)
            && isLifecycleCurrent(registration.lifecycle)
            ? registration
            : null;
    };

    const createScope = (input: Readonly<{
        pluginId: string;
        contributes: Readonly<Record<string, unknown>>;
        publishedContributes?: Readonly<Record<string, unknown>>;
        target: PluginUiClientExecutableTarget;
        executionOrigin: PluginMachineExecutionOriginV1;
        projectionGeneration: number;
        pluginVersion?: string;
        lifecycle: PluginUiClientExecutableRegistrationLifecycle;
    }>): PluginUiClientExecutableRegistrationScope => {
        const exact = validateScopeInput(input);
        const rights = derivePluginClientContributionRegistrationRights(input.contributes, exact.target);
        if (rights.length === 0) {
            throw new Error('client_executable_target_has_no_registration_rights');
        }
        const publishedRights = derivePluginClientContributionRegistrationRights(
            input.publishedContributes ?? input.contributes,
            exact.target,
        );
        const registrationScope = createPluginRegistrationScope({
            pluginId: input.pluginId,
            target: Object.freeze({ realm: 'client' as const, ...exact.target }),
            rights,
        });
        const ownerToken = Object.freeze({});
        const rightsByKey = new Map(rights.map((right) => [registrationIndexKey({
            family: right.family,
            pluginId: input.pluginId,
            localId: right.localId,
        }), right] as const));
        const publishedRightsByKey = new Map(publishedRights.map((right) => [registrationIndexKey({
            family: right.family,
            pluginId: input.pluginId,
            localId: right.localId,
        }), right] as const));
        for (const key of publishedRightsByKey.keys()) {
            if (!rightsByKey.has(key)) {
                throw new Error('client_executable_published_registration_right_missing');
            }
        }
        let committed = false;
        let unwound = false;
        let registrations: readonly PluginRuntimeRegistration[] = Object.freeze([]);
        let ownedKeys: readonly string[] = Object.freeze([]);

        const withdraw = (): void => {
            if (ownedKeys.length === 0) return;
            const next: Record<string, IndexedRegistration> = { ...snapshot };
            let changed = false;
            for (const key of ownedKeys) {
                if (next[key]?.ownerToken !== ownerToken) continue;
                delete next[key];
                changed = true;
            }
            ownedKeys = Object.freeze([]);
            if (changed) publish(next);
        };

        return Object.freeze({
            api: registrationScope.api,
            registrations: () => registrations,
            isCurrent: () => !unwound && isLifecycleCurrent(input.lifecycle),
            commit: () => {
                if (committed || unwound) {
                    throw new Error('client_executable_registration_scope_closed');
                }
                if (!isLifecycleCurrent(input.lifecycle)) {
                    throw new Error('client_executable_registration_stale');
                }
                const committedRegistrations = registrationScope.commit();
                const nextEntries: Array<readonly [string, IndexedRegistration]> = [];
                for (const registration of committedRegistrations) {
                    const key = registrationIndexKey({
                        family: registration.family,
                        pluginId: input.pluginId,
                        localId: registration.localId,
                    });
                    const right = rightsByKey.get(key);
                    if (!right) {
                        throw new Error('client_executable_registration_right_missing');
                    }
                    // A shared client module may receive the complete right
                    // set while this authority owns only a family subset.
                    // Capture every registration for the module lifecycle,
                    // but publish only this activation's exact declarations.
                    if (!publishedRightsByKey.has(key)) continue;
                    if (nextEntries.some(([candidateKey]) => candidateKey === key)) {
                        throw new Error('client_executable_registration_duplicate');
                    }
                    const existing = snapshot[key];
                    if (existing && existing.ownerToken !== ownerToken) {
                        throw new Error('client_executable_registration_conflict');
                    }
                    nextEntries.push(Object.freeze([key, Object.freeze({
                        ownerToken,
                        registration: Object.freeze({
                            contribution: Object.freeze({
                                pluginId: input.pluginId,
                                localId: registration.localId,
                            }),
                            right,
                            registration,
                            target: exact.target,
                            executionOrigin: exact.executionOrigin,
                            projectionGeneration: input.projectionGeneration,
                            ...(exact.pluginVersion === undefined
                                ? {}
                                : { pluginVersion: exact.pluginVersion }),
                            lifecycle: input.lifecycle,
                        }),
                    })] as const));
                }
                // Publish the complete target transaction in one frozen state.
                const next: Record<string, IndexedRegistration> = { ...snapshot };
                for (const [key, entry] of nextEntries) next[key] = entry;
                registrations = committedRegistrations;
                ownedKeys = Object.freeze(nextEntries.map(([key]) => key));
                publish(next);
                if (!isLifecycleCurrent(input.lifecycle)) {
                    withdraw();
                    throw new Error('client_executable_registration_stale');
                }
                committed = true;
            },
            unwind: (): Promise<void> => {
                if (!unwound) {
                    unwound = true;
                    // This stays before every asynchronous boundary.
                    withdraw();
                }
                return registrationScope.dispose();
            },
        });
    };

    return Object.freeze({
        createScope,
        read,
        revision: () => revision,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    });
}

export type PluginUiClientExecutableActivation = Readonly<{
    /** One exact authority-owned client target declaration projection. */
    pluginId: string;
    contributes: Readonly<Record<string, unknown>>;
    target: PluginUiClientExecutableTarget;
    executionOrigin: PluginMachineExecutionOriginV1;
    projectionGeneration: number;
    /** Exact package version retained for client Action SDK context. */
    pluginVersion?: string;
    cache: PluginReactNativeBundleCache;
    identity: PluginReactNativeBundleCacheIdentity;
    moduleReference: RepackInstalledArtifactModuleReference;
    backend: PluginReactNativeLoaderBackend;
    authority: PluginUiExecutableAuthority;
    isCurrent(): boolean;
    /** A derived family may compose runtime state but cannot replace the ABI/index owner. */
    createScope?(
        registrationScope: PluginUiClientExecutableRegistrationScope,
    ): PluginUiClientExecutableDerivedScope;
}>;

export type PluginUiClientExecutableCompositionAttempt = Readonly<{
    activation: PluginUiClientExecutableActivation;
    result: PluginUiExecutableModuleActivationResult;
    /** The incumbent host scope remained current, so this input did not take ownership. */
    reused: boolean;
}>;

export type PluginUiClientExecutableComposition = Readonly<{
    reconcile(
        activations: readonly PluginUiClientExecutableActivation[],
    ): Promise<readonly PluginUiClientExecutableCompositionAttempt[]>;
    read(address: PluginUiClientExecutableRegistrationAddress): PluginUiClientExecutableRegistration | null;
    revision(): number;
    subscribe(listener: () => void): () => void;
    invalidatePlugin(pluginId: string): Promise<void>;
    unload(): Promise<void>;
}>;

type ActiveClientExecutableTarget = Readonly<{
    fingerprint: string;
    pluginId: string;
    activation: PluginUiClientExecutableActivation;
    identity: PluginReactNativeBundleCacheIdentity;
    moduleReference: RepackInstalledArtifactModuleReference;
    controller: AbortController;
    authorityKey: string;
    executableHost: PluginUiExecutableModuleHost;
}>;

type PreparedClientExecutableTarget = Readonly<{
    key: string;
    activation: PluginUiClientExecutableActivation;
    inputIndexes: readonly number[];
    /** Complete compatible rights required by this shared module activation. */
    registrationContributes: Readonly<Record<string, unknown>>;
}>;

type ExecutableAuthorityLeaf = Readonly<{
    authority: PluginUiExecutableAuthority;
    executableHost: PluginUiExecutableModuleHost;
}>;

function clientExecutableAuthorityKey(authority: PluginUiExecutableAuthority): string {
    return JSON.stringify([
        authority.serverId,
        authority.machineId,
        authority.projectionGeneration,
    ]);
}

/**
 * The exact client executable address. Projection, reconciliation, and the
 * generic composition owner must partition the same target/currentness facts.
 */
export function getPluginUiClientExecutableTargetAddressKey(input: Pick<
    PluginUiClientExecutableActivation,
    'pluginId' | 'target' | 'executionOrigin' | 'projectionGeneration' | 'authority'
>): string {
    return [
        input.pluginId,
        input.target.artifactId,
        input.target.modulePath,
        input.target.exportName,
        input.target.platform,
        input.executionOrigin.serverIdentityId,
        input.executionOrigin.materializationRef.machineId,
        input.executionOrigin.materializationRef.materializationId,
        input.executionOrigin.materializationRef.pluginId,
        String(input.projectionGeneration),
        clientExecutableAuthorityKey(input.authority),
    ].join('\u0000');
}

/**
 * Rights may be shared only by the same installed executable bytes. Authority
 * and projection generation intentionally do not participate: they select
 * separate hosts, exact index publication, and currentness, not what one
 * module is allowed to register.
 */
function clientExecutableModuleKey(activation: PluginUiClientExecutableActivation): string {
    return [
        activation.pluginId,
        activation.target.artifactId,
        activation.target.modulePath,
        activation.target.exportName,
        activation.target.platform,
        activation.identity.artifactDigest,
        activation.identity.hostAppVersion,
        activation.identity.hostUiApiVersion,
        activation.identity.reactVersion,
        activation.identity.reactNativeVersion,
        activation.identity.expoRuntimeVersion ?? '',
        activation.identity.hermesVersion ?? '',
        activation.identity.platform,
        activation.identity.channel,
        activation.identity.nativeCapabilitiesDigest,
        activation.pluginVersion ?? '',
        activation.moduleReference.containerName,
        activation.moduleReference.modulePath,
        activation.moduleReference.exportName,
    ].join('\u0000');
}

/**
 * Inputs arrive already normalized by their family producers. The generic
 * composition combines only compatible module declarations, then leaves the
 * registration index to derive and validate their rights once.
 */
function mergeClientExecutableRegistrationContributes(
    activations: readonly PluginUiClientExecutableActivation[],
): Readonly<Record<string, unknown>> {
    const merged: Record<string, readonly unknown[]> = {};
    for (const activation of activations) {
        for (const [family, declarations] of Object.entries(activation.contributes)) {
            if (!Array.isArray(declarations)) continue;
            const entries: readonly unknown[] = declarations;
            merged[family] = Object.freeze([
                ...(merged[family] ?? []),
                ...entries,
            ]);
        }
    }
    return Object.freeze(merged);
}

function clientExecutableActivationFingerprint(
    activation: PluginUiClientExecutableActivation,
    registrationContributes: Readonly<Record<string, unknown>> = activation.contributes,
): string {
    return [
        activation.identity.pluginId,
        activation.identity.contributionId,
        activation.identity.artifactDigest,
        activation.identity.hostAppVersion,
        activation.identity.hostUiApiVersion,
        activation.identity.reactVersion,
        activation.identity.reactNativeVersion,
        activation.identity.expoRuntimeVersion ?? '',
        activation.identity.hermesVersion ?? '',
        activation.identity.platform,
        activation.identity.channel,
        activation.identity.nativeCapabilitiesDigest,
        String(activation.identity.projectionGeneration),
        activation.pluginVersion ?? '',
        activation.moduleReference.containerName,
        activation.moduleReference.modulePath,
        activation.moduleReference.exportName,
        clientExecutableAuthorityKey(activation.authority),
        derivePluginClientContributionRegistrationRights(registrationContributes, activation.target)
            .map((right) => `${right.family}\u0000${right.localId}`)
            .sort((left, right) => left.localeCompare(right))
            .join('\u0001'),
    ].join('\u0000');
}

function isClientExecutableActivationCurrent(
    activation: PluginUiClientExecutableActivation,
): boolean {
    try {
        return activation.isCurrent();
    } catch {
        return false;
    }
}

function isClientExecutableActivationCoherent(
    activation: PluginUiClientExecutableActivation,
): boolean {
    return activation.identity.pluginId === activation.pluginId
        && activation.identity.platform === activation.target.platform
        && activation.identity.projectionGeneration === activation.projectionGeneration
        && activation.moduleReference.modulePath === activation.target.modulePath
        && activation.moduleReference.exportName === activation.target.exportName
        && activation.authority.machineId === activation.executionOrigin.materializationRef.machineId
        && activation.authority.projectionGeneration === activation.projectionGeneration
        && activation.executionOrigin.materializationRef.pluginId === activation.pluginId
        && (activation.pluginVersion === undefined || activation.pluginVersion.trim().length > 0);
}

function staleClientExecutableResult(): PluginUiExecutableModuleActivationResult {
    return Object.freeze({
        ok: false,
        code: 'stale_projection_generation',
        diagnostics: Object.freeze(['stale_projection_generation']),
    });
}

function invalidClientExecutableResult(diagnostic: string): PluginUiExecutableModuleActivationResult {
    return Object.freeze({
        ok: false,
        code: 'activation_failed',
        diagnostics: Object.freeze([diagnostic]),
    });
}

/**
 * One generic composition owns one incumbent executable host and one
 * immutable client-registration index. It replaces the Voice-only activation
 * path rather than adding a parallel Action or Voice loader/ABI.
 */
export function createPluginUiClientExecutableComposition(input: Readonly<{
    executableHost?: PluginUiExecutableModuleHost;
    createExecutableHost?: () => PluginUiExecutableModuleHost;
    registrationIndex?: PluginUiClientExecutableRegistrationIndex;
}> = {}): PluginUiClientExecutableComposition {
    if (input.executableHost && input.createExecutableHost) {
        throw new Error('client_executable_host_owner_ambiguous');
    }
    const firstExecutableHost = input.executableHost
        ?? input.createExecutableHost?.()
        ?? createPluginUiExecutableModuleHost();
    const createExecutableHost = input.createExecutableHost
        ?? createPluginUiExecutableModuleHost;
    const registrationIndex = input.registrationIndex
        ?? createPluginUiClientExecutableRegistrationIndex();
    const activeByTargetKey = new Map<string, ActiveClientExecutableTarget>();
    const authorityLeavesByKey = new Map<string, ExecutableAuthorityLeaf>();
    let firstExecutableHostAvailable = true;

    const releaseAuthorityLeaf = (
        authorityKey: string,
        leaf: ExecutableAuthorityLeaf,
        reusable = true,
    ): void => {
        if (authorityLeavesByKey.get(authorityKey) !== leaf) return;
        authorityLeavesByKey.delete(authorityKey);
        if (leaf.executableHost === firstExecutableHost) {
            firstExecutableHostAvailable = reusable;
        }
    };

    const ensureAuthorityLeaf = async (
        authority: PluginUiExecutableAuthority,
    ): Promise<ExecutableAuthorityLeaf> => {
        const authorityKey = clientExecutableAuthorityKey(authority);
        const existing = authorityLeavesByKey.get(authorityKey);
        if (existing) return existing;
        const executableHost = firstExecutableHostAvailable
            ? firstExecutableHost
            : createExecutableHost();
        firstExecutableHostAvailable = false;
        const leaf = Object.freeze({ authority, executableHost });
        authorityLeavesByKey.set(authorityKey, leaf);
        try {
            await executableHost.replaceAuthority(authority);
            return leaf;
        } catch (error) {
            // A rejected replacement may have crossed host-local state before
            // it failed. Fence that leaf before making it eligible for reuse;
            // otherwise the next complete-set reconcile could retain a stale
            // authority behind the same map key.
            let reusable = true;
            try {
                await executableHost.unload();
            } catch {
                reusable = false;
            }
            releaseAuthorityLeaf(authorityKey, leaf, reusable);
            throw error;
        }
    };

    const reconcile = async (
        activations: readonly PluginUiClientExecutableActivation[],
    ): Promise<readonly PluginUiClientExecutableCompositionAttempt[]> => {
        const results: Array<PluginUiExecutableModuleActivationResult | null> = activations.map(() => null);
        const reused: boolean[] = activations.map(() => false);
        const grouped = new Map<string, {
            activation: PluginUiClientExecutableActivation;
            inputIndexes: number[];
            conflict: boolean;
        }>();

        for (const [index, activation] of activations.entries()) {
            if (!isClientExecutableActivationCurrent(activation)) {
                results[index] = staleClientExecutableResult();
                continue;
            }
            if (!isClientExecutableActivationCoherent(activation)) {
                results[index] = invalidClientExecutableResult('client_executable_activation_incoherent');
                continue;
            }
            const key = getPluginUiClientExecutableTargetAddressKey(activation);
            const existing = grouped.get(key);
            if (!existing) {
                grouped.set(key, { activation, inputIndexes: [index], conflict: false });
                continue;
            }
            existing.inputIndexes.push(index);
            existing.conflict = true;
        }

        const preparedTargets: Array<Readonly<{
            key: string;
            activation: PluginUiClientExecutableActivation;
            inputIndexes: readonly number[];
        }>> = [];
        const requestedAuthoritiesByKey = new Map<string, PluginUiExecutableAuthority>();
        for (const [key, group] of grouped.entries()) {
            if (group.conflict) {
                for (const index of group.inputIndexes) {
                    results[index] = invalidClientExecutableResult('client_executable_target_duplicate');
                }
                continue;
            }
            requestedAuthoritiesByKey.set(
                clientExecutableAuthorityKey(group.activation.authority),
                group.activation.authority,
            );
            preparedTargets.push(Object.freeze({
                key,
                activation: group.activation,
                inputIndexes: Object.freeze([...group.inputIndexes]),
            }));
        }

        const compatibleTargetsByModuleKey = new Map<
            string,
            Array<(typeof preparedTargets)[number]>
        >();
        for (const preparedTarget of preparedTargets) {
            const moduleKey = clientExecutableModuleKey(preparedTarget.activation);
            const compatible = compatibleTargetsByModuleKey.get(moduleKey);
            if (compatible) {
                compatible.push(preparedTarget);
            } else {
                compatibleTargetsByModuleKey.set(moduleKey, [preparedTarget]);
            }
        }
        const registrationContributesByTargetKey = new Map<string, Readonly<Record<string, unknown>>>();
        for (const compatibleTargets of compatibleTargetsByModuleKey.values()) {
            const registrationContributes = mergeClientExecutableRegistrationContributes(
                compatibleTargets.map((candidate) => candidate.activation),
            );
            for (const preparedTarget of compatibleTargets) {
                registrationContributesByTargetKey.set(preparedTarget.key, registrationContributes);
            }
        }
        const prepared: PreparedClientExecutableTarget[] = preparedTargets.map((preparedTarget) => Object.freeze({
            ...preparedTarget,
            registrationContributes: registrationContributesByTargetKey.get(preparedTarget.key)
                ?? preparedTarget.activation.contributes,
        }));

        const preparedByKey = new Map(prepared.map((candidate) => [candidate.key, candidate]));
        const retirements: Promise<void>[] = [];
        for (const [key, active] of activeByTargetKey.entries()) {
            const replacement = preparedByKey.get(key);
            if (replacement && active.fingerprint === clientExecutableActivationFingerprint(
                replacement.activation,
                replacement.registrationContributes,
            )) {
                continue;
            }
            activeByTargetKey.delete(key);
            active.controller.abort();
            if (!requestedAuthoritiesByKey.has(active.authorityKey)) continue;
            // The host invokes scope unwind synchronously before cleanup.
            retirements.push(active.executableHost.invalidateActivation({
                identity: active.identity,
                moduleReference: active.moduleReference,
            }));
        }
        for (const [authorityKey, leaf] of [...authorityLeavesByKey.entries()]) {
            if (requestedAuthoritiesByKey.has(authorityKey)) continue;
            // The host fences the registration synchronously, but its plugin
            // cleanup may await. Remove this retiring leaf before that await
            // so a same-authority remount installs current authority instead
            // of reusing the fenced host.
            releaseAuthorityLeaf(authorityKey, leaf);
            retirements.push(leaf.executableHost.unload());
        }
        await Promise.all(retirements);

        const leavesByAuthorityKey = new Map<string, ExecutableAuthorityLeaf>();
        for (const [authorityKey, requestedAuthority] of requestedAuthoritiesByKey.entries()) {
            leavesByAuthorityKey.set(authorityKey, await ensureAuthorityLeaf(requestedAuthority));
        }

        for (const preparedTarget of prepared) {
            const { activation } = preparedTarget;
            const authorityKey = clientExecutableAuthorityKey(activation.authority);
            const leaf = leavesByAuthorityKey.get(authorityKey);
            if (!leaf) {
                for (const index of preparedTarget.inputIndexes) {
                    results[index] = staleClientExecutableResult();
                }
                continue;
            }
            const fingerprint = clientExecutableActivationFingerprint(
                activation,
                preparedTarget.registrationContributes,
            );
            let active = activeByTargetKey.get(preparedTarget.key);
            const incumbentRemainsCurrent = active !== undefined
                && active.fingerprint === fingerprint
                && isClientExecutableActivationCurrent(active.activation);
            if (!active || active.fingerprint !== fingerprint) {
                active = Object.freeze({
                    fingerprint,
                    pluginId: activation.pluginId,
                    activation,
                    identity: activation.identity,
                    moduleReference: activation.moduleReference,
                    controller: new AbortController(),
                    authorityKey,
                    executableHost: leaf.executableHost,
                });
                activeByTargetKey.set(preparedTarget.key, active);
            }
            const lifecycle: PluginUiClientExecutableRegistrationLifecycle = Object.freeze({
                signal: active.controller.signal,
                isCurrent: () => (
                    !active.controller.signal.aborted
                    && isClientExecutableActivationCurrent(activation)
                ),
            });
            const targetIsCurrent = () => isLifecycleCurrent(lifecycle);
            const result = await leaf.executableHost.activate({
                cache: activation.cache,
                identity: activation.identity,
                moduleReference: activation.moduleReference,
                backend: activation.backend,
                hostPlatform: activation.target.platform,
                authority: activation.authority,
                createScope: () => {
                    const registrationScope = registrationIndex.createScope({
                        pluginId: activation.pluginId,
                        contributes: preparedTarget.registrationContributes,
                        publishedContributes: activation.contributes,
                        target: activation.target,
                        executionOrigin: activation.executionOrigin,
                        projectionGeneration: activation.projectionGeneration,
                        ...(activation.pluginVersion === undefined
                            ? {}
                            : { pluginVersion: activation.pluginVersion }),
                        lifecycle,
                    });
                    const derivedScope = activation.createScope?.(registrationScope);
                    let committed = false;
                    const scopeIsCurrent = () => (
                        targetIsCurrent()
                        && (!committed || (
                            registrationScope.isCurrent()
                            && (derivedScope?.isCurrent?.() ?? true)
                        ))
                    );
                    return Object.freeze({
                        // A derived Voice projection cannot hide co-resident
                        // Action rights from the one activated module.
                        api: registrationScope.api,
                        isCurrent: scopeIsCurrent,
                        async commit() {
                            if (!scopeIsCurrent()) {
                                throw new Error('client_executable_activation_retired');
                            }
                            if (derivedScope) {
                                await derivedScope.commit();
                            } else {
                                registrationScope.commit();
                            }
                            committed = true;
                            if (!scopeIsCurrent()) {
                                void registrationScope.unwind();
                                throw new Error('client_executable_activation_retired');
                            }
                        },
                        unwind: () => {
                            let registrationUnwind: Promise<void>;
                            try {
                                registrationUnwind = registrationScope.unwind();
                            } catch (error) {
                                registrationUnwind = Promise.reject(error);
                            }
                            if (!derivedScope) return registrationUnwind;
                            let derivedUnwind: Promise<void>;
                            try {
                                derivedUnwind = Promise.resolve(derivedScope.unwind());
                            } catch (error) {
                                derivedUnwind = Promise.reject(error);
                            }
                            return Promise.all([registrationUnwind, derivedUnwind]).then(() => undefined);
                        },
                    });
                },
            });
            for (const index of preparedTarget.inputIndexes) results[index] = result;
            for (const index of preparedTarget.inputIndexes) reused[index] = result.ok && incumbentRemainsCurrent;
            if (result.ok) {
                if (!incumbentRemainsCurrent) {
                    activeByTargetKey.set(preparedTarget.key, Object.freeze({
                        fingerprint,
                        pluginId: activation.pluginId,
                        activation,
                        identity: activation.identity,
                        moduleReference: activation.moduleReference,
                        controller: active.controller,
                        authorityKey,
                        executableHost: leaf.executableHost,
                    }));
                }
            } else if (activeByTargetKey.get(preparedTarget.key) === active) {
                active.controller.abort();
                activeByTargetKey.delete(preparedTarget.key);
            }
        }

        return Object.freeze(activations.map((activation, index) => Object.freeze({
            activation,
            result: results[index] ?? staleClientExecutableResult(),
            reused: reused[index] === true,
        })));
    };

    return Object.freeze({
        reconcile,
        read: registrationIndex.read,
        revision: registrationIndex.revision,
        subscribe: registrationIndex.subscribe,
        invalidatePlugin: async (pluginId) => {
            const leaves = new Set<PluginUiExecutableModuleHost>();
            for (const [key, active] of activeByTargetKey.entries()) {
                if (active.pluginId !== pluginId) continue;
                active.controller.abort();
                activeByTargetKey.delete(key);
                leaves.add(active.executableHost);
            }
            await Promise.all([...leaves].map((executableHost) => executableHost.invalidatePlugin(pluginId)));
        },
        unload: async () => {
            for (const active of activeByTargetKey.values()) active.controller.abort();
            activeByTargetKey.clear();
            const leaves = [...authorityLeavesByKey.entries()];
            const retirements = leaves.map(([authorityKey, leaf]) => {
                // Keep a retiring host out of the reusable authority index
                // before its asynchronous plugin cleanup settles.
                releaseAuthorityLeaf(authorityKey, leaf);
                return leaf.executableHost.unload();
            });
            await Promise.all(retirements);
        },
    });
}

const compositionsByExecutableHost = new WeakMap<
    PluginUiExecutableModuleHost,
    PluginUiClientExecutableComposition
>();

export function getPluginUiClientExecutableComposition(
    executableHost: PluginUiExecutableModuleHost = getInstalledPluginUiExecutableModuleHost(),
): PluginUiClientExecutableComposition {
    const existing = compositionsByExecutableHost.get(executableHost);
    if (existing) return existing;
    const composition = createPluginUiClientExecutableComposition({ executableHost });
    compositionsByExecutableHost.set(executableHost, composition);
    return composition;
}

export function getInstalledPluginUiClientExecutableComposition(): PluginUiClientExecutableComposition {
    return getPluginUiClientExecutableComposition();
}

/**
 * One exact client-Action eligibility lookup. Projection admission alone does
 * not prove that its executable module committed a handler, so every consumer
 * reads this generic index instead of rebuilding target/origin checks locally.
 */
export function resolvePluginUiClientActionRegistration(input: Readonly<{
    action: PluginProjectedActionV2;
    projectionGeneration: number;
    /** The one platform mapper is `resolvePluginUiClientExecutablePlatform`. */
    platform: PluginContributionClientPlatform;
    reader?: PluginUiClientExecutableRegistrationReader;
}>): PluginUiClientActionRegistration | null {
    const { action, projectionGeneration, platform } = input;
    if (
        action.execution.target !== 'client'
        || !isPluginProjectedActionExecutable(action)
        || !action.authorization
        || !Number.isInteger(projectionGeneration)
        || projectionGeneration < 0
    ) {
        return null;
    }
    const parsedOrigin = PluginMachineExecutionOriginV1Schema.safeParse({
        serverIdentityId: action.serverIdentityId,
        materializationRef: action.materializationRef,
    });
    if (
        !parsedOrigin.success
        || parsedOrigin.data.materializationRef.pluginId !== action.pluginId
    ) {
        return null;
    }
    if (!action.execution.platforms.includes(platform)) return null;
    const address = Object.freeze({
        family: 'actions' as const,
        pluginId: action.pluginId,
        localId: action.id,
        target: freezeTarget({
            artifactId: action.execution.client.artifactId,
            modulePath: action.execution.client.modulePath,
            exportName: action.execution.client.exportName,
            platform,
        }),
        executionOrigin: freezeExecutionOrigin(parsedOrigin.data),
        projectionGeneration,
    }) satisfies PluginUiClientExecutableRegistrationAddress;
    let registration: PluginUiClientExecutableRegistration | null;
    try {
        registration = (input.reader ?? getInstalledPluginUiClientExecutableComposition()).read(address);
    } catch {
        return null;
    }
    const pluginVersion = registration?.pluginVersion;
    if (
        !registration
        || registration.contribution.pluginId !== action.pluginId
        || registration.contribution.localId !== action.id
        || registration.right.family !== 'actions'
        || registration.registration.family !== 'actions'
        || typeof registration.registration.value !== 'function'
        || typeof pluginVersion !== 'string'
        || pluginVersion.trim().length === 0
    ) {
        return null;
    }
    // The generic registration value is family-opaque until this exact
    // `actions` right is confirmed at the SDK ABI boundary.
    return Object.freeze({
        registration,
        pluginVersion,
        handler: registration.registration.value as unknown as PluginClientActionHandler,
    });
}

/**
 * Presentation consumers re-render when the generic index commits or
 * withdraws. This observes the existing publication stream; it starts no
 * Action-specific reconciliation, polling, or second registry.
 */
export function usePluginUiClientExecutableRegistrationRevision(
    composition: PluginUiClientExecutableComposition = getInstalledPluginUiClientExecutableComposition(),
): number {
    return React.useSyncExternalStore(
        composition.subscribe,
        composition.revision,
        composition.revision,
    );
}
