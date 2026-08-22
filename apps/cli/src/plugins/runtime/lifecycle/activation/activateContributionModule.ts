import type { PluginCleanup } from '@happier-dev/plugin-sdk';

import type { CanonicalPluginManifest } from '../../../manifest/types';
import type { PluginCompatibilityDiagnostic } from '../../../validation/diagnostics/types';
import { logger } from '@/ui/logger';
import {
    createContributionRegistrationHost,
    deriveContributionRegistrationRightsForManifest,
    recordValidatedAgentSessionRunnerFactory,
    type ContributionRegistrationRight,
    type ContributionRuntimeRegistration,
} from '../../api/registrationRightsHost';
import type { PluginDaemonModuleNamespace } from '../../types';
import {
    normalizePositiveTimeoutMs,
    projectPluginFailureDiagnostic,
    projectPluginFailureText,
    runWithOptionalTimeout,
} from '../utils';
import { resolveActivationExport } from './source';

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
const DEFAULT_FAILED_ACTIVATION_CLEANUP_TIMEOUT_MS = 5_000;
const ACTIVATION_DEADLINE_MS = 30_000;

class ActivationDeadlineExceededError extends Error {
    constructor(pluginId: string) {
        super(
            `Plugin '${pluginId}' activation timed out after ${ACTIVATION_DEADLINE_MS}ms; `
            + 'synchronous plugin work cannot be preempted by this asynchronous deadline',
        );
        this.name = 'ActivationDeadlineExceededError';
    }
}

function unavailable(message: string): ContributionModuleActivationResult {
    return Object.freeze({
        status: 'unavailable',
        registrations: EMPTY_REGISTRATIONS,
        validatedAgentSessionRunnerFactories: EMPTY_VALIDATED_AGENT_FACTORIES,
        diagnostics: Object.freeze([{ code: 'plugin_activation_failed' as const, message }]),
        dispose: NOOP_DISPOSE,
    });
}

