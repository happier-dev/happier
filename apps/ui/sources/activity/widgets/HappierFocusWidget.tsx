import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import * as React from 'react';
import { VStack } from '@expo/ui/swift-ui';
import { padding } from '@expo/ui/swift-ui/modifiers';

import { ACTIVITY_SURFACE_TARGETS } from '@/activity/actions/activitySurfaceTargets';
import {
    renderActivitySurfaceCounts,
    renderActivitySurfaceHeader,
    renderActivitySurfaceOpenInboxButton,
    renderActivitySurfaceOpenPrimaryButton,
    renderActivitySurfaceSessionCard,
    resolveActivitySurfaceSessionLimit,
} from '@/activity/adapters/ios/presentation/activitySurfacePresentation';
import type { ActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';

function HappierFocusWidgetComponent(props: ActivitySurfaceSnapshot, environment: WidgetEnvironment): React.ReactElement {
    'widget';

    const limit = resolveActivitySurfaceSessionLimit('focus', environment.widgetFamily);
    const additionalSessions = props.sessions.slice(1, limit);
    const visibleSessionCount = props.primary
        ? 1 + additionalSessions.length
        : 0;
    const overflowCount = Math.max(props.sessions.length - visibleSessionCount, 0);

    return (
        <VStack modifiers={[padding({ all: 8 })]} spacing={8}>
            {renderActivitySurfaceHeader(props, props.labels.focusTitle, {
                overflowCount,
            })}
            {props.primary ? (
                <>
                    {renderActivitySurfaceOpenPrimaryButton(props.labels.openLabel, props.defaultTarget)}
                    {renderActivitySurfaceOpenInboxButton(props.labels.inboxLabel)}
                    {additionalSessions.length > 0 ? additionalSessions.map((session) => (
                        <React.Fragment key={session.sessionId}>
                            {renderActivitySurfaceSessionCard(session, {
                                showSubtitle: false,
                                showStatus: false,
                                actionTarget: session.target ?? ACTIVITY_SURFACE_TARGETS.openSessionPrefix + session.sessionId,
                            })}
                        </React.Fragment>
                    )) : null}
                </>
            ) : (
                renderActivitySurfaceOpenInboxButton(props.labels.inboxLabel)
            )}
            {renderActivitySurfaceCounts(props)}
        </VStack>
    );
}

export default createWidget('HappierFocusWidget', HappierFocusWidgetComponent);
