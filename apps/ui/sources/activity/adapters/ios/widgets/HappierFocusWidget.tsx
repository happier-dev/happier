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
import { ACTIVITY_SURFACE_TARGETS } from '@/activity/actions/activitySurfaceTargets';
import type { ActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';

export function HappierFocusWidgetComponent(props: ActivitySurfaceSnapshot, environment: WidgetEnvironment): React.ReactElement {
    'widget';

    const isSmallFamily = String(environment.widgetFamily) === 'systemSmall';
    const limit = resolveActivitySurfaceSessionLimit('focus', environment.widgetFamily);
    const additionalSessions = props.sessions.slice(1, limit);
    const visibleSessionCount = props.primary
        ? 1 + additionalSessions.length
        : 0;
    const overflowCount = Math.max(props.sessions.length - visibleSessionCount, 0);

    return (
        <VStack modifiers={[padding({ all: 6 })]} spacing={8}>
            {renderActivitySurfaceHeader(props, props.labels.focusTitle, {
                overflowCount,
            })}
            {props.primary ? (
                <>
                    {renderActivitySurfaceHeroCard(props.primary, {
                        actionTarget: props.defaultTarget === ACTIVITY_SURFACE_TARGETS.openInbox
                            ? props.defaultTarget
                            : undefined,
                        showPreviewText: !isSmallFamily,
                    })}
                    {isSmallFamily
                        ? null
                        : renderActivitySurfaceSessionStrip(additionalSessions, {
                            showPreviewText: environment.widgetFamily === 'systemLarge',
                            showStatus: !isSmallFamily,
                            showSubtitle: false,
                        })}
                </>
            ) : (
                renderActivitySurfaceOpenInboxButton(props.labels.inboxLabel)
            )}
            {renderActivitySurfaceCounts(props)}
        </VStack>
    );
}

export default createWidget('HappierFocusWidget', HappierFocusWidgetComponent);
