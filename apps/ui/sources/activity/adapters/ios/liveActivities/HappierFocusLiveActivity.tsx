import { createLiveActivity, type LiveActivityComponent } from 'expo-widgets';
import * as React from 'react';
import { HStack, Image, Text, VStack } from '@expo/ui/swift-ui';
import { font, padding } from '@expo/ui/swift-ui/modifiers';

import {
    renderActivitySurfaceAttentionCountBadge,
    isActivitySurfaceUrgentAttentionState,
    renderActivitySurfaceOpenInboxButton,
    renderActivitySurfaceOpenPrimaryButton,
    renderActivitySurfaceOverflowBadge,
    renderActivitySurfacePrimarySummary,
    resolveActivitySurfaceAttentionSymbol,
    resolveActivitySurfaceCompactLabel,
    resolveActivitySurfaceDetailLines,
} from '@/activity/adapters/ios/presentation/activitySurfacePresentation';

import type { LiveActivitySnapshot } from './buildLiveActivitySnapshots';

export const HappierFocusLiveActivityComponent: LiveActivityComponent<LiveActivitySnapshot> = (
    props,
    _environment,
) => {
    'widget';

    const compactLabel = resolveActivitySurfaceCompactLabel({
        session: props,
        overflowCount: props.overflowCount,
    });
    const attentionSymbol = resolveActivitySurfaceAttentionSymbol(props.attentionState);
    const prioritizeStatusText = isActivitySurfaceUrgentAttentionState(props.attentionState);
    const detailLines = resolveActivitySurfaceDetailLines(props, {
        prioritizeStatusText,
        maxLines: 2,
    });

    return {
        banner: (
            <VStack modifiers={[padding({ all: 10 })]} spacing={8}>
                <HStack spacing={6}>
                    <Text modifiers={[font({ weight: 'semibold', design: 'rounded', size: 11 })]}>
                        {props.labels.title}
                    </Text>
                    {renderActivitySurfaceOverflowBadge(props.overflowCount)}
                </HStack>
                {renderActivitySurfacePrimarySummary(props.title, detailLines)}
            </VStack>
        ),
        compactLeading: <Image systemName={attentionSymbol} />,
        compactTrailing: props.overflowCount > 0
            ? renderActivitySurfaceOverflowBadge(props.overflowCount)
            : <Text modifiers={[font({ weight: 'semibold', design: 'rounded', size: 12 })]}>{compactLabel}</Text>,
        minimal: <Image systemName={attentionSymbol} />,
        expandedLeading: renderActivitySurfacePrimarySummary(props.title, detailLines),
        expandedTrailing: renderActivitySurfaceAttentionCountBadge(
            props.totalAttentionCount,
            props.labels.attentionLabel,
        ),
        expandedBottom: props.allowActionButtons
            ? (
                <HStack modifiers={[padding({ all: 10 })]} spacing={6}>
                    {renderActivitySurfaceOpenPrimaryButton(props.labels.openLabel, props.sessionTarget)}
                    {props.defaultTarget === props.sessionTarget
                        ? null
                        : renderActivitySurfaceOpenInboxButton(props.labels.inboxLabel)}
                </HStack>
            )
            : null,
    };
};

export default createLiveActivity('HappierFocusLiveActivity', HappierFocusLiveActivityComponent);
