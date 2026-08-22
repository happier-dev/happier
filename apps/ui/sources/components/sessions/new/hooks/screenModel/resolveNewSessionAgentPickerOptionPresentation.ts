import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
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
): string {
    if (reason?.startsWith('cli-not-detected:')) {
        const agentId = reason.split(':')[1];
        const cli = agentId && isBundledAgentId(agentId)
            ? t(getAgentCore(agentId).displayNameKey)
            : agentId || t('common.unavailable');
        return t('newSession.aiBackendCliNotDetectedOnMachine', { cli });
    }

    if (reason?.startsWith('logged-out:')) {
        return t('profiles.machineLogin.status.notLoggedIn');
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
