import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol';
import type { PluginCleanup } from '@happier-dev/plugin-sdk/runtime';

import type { CanonicalPluginManifest } from '../../../manifest/types';
import type { PluginCompatibilityDiagnostic } from '../../../validation/diagnostics/types';
import {
    createContributionRegistrationHost,
    type ContributionRuntimeRegistration,
} from '../../api/registrationRightsHost';
import type { PluginDaemonModuleNamespace } from '../../types';
import { normalizePositiveTimeoutMs, runWithOptionalTimeout } from '../utils';
import { resolveActivationExport } from './source';

type ContributionModuleActivationResult = Readonly<{
    status: 'active' | 'dormant' | 'unavailable';
    registrations: readonly ContributionRuntimeRegistration[];
    diagnostics: readonly PluginCompatibilityDiagnostic[];
    dispose(): Promise<void>;
}>;

const EMPTY_REGISTRATIONS: readonly ContributionRuntimeRegistration[] = Object.freeze([]);
const NOOP_DISPOSE = async (): Promise<void> => undefined;
const DEFAULT_FAILED_ACTIVATION_CLEANUP_TIMEOUT_MS = 5_000;

function unavailable(message: string): ContributionModuleActivationResult {
    return Object.freeze({
        status: 'unavailable',
        registrations: EMPTY_REGISTRATIONS,
        diagnostics: Object.freeze([{ code: 'plugin_activation_failed' as const, message }]),
        dispose: NOOP_DISPOSE,
    });
}

export async function activateContributionModule(params: Readonly<{
    pluginId: string;
    generation: string;
    manifest: CanonicalPluginManifest;
    moduleNamespace: PluginDaemonModuleNamespace;
    isGenerationCurrent(): boolean;
    forceActivation?: boolean;
    cleanupTimeoutMs?: number;
}>): Promise<ContributionModuleActivationResult> {
    const rights = derivePluginDaemonContributionRegistrationRights(
        params.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
    );
    const activationExport = resolveActivationExport(params.moduleNamespace);
    if (activationExport.status === 'invalid') {
        return unavailable(`Plugin '${params.pluginId}' named activation export is not a function`);
    }
    if (activationExport.status === 'missing') {
        return rights.length > 0
            ? unavailable(`Plugin '${params.pluginId}' has required runtime registrations but no named activate export`)
            : Object.freeze({
                status: 'dormant', registrations: EMPTY_REGISTRATIONS,
                diagnostics: Object.freeze([]), dispose: NOOP_DISPOSE,
            });
    }
    if (rights.length === 0 && !params.forceActivation) {
        return Object.freeze({
            status: 'dormant', registrations: EMPTY_REGISTRATIONS,
            diagnostics: Object.freeze([]), dispose: NOOP_DISPOSE,
        });
    }

    const host = createContributionRegistrationHost({
        pluginId: params.pluginId,
        generation: params.generation,
        rights,
        isGenerationCurrent: params.isGenerationCurrent,
    });
    let pluginCleanup: PluginCleanup | null = null;
    let disposalPromise: Promise<void> | null = null;
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
                await pluginCleanup?.();
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
    try {
        const result: unknown = await activationExport.activate(host.api);
        if (result !== undefined && typeof result !== 'function') {
            throw new Error(`Plugin '${params.pluginId}' activate export must return void or one cleanup function`);
        }
        pluginCleanup = typeof result === 'function' ? result as PluginCleanup : null;
        const registrations = host.commit();
        return Object.freeze({
            status: 'active', registrations, diagnostics: host.diagnostics(), dispose: disposeActivation,
        });
    } catch (error) {
        const hostDiagnostics = host.diagnostics();
        const diagnostics: PluginCompatibilityDiagnostic[] = hostDiagnostics.length > 0
            ? [...hostDiagnostics]
            : [{
                code: 'plugin_activation_failed',
                message: error instanceof Error ? error.message : `Plugin '${params.pluginId}' activation failed`,
            }];
        try {
            const timeoutMs = normalizePositiveTimeoutMs(
                params.cleanupTimeoutMs ?? DEFAULT_FAILED_ACTIVATION_CLEANUP_TIMEOUT_MS,
            ) ?? DEFAULT_FAILED_ACTIVATION_CLEANUP_TIMEOUT_MS;
            await runWithOptionalTimeout(
                timeoutMs,
                disposeActivation,
                () => new Error(`Plugin '${params.pluginId}' cleanup after activation failure timed out after ${timeoutMs}ms`),
            );
        } catch (cleanupError) {
            diagnostics.push({
                code: 'plugin_activation_failed',
                message: cleanupError instanceof Error
                    ? `Plugin '${params.pluginId}' cleanup after activation failure failed: ${cleanupError.message}`
                    : `Plugin '${params.pluginId}' cleanup after activation failure failed`,
            });
        }
        return Object.freeze({
            status: 'unavailable',
            registrations: EMPTY_REGISTRATIONS,
            diagnostics: Object.freeze(diagnostics),
            dispose: NOOP_DISPOSE,
        });
    }
}