async function validateSessionRunnerFactoryRegistrations(params: Readonly<{
    pluginId: string;
    manifestAuthority: 'external' | 'bundled_first_party';
    registrationRights: readonly ContributionRegistrationRight[];
    registrations: readonly ContributionRuntimeRegistration[];
    registeredExternalSessionsByAgent: ReadonlyMap<string, unknown>;
    resolveRelativeModule?: NonNullable<
        import('../../activationSources').PluginActivationSource<
            PluginDaemonModuleNamespace
        >['resolveRelativeModule']
    >;
}>): Promise<readonly import(
    '../../activationSources'
).ValidatedAgentSessionRunnerFactoryFactV1[]> {
    const validatedFacts: import(
        '../../activationSources'
    ).ValidatedAgentSessionRunnerFactoryFactV1[] = [];
    const agentRegistrationRights = new Map(
        params.registrationRights.flatMap((right) => (
            right.family === 'agents'
                ? [[right.localId, right] as const]
                : []
        )),
    );
    const agentRegistrations = new Map(
        params.registrations.flatMap((registration) => (
            registration.family === 'agents'
                ? [[registration.localId, registration.value] as const]
                : []
        )),
    );
    for (const [agentId, right] of agentRegistrationRights) {
        if (!right.requiredFields?.includes('sessionRunnerFactory')) {
            continue;
        }
        const registration = agentRegistrations.get(agentId);
        if (!registration?.factory) {
            throw new Error(
                `Session-capable Agent '${agentId}' must register one primary Agent runtime factory`,
            );
        }
    }
    for (const registration of params.registrations) {
        if (registration.family !== 'agents') continue;
        const right = agentRegistrationRights.get(registration.localId);
        const ownsPrimaryFactory =
            right?.requiredFields?.includes('factory') === true;
        const requiresLocator =
            right?.requiredFields?.includes('sessionRunnerFactory') === true;
        if (!ownsPrimaryFactory && registration.value.factory) {
            throw new Error(
                `Agent '${registration.localId}' must not register a competing primary Agent runtime factory`,
            );
        }
        const locator = registration.value.sessionRunnerFactory;
        if (!requiresLocator) {
            if (locator) {
                throw new Error(
                    `Execution-run-only Agent '${registration.localId}' must not register a session runner factory locator`,
                );
            }
            continue;
        }
        if (!registration.value.factory) {
            throw new Error(
                `Session-capable Agent '${registration.localId}' must register one primary Agent runtime factory`,
            );
        }
        if (!locator) {
            throw new Error(
                `Session-capable Agent '${registration.localId}' must register a session runner factory locator`,
            );
        }
        if (!params.resolveRelativeModule) {
            throw new Error(
                `Plugin '${params.pluginId}' has no immutable-generation module resolver for Agent '${registration.localId}'`,
            );
        }
        const resolved = await params.resolveRelativeModule(locator.module);
        const selectedExport = Object.prototype.hasOwnProperty.call(
            resolved.module,
            locator.export,
        )
            ? resolved.module[locator.export]
            : undefined;
        if (selectedExport !== registration.value.factory) {
            throw new Error(
                `Session runner factory export '${locator.export}' does not match the factory registered for Agent '${registration.localId}'`,
            );
        }
        const hasRegisteredExternalSessions =
            params.registeredExternalSessionsByAgent.has(registration.localId);
        const registeredExternalSessions =
            params.registeredExternalSessionsByAgent.get(registration.localId);
        if (locator.externalSessionsExport === undefined) {
            if (hasRegisteredExternalSessions) {
                throw new Error(
                    `Agent '${registration.localId}' registered an External Sessions contribution but its session runner factory locator must declare externalSessionsExport`,
                );
            }
        } else {
            const selectedExternalSessions = Object.prototype.hasOwnProperty.call(
                resolved.module,
                locator.externalSessionsExport,
            )
                ? resolved.module[locator.externalSessionsExport]
                : undefined;
            if (
                selectedExternalSessions === undefined
                || !hasRegisteredExternalSessions
                || selectedExternalSessions !== registeredExternalSessions
            ) {
                throw new Error(
                    `External Sessions companion export '${locator.externalSessionsExport}' does not match the contribution registered for Agent '${registration.localId}'`,
                );
            }
        }
        recordValidatedAgentSessionRunnerFactory(
            registration.value,
            Object.freeze({
                locator,
                normalizedModulePath: resolved.normalizedModulePath,
                loadMode: resolved.loadMode,
            }),
        );
        validatedFacts.push(Object.freeze({
            localAgentId: registration.localId,
            locator,
            normalizedModulePath: resolved.normalizedModulePath,
            loadMode: resolved.loadMode,
        }));
    }
    return Object.freeze(validatedFacts);
}

