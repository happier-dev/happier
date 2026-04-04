import { createLiveActivity, type LiveActivityComponent } from 'expo-widgets';
import * as React from 'react';
import { HStack, Image, Text, VStack } from '@expo/ui/swift-ui';
import { font, padding } from '@expo/ui/swift-ui/modifiers';

import type { LiveActivitySnapshot } from './buildLiveActivitySnapshots';
import {
    renderActivitySurfaceOpenInboxButton,
    renderActivitySurfaceOpenPrimaryButton,
} from '../widgets/activitySurfacePresentation';

export const HappierFocusLiveActivityComponent: LiveActivityComponent<LiveActivitySnapshot> = (
    props,
    _environment,
) => {
    'widget';

    const compactLabel = props.statusText ?? props.title;

    return {
        banner: (
            <VStack modifiers={[padding({ all: 12 })]} spacing={8}>
                <Text modifiers={[font({ weight: 'bold', size: 16 })]}>
                    {props.labels.title}
                </Text>
                <Text modifiers={[font({ weight: 'semibold', size: 15 })]}>
                    {props.title}
                </Text>
                {props.subtitle ? (
                    <Text modifiers={[font({ size: 12 })]}>
                        {props.subtitle}
                    </Text>
                ) : null}
                {props.statusText ? (
                    <Text modifiers={[font({ size: 12 })]}>
                        {props.statusText}
                    </Text>
                ) : null}
            </VStack>
        ),
        compactLeading: <Image systemName="sparkles" />,
        compactTrailing: <Text modifiers={[font({ weight: 'semibold', size: 12 })]}>{compactLabel}</Text>,
        minimal: <Image systemName="sparkles" />,
        expandedLeading: (
            <VStack modifiers={[padding({ all: 12 })]} spacing={8}>
                <Text modifiers={[font({ weight: 'semibold', size: 15 })]}>
                    {props.title}
                </Text>
                {props.subtitle ? (
                    <Text modifiers={[font({ size: 12 })]}>
                        {props.subtitle}
                    </Text>
                ) : null}
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
                    {renderActivitySurfaceOpenPrimaryButton(props.labels.openLabel, props.defaultTarget)}
                    {props.defaultTarget === props.sessionTarget
                        ? null
                        : renderActivitySurfaceOpenInboxButton(props.labels.inboxLabel)}
                </HStack>
            )
            : null,
    };
};

export default createLiveActivity('HappierFocusLiveActivity', HappierFocusLiveActivityComponent);
