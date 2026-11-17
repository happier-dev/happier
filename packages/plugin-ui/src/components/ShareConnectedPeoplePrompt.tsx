import * as React from 'react';
import type { ShareSheetHost } from './shareSheetHost.js';
import { useShareSheetHost } from './useShareSheetHost.js';
export const ShareConnectedPeoplePrompt = React.memo(function ShareConnectedPeoplePrompt(props: Readonly<{ testID: string; query?: string; host?: ShareSheetHost }>) {
    const host = useShareSheetHost(props.host);
    return <host.ConnectedPeoplePrompt testID={props.testID}
        title={props.query ? host.noMatchingPeople(props.query) : host.text('shareSheet.noConnectedPeople')}
        actionLabel={host.text('friends.findFriends')} />;
});
