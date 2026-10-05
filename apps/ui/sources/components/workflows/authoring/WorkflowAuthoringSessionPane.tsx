import * as React from 'react';
import { View } from 'react-native';
import type { SessionInPaneProps } from '@/components/sessions/panes/SessionInPane';

const SessionInPane = React.lazy(() => import('@/components/sessions/panes/SessionInPane').then((module) => ({ default: module.SessionInPane })));

/** Hidden Agent tabs mount neither the Session graph nor its transcript/composer subscriptions. */
export function WorkflowAuthoringSessionPane(props: SessionInPaneProps) {
    if (!props.active) return <View testID={`session-in-pane-inactive:${props.sessionId}`} style={{ flex: 1 }} />;
    return <React.Suspense fallback={null}><SessionInPane {...props} /></React.Suspense>;
}
