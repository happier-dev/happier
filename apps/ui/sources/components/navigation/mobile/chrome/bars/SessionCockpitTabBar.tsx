import * as React from 'react';

import { t } from '@/text';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useSessionLateralSwipe } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

import { SessionCockpitLateralReadout } from '../lateralSwipe/SessionCockpitLateralReadout';
import { useSessionCockpitLateralNavigation } from '../lateralSwipe/useSessionCockpitLateralNavigation';
import { CockpitTabBar } from './CockpitTabBar';
import { useSessionCockpitTabDefinitions } from './useSessionCockpitTabDefinitions';

type SessionCockpitTabBarProps = Readonly<{
    sessionId: string;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    openDetailsTabCount: number;
    onSurfacePress: (surface: SessionMobileSurface) => void;
}>;

const PREVIOUS_SESSION_ACTION = 'previousSession';
const NEXT_SESSION_ACTION = 'nextSession';

export const SessionCockpitTabBar = React.memo((props: SessionCockpitTabBarProps) => {
    const lateralSwipe = useSessionLateralSwipe();
    // The band's actions are built HERE rather than in the chrome host because a tab is
    // the only element in the band a screen reader can focus, and an action only reaches
    // the rotor through the element that owns it.
    const lateralNavigation = useSessionCockpitLateralNavigation({ sessionId: props.sessionId });
    const bandAccessibilityActions = React.useMemo(() => {
        const actions: Array<{ name: string; label: string }> = [];
        if (lateralNavigation.previous) {
            actions.push({ name: PREVIOUS_SESSION_ACTION, label: t('workspaceCockpit.previousSession') });
        }
        if (lateralNavigation.next) {
            actions.push({ name: NEXT_SESSION_ACTION, label: t('workspaceCockpit.nextSession') });
        }
        return actions.length > 0 ? actions : undefined;
    }, [lateralNavigation.next, lateralNavigation.previous]);
    const handleBandAccessibilityAction = React.useCallback((actionName: string) => {
        if (actionName === PREVIOUS_SESSION_ACTION) lateralNavigation.navigate('previous');
        else if (actionName === NEXT_SESSION_ACTION) lateralNavigation.navigate('next');
    }, [lateralNavigation]);
    const tabs = useSessionCockpitTabDefinitions(props);

    return (
        <CockpitTabBar
            activeSurface={props.activeSurface}
            barTestId={`session-cockpit-tabbar-${props.sessionId}`}
            tabs={tabs}
            tabTestIdPrefix="session-cockpit-tab-"
            onSurfacePress={props.onSurfacePress}
            bandAccessibilityActions={bandAccessibilityActions}
            onBandAccessibilityAction={bandAccessibilityActions ? handleBandAccessibilityAction : undefined}
            swipeReadout={{
                progress: lateralSwipe.progress,
                browseProgress: lateralSwipe.picker.browseProgress,
                node: <SessionCockpitLateralReadout sessionId={props.sessionId} />,
            }}
        />
    );
});
