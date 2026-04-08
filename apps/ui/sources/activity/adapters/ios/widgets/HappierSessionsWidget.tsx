import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import * as React from 'react';
import { VStack } from '@expo/ui/swift-ui';
import { padding } from '@expo/ui/swift-ui/modifiers';

import {
    renderActivitySurfaceCounts,
    renderActivitySurfaceHeroCard,
    renderActivitySurfaceHeader,
    renderActivitySurfaceOpenInboxButton,
    renderActivitySurfaceSessionStrip,
    resolveActivitySurfaceSessionLimit,
} from '@/activity/adapters/ios/presentation/activitySurfacePresentation';
import type { ActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';

export function HappierSessionsWidgetComponent(props: ActivitySurfaceSnapshot, environment: WidgetEnvironment): React.ReactElement {
    'widget';

    const limit = resolveActivitySurfaceSessionLimit('sessions', environment.widgetFamily);
    const sessions = props.sessions.slice(0, limit);
    const [primarySession, ...supportingSessions] = sessions;
    const overflowCount = Math.max(props.sessions.length - sessions.length, 0);

    return (
        <VStack modifiers={[padding({ all: 6 })]} spacing={8}>
            {renderActivitySurfaceHeader(props, props.labels.sessionsTitle, {
                overflowCount,
            })}
            {primarySession ? (
                <>
                    {renderActivitySurfaceHeroCard(primarySession, {
                        actionTarget: primarySession.target,
                        showPreviewText: environment.widgetFamily !== 'systemSmall',
                        showStatus: environment.widgetFamily !== 'systemSmall',
                        showSubtitle: environment.widgetFamily === 'systemLarge',
                    })}
                    {renderActivitySurfaceSessionStrip(supportingSessions, {
                        showPreviewText: environment.widgetFamily === 'systemLarge',
                        showSubtitle: environment.widgetFamily === 'systemLarge',
                        showStatus: environment.widgetFamily !== 'systemSmall',
                    })}
                </>
            ) : renderActivitySurfaceOpenInboxButton(props.labels.inboxLabel)}
            {renderActivitySurfaceCounts(props)}
        </VStack>
    );
}

export default createWidget('HappierSessionsWidget', HappierSessionsWidgetComponent);
