import type { PluginCleanup } from '@happier-dev/plugin-sdk';
import { derivePluginAccountContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';

import type { CanonicalPluginManifest } from '../../../manifest/types';
import type { PluginCompatibilityDiagnostic } from '../../../validation/diagnostics/types';
import {
    createContributionRegistrationHost,
    deriveContributionRegistrationRightsForManifest,
    type ContributionRuntimeRegistration,
} from '../../api/registrationRightsHost';
import type { PluginDaemonModuleNamespace } from '../../types';
import {
    projectPluginFailureDiagnostic,
} from '../utils';
import { resolveActivationExport } from './source';
import type { PluginModuleFailureCause } from '../../moduleFailure';

type ContributionModuleActivationResult = Readonly<{
    status: 'active' | 'dormant' | 'unavailable';
    registrations: readonly ContributionRuntimeRegistration[];
    validatedAgentSessionRunnerFactories: readonly import(
        '../../activationSources'
    ).ValidatedAgentSessionRunnerFactoryFactV1[];
    diagnostics: readonly PluginCompatibilityDiagnostic[];
    dispose(): Promise<void>;
}>;

const EMPTY_REGISTRATIONS: readonly ContributionRuntimeRegistration[] = Object.freeze([]);
const EMPTY_VALIDATED_AGENT_FACTORIES = Object.freeze([]);
const NOOP_DISPOSE = async (): Promise<void> => undefined;

class ActivationTransactionSupersededError extends Error {
    constructor(pluginId: string, reason: string) {
        super(
            `Plugin '${pluginId}' activation transaction was superseded: ${reason}; `
            + 'late retained-fact persistence and validation recording were refused',
        );
        this.name = 'ActivationTransactionSupersededError';
    }
}

function unavailable(message: string, code: Extract<PluginModuleFailureCause['code'], 'PLUGIN_ACTIVATION_EXPORT_MISSING' | 'PLUGIN_ACTIVATION_EXPORT_INVALID'>): ContributionModuleActivationResult {
    return Object.freeze({
        status: 'unavailable',
        registrations: EMPTY_REGISTRATIONS,
        validatedAgentSessionRunnerFactories: EMPTY_VALIDATED_AGENT_FACTORIES,
        diagnostics: Object.freeze([{ code: 'plugin_activation_failed' as const, message,
            details: { cause: { phase: 'activate', code, retryable: false } },
        }]),
        dispose: NOOP_DISPOSE,
    });
}

async function collectSessionRunnerFactoryRegistrations(params: Readonly<{
    pluginId: string;
    registrations: readonly ContributionRuntimeRegistration[];
    resolveRelativeModule?: NonNullable<
        import('../../activationSources').PluginActivationSource<
            PluginDaemonModuleNamespace
        >['resolveRelativeModule']
    >;
}>): Promise<readonly import('../../activationSources').ValidatedAgentSessionRunnerFactoryFactV1[]> {
    const facts: import('../../activationSources').ValidatedAgentSessionRunnerFactoryFactV1[] = [];
    for (const registration of params.registrations) {
        if (registration.family !== 'agents') continue;
        const locator = registration.value.sessionRunnerFactory;
        if (!locator) continue;
        if (!params.resolveRelativeModule) {
            throw new Error(
                `Plugin '${params.pluginId}' has no immutable-generation module resolver for Agent '${registration.localId}'`,
            );
        }
        const resolved = await params.resolveRelativeModule(locator.module);
        facts.push({
            localAgentId: registration.localId,
            locator,
            normalizedModulePath: resolved.normalizedModulePath,
            loadMode: resolved.loadMode,
        });
    }
    return facts;
}

export async function activateContributionModule(params: Readonly<{
    pluginId: string;
    manifestAuthority?: 'external' | 'bundled_first_party';
    occurrenceId: string;
    manifest: CanonicalPluginManifest;
    moduleNamespace: PluginDaemonModuleNamespace;
    target?: Readonly<{ realm: 'account'; artifactId: string; exportName: string }>;
    isOccurrenceCurrent(): boolean;
    forceActivation?: boolean;
    /**
     * The author's authenticated project root, supplied by the activation
     * owner ONLY for a locally trusted development plugin. Its presence is
     * what admits an author-actionable source location and stack into this
     * plugin's activation diagnostics; every other plugin keeps the ordinary
     * redacted projection.
     */
    localDevelopmentSourceRoot?: string;
    resolveRelativeModule?: NonNullable<
        import('../../activationSources').PluginActivationSource<
            PluginDaemonModuleNamespace
        >['resolveRelativeModule']
    >;
    persistValidatedAgentSessionRunnerFactories?: NonNullable<
        import('../../activationSources').PluginActivationSource<
            PluginDaemonModuleNamespace
        >['persistValidatedAgentSessionRunnerFactories']
    >;
}>): Promise<ContributionModuleActivationResult> {
    const rights = params.target
        ? derivePluginAccountContributionRegistrationRights(params.manifest.contributes, params.target)
        : deriveContributionRegistrationRightsForManifest(params.manifest);
    const activationExport = resolveActivationExport(params.moduleNamespace, params.target?.exportName);
    if (activationExport.status === 'invalid') {
        return unavailable(`Plugin '${params.pluginId}' named activation export is not a function`, 'PLUGIN_ACTIVATION_EXPORT_INVALID');
    }
    if (activationExport.status === 'missing') {
        return rights.length > 0
            ? unavailable(`Plugin '${params.pluginId}' has required runtime registrations but no named activate export`, 'PLUGIN_ACTIVATION_EXPORT_MISSING')
            : Object.freeze({
                status: 'dormant', registrations: EMPTY_REGISTRATIONS,
                validatedAgentSessionRunnerFactories: EMPTY_VALIDATED_AGENT_FACTORIES,
                diagnostics: Object.freeze([]), dispose: NOOP_DISPOSE,
            });
    }
    if (rights.length === 0 && !params.forceActivation) {
        return Object.freeze({
            status: 'dormant', registrations: EMPTY_REGISTRATIONS,
            validatedAgentSessionRunnerFactories: EMPTY_VALIDATED_AGENT_FACTORIES,
            diagnostics: Object.freeze([]), dispose: NOOP_DISPOSE,
        });
    }
    const hostParams = {
        pluginId: params.pluginId,
        occurrenceId: params.occurrenceId,
        rights,
        isOccurrenceCurrent: params.isOccurrenceCurrent,
    };
    const host = params.target
        ? createContributionRegistrationHost({ ...hostParams, target: params.target })
        : createContributionRegistrationHost(hostParams);
    let pluginCleanup: PluginCleanup | null = null;
    let pluginCleanupDisposalPromise: Promise<void> | null = null;
    let disposalPromise: Promise<void> | null = null;
    const disposePluginCleanup = (): Promise<void> => {
        if (!pluginCleanup) return Promise.resolve();
        if (pluginCleanupDisposalPromise) return pluginCleanupDisposalPromise;
        const cleanup = pluginCleanup;
        pluginCleanupDisposalPromise = Promise.resolve().then(() => cleanup());
        return pluginCleanupDisposalPromise;
    };
    const disposeActivation = (): Promise<void> => {
        if (disposalPromise) return disposalPromise;
        disposalPromise = (async () => {
            const errors: unknown[] = [];
            // Each activation keeps its dependency order. Peer activations own
            // independent cleanup sequences; no subordinate deadline is added.
            for (const step of [() => host.dispose(), disposePluginCleanup]) {
                try {
                    await step();
                } catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) {
                throw new AggregateError(errors, `Plugin '${params.pluginId}' activation cleanup failed`);
            }
        })();
        return disposalPromise;
    };
    let activationPromise: Promise<void | PluginCleanup>;
    try {
        activationPromise = Promise.resolve(Reflect.apply(activationExport.activate, undefined, params.target
            ? [host.api, { artifactId: params.target.artifactId, exportName: params.target.exportName }]
            : [host.api]));
    } catch (error) {
        activationPromise = Promise.reject(error);
    }
    // Retained facts publish only while this occurrence is current. The
    // starter's reporting wait does not retire trusted activation work.
    const assertActivationTransactionCurrent = (): void => {
        if (!params.isOccurrenceCurrent()) {
            throw new ActivationTransactionSupersededError(
                params.pluginId,
                'its generation is no longer current',
            );
        }
    };
    try {
        const result: unknown = await activationPromise;
        if (result !== undefined && typeof result !== 'function') {
            throw new Error(`Plugin '${params.pluginId}' activate export must return void or one cleanup function`);
        }
        pluginCleanup = typeof result === 'function' ? result as PluginCleanup : null;
        const registrations = host.commit();
        const sourceValidatedAgentSessionRunnerFactories =
            await collectSessionRunnerFactoryRegistrations({
                pluginId: params.pluginId,
                registrations,
                ...(params.resolveRelativeModule
                    ? { resolveRelativeModule: params.resolveRelativeModule }
                    : {}),
            });
        assertActivationTransactionCurrent();
        const validatedAgentSessionRunnerFactories = Object.freeze(
            await params.persistValidatedAgentSessionRunnerFactories?.(
                sourceValidatedAgentSessionRunnerFactories,
                Object.freeze({ assertCurrent: assertActivationTransactionCurrent }),
            ) ?? sourceValidatedAgentSessionRunnerFactories,
        );
        assertActivationTransactionCurrent();
        return Object.freeze({
            status: 'active',
            registrations,
            validatedAgentSessionRunnerFactories,
            diagnostics: host.diagnostics(),
            dispose: disposeActivation,
        });
    } catch (error) {
        const realm = params.localDevelopmentSourceRoot
            ? { localDevelopmentSourceRoot: params.localDevelopmentSourceRoot }
            : {};
        const hostDiagnostics = host.diagnostics();
        const diagnostics: PluginCompatibilityDiagnostic[] = hostDiagnostics.length > 0
            ? [...hostDiagnostics]
            : [{
                code: 'plugin_activation_failed',
                ...projectPluginFailureDiagnostic(error, realm, 'activate'),
            }];
        try {
            // Retirement observes this activation's actual cleanup settlement.
            await disposeActivation();
        } catch (cleanupError) {
            diagnostics.push({
                code: 'plugin_activation_failed',
                ...projectPluginFailureDiagnostic(cleanupError, realm, 'activate'),
            });
        }
        return Object.freeze({
            status: 'unavailable',
            registrations: EMPTY_REGISTRATIONS,
            validatedAgentSessionRunnerFactories: EMPTY_VALIDATED_AGENT_FACTORIES,
            diagnostics: Object.freeze(diagnostics),
            dispose: NOOP_DISPOSE,
        });
    }
}
