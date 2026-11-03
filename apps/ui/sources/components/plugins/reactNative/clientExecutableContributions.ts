import * as React from 'react';

import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, PluginMachineExecutionOriginV1Schema, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { derivePluginAccountContributionRegistrationRights, derivePluginClientContributionRegistrationRights, type PluginContributionClientPlatform, type PluginContributionRegistrationRight } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { PluginProjectedActionV2, PluginProjectedDragSourceEntryV1, PluginProjectedDropTargetEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginAccountApi, PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import type { PluginUiResourceProjection, PluginUiConnectedAccountDescriptorProjection } from '@/sync/domains/plugins/ui/projection';
import type { PluginDragSourceRuntime, PluginDropTargetRuntime } from '@happier-dev/plugin-sdk';
import type { PluginProjectedWorkItemsEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import type { PluginAccountActionHandler, PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { createPluginRegistrationScope, type PluginRuntimeRegistration } from '@/sync/domains/plugins/registrationScope';

import type { PluginReactNativeBundleCache } from './bundleCache';
import {
    createPluginUiExecutableModuleHost,
    getInstalledPluginUiExecutableModuleHost,
    getPluginUiExecutableAuthorityKey,
    readPluginUiAccountExecutableOrigin,
    type PluginUiExecutableAuthority,
    type PluginUiExecutableModuleActivationResult,
    type PluginUiExecutableModuleHost,
} from './executableModuleHost';
import type {
    PluginReactNativeLoaderBackend,
    PluginReactNativeExecutableModuleReference,
    PluginReactNativeExportLoaderResult,
} from './loader';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import { isPluginProjectedActionExecutable } from '@/sync/domains/plugins/ui/projection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginUiContributionOrigin, readPluginUiProjectionEntryExecutionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { UiConnectedAccountAuthenticationRuntime } from '@/sync/ops/connectedAccounts/connectedAccountAuthenticationRuntime';

type PluginWorkItemsRuntime = Parameters<PluginClientApi['workItems']['register']>[1];

export type PluginUiClientExecutableTarget = Readonly<{
    realm?: 'account';
    artifactId: string;
    exportName: string;
    platform: PluginContributionClientPlatform;
}>;

export type PluginUiClientExecutableRegistrationAddress = Readonly<{
    family: PluginRuntimeRegistration['family'];
    pluginId: string;
    localId: string;
    target: PluginUiClientExecutableTarget;
    executionOrigin: PluginMachineExecutionOriginV1 | null;
    occurrenceId: string;
}>;

/** One host-owned activation lifetime, never reconstructed by a family consumer. */
export type PluginUiClientExecutableRegistrationLifecycle = Readonly<{
    signal: AbortSignal;
    isCurrent: () => boolean;
}>;

/** One client registration from one exact target/origin/plugin occurrence. */
export type PluginUiClientExecutableRegistration = Readonly<{
    /** Host-only first-use preparation; declaration reads do not acquire code. */
    prepare?: (signal?: AbortSignal) => Promise<void>;
    contribution: Readonly<{
        pluginId: string;
        localId: string;
    }>;
    right: PluginContributionRegistrationRight;
    registration: PluginRuntimeRegistration;
    target: PluginUiClientExecutableTarget;
    executionOrigin: PluginMachineExecutionOriginV1 | null;
    /** Process-local admitted plugin slot currentness. */
    occurrenceId: string;
    /** Exact installed package identity supplied by the activated projection. */
    pluginVersion?: string;
    accountLifetime?: ActiveServerAccountScopeLifetime;
    authority?: PluginUiExecutableAuthority;
    lifecycle: PluginUiClientExecutableRegistrationLifecycle;
    /** Present only on the connected-account family; retired with this registration. */
    connectedAccountAuthentication?: Readonly<{
        acquire(create: () => Promise<UiConnectedAccountAuthenticationRuntime>): Promise<UiConnectedAccountAuthenticationRuntime>;
    }>;
}>;

/** Read-only seam shared by the generic index and its installed composition. */
export type PluginUiClientExecutableRegistrationReader = Readonly<{
    read(address: PluginUiClientExecutableRegistrationAddress): PluginUiClientExecutableRegistration | null;
    readRefusal?(address: PluginUiClientExecutableRegistrationAddress, authority?: PluginUiExecutableAuthority): PluginUiClientExecutableFailure | null;
}>;

/** A deciding target failure, without executable bytes or author content. */
export type PluginUiClientExecutableFailure = Readonly<{
    ok: false;
    code: string;
    layer: 'artifact' | 'registration';
    phase: 'preparation' | 'activation';
    retryable: boolean;
    diagnostics: readonly string[];
}>;

/** Exact portable Resource from the same committed Account registration transaction. */
export function resolvePluginUiAccountResourceRegistration(input: Readonly<{
    resource: PluginUiResourceProjection;
    platform: PluginContributionClientPlatform;
    reader?: PluginUiClientExecutableRegistrationReader;
}>): Readonly<{ registration: PluginUiClientExecutableRegistration; runtime: PluginDynamicResourceRuntime }> | null {
    const { resource } = input;
    if (resource.execution?.target !== 'account') return null;
    const origin = readPluginUiAccountExecutableOrigin(resource);
    if (!origin || resource.occurrenceId !== origin.custodyId) return null;
    const registration = (input.reader ?? getInstalledPluginUiClientExecutableComposition()).read({
        family: 'resources', pluginId: resource.pluginId, localId: resource.id,
        target: { realm: 'account', ...resource.execution.account, platform: input.platform },
        executionOrigin: null, occurrenceId: origin.custodyId,
    });
    if (!registration || registration.registration.family !== 'resources' || registration.right.target.realm !== 'account'
        || !registration.authority || !('kind' in registration.authority)
        || registration.authority.serverId !== origin.serverId || registration.authority.accountId !== origin.accountId
        || registration.authority.custodyId !== origin.custodyId) return null;
    // The SDK registration scope validates the declared Resource runtime ABI.
    return Object.freeze({ registration, get runtime() { return registration.registration.value as PluginDynamicResourceRuntime; } });
}

/** The selected Account authentication uses the same committed lazy index as Resources and Actions. */
export async function resolvePluginUiAccountConnectedAccountRegistration(input: Readonly<{
    descriptor: PluginUiConnectedAccountDescriptorProjection;
    platform: PluginContributionClientPlatform;
    reader?: PluginUiClientExecutableRegistrationReader;
    signal?: AbortSignal;
}>): Promise<Readonly<{
    registration: PluginUiClientExecutableRegistration;
    runtime: Parameters<PluginAccountApi['connectedAccounts']['register']>[1];
}> | null> {
    const { descriptor } = input;
    const target = descriptor.definition.authentication.account;
    const origin = readPluginUiAccountExecutableOrigin(descriptor);
    if (!target || !origin || descriptor.occurrenceId !== origin.custodyId) return null;
    const registration = (input.reader ?? getInstalledPluginUiClientExecutableComposition()).read({
        family: 'connectedAccountDescriptors', pluginId: descriptor.pluginId, localId: descriptor.id,
        target: { realm: 'account', ...target, platform: input.platform },
        executionOrigin: null, occurrenceId: origin.custodyId,
    });
    if (!registration || registration.registration.family !== 'connectedAccountDescriptors'
        || registration.right.target.realm !== 'account' || !registration.authority || !('kind' in registration.authority)
        || registration.authority.serverId !== origin.serverId || registration.authority.accountId !== origin.accountId
        || registration.authority.custodyId !== origin.custodyId) return null;
    await registration.prepare?.(input.signal);
    return Object.freeze({ registration, get runtime() {
        // The SDK scope owns validation of the registered authentication ABI.
        return registration.registration.value as Parameters<PluginAccountApi['connectedAccounts']['register']>[1];
    } });
}

/**
 * One committed client Action registration that is safe for both presentation
 * eligibility and dispatch. The generic index remains its lifecycle owner.
 */
export type PluginUiClientActionRegistration = Readonly<{
    registration: PluginUiClientExecutableRegistration;
    pluginVersion: string;
    handler: PluginClientActionHandler | PluginAccountActionHandler;
    authorization: NonNullable<PluginProjectedActionV2['authorization']>;
}>;

export type PluginUiClientExecutableRegistrationScope<TApi = PluginClientApi> = Readonly<{
    /** Portable realms expose no daemon-only activation capabilities. */
    api: TApi;
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

type PluginUiClientExecutableRegistrationScopeInput = Readonly<{
        prepareRegistration?: (registration: PluginRuntimeRegistration) => Promise<PluginRuntimeRegistration>;
        pluginId: string;
        /** Every compatible declaration the shared module must register. */
        contributes: Readonly<Record<string, unknown>>;
        /**
         * The exact authority-owned declarations this activation may publish.
         * Omitted only when one activation owns the whole declaration set.
         */
        publishedContributes?: Readonly<Record<string, unknown>>;
        target: PluginUiClientExecutableTarget;
        executionOrigin: PluginMachineExecutionOriginV1 | null;
        occurrenceId: string;
        /** Optional for non-Action client families; Actions fail closed without it. */
        pluginVersion?: string;
        accountLifetime?: ActiveServerAccountScopeLifetime;
        authority?: PluginUiExecutableAuthority;
        lifecycle: PluginUiClientExecutableRegistrationLifecycle;
    }>;
type PluginUiExecutableRegistrationApi = PluginClientApi | PluginAccountApi;
type PluginUiExecutableRegistrationScope = PluginUiClientExecutableRegistrationScope<PluginUiExecutableRegistrationApi>;

export type PluginUiClientExecutableRegistrationIndex = Readonly<{
    createScope(input: PluginUiClientExecutableRegistrationScopeInput & Readonly<{ target: PluginUiClientExecutableTarget & { realm: 'account' } }>): PluginUiClientExecutableRegistrationScope<PluginAccountApi>;
    createScope(input: PluginUiClientExecutableRegistrationScopeInput & Readonly<{ target: PluginUiClientExecutableTarget & { realm?: undefined } }>): PluginUiClientExecutableRegistrationScope;
    createScope(input: PluginUiClientExecutableRegistrationScopeInput): PluginUiExecutableRegistrationScope;
    read(address: PluginUiClientExecutableRegistrationAddress): PluginUiClientExecutableRegistration | null;
    readRefusal(address: PluginUiClientExecutableRegistrationAddress, authority?: PluginUiExecutableAuthority): PluginUiClientExecutableFailure | null;
    refuse(admission: PluginUiClientExecutableAdmission, failure: PluginUiClientExecutableFailure): void;
    retainRefusals(isCurrent: (admission: PluginUiClientExecutableAdmission) => boolean): void;
    revision(): number;
    subscribe(listener: () => void): () => void;
}>;

type IndexedRegistration = Readonly<{
    ownerToken: object;
    registration: PluginUiClientExecutableRegistration;
}> | Readonly<{
    ownerToken: object;
    admission: PluginUiClientExecutableAdmission;
    refusal: PluginUiClientExecutableFailure;
}>;

type RegistrationSnapshot = Readonly<Record<string, IndexedRegistration>>;

function freezeTarget(target: PluginUiClientExecutableTarget): PluginUiClientExecutableTarget {
    return Object.freeze({
        ...(target.realm ? { realm: target.realm } : {}),
        artifactId: target.artifactId,
        exportName: target.exportName,
        platform: target.platform,
    });
}

/**
 * A bundled or development plugin has no materialization: its registrations
 * carry no origin and route through the projecting daemon's authority.
 */
function sameExecutionOrigin(
    left: PluginMachineExecutionOriginV1 | null,
    right: PluginMachineExecutionOriginV1 | null,
): boolean {
    return left === null || right === null
        ? left === right
        : arePluginMachineExecutionOriginsEqual(left, right);
}

function freezeExecutionOrigin(origin: PluginMachineExecutionOriginV1): PluginMachineExecutionOriginV1 {
    return Object.freeze({
        serverIdentityId: origin.serverIdentityId,
        ...('materializationRef' in origin
            ? { materializationRef: Object.freeze({ ...origin.materializationRef }) }
            : { sourceRef: Object.freeze({ ...origin.sourceRef, sourceCustody: Object.freeze({ ...origin.sourceRef.sourceCustody }) }) }),
    });
}

function sameTarget(
    left: PluginUiClientExecutableTarget,
    right: PluginUiClientExecutableTarget,
): boolean {
    return left.realm === right.realm && left.artifactId === right.artifactId
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

function awaitRegistrationPreparation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(Object.assign(new Error('plugin_action_generation_retired'), { code: 'plugin_action_generation_retired' }));
        };
        signal.addEventListener('abort', abort, { once: true });
        void work.then(value => {
            signal.removeEventListener('abort', abort);
            resolve(value);
        }, error => {
            signal.removeEventListener('abort', abort);
            reject(error);
        });
        if (signal.aborted) abort();
    });
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
    executionOrigin: PluginMachineExecutionOriginV1 | null;
    occurrenceId: string;
    pluginVersion?: string;
}>): Readonly<{
    target: PluginUiClientExecutableTarget;
    executionOrigin: PluginMachineExecutionOriginV1 | null;
    pluginVersion?: string;
}> {
    if (input.occurrenceId.trim().length === 0) {
        throw new Error('client_executable_occurrence_required');
    }
    const parsedOrigin = input.executionOrigin === null
        ? null
        : PluginMachineExecutionOriginV1Schema.safeParse(input.executionOrigin);
    if (parsedOrigin && (!parsedOrigin.success || getPluginMachineExecutionOriginRef(parsedOrigin.data).pluginId !== input.pluginId)) {
        throw new Error('client_executable_origin_mismatch');
    }
    if (
        !input.target.artifactId
        || !input.target.exportName
    ) {
        throw new Error('client_executable_target_invalid');
    }
    if (input.pluginVersion !== undefined && input.pluginVersion.trim().length === 0) {
        throw new Error('client_executable_plugin_version_invalid');
    }
    return Object.freeze({
        target: freezeTarget(input.target),
        executionOrigin: parsedOrigin?.success ? freezeExecutionOrigin(parsedOrigin.data) : null,
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
        if (!indexed || !('registration' in indexed)) return null;
        const registration = indexed.registration;
        return registration.occurrenceId === address.occurrenceId
            && sameTarget(registration.target, address.target)
            && sameExecutionOrigin(registration.executionOrigin, address.executionOrigin)
            && isLifecycleCurrent(registration.lifecycle)
            ? registration
            : null;
    };

    const readRefusal = (address: Omit<PluginUiClientExecutableRegistrationAddress, 'family'> & Pick<PluginContributionRegistrationRight, 'family'>, authority?: PluginUiExecutableAuthority): PluginUiClientExecutableFailure | null => {
        const entry = snapshot[registrationIndexKey(address)];
        return entry && 'refusal' in entry && entry.admission.occurrenceId === address.occurrenceId
            && (authority === undefined || getPluginUiExecutableAuthorityKey(authority) === getPluginUiExecutableAuthorityKey(entry.admission.authority))
            && sameTarget(entry.admission.target, address.target)
            && sameExecutionOrigin(entry.admission.executionOrigin, address.executionOrigin) ? entry.refusal : null;
    };

    const retainRefusals = (isCurrent: (admission: PluginUiClientExecutableAdmission) => boolean): void => {
        let next: Record<string, IndexedRegistration> | undefined;
        for (const [key, entry] of Object.entries(snapshot)) {
            if (!('refusal' in entry) || isCurrent(entry.admission)) continue;
            next ??= { ...snapshot };
            delete next[key];
        }
        if (next) publish(next);
    };

    const refuse = (admission: PluginUiClientExecutableAdmission, refusal: PluginUiClientExecutableFailure): void => {
        const rights = (admission.target.realm === 'account'
            ? derivePluginAccountContributionRegistrationRights : derivePluginClientContributionRegistrationRights)(admission.contributes, admission.target);
        const next = { ...snapshot };
        let changed = false;
        for (const right of rights) {
            const address = { family: right.family, pluginId: admission.pluginId, localId: right.localId,
                target: admission.target, executionOrigin: admission.executionOrigin, occurrenceId: admission.occurrenceId };
            const key = registrationIndexKey(address);
            // A redundant cold acquisition cannot replace an exact committed handler.
            const prior = snapshot[key];
            if (prior && 'registration' in prior && isLifecycleCurrent(prior.registration.lifecycle)) continue;
            const existing = readRefusal(address);
            if (existing?.code === refusal.code && existing.layer === refusal.layer && existing.phase === refusal.phase
                && existing.retryable === refusal.retryable && existing.diagnostics.length === refusal.diagnostics.length
                && existing.diagnostics.every((diagnostic, index) => diagnostic === refusal.diagnostics[index])) continue;
            next[key] = { ownerToken: Object.freeze({}), admission, refusal };
            changed = true;
        }
        if (changed) publish(next);
    };

    function createScope(input: PluginUiClientExecutableRegistrationScopeInput & Readonly<{ target: PluginUiClientExecutableTarget & { realm: 'account' } }>): PluginUiClientExecutableRegistrationScope<PluginAccountApi>;
    function createScope(input: PluginUiClientExecutableRegistrationScopeInput & Readonly<{ target: PluginUiClientExecutableTarget & { realm?: undefined } }>): PluginUiClientExecutableRegistrationScope;
    function createScope(input: PluginUiClientExecutableRegistrationScopeInput): PluginUiExecutableRegistrationScope;
    function createScope(input: PluginUiClientExecutableRegistrationScopeInput): PluginUiExecutableRegistrationScope {
        const exact = validateScopeInput(input);
        const deriveRights = exact.target.realm === 'account' ? derivePluginAccountContributionRegistrationRights : derivePluginClientContributionRegistrationRights;
        const rights = deriveRights(input.contributes, exact.target);
        if (rights.length === 0) {
            throw new Error('client_executable_target_has_no_registration_rights');
        }
        const publishedRights = deriveRights(
            input.publishedContributes ?? input.contributes,
            exact.target,
        );
        const registrationScope = exact.target.realm === 'account'
            ? createPluginRegistrationScope({ pluginId: input.pluginId, rights,
                target: Object.freeze({ realm: 'account' as const, artifactId: exact.target.artifactId, exportName: exact.target.exportName }) })
            : createPluginRegistrationScope({ pluginId: input.pluginId, rights,
                target: Object.freeze({ ...exact.target, realm: 'client' as const }) });
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
        const retirement = new AbortController();
        const mergedLifetime = mergeAbortSignals([input.lifecycle.signal, retirement.signal]);
        const lifecycle: PluginUiClientExecutableRegistrationLifecycle = Object.freeze({
            signal: mergedLifetime.signal,
            isCurrent: () => !unwound && isLifecycleCurrent(input.lifecycle),
        });
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
            isCurrent: () => isLifecycleCurrent(lifecycle),
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
                    if (existing && 'registration' in existing && existing.ownerToken !== ownerToken) {
                        throw new Error('client_executable_registration_conflict');
                    }
                    let currentRegistration = registration;
                    const prepareRegistration = input.prepareRegistration;
                    let authenticationRuntime: Promise<UiConnectedAccountAuthenticationRuntime> | undefined;
                    nextEntries.push(Object.freeze([key, Object.freeze({
                        ownerToken,
                        registration: Object.freeze({
                            contribution: Object.freeze({
                                pluginId: input.pluginId,
                                localId: registration.localId,
                            }),
                            right,
                            get registration() { return currentRegistration; },
                            ...(prepareRegistration ? { async prepare(signal?: AbortSignal) {
                                const cancellation = mergeAbortSignals([signal, lifecycle.signal]);
                                try {
                                    if (cancellation.signal.aborted) {
                                        throw Object.assign(new Error('plugin_action_generation_retired'), { code: 'plugin_action_generation_retired' });
                                    }
                                    currentRegistration = await awaitRegistrationPreparation(prepareRegistration(registration), cancellation.signal);
                                } finally { cancellation.dispose(); }
                            } } : {}),
                            target: exact.target,
                            executionOrigin: exact.executionOrigin,
                            occurrenceId: input.occurrenceId,
                            ...(exact.pluginVersion === undefined
                                ? {}
                                : { pluginVersion: exact.pluginVersion }),
                            ...(input.accountLifetime === undefined ? {} : { accountLifetime: input.accountLifetime }),
                            ...(input.authority === undefined ? {} : { authority: input.authority }),
                            lifecycle,
                            ...(registration.family === 'connectedAccountDescriptors' ? {
                                connectedAccountAuthentication: Object.freeze({
                                    acquire(create: () => Promise<UiConnectedAccountAuthenticationRuntime>) {
                                        authenticationRuntime ??= create().catch(error => {
                                            authenticationRuntime = undefined;
                                            throw error;
                                        });
                                        return authenticationRuntime;
                                    },
                                }),
                            } : {}),
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
                    retirement.abort();
                    mergedLifetime.dispose();
                }
                return registrationScope.dispose();
            },
        });
    }

    return Object.freeze({
        createScope,
        read,
        readRefusal,
        refuse,
        retainRefusals,
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
    executionOrigin: PluginMachineExecutionOriginV1 | null;
    occurrenceId: string;
    /** Host ABI compatibility participates in byte/module sharing identity. */
    hostUiApiRange: string;
    /** Exact package version retained for client Action SDK context. */
    pluginVersion?: string;
    accountLifetime?: ActiveServerAccountScopeLifetime;
    cache: PluginReactNativeBundleCache;
    identity: PluginReactNativeBundleCacheIdentity;
    moduleReference: PluginReactNativeExecutableModuleReference;
    backend: PluginReactNativeLoaderBackend;
    loadExport?: () => Promise<PluginReactNativeExportLoaderResult>;
    prepareRegistration?: PluginUiClientExecutableRegistrationScopeInput['prepareRegistration'];
    authority: PluginUiExecutableAuthority;
    isCurrent(): boolean;
    /** A derived family may compose runtime state but cannot replace the ABI/index owner. */
    createScope?(
        registrationScope: PluginUiExecutableRegistrationScope,
    ): PluginUiClientExecutableDerivedScope;
}>;

export type PluginUiClientExecutableCompositionAttempt = Readonly<{
    activation: PluginUiClientExecutableActivation;
    result: PluginUiExecutableModuleActivationResult | PluginUiClientExecutableFailure;
    /** The incumbent host scope remained current, so this input did not take ownership. */
    reused: boolean;
}>;

export type PluginUiClientExecutableAdmission = Pick<PluginUiClientExecutableActivation,
    'pluginId' | 'contributes' | 'target' | 'executionOrigin' | 'occurrenceId' | 'hostUiApiRange'
    | 'pluginVersion' | 'identity' | 'moduleReference' | 'authority'>;

export type PluginUiClientExecutableComposition = Readonly<{
    /** Withdraw obsolete exact targets before successor Artifact preparation awaits. */
    retain(admissions: readonly PluginUiClientExecutableAdmission[]): Promise<void>;
    /** A preparing or committed activation still owns its exact controller and index target. */
    isCurrentActivation(activation: PluginUiClientExecutableActivation): boolean;
    /** Publish ready targets against the complete set already admitted by retain. */
    adopt(
        activations: readonly PluginUiClientExecutableActivation[],
    ): Promise<readonly PluginUiClientExecutableCompositionAttempt[]>;
    reconcile(
        activations: readonly PluginUiClientExecutableActivation[],
    ): Promise<readonly PluginUiClientExecutableCompositionAttempt[]>;
    read(address: PluginUiClientExecutableRegistrationAddress): PluginUiClientExecutableRegistration | null;
    readRefusal(address: PluginUiClientExecutableRegistrationAddress, authority?: PluginUiExecutableAuthority): PluginUiClientExecutableFailure | null;
    refuse(admission: PluginUiClientExecutableAdmission, failure: PluginUiClientExecutableFailure): void;
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
    moduleReference: PluginReactNativeExecutableModuleReference;
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
    return getPluginUiExecutableAuthorityKey(authority);
}

/**
 * The exact client executable address. Projection, reconciliation, and the
 * generic composition owner must partition the same target/currentness facts.
 */
export function getPluginUiClientExecutableTargetAddressKey(input: Pick<
    PluginUiClientExecutableActivation,
    'pluginId' | 'target' | 'executionOrigin' | 'authority'
>): string {
    return [
        input.pluginId,
        input.target.realm ?? 'client',
        input.target.artifactId,
        input.target.exportName,
        input.target.platform,
        input.executionOrigin === null ? '' : JSON.stringify(PluginMachineExecutionOriginV1Schema.parse(input.executionOrigin)),
        clientExecutableAuthorityKey(input.authority),
    ].join('\u0000');
}

/**
 * Rights may be shared only within one plugin's installed executable bytes. Authority
 * and plugin occurrence intentionally do not participate: they select exact
 * index publication and currentness, not what one module is allowed to register.
 */
function clientExecutableModuleKey(activation: PluginUiClientExecutableAdmission): string {
    return [
        activation.pluginId,
        activation.identity.artifactDigest,
        activation.target.realm ?? 'client',
        activation.moduleReference.exportName,
        activation.identity.platform,
        activation.hostUiApiRange,
    ].join('\u0000');
}

/**
 * Inputs arrive already normalized by their family producers. The generic
 * composition combines only compatible module declarations, then leaves the
 * registration index to derive and validate their rights once.
 */
function mergeClientExecutableRegistrationContributes(
    activations: readonly PluginUiClientExecutableAdmission[],
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
    activation: PluginUiClientExecutableAdmission,
    registrationContributes: Readonly<Record<string, unknown>> = activation.contributes,
): string {
    return [
        activation.identity.pluginId,
        activation.identity.contributionId,
        activation.identity.artifactId,
        activation.identity.artifactDigest,
        activation.identity.platform,
        activation.occurrenceId,
        activation.hostUiApiRange,
        activation.moduleReference.exportName,
        clientExecutableAuthorityKey(activation.authority),
        (activation.target.realm === 'account' ? derivePluginAccountContributionRegistrationRights : derivePluginClientContributionRegistrationRights)(registrationContributes, activation.target)
            .map((right) => `${right.family}\u0000${right.localId}`)
            .sort((left, right) => left.localeCompare(right))
            .join('\u0001'),
    ].join('\u0000');
}

function clientExecutableRegistrationContributesByTarget(
    admissions: readonly PluginUiClientExecutableAdmission[],
): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
    const compatible = new Map<string, PluginUiClientExecutableAdmission[]>();
    for (const admission of admissions) {
        const moduleKey = clientExecutableModuleKey(admission);
        const group = compatible.get(moduleKey) ?? [];
        group.push(admission);
        compatible.set(moduleKey, group);
    }
    const rights = new Map<string, Readonly<Record<string, unknown>>>();
    for (const group of compatible.values()) {
        const contributes = mergeClientExecutableRegistrationContributes(group);
        for (const admission of group) rights.set(getPluginUiClientExecutableTargetAddressKey(admission), contributes);
    }
    return rights;
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
    activation: PluginUiClientExecutableAdmission,
): boolean {
    return activation.identity.pluginId === activation.pluginId
        && activation.identity.platform === activation.target.platform
        && activation.moduleReference.exportName === activation.target.exportName
        && (activation.target.realm === 'account' ? 'kind' in activation.authority && activation.executionOrigin === null
            && activation.occurrenceId === activation.authority.custodyId : !('kind' in activation.authority))
        && (activation.executionOrigin === null || (
            !('kind' in activation.authority) &&
            activation.authority.machineId === getPluginMachineExecutionOriginRef(activation.executionOrigin).machineId
            && getPluginMachineExecutionOriginRef(activation.executionOrigin).pluginId === activation.pluginId
        ))
        && activation.occurrenceId.trim().length > 0
        && activation.hostUiApiRange.trim().length > 0
        && (activation.pluginVersion === undefined || activation.pluginVersion.trim().length > 0);
}

function retiredClientExecutableResult(): PluginUiClientExecutableFailure {
    return Object.freeze({
        ok: false,
        code: 'artifact_replaced',
        diagnostics: Object.freeze(['artifact_replaced']),
        layer: 'registration', phase: 'activation', retryable: false,
    });
}

function invalidClientExecutableResult(diagnostic: string): PluginUiClientExecutableFailure {
    return Object.freeze({
        ok: false,
        code: 'activation_failed',
        diagnostics: Object.freeze([diagnostic]),
        layer: 'registration', phase: 'activation', retryable: false,
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
    const admittedByTargetKey = new Map<string, Readonly<{
        fingerprint: string;
        registrationContributes: Readonly<Record<string, unknown>>;
    }>>();
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

    const retain = async (admissions: readonly PluginUiClientExecutableAdmission[]): Promise<void> => {
        const byKey = new Map<string, PluginUiClientExecutableAdmission>();
        const duplicates = new Set<string>();
        for (const admission of admissions) {
            if (!isClientExecutableActivationCoherent(admission)) continue;
            const key = getPluginUiClientExecutableTargetAddressKey(admission);
            if (byKey.has(key)) duplicates.add(key);
            byKey.set(key, admission);
        }
        for (const key of duplicates) byKey.delete(key);
        const rights = clientExecutableRegistrationContributesByTarget([...byKey.values()]);
        admittedByTargetKey.clear();
        for (const [key, admission] of byKey) {
            const registrationContributes = rights.get(key) ?? admission.contributes;
            admittedByTargetKey.set(key, { fingerprint: clientExecutableActivationFingerprint(admission, registrationContributes),
                registrationContributes });
        }
        registrationIndex.retainRefusals(admission => {
            const admitted = admittedByTargetKey.get(getPluginUiClientExecutableTargetAddressKey(admission));
            return admitted !== undefined && admitted.fingerprint === clientExecutableActivationFingerprint(admission, admitted.registrationContributes);
        });
        const requestedAuthorities = new Set([...byKey.values()].map(admission => clientExecutableAuthorityKey(admission.authority)));
        const retirements: Promise<void>[] = [];
        for (const [key, active] of activeByTargetKey) {
            const replacement = byKey.get(key);
            if (replacement && active.fingerprint === clientExecutableActivationFingerprint(
                replacement, rights.get(key),
            )) continue;
            activeByTargetKey.delete(key);
            active.controller.abort();
            if (requestedAuthorities.has(active.authorityKey)) {
                retirements.push(active.executableHost.invalidateActivation({ identity: active.identity, moduleReference: active.moduleReference }));
            }
        }
        for (const [authorityKey, leaf] of [...authorityLeavesByKey]) {
            if (requestedAuthorities.has(authorityKey)) continue;
            releaseAuthorityLeaf(authorityKey, leaf);
            retirements.push(leaf.executableHost.unload());
        }
        await Promise.all(retirements);
    };

    const isAdmitted = (activation: PluginUiClientExecutableActivation): boolean => {
        const admitted = admittedByTargetKey.get(getPluginUiClientExecutableTargetAddressKey(activation));
        return admitted !== undefined && admitted.fingerprint === clientExecutableActivationFingerprint(
            activation, admitted.registrationContributes,
        );
    };

    const adopt = async (
        activations: readonly PluginUiClientExecutableActivation[],
    ): Promise<readonly PluginUiClientExecutableCompositionAttempt[]> => {
        const results: Array<PluginUiClientExecutableCompositionAttempt['result'] | null> = activations.map(() => null);
        const reused: boolean[] = activations.map(() => false);
        const grouped = new Map<string, {
            activation: PluginUiClientExecutableActivation;
            inputIndexes: number[];
            conflict: boolean;
        }>();

        for (const [index, activation] of activations.entries()) {
            if (!isClientExecutableActivationCurrent(activation)) {
                results[index] = retiredClientExecutableResult();
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
            if (!isAdmitted(group.activation)) {
                for (const index of group.inputIndexes) results[index] = retiredClientExecutableResult();
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

        const prepared: PreparedClientExecutableTarget[] = preparedTargets.map((preparedTarget) => Object.freeze({
            ...preparedTarget,
            registrationContributes: admittedByTargetKey.get(preparedTarget.key)?.registrationContributes
                ?? preparedTarget.activation.contributes,
        }));

        const leavesByAuthorityKey = new Map<string, ExecutableAuthorityLeaf>();
        for (const [authorityKey, requestedAuthority] of requestedAuthoritiesByKey.entries()) {
            leavesByAuthorityKey.set(authorityKey, await ensureAuthorityLeaf(requestedAuthority));
        }

        await Promise.all(prepared.map(async (preparedTarget) => {
            const { activation } = preparedTarget;
            const authorityKey = clientExecutableAuthorityKey(activation.authority);
            const leaf = leavesByAuthorityKey.get(authorityKey);
            if (!leaf || !isAdmitted(activation) || !isClientExecutableActivationCurrent(activation)) {
                for (const index of preparedTarget.inputIndexes) {
                    results[index] = retiredClientExecutableResult();
                }
                return;
            }
            const fingerprint = clientExecutableActivationFingerprint(
                activation,
                preparedTarget.registrationContributes,
            );
            const remainsAdmitted = () => admittedByTargetKey.get(preparedTarget.key)?.fingerprint === fingerprint;
            const incumbent = activeByTargetKey.get(preparedTarget.key);
            const incumbentRemainsCurrent = incumbent !== undefined
                && incumbent.fingerprint === fingerprint
                && isClientExecutableActivationCurrent(incumbent.activation);
            let active: ActiveClientExecutableTarget = incumbent && incumbent.fingerprint === fingerprint
                ? incumbent
                : Object.freeze({
                    fingerprint,
                    pluginId: activation.pluginId,
                    activation,
                    identity: activation.identity,
                    moduleReference: activation.moduleReference,
                    controller: new AbortController(),
                    authorityKey,
                    executableHost: leaf.executableHost,
                });
            if (active !== incumbent) {
                activeByTargetKey.set(preparedTarget.key, active);
            }
            let createdScope = false;
            const result = await leaf.executableHost.activate({
                cache: activation.cache,
                identity: activation.identity,
                moduleReference: activation.moduleReference,
                backend: activation.backend,
                ...(activation.loadExport ? { loadExport: activation.loadExport } : {}),
                hostPlatform: activation.target.platform,
                authority: activation.authority,
                createScope: () => {
                    createdScope = true;
                    // The host may retire a derived scope despite equal bytes.
                    // A fresh scope owns this activation before commit checks its
                    // retained lease; only an actual host reuse keeps the incumbent.
                    if (active === incumbent) {
                        active.controller.abort();
                        active = Object.freeze({ ...active, activation, controller: new AbortController() });
                        activeByTargetKey.set(preparedTarget.key, active);
                    }
                    const lifecycle: PluginUiClientExecutableRegistrationLifecycle = Object.freeze({
                        signal: active.controller.signal,
                        isCurrent: () => (
                            !active.controller.signal.aborted
                            && remainsAdmitted()
                            && isClientExecutableActivationCurrent(activation)
                        ),
                    });
                    const targetIsCurrent = () => isLifecycleCurrent(lifecycle);
                    const registrationScope = registrationIndex.createScope({
                        pluginId: activation.pluginId,
                        contributes: preparedTarget.registrationContributes,
                        publishedContributes: activation.contributes,
                        target: activation.target,
                        executionOrigin: activation.executionOrigin,
                        occurrenceId: activation.occurrenceId,
                        ...(activation.pluginVersion === undefined
                            ? {}
                            : { pluginVersion: activation.pluginVersion }),
                        ...(activation.accountLifetime === undefined ? {} : { accountLifetime: activation.accountLifetime }),
                        authority: activation.authority,
                        ...(activation.prepareRegistration ? { prepareRegistration: activation.prepareRegistration } : {}),
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
            const settled = result.ok
                ? (!remainsAdmitted() || !isClientExecutableActivationCurrent(activation) ? retiredClientExecutableResult() : result)
                : { ...result, layer: 'registration' as const, phase: 'activation' as const, retryable: false };
            for (const index of preparedTarget.inputIndexes) results[index] = settled;
            for (const index of preparedTarget.inputIndexes) {
                reused[index] = result.ok && incumbentRemainsCurrent && !createdScope;
            }
            if (settled.ok) {
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
            if (!settled.ok && remainsAdmitted()) {
                registrationIndex.refuse(activation, settled);
            }
        }));

        return Object.freeze(activations.map((activation, index) => Object.freeze({
            activation,
            result: results[index] ?? retiredClientExecutableResult(),
            reused: reused[index] === true,
        })));
    };

    return Object.freeze({
        retain,
        isCurrentActivation: (activation) => {
            const active = activeByTargetKey.get(getPluginUiClientExecutableTargetAddressKey(activation));
            return active?.activation === activation && !active.controller.signal.aborted;
        },
        adopt,
        reconcile: async (activations) => {
            const retention = retain(activations);
            const attempts = adopt(activations);
            const [result] = await Promise.all([attempts, retention]);
            return result;
        },
        read: registrationIndex.read,
        readRefusal: registrationIndex.readRefusal,
        refuse: (admission, failure) => {
            const admitted = admittedByTargetKey.get(getPluginUiClientExecutableTargetAddressKey(admission));
            if (admitted !== undefined && admitted.fingerprint === clientExecutableActivationFingerprint(admission, admitted.registrationContributes)) {
                registrationIndex.refuse(admission, failure);
            }
        },
        revision: registrationIndex.revision,
        subscribe: registrationIndex.subscribe,
        invalidatePlugin: async (pluginId) => {
            registrationIndex.retainRefusals(admission => admission.pluginId !== pluginId);
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
            admittedByTargetKey.clear();
            registrationIndex.retainRefusals(() => false);
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
function readProjectedClientRegistrationOrigin(
    entry: Readonly<{ pluginId: string }>,
): Readonly<{ origin: PluginMachineExecutionOriginV1 | null }> | null {
    const stamped = readPluginUiContributionOrigin(entry);
    if (stamped) {
        if (stamped.phase !== 'current' || !stamped.interactionEnabled) return null;
        const origin = stamped.executionOrigin;
        if (origin && (getPluginMachineExecutionOriginRef(origin).pluginId !== entry.pluginId
            || getPluginMachineExecutionOriginRef(origin).machineId !== stamped.machineId)) return null;
        return { origin };
    }
    const origin = readPluginUiProjectionEntryExecutionOrigin(entry);
    if (origin) return { origin };
    // A partial or invalid producer stamp is not an originless client target.
    return 'serverIdentityId' in entry || 'materializationRef' in entry ? null : { origin: null };
}

function resolvePluginUiClientActionAddress(input: Readonly<{
    action: PluginProjectedActionV2;
    /** The one platform mapper is `resolvePluginUiClientExecutablePlatform`. */
    platform: PluginContributionClientPlatform;
    reader?: PluginUiClientExecutableRegistrationReader;
}>) {
    const { action, platform } = input;
    if (
        action.execution.target === 'daemon'
        || !isPluginProjectedActionExecutable(action)
        || !action.authorization
    ) {
        return null;
    }
    const accountOrigin = action.execution.target === 'account' ? readPluginUiAccountExecutableOrigin(action) : null;
    const producer = action.execution.target === 'account'
        ? accountOrigin && action.occurrenceId === accountOrigin.custodyId ? { origin: null } : null
        : readProjectedClientRegistrationOrigin(action);
    if (!producer) return null;
    if (action.execution.target === 'client' && !action.execution.platforms.includes(platform)) return null;
    const executable = action.execution.target === 'account' ? action.execution.account : action.execution.client;
    const address = Object.freeze({
        family: 'actions' as const,
        pluginId: action.pluginId,
        localId: action.id,
        target: freezeTarget({
            ...(accountOrigin ? { realm: 'account' as const } : {}),
            artifactId: executable.artifactId,
            exportName: executable.exportName,
            platform,
        }),
        executionOrigin: producer.origin ? freezeExecutionOrigin(producer.origin) : null,
        occurrenceId: action.occurrenceId,
    }) satisfies PluginUiClientExecutableRegistrationAddress;
    return { address, accountOrigin, authorization: action.authorization };
}

export function resolvePluginUiClientActionRefusal(input: Readonly<{
    action: PluginProjectedActionV2;
    platform: PluginContributionClientPlatform;
    reader?: PluginUiClientExecutableRegistrationReader;
}>): PluginUiClientExecutableFailure | null {
    const resolved = resolvePluginUiClientActionAddress(input);
    if (!resolved) return null;
    const account = resolved.accountOrigin;
    const stamped = readPluginUiContributionOrigin(input.action);
    const authority: PluginUiExecutableAuthority | undefined = account
        ? { kind: 'account', serverId: account.serverId, accountId: account.accountId, custodyId: account.custodyId }
        : stamped ? { machineId: stamped.machineId, serverId: stamped.serverId } : undefined;
    if (!authority) return null;
    return (input.reader ?? getInstalledPluginUiClientExecutableComposition()).readRefusal?.(resolved.address, authority) ?? null;
}

export function resolvePluginUiClientActionRegistration(input: Readonly<{
    action: PluginProjectedActionV2;
    /** The one platform mapper is `resolvePluginUiClientExecutablePlatform`. */
    platform: PluginContributionClientPlatform;
    reader?: PluginUiClientExecutableRegistrationReader;
}>): PluginUiClientActionRegistration | null {
    const resolved = resolvePluginUiClientActionAddress(input);
    if (!resolved) return null;
    const { address, accountOrigin, authorization } = resolved;
    const { action } = input;
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
        || registration.right.target.realm !== action.execution.target
        || registration.registration.family !== 'actions'
        || registration.occurrenceId !== action.occurrenceId
        || typeof registration.registration.value !== 'function'
        || typeof pluginVersion !== 'string'
        || pluginVersion.trim().length === 0
        || (accountOrigin && (!registration.authority || !('kind' in registration.authority)
            || registration.authority.serverId !== accountOrigin.serverId
            || registration.authority.accountId !== accountOrigin.accountId
            || registration.authority.custodyId !== accountOrigin.custodyId))
    ) {
        return null;
    }
    // The generic registration value is family-opaque until this exact
    // `actions` right is confirmed at the SDK ABI boundary.
    return Object.freeze({
        registration,
        pluginVersion,
        get handler() { return registration.registration.value as unknown as PluginClientActionHandler | PluginAccountActionHandler; },
        // The daemon supplies desired occurrence and access facts. Application
        // in the client realm is proven by this exact committed SDK registration,
        // independently of whether the plugin's daemon entrypoint was demanded.
        authorization: Object.freeze({
            ...authorization,
            generation: Object.freeze({
                ...authorization.generation,
                appliedGeneration: registration.occurrenceId,
                targetGenerationMode: 'current' as const,
            }),
        }),
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

type ProjectedEntityContribution = (PluginProjectedDragSourceEntryV1 | PluginProjectedDropTargetEntryV1 | PluginProjectedWorkItemsEntryV1) & Partial<PluginMachineExecutionOriginV1>;

function resolvePluginUiClientEntityRegistration(input: Readonly<{
    family: 'dragSources' | 'dropTargets' | 'workItems';
    contribution: ProjectedEntityContribution;
    platform: PluginContributionClientPlatform;
    reader?: PluginUiClientExecutableRegistrationReader;
}>): PluginUiClientExecutableRegistration | null {
    const { contribution, platform, family } = input;
    if (!contribution.occurrenceId || contribution.id !== `${contribution.pluginId}/${contribution.definition.id}`
        || !contribution.definition.platforms.includes(platform)) return null;
    const producer = readProjectedClientRegistrationOrigin(contribution);
    if (!producer) return null;
    let registration: PluginUiClientExecutableRegistration | null;
    try {
        registration = (input.reader ?? getInstalledPluginUiClientExecutableComposition()).read({
            family, pluginId: contribution.pluginId, localId: contribution.definition.id,
            occurrenceId: contribution.occurrenceId,
            target: freezeTarget({ ...contribution.definition.client, platform }),
            executionOrigin: producer.origin ? freezeExecutionOrigin(producer.origin) : null,
        });
    } catch { return null; }
    return registration && registration.right.family === family && registration.registration.family === family
        && registration.contribution.pluginId === contribution.pluginId && registration.contribution.localId === contribution.definition.id
        && registration.occurrenceId === contribution.occurrenceId && registration.pluginVersion === contribution.pluginVersion
        && registration.lifecycle.isCurrent() && !registration.lifecycle.signal.aborted
        ? registration : null;
}

export type PluginUiClientDragSourceRegistration = Readonly<{
    registration: PluginUiClientExecutableRegistration; pluginVersion: string; runtime: PluginDragSourceRuntime;
}>;

export type PluginUiClientWorkItemsRegistration = Readonly<{
    registration: PluginUiClientExecutableRegistration; pluginVersion: string; runtime: PluginWorkItemsRuntime;
}>;

/** Reads and watches stay inside the exact admitted client activation lifetime. */
export function resolvePluginUiClientWorkItemsRegistration(input: Readonly<{
    source: PluginProjectedWorkItemsEntryV1 & Partial<PluginMachineExecutionOriginV1>;
    platform: PluginContributionClientPlatform; reader?: PluginUiClientExecutableRegistrationReader;
}>): PluginUiClientWorkItemsRegistration | null {
    const registration = resolvePluginUiClientEntityRegistration({ ...input, family: 'workItems', contribution: input.source });
    if (registration?.registration.family !== 'workItems') return null;
    const captured = registration.registration.value;
    const assertCurrent = () => {
        throwIfAborted(registration.lifecycle.signal);
        if (!registration.lifecycle.isCurrent()) throw new Error('Work items registration is no longer current');
    };
    const assertHome = (serverId: string) => {
        if (!areServerProfileIdentifiersEquivalent(registration.authority?.serverId, serverId)) {
            throw new Error('Work items read must use its admitted Home');
        }
    };
    const invoke = async <T>(serverId: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        assertCurrent();
        assertHome(serverId);
        const merged = mergeAbortSignals([signal, registration.lifecycle.signal]);
        try {
            throwIfAborted(merged.signal);
            const result = await run(merged.signal);
            throwIfAborted(merged.signal);
            assertCurrent();
            return result;
        } finally { merged.dispose(); }
    };
    const findLinked = captured.findLinked;
    const watch = captured.watch;
    const runtime = Object.freeze<PluginWorkItemsRuntime>({
        resolve: (request, context) => invoke(request.serverId, context.signal, signal => captured.resolve(request, { signal })),
        ...(findLinked ? { findLinked: (request: Parameters<typeof findLinked>[0], context: Parameters<typeof findLinked>[1]) => invoke(request.serverId, context.signal, signal => findLinked(request, { signal })) } : {}),
        ...(watch ? { watch: (request: Parameters<typeof watch>[0], onChange: () => void) => {
            assertCurrent();
            assertHome(request.serverId);
            let stopped = false;
            const cleanup = watch(request, () => { if (!stopped && registration.lifecycle.isCurrent() && !registration.lifecycle.signal.aborted) onChange(); });
            const stop = () => {
                if (stopped) return;
                stopped = true;
                registration.lifecycle.signal.removeEventListener('abort', stop);
                cleanup();
            };
            registration.lifecycle.signal.addEventListener('abort', stop, { once: true });
            if (registration.lifecycle.signal.aborted || !registration.lifecycle.isCurrent()) stop();
            return stop;
        } } : {}),
    });
    return Object.freeze({ registration, pluginVersion: input.source.pluginVersion, runtime });
}
export function resolvePluginUiClientDragSourceRegistration(input: Readonly<{
    source: PluginProjectedDragSourceEntryV1 & Partial<PluginMachineExecutionOriginV1>;
    platform: PluginContributionClientPlatform; reader?: PluginUiClientExecutableRegistrationReader;
}>): PluginUiClientDragSourceRegistration | null {
    const registration = resolvePluginUiClientEntityRegistration({ ...input, family: 'dragSources', contribution: input.source });
    return registration?.registration.family === 'dragSources'
        ? { registration, pluginVersion: input.source.pluginVersion, runtime: registration.registration.value } : null;
}

export type PluginUiClientDropTargetRegistration = Readonly<{
    registration: PluginUiClientExecutableRegistration; pluginVersion: string; runtime: PluginDropTargetRuntime;
}>;
export function resolvePluginUiClientDropTargetRegistration(input: Readonly<{
    target: PluginProjectedDropTargetEntryV1 & Partial<PluginMachineExecutionOriginV1>;
    platform: PluginContributionClientPlatform; reader?: PluginUiClientExecutableRegistrationReader;
}>): PluginUiClientDropTargetRegistration | null {
    const registration = resolvePluginUiClientEntityRegistration({ ...input, family: 'dropTargets', contribution: input.target });
    return registration?.registration.family === 'dropTargets'
        ? { registration, pluginVersion: input.target.pluginVersion, runtime: registration.registration.value } : null;
}
