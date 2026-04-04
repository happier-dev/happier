import * as React from 'react';

import { Button, HStack, Image, Text, VStack } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, font, padding } from '@expo/ui/swift-ui/modifiers';
import type { SFSymbol } from 'sf-symbols-typescript';

import type { ActivitySurfaceSnapshot } from './activitySurfaceSnapshot';
import type { ActivitySurfaceSessionCard } from './buildActivitySurfaceSessionCard';
import { ACTIVITY_SURFACE_TARGETS } from './activitySurfaceRouting';

export type ActivitySurfaceWidgetPreset = 'focus' | 'sessions';
export function resolveActivitySurfaceSessionLimit(
    preset: ActivitySurfaceWidgetPreset,
    widgetFamily: string,
): number {
    if (preset === 'focus') {
        if (widgetFamily === 'systemLarge') return 3;
        if (widgetFamily === 'systemMedium') return 2;
        return 1;
    }

    if (widgetFamily === 'systemLarge') return 5;
    if (widgetFamily === 'systemMedium') return 3;
    return 2;
}

function resolveAttentionSymbol(attentionState: ActivitySurfaceSessionCard['attentionState']): SFSymbol {
    switch (attentionState) {
        case 'permission_required':
        case 'action_required':
            return 'exclamationmark.circle.fill';
        case 'thinking':
            return 'sparkles';
        case 'pending':
            return 'clock.fill';
        case 'unread':
            return 'tray.fill';
        case 'quiet':
        default:
            return 'circle.dotted';
    }
}

export function renderActivitySurfaceHeader(snapshot: ActivitySurfaceSnapshot, presetLabel: string): React.ReactElement {
    const primary = snapshot.primary;
    return (
        <VStack modifiers={[padding({ all: 12 })]} spacing={8}>
            <Text modifiers={[font({ weight: 'bold', size: 16 })]}>
                {presetLabel}
            </Text>
            {primary ? (
                <>
                    <Text modifiers={[font({ weight: 'semibold', size: 14 })]}>
                        {primary.title}
                    </Text>
                    {primary.subtitle ? (
                        <Text modifiers={[font({ size: 12 })]}>
                            {primary.subtitle}
                        </Text>
                    ) : null}
                    {primary.statusText ? (
                        <Text modifiers={[font({ size: 12 })]}>
                            {primary.statusText}
                        </Text>
                    ) : null}
                </>
            ) : (
                <Text modifiers={[font({ size: 12 })]}>
                    {snapshot.labels.emptyTitle}
                </Text>
            )}
        </VStack>
    );
}

export function renderActivitySurfaceCounts(snapshot: ActivitySurfaceSnapshot): React.ReactElement {
    return (
        <HStack modifiers={[padding({ leading: 12, trailing: 12, bottom: 12 })]} spacing={8}>
            <Text modifiers={[font({ size: 12 })]}>
                {`${snapshot.labels.attentionLabel} ${snapshot.counts.totalAttention}`}
            </Text>
            <Text modifiers={[font({ size: 12 })]}>
                {`${snapshot.labels.runningLabel} ${snapshot.counts.thinking}`}
            </Text>
            <Text modifiers={[font({ size: 12 })]}>
                {`${snapshot.labels.permissionLabel} ${snapshot.counts.permissionRequired + snapshot.counts.actionRequired}`}
            </Text>
        </HStack>
    );
}

export function renderActivitySurfaceSessionCard(
    session: ActivitySurfaceSessionCard,
    options: Readonly<{
        showSubtitle?: boolean;
        showStatus?: boolean;
        actionLabel?: string;
        actionTarget?: string;
    }> = {},
): React.ReactElement {
    const actionTarget = options.actionTarget ?? `${ACTIVITY_SURFACE_TARGETS.openSessionPrefix}${session.sessionId}`;
    return (
        <Button target={actionTarget} modifiers={[buttonStyle('bordered'), controlSize('regular')]}>
            <HStack modifiers={[padding({ all: 8 })]} spacing={8}>
                <Image systemName={resolveAttentionSymbol(session.attentionState)} />
                <VStack spacing={2}>
                    <Text modifiers={[font({ weight: 'semibold', size: 14 })]}>
                        {session.title}
                    </Text>
                    {options.showSubtitle !== false && session.subtitle ? (
                        <Text modifiers={[font({ size: 12 })]}>
                            {session.subtitle}
                        </Text>
                    ) : null}
                    {options.showStatus !== false && session.statusText ? (
                        <Text modifiers={[font({ size: 12 })]}>
                            {session.statusText}
                        </Text>
                    ) : null}
                </VStack>
            </HStack>
        </Button>
    );
}

export function renderActivitySurfaceOpenPrimaryButton(
    label: string,
    target: string = ACTIVITY_SURFACE_TARGETS.openPrimarySession,
): React.ReactElement {
    return (
        <Button
            target={target}
            modifiers={[buttonStyle('borderedProminent'), controlSize('regular')]}
        >
            <Text modifiers={[font({ weight: 'semibold', size: 13 })]}>
                {label}
            </Text>
        </Button>
    );
}

export function renderActivitySurfaceOpenInboxButton(
    label: string,
    target: string = ACTIVITY_SURFACE_TARGETS.openInbox,
): React.ReactElement {
    return (
        <Button
            target={target}
            modifiers={[buttonStyle('bordered'), controlSize('regular')]}
        >
            <Text modifiers={[font({ weight: 'semibold', size: 13 })]}>
                {label}
            </Text>
        </Button>
    );
}
