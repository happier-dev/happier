import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import * as React from 'react';
import { VStack } from '@expo/ui/swift-ui';
import { padding } from '@expo/ui/swift-ui/modifiers';

import type { ActivitySurfaceSnapshot } from './activitySurfaceSnapshot';
import {
    renderActivitySurfaceCounts,
    renderActivitySurfaceHeader,
    renderActivitySurfaceOpenInboxButton,
    renderActivitySurfaceOpenPrimaryButton,
    renderActivitySurfaceSessionCard,
    resolveActivitySurfaceSessionLimit,
} from './activitySurfacePresentation';
import { ACTIVITY_SURFACE_TARGETS } from './activitySurfaceRouting';

function HappierFocusWidgetComponent(props: ActivitySurfaceSnapshot, environment: WidgetEnvironment): React.ReactElement {
    'widget';

    const limit = resolveActivitySurfaceSessionLimit('focus', environment.widgetFamily);
    const additionalSessions = props.sessions.slice(1, limit);

    return (
        <VStack modifiers={[padding({ all: 8 })]} spacing={8}>
            {renderActivitySurfaceHeader(props, props.labels.focusTitle)}
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
