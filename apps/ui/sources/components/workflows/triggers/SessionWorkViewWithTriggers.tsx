import * as React from 'react';

import { SessionWorkView } from '@/components/sessions/work/SessionWorkView';

import { SessionTriggersSection } from './SessionTriggersSection';
import { SessionWritesHereSection } from './SessionWritesHereSection';

/**
 * The one Work tab host with this session's Triggers section in ORC's `triggersSection` slot. The
 * desktop pane (`SessionRightPanel`) and the phone Work surface (`SessionCockpitSurfaceScreen`) both
 * mount it, so the section is filled once for every layout. The slot element changes only with the
 * session, so trigger updates re-render the section, not the Work tab.
 */
export const SessionWorkViewWithTriggers = React.memo(function SessionWorkViewWithTriggers(
    props: Omit<React.ComponentProps<typeof SessionWorkView>, 'triggersSection'>,
) {
    const triggersSection = React.useMemo(() => <>
        <SessionTriggersSection sessionId={props.sessionId} serverId={props.serverId} />
        <SessionWritesHereSection sessionId={props.sessionId} serverId={props.serverId} />
    </>, [props.sessionId, props.serverId]);
    return <SessionWorkView {...props} triggersSection={triggersSection} />;
});
