import type { NewSessionPresentationModeV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';

type PlatformOs = string;
export type NewSessionRoutePresentation = 'containedModal' | 'modal' | undefined;
export type NewSessionSecretRequirementRoutePresentation = 'containedTransparentModal' | 'modal' | undefined;

export function resolveNewSessionRoutePresentation(params: Readonly<{
    mode: NewSessionPresentationModeV1 | null | undefined;
    platformOs: PlatformOs;
}>): NewSessionRoutePresentation {
    if (params.mode === 'screen') return undefined;
    if (params.mode === 'modal') {
        return params.platformOs === 'ios' ? 'containedModal' : 'modal';
    }
    return params.platformOs === 'ios' ? 'containedModal' : 'modal';
}

export function resolveNewSessionShouldBottomAnchor(params: Readonly<{
    mode: NewSessionPresentationModeV1 | null | undefined;
    platformOs: PlatformOs;
    isMobileLayoutWidth: boolean;
}>): boolean {
    if (params.isMobileLayoutWidth) return true;
    return resolveNewSessionRoutePresentation({
        mode: params.mode,
        platformOs: params.platformOs,
    }) === undefined;
}

export function resolveNewSessionPickerRoutePresentation(params: Readonly<{
    mode: NewSessionPresentationModeV1 | null | undefined;
    platformOs: PlatformOs;
}>): NewSessionRoutePresentation {
    return resolveNewSessionRoutePresentation(params);
}

export function resolveNewSessionSecretRequirementRoutePresentation(params: Readonly<{
    mode: NewSessionPresentationModeV1 | null | undefined;
    platformOs: PlatformOs;
}>): NewSessionSecretRequirementRoutePresentation {
    if (params.mode === 'screen') return undefined;
    return params.platformOs === 'ios' ? 'containedTransparentModal' : 'modal';
}
