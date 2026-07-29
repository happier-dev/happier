import {
    createPluginRegistrationScope,
    type PluginAgentRuntimeRegistration,
    type PluginRegistrationRight,
    type PluginRuntimeRegistration,
} from '@happier-dev/plugin-sdk/experimental/testing/registration-scope';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

export type ContributionRegistrationRight = PluginRegistrationRight;
export type AgentContributionRuntimeRegistration = PluginAgentRuntimeRegistration;
export type ContributionRuntimeRegistration = PluginRuntimeRegistration;

/**
 * Production lifecycle wrapper around the shared daemon-independent SDK
 * registration contract. Generation currentness and compatibility diagnostics
 * remain CLI host policy and are not exposed by the SDK testkit.
 */
export function createContributionRegistrationHost(params: Readonly<{
    pluginId: string;
    generation: string;
    rights: readonly ContributionRegistrationRight[];
    isGenerationCurrent(): boolean;
}>): Readonly<{
    api: ReturnType<typeof createPluginRegistrationScope>['api'];
    commit(): readonly ContributionRuntimeRegistration[];
    registrations(): readonly ContributionRuntimeRegistration[];
    diagnostics(): readonly PluginCompatibilityDiagnostic[];
    dispose(): Promise<void>;
}> {
    const diagnostics: PluginCompatibilityDiagnostic[] = [];
    const scope = createPluginRegistrationScope({
        pluginId: params.pluginId,
        rights: params.rights,
        assertAvailable() {
            if (!params.isGenerationCurrent()) {
                throw new Error(`Plugin '${params.pluginId}' cannot register against retired generation '${params.generation}'`);
            }
        },
        onFailure(message) {
            if (diagnostics.length === 0) {
                diagnostics.push(Object.freeze({
                    code: 'plugin_activation_failed',
                    message,
                }));
            }
        },
    });
    let disposalPromise: Promise<void> | null = null;

    return Object.freeze({
        api: scope.api,
        commit: scope.commit,
        registrations: scope.registrations,
        diagnostics() {
            return Object.freeze([...diagnostics]);
        },
        dispose() {
            if (disposalPromise) return disposalPromise;
            disposalPromise = scope.dispose();
            return disposalPromise;
        },
    });
}
