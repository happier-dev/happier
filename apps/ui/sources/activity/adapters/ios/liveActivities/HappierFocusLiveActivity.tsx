import { createLiveActivity, type LiveActivityComponent } from 'expo-widgets';
import * as React from 'react';
import { HStack, Image, Text, VStack } from '@expo/ui/swift-ui';
import { font, padding } from '@expo/ui/swift-ui/modifiers';

import {
    renderActivitySurfaceOpenInboxButton,
    renderActivitySurfaceOpenPrimaryButton,
    renderActivitySurfaceOverflowBadge,
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
    const detailLines = resolveActivitySurfaceDetailLines(props, {
        maxLines: 2,
    });

    return {
        banner: (
            <VStack modifiers={[padding({ all: 12 })]} spacing={8}>
                <HStack spacing={8}>
                    <Text modifiers={[font({ weight: 'bold', size: 16 })]}>
                        {props.labels.title}
                    </Text>
                    {renderActivitySurfaceOverflowBadge(props.overflowCount)}
                </HStack>
                <Text modifiers={[font({ weight: 'semibold', size: 15 })]}>
                    {props.title}
                </Text>
                {detailLines.map((line) => (
                    <Text key={line} modifiers={[font({ size: 12 })]}>
                        {line}
                    </Text>
                ))}
            </VStack>
        ),
        compactLeading: <Image systemName={attentionSymbol} />,
        compactTrailing: <Text modifiers={[font({ weight: 'semibold', size: 12 })]}>{compactLabel}</Text>,
        minimal: <Image systemName={attentionSymbol} />,
        expandedLeading: (
            <VStack modifiers={[padding({ all: 12 })]} spacing={8}>
                <Text modifiers={[font({ weight: 'semibold', size: 15 })]}>
                    {props.title}
                </Text>
                {detailLines.map((line) => (
                    <Text key={line} modifiers={[font({ size: 12 })]}>
                        {line}
                    </Text>
                ))}
            </VStack>
        ),
        expandedTrailing: (
            <VStack modifiers={[padding({ all: 12 })]} spacing={8}>
                <Text modifiers={[font({ weight: 'bold', size: 18 })]}>
                    {props.totalAttentionCount}
                </Text>
                <Text modifiers={[font({ size: 12 })]}>
                    {props.labels.attentionLabel}
                </Text>
            </VStack>
        ),
        expandedBottom: props.allowActionButtons
            ? (
                <HStack modifiers={[padding({ all: 12 })]} spacing={8}>
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
