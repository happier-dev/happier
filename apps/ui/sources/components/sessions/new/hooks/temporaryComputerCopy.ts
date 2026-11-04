import { t } from '@/text';

import type { TemporaryComputerLaunchBlock } from './temporaryComputerLaunchReadiness';
import type { TemporaryComputerAvailability } from './useTemporaryComputerAvailability';

/**
 * The one place a Temporary-computer destination or launch problem becomes copy.
 *
 * Both pickers and the launch surface read it, so a user who is told "choose a
 * Team model" in the picker is told the same thing by the blocked Send, instead
 * of two surfaces inventing two different explanations for one fact.
 */
export function describeTemporaryComputerUnavailability(
    availability: TemporaryComputerAvailability,
): string | null {
    if (availability.status === 'available') return null;
    if (availability.status === 'loading') return t('newSession.temporaryComputer.unavailable.loading');
    if (availability.publicationFailure?.reason === 'rate_limited') {
        const resetAtMs = availability.publicationFailure.resetAtMs;
        return resetAtMs == null
            ? t('newSession.temporaryComputer.unavailable.rateLimited')
            : t('newSession.temporaryComputer.unavailable.rateLimitedUntil', {
                time: new Date(resetAtMs).toLocaleString(),
            });
    }
    switch (availability.reason) {
        case 'automation_unsupported':
            return t('newSession.temporaryComputer.unavailable.automation');
        case 'feature_disabled':
        case 'home_unavailable':
        case 'home_identity_unavailable':
        case 'account_scope_unavailable':
            return t('newSession.temporaryComputer.unavailable.notAvailable');
        case 'artifact_unavailable':
            return t('newSession.temporaryComputer.unavailable.notPublished');
        default:
            // A transport or protocol failure is not proof that no package
            // exists, so it reads as "could not check", never "not published".
            return t('newSession.temporaryComputer.unavailable.unreachable');
    }
}

export function describeTemporaryComputerLaunchBlock(block: TemporaryComputerLaunchBlock): string {
    switch (block) {
        case 'agent_managed_install_undeclared':
            return t('newSession.temporaryComputer.blocked.agentUnsupported');
        case 'agent_plugin_distribution_unacquirable':
            return t('newSession.temporaryComputer.blocked.pluginUnacquirable');
        case 'team_credential_model_unselected':
            return t('newSession.temporaryComputer.blocked.modelUnselected');
        case 'team_credential_resource_unavailable':
            return t('newSession.temporaryComputer.blocked.modelUnavailable');
        case 'broker_selection_unavailable':
            return t('newSession.temporaryComputer.blocked.brokerUnavailable');
        case 'authoring_connectedServices_unsupported':
            return `${t('connectedServices.title')}: ${t('newSession.connectedServicesReasonNotPortable')}`;
        case 'authoring_transcriptStorage_unsupported':
            return `${t('settingsSession.defaultStorage.title')}: ${t('newSession.mcpReasonNotPortable')}`;
        case 'authoring_environmentVariables_unsupported':
            return `${t('profiles.environmentVariables.title')}: ${t('newSession.profileReasonNotPortable')}`;
        case 'authoring_windowsRemoteSessionLaunchMode_unsupported':
        case 'authoring_windowsRemoteSessionConsole_unsupported':
            return `${t('machine.windows.remoteSessionModeTitle')}: ${t('newSession.mcpReasonNotPortable')}`;
        case 'authoring_windowsTerminalWindowName_unsupported':
            return `${t('settingsSession.windows.windowNameTitle')}: ${t('newSession.mcpReasonNotPortable')}`;
        case 'authoring_runtimeDescriptorV1_unsupported':
            return `${t('settingsSession.advanced.title')}: ${t('newSession.mcpReasonNotPortable')}`;
        case 'authoring_automation_unsupported':
            return `${t('newSession.automationChip.default')}: ${t('newSession.temporaryComputer.unavailable.automation')}`;
    }
}
