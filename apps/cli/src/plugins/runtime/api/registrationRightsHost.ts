import { createPluginRegistrationScope, type PluginAgentRuntimeRegistration, type PluginRegistrationRight, type PluginRuntimeRegistration } from '@/plugins/runtime/api/registrationScope';
import type { PluginApi, PluginAccountApi } from '@happier-dev/plugin-sdk';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

export type ContributionRegistrationRight = PluginRegistrationRight;
export type AgentContributionRuntimeRegistration = PluginAgentRuntimeRegistration;
export type ContributionRuntimeRegistration = PluginRuntimeRegistration | (
    Extract<PluginRuntimeRegistration<'account'>, { family: 'connectedAccountDescriptors' }>
    & Readonly<{ realm: 'account' }>
);
export function deriveContributionRegistrationRightsForManifest(
    manifest: CanonicalPluginManifest,
): readonly ContributionRegistrationRight[] {
    return derivePluginDaemonContributionRegistrationRights(
        manifest.contributes as unknown as Readonly<Record<string, unknown>>,
    );
}

/**
 * Production lifecycle wrapper around the shared daemon-independent SDK
 * registration contract. Occurrence currentness and compatibility diagnostics
 * remain CLI host policy and are not exposed by the SDK testkit.
 */
type ContributionRegistrationHostParams = Readonly<{
    pluginId: string;
    occurrenceId: string;
    rights: readonly ContributionRegistrationRight[];
    isOccurrenceCurrent(): boolean;
}>;
type AccountRegistrationTarget = Readonly<{ realm: 'account'; artifactId: string; exportName: string }>;
type ContributionRegistrationHost<TApi> = Readonly<{
    api: TApi;
    commit(): readonly ContributionRuntimeRegistration[];
    registrations(): readonly ContributionRuntimeRegistration[];
    diagnostics(): readonly PluginCompatibilityDiagnostic[];
    dispose(): Promise<void>;
}>;
export function createContributionRegistrationHost(params: ContributionRegistrationHostParams & Readonly<{ target: AccountRegistrationTarget }>): ContributionRegistrationHost<PluginAccountApi>;
export function createContributionRegistrationHost(params: ContributionRegistrationHostParams & Readonly<{ target?: Readonly<{ realm: 'daemon' }> }>): ContributionRegistrationHost<PluginApi>;
export function createContributionRegistrationHost(params: ContributionRegistrationHostParams & Readonly<{ target?: Readonly<{ realm: 'daemon' }> | AccountRegistrationTarget }>): ContributionRegistrationHost<PluginApi | PluginAccountApi> {
    const diagnostics: PluginCompatibilityDiagnostic[] = [];
    const scopeParams = {
        pluginId: params.pluginId,
        rights: params.rights,
        assertAvailable() {
            if (!params.isOccurrenceCurrent()) {
                throw new Error(`Plugin '${params.pluginId}' cannot register against retired occurrence '${params.occurrenceId}'`);
            }
        },
        onFailure(message: string) {
            if (diagnostics.length === 0) {
                diagnostics.push(Object.freeze({
                    code: 'plugin_activation_failed',
                    message,
                }));
            }
        },
    };
    const target = params.target;
    const scope = target?.realm === 'account'
        ? (() => {
            const accountScope = createPluginRegistrationScope({ ...scopeParams, target });
            const project = (registrations: readonly PluginRuntimeRegistration<'account'>[]): readonly ContributionRuntimeRegistration[] => (
                registrations.map(registration => registration.family === 'connectedAccountDescriptors'
                    ? Object.freeze({ ...registration, realm: 'account' as const }) : registration)
            );
            return { ...accountScope, commit: () => project(accountScope.commit()),
                registrations: () => project(accountScope.registrations()) };
        })()
        : createPluginRegistrationScope({ ...scopeParams, target: { realm: 'daemon' } });
    return Object.freeze({
        api: scope.api,
        commit: scope.commit,
        registrations: scope.registrations,
        diagnostics() {
            return Object.freeze([...diagnostics]);
        },
        dispose: scope.dispose,
    });
}
