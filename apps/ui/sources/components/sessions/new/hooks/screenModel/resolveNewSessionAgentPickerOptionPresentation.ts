import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { t } from '@/text';

type ResolveNewSessionAgentPickerOptionPresentationParams = Readonly<{
    entry: ResolvedBackendCatalogEntry;
    profileForAgentSelection: AIBackendProfile | null;
    compatibleBackendTargetKeys: ReadonlySet<string>;
    selectable: boolean;
}>;

export type NewSessionAgentPickerOptionPresentation = Readonly<{
    subtitle?: string;
    disabled: boolean;
    muted: boolean;
}>;

export function isNewSessionAgentPickerOptionCompatibleWithSelectedProfile(params: Readonly<{
    entry: ResolvedBackendCatalogEntry;
    profileForAgentSelection: AIBackendProfile | null;
    compatibleBackendTargetKeys: ReadonlySet<string>;
}>): boolean {
    return params.profileForAgentSelection === null
        || params.compatibleBackendTargetKeys.has(params.entry.targetKey);
}

export function resolveNewSessionAgentPickerOptionPresentation(
    params: ResolveNewSessionAgentPickerOptionPresentationParams,
): NewSessionAgentPickerOptionPresentation {
    const isCompatibleWithSelectedProfile = isNewSessionAgentPickerOptionCompatibleWithSelectedProfile({
        entry: params.entry,
        profileForAgentSelection: params.profileForAgentSelection,
        compatibleBackendTargetKeys: params.compatibleBackendTargetKeys,
    });

    const disabled = !isCompatibleWithSelectedProfile;

    return {
        subtitle: disabled ? t('newSession.aiBackendNotCompatibleWithSelectedProfile') : undefined,
        disabled,
        muted: disabled || !params.selectable,
    };
}
