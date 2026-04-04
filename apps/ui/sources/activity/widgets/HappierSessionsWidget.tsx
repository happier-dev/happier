import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import * as React from 'react';
import { VStack } from '@expo/ui/swift-ui';
import { padding } from '@expo/ui/swift-ui/modifiers';

import type { ActivitySurfaceSnapshot } from './activitySurfaceSnapshot';
import {
    renderActivitySurfaceCounts,
    renderActivitySurfaceHeader,
    renderActivitySurfaceOpenInboxButton,
    renderActivitySurfaceSessionCard,
    resolveActivitySurfaceSessionLimit,
} from './activitySurfacePresentation';

function HappierSessionsWidgetComponent(props: ActivitySurfaceSnapshot, environment: WidgetEnvironment): React.ReactElement {
    'widget';

    const limit = resolveActivitySurfaceSessionLimit('sessions', environment.widgetFamily);
    const sessions = props.sessions.slice(0, limit);

    return (
        <VStack modifiers={[padding({ all: 8 })]} spacing={8}>
            {renderActivitySurfaceHeader(props, props.labels.sessionsTitle)}
            {sessions.length > 0 ? sessions.map((session) => (
                <React.Fragment key={session.sessionId}>
                    {renderActivitySurfaceSessionCard(session, {
                        showSubtitle: environment.widgetFamily !== 'systemSmall',
                        showStatus: environment.widgetFamily !== 'systemSmall',
                    })}
                </React.Fragment>
            )) : renderActivitySurfaceOpenInboxButton(props.labels.inboxLabel)}
            {renderActivitySurfaceCounts(props)}
        </VStack>
    );
}

export default createWidget('HappierSessionsWidget', HappierSessionsWidgetComponent);
