import * as React from 'react';
import { Platform } from 'react-native';

import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { selectAllHomes } from '@/sync/domains/server/selection/homeViewSelectionState';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { useUsableHomeServerIds } from '@/sync/domains/scope/usableHomeServerIds';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { offerThisComputerConnectionToHome } from '@/components/serverProfiles/offerThisComputerConnectionToHome';

import {
    resolveAddHomePaths,
    shouldFocusConnectedHome,
    transitionAddHomePane,
    type AddHomeAvailabilityInput,
    type AddHomePane,
    type AddHomePath,
} from './addHomeFlowModel';

export type AddHomeConnectedResult = Readonly<{
    kind: 'focused' | 'connected';
    profile: ServerProfile;
}>;

/** One path, handover, and post-sign-in focus decision for every Add a Home presentation. */
export function useAddHomeFlow(input: AddHomeAvailabilityInput & Readonly<{
    initialPath: AddHomePath;
    initialAddress?: string;
}>) {
    const [pane, setPane] = React.useState<AddHomePane>(() => (
        input.initialPath === 'direct' || input.initialPath === 'other_service'
            ? { pane: input.initialPath, initialAddress: input.initialAddress }
            : { pane: input.initialPath }
    ));
    const [completion, setCompletion] = React.useState<AddHomeConnectedResult | null>(null);
    const paths = React.useMemo(() => resolveAddHomePaths(input), [
        input.serviceStatus,
        input.serviceHostsHome,
        input.canSetUpServerHome,
    ]);
    // Capture the answer at entry. An unknown projection must not become an accidental first-Home
    // decision after authentication adds a credential and updates that projection.
    const usableHomesAtEntry = React.useRef(useUsableHomeServerIds()).current;
    const shouldFocusNewHome = shouldFocusConnectedHome(usableHomesAtEntry);

    const choosePath = React.useCallback((path: AddHomePath) => {
        setCompletion(null);
        setPane((current) => transitionAddHomePane(current, { kind: 'choose_path', path }));
    }, []);
    const connectAsHome = React.useCallback((address: string) => {
        setCompletion(null);
        setPane((current) => transitionAddHomePane(current, { kind: 'connect_as_home', address }));
    }, []);
    const homeConnected = React.useCallback((profile: ServerProfile) => {
        setCompletion(null);
        setPane((current) => transitionAddHomePane(current, { kind: 'home_connected', profile }));
    }, []);
    const back = React.useCallback(() => {
        setCompletion(null);
        setPane((current) => transitionAddHomePane(current, { kind: 'back' }));
    }, []);
    const onConnected = React.useCallback(async (profile: ServerProfile): Promise<AddHomeConnectedResult> => {
        await offerThisComputerConnectionToHome(profile);
        if (shouldFocusNewHome) {
            try {
                const switched = await setActiveServerAndSwitch({
                    serverId: profile.id,
                    scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                });
                if (switched !== 'blocked') {
                    const result = { kind: 'focused', profile } as const;
                    setCompletion(result);
                    return result;
                }
            } catch {
                // The Home was saved and authenticated; keep the explicit Open action available.
            }
        }
        const result = { kind: 'connected', profile } as const;
        setCompletion(result);
        return result;
    }, [shouldFocusNewHome]);
    const openConnectedHome = React.useCallback(async (profile: ServerProfile) => {
        const switched = await setActiveServerAndSwitch({
            serverId: profile.id,
            scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
        });
        if (switched !== 'blocked') await offerThisComputerConnectionToHome(profile);
        return switched;
    }, []);
    const showAllHomes = React.useCallback(async () => {
        await selectAllHomes({ scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()) });
    }, []);

    return { pane, paths, completion, shouldFocusNewHome, choosePath, connectAsHome, homeConnected, back, onConnected, openConnectedHome, showAllHomes };
}
