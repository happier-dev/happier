import * as React from 'react';
import { Platform } from 'react-native';

import { RouteModalPortalScope } from '@/components/navigation/RouteModalPortalScope';
import { useSetting } from '@/sync/domains/state/storage';
import type { NewSessionPresentationModeV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import {
    resolveNewSessionPickerRoutePresentation,
    resolveNewSessionSecretRequirementRoutePresentation,
} from '@/components/sessions/new/navigation/newSessionPresentation';

export function createNewSessionContainedModalScreenOptions(params: Readonly<{
    title: string;
    headerBackTitle: string;
    headerShown?: boolean;
    presentationMode?: NewSessionPresentationModeV1 | null;
    platformOs?: string;
}>) {
    return {
        headerShown: params.headerShown ?? true,
        title: params.title,
        headerTitle: params.title,
        headerBackTitle: params.headerBackTitle,
        presentation: resolveNewSessionPickerRoutePresentation({
            mode: params.presentationMode,
            platformOs: params.platformOs ?? Platform.OS,
        }),
    } as const;
}

export function useNewSessionPickerRoutePresentation() {
    const presentationMode = useSetting('newSessionPresentationModeV1');
    return React.useMemo(() => resolveNewSessionPickerRoutePresentation({
        mode: presentationMode,
        platformOs: Platform.OS,
    }), [presentationMode]);
}

export function useNewSessionSecretRequirementRoutePresentation() {
    const presentationMode = useSetting('newSessionPresentationModeV1');
    return React.useMemo(() => resolveNewSessionSecretRequirementRoutePresentation({
        mode: presentationMode,
        platformOs: Platform.OS,
    }), [presentationMode]);
}

export function useNewSessionContainedModalScreenOptions(params: Readonly<{
    title: string;
    headerBackTitle: string;
    headerShown?: boolean;
}>) {
    const presentationMode = useSetting('newSessionPresentationModeV1');
    return React.useMemo(() => createNewSessionContainedModalScreenOptions({
        ...params,
        presentationMode,
    }), [params.headerBackTitle, params.headerShown, params.title, presentationMode]);
}

/**
 * Re-export of the canonical {@link RouteModalPortalScope} under the new-session name
 * so existing `/new` route importers keep a stable path. The portal-scope
 * implementation is shared with settings and any other modally-presented route.
 */
export const NewSessionScreenPortalScope = RouteModalPortalScope;
