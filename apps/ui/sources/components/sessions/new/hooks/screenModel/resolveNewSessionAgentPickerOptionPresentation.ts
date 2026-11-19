import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import type { NewSessionProfileAvailabilityReason } from '@/components/sessions/new/modules/newSessionAgentSelection';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { t } from '@/text';

type ResolveNewSessionAgentPickerOptionPresentationParams = Readonly<{
    entry: ResolvedBackendCatalogEntry;
    profileForAgentSelection: AIBackendProfile | null;
    compatibleBackendTargetKeys: ReadonlySet<string>;
    selectable: boolean;
    unavailabilityReason?: NewSessionProfileAvailabilityReason | null;
}>;

export type NewSessionAgentPickerOptionPresentation = Readonly<{
    subtitle?: string;
    disabled: boolean;
    muted: boolean;
}>;

function resolveBackendUnavailableSubtitle(
    reason: NewSessionProfileAvailabilityReason | null | undefined,
): string | undefined {
    if (reason === 'plugin_limited_to_other_projects') return t('newSession.pluginLimitedToOtherProjects');

    if (reason?.startsWith('cli-not-detected:')) {
        const agentId = reason.split(':')[1];
        const cli = agentId && isBundledAgentId(agentId)
            ? resolveAgentCatalogTitle(agentId)
            : agentId || t('common.unavailable');
        return t('newSession.aiBackendCliNotDetectedOnMachine', { cli });
    }

    if (reason?.startsWith('logged-out:')) {
        return t('profiles.machineLogin.status.notLoggedIn');
    }

    // Nothing is known about this Agent on the machine (unreachable or not reported yet): that is
    // one machine-wide fact the picker header states once, not a reason to repeat on every row.
    if (reason?.startsWith('agent-not-ready:')) {
        return undefined;
    }

    return t('common.unavailable');
}

export function isNewSessionAgentPickerOptionCompatibleWithSelectedProfile(params: Readonly<{
    entry: ResolvedBackendCatalogEntry;
    profileForAgentSelection: AIBackendProfile | null;
    compatibleBackendTargetKeys: ReadonlySet<string>;
}>): boolean {
    return params.profileForAgentSelection === null
        || params.compatibleBackendTargetKeys.has(params.entry.backendTargetKey);
}

export function resolveNewSessionAgentPickerOptionPresentation(
    params: ResolveNewSessionAgentPickerOptionPresentationParams,
): NewSessionAgentPickerOptionPresentation {
    const isCompatibleWithSelectedProfile = isNewSessionAgentPickerOptionCompatibleWithSelectedProfile({
        entry: params.entry,
        profileForAgentSelection: params.profileForAgentSelection,
        compatibleBackendTargetKeys: params.compatibleBackendTargetKeys,
    });

    const disabled = !isCompatibleWithSelectedProfile || !params.selectable;

    return {
        subtitle: !isCompatibleWithSelectedProfile
            ? t('newSession.aiBackendNotCompatibleWithSelectedProfile')
            : !params.selectable
                ? resolveBackendUnavailableSubtitle(params.unavailabilityReason)
                : undefined,
        disabled,
        muted: disabled || !params.selectable,
    };
}