export async function activateContributionModule(params: Readonly<{
    pluginId: string;
    manifestAuthority?: 'external' | 'bundled_first_party';
    generation: string;
    manifest: CanonicalPluginManifest;
    moduleNamespace: PluginDaemonModuleNamespace;
    isGenerationCurrent(): boolean;
    forceActivation?: boolean;
    cleanupTimeoutMs?: number;
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
    const rights = deriveContributionRegistrationRightsForManifest(params.manifest);
    const activationExport = resolveActivationExport(params.moduleNamespace);
    if (activationExport.status === 'invalid') {
        return unavailable(`Plugin '${params.pluginId}' named activation export is not a function`);
    }
    if (activationExport.status === 'missing') {
        return rights.length > 0
            ? unavailable(`Plugin '${params.pluginId}' has required runtime registrations but no named activate export`)
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

    const registeredExternalSessionsByAgent = new Map<string, unknown>();
    const host = createContributionRegistrationHost({
        pluginId: params.pluginId,
        generation: params.generation,
        rights,
        isGenerationCurrent: params.isGenerationCurrent,
        onAgentExternalSessionsRegistration(localAgentId, contribution) {
            registeredExternalSessionsByAgent.set(localAgentId, contribution);
        },
    });
    const cleanupTimeoutMs = normalizePositiveTimeoutMs(
        params.cleanupTimeoutMs ?? DEFAULT_FAILED_ACTIVATION_CLEANUP_TIMEOUT_MS,
    ) ?? DEFAULT_FAILED_ACTIVATION_CLEANUP_TIMEOUT_MS;
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
            try {
                await host.dispose();
            } catch (error) {
                errors.push(error);
            }
            try {
                await disposePluginCleanup();
            } catch (error) {
                errors.push(error);
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
        activationPromise = Promise.resolve(activationExport.activate(host.api));
    } catch (error) {
        activationPromise = Promise.reject(error);
    }
    try {
        const result: unknown = await runWithOptionalTimeout(
            ACTIVATION_DEADLINE_MS,
            () => activationPromise,
            () => new ActivationDeadlineExceededError(params.pluginId),
        );
        if (result !== undefined && typeof result !== 'function') {
            throw new Error(`Plugin '${params.pluginId}' activate export must return void or one cleanup function`);
        }
        pluginCleanup = typeof result === 'function' ? result as PluginCleanup : null;
        const registrations = host.commit();
        const validatedAgentSessionRunnerFactories =
            await validateSessionRunnerFactoryRegistrations({
                pluginId: params.pluginId,
                manifestAuthority: params.manifestAuthority ?? 'external',
                registrationRights: rights,
                registrations,
                registeredExternalSessionsByAgent,
                ...(params.resolveRelativeModule
                    ? { resolveRelativeModule: params.resolveRelativeModule }
                    : {}),
            });
        await params.persistValidatedAgentSessionRunnerFactories?.(
            validatedAgentSessionRunnerFactories,
        );
        return Object.freeze({
            status: 'active',
            registrations,
            validatedAgentSessionRunnerFactories,
            diagnostics: host.diagnostics(),
            dispose: disposeActivation,
        });
    } catch (error) {
        if (error instanceof ActivationDeadlineExceededError) {
            // The activation promise cannot be preempted, so retain one observer
            // solely to dispose a cleanup function returned after its scope retired.
            // Its rejection is deliberately observed: the timeout result is final.
            void activationPromise.then(
                (lateResult) => {
                    if (typeof lateResult !== 'function') return;
                    pluginCleanup = lateResult as PluginCleanup;
                    void runWithOptionalTimeout(
                        cleanupTimeoutMs,
                        disposePluginCleanup,
                        () => new Error(
                            `Plugin '${params.pluginId}' late activation cleanup timed out after ${cleanupTimeoutMs}ms`,
                        ),
                    ).catch((cleanupError: unknown) => {
                        logger.warn('[PLUGIN RUNTIME] Late activation cleanup failed', {
                            pluginId: params.pluginId,
                            error: projectPluginFailureText(cleanupError),
                        });
                    });
                },
                () => undefined,
            );
        }
        const realm = params.localDevelopmentSourceRoot
            ? { localDevelopmentSourceRoot: params.localDevelopmentSourceRoot }
            : {};
        const hostDiagnostics = host.diagnostics();
        const diagnostics: PluginCompatibilityDiagnostic[] = hostDiagnostics.length > 0
            ? [...hostDiagnostics]
            : [{
                code: 'plugin_activation_failed',
                ...projectPluginFailureDiagnostic(error, realm),
            }];
        try {
            await runWithOptionalTimeout(
                cleanupTimeoutMs,
                disposeActivation,
                () => new Error(`Plugin '${params.pluginId}' cleanup after activation failure timed out after ${cleanupTimeoutMs}ms`),
            );
        } catch (cleanupError) {
            diagnostics.push({
                code: 'plugin_activation_failed',
                ...projectPluginFailureDiagnostic(cleanupError, realm),
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
