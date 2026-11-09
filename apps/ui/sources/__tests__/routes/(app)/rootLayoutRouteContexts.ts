import * as React from 'react';
import { useAuth } from '@/auth/context/AuthContext';
import { ActivityPersonalSessionMembershipProvider } from '@/activity/source/activityPersonalSessionMembership';

import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';

/** Parents normally supplied by app/_layout and SidebarNavigator to the nested app route. */
export function RootLayoutRouteContexts(props: React.PropsWithChildren): React.ReactElement {
    const { isAuthenticated } = useAuth();
    return React.createElement(MainAppTabStateProvider, null,
        React.createElement(ActivityPersonalSessionMembershipProvider, { enabled: isAuthenticated },
            React.createElement(InboxSummaryProvider, null, props.children)));
}
