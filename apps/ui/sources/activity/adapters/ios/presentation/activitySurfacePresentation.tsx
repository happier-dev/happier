import * as React from 'react';

import { Button, HStack, Image, Text, VStack } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, font, padding } from '@expo/ui/swift-ui/modifiers';
import type { SFSymbol } from 'sf-symbols-typescript';

import { ACTIVITY_SURFACE_TARGETS } from '@/activity/actions/activitySurfaceTargets';
import type { ActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';

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

type ActivitySurfaceRenderableSession = Pick<
    ActivitySurfaceSessionViewModel,
    'title' | 'subtitle' | 'previewText' | 'statusText' | 'attentionState'
>;

export function resolveActivitySurfaceAttentionSymbol(
    attentionState: ActivitySurfaceSessionViewModel['attentionState'],
): SFSymbol {
    switch (attentionState) {
        case 'permission_required':
            return 'hand.raised.fill';
        case 'action_required':
            return 'exclamationmark.bubble.fill';
        case 'thinking':
            return 'sparkles';
        case 'pending':
            return 'clock.badge.exclamationmark';
        case 'unread':
            return 'tray.full.fill';
        case 'quiet':
        default:
            return 'circle.dotted';
    }
}

export function resolveActivitySurfacePrimaryDetailText(
    session: ActivitySurfaceRenderableSession,
): string | null {
    return session.previewText ?? session.statusText ?? session.subtitle ?? null;
}

export function resolveActivitySurfaceCompactLabel(params: Readonly<{
    session: ActivitySurfaceRenderableSession;
    overflowCount?: number;
}>): string {
    if ((params.overflowCount ?? 0) > 0) {
        return `+${params.overflowCount}`;
    }

    return resolveActivitySurfacePrimaryDetailText(params.session) ?? params.session.title;
}

export function resolveActivitySurfaceDetailLines(
    session: ActivitySurfaceRenderableSession,
    options: Readonly<{
        showPreviewText?: boolean;
        showStatus?: boolean;
        showSubtitle?: boolean;
        maxLines?: number;
    }> = {},
): readonly string[] {
    const lines: string[] = [];
    const maybePush = (value: string | null | undefined) => {
        const trimmed = value?.trim();
        if (!trimmed) return;
        if (lines.includes(trimmed)) return;
        lines.push(trimmed);
    };

    if (options.showPreviewText !== false) {
        maybePush(session.previewText);
    }
    if (options.showStatus !== false) {
        maybePush(session.statusText);
    }
    if (options.showSubtitle !== false) {
        maybePush(session.subtitle);
    }

    const maxLines = options.maxLines ?? lines.length;
    return lines.slice(0, maxLines);
}

export function renderActivitySurfaceOverflowBadge(
    overflowCount: number,
): React.ReactElement | null {
    if (overflowCount <= 0) {
        return null;
    }

    return (
        <Text modifiers={[font({ weight: 'semibold', size: 11 })]}>
            {`+${overflowCount}`}
        </Text>
    );
}

export function renderActivitySurfaceHeader(
    snapshot: ActivitySurfaceSnapshot,
    presetLabel: string,
    options: Readonly<{
        overflowCount?: number;
    }> = {},
): React.ReactElement {
    const primary = snapshot.primary;
    const detailLines = primary
        ? resolveActivitySurfaceDetailLines(primary, {
            maxLines: 2,
        })
        : [];

    return (
        <VStack modifiers={[padding({ all: 12 })]} spacing={8}>
            <HStack spacing={8}>
                <Text modifiers={[font({ weight: 'bold', size: 16 })]}>
                    {presetLabel}
                </Text>
                {renderActivitySurfaceOverflowBadge(options.overflowCount ?? 0)}
            </HStack>
            {primary ? (
                <>
                    <HStack spacing={8}>
                        <Image systemName={resolveActivitySurfaceAttentionSymbol(primary.attentionState)} />
                        <Text modifiers={[font({ weight: 'semibold', size: 14 })]}>
                            {primary.title}
                        </Text>
                    </HStack>
                    {detailLines.map((line) => (
                        <Text key={line} modifiers={[font({ size: 12 })]}>
                            {line}
                        </Text>
                    ))}
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
                {`${snapshot.labels.attentionLabel} ${snapshot.summaryCounts.attentionCount}`}
            </Text>
            <Text modifiers={[font({ size: 12 })]}>
                {`${snapshot.labels.runningLabel} ${snapshot.summaryCounts.runningCount}`}
            </Text>
            <Text modifiers={[font({ size: 12 })]}>
                {`${snapshot.labels.permissionLabel} ${snapshot.summaryCounts.permissionCount}`}
            </Text>
        </HStack>
    );
}

export function renderActivitySurfaceSessionCard(
    session: ActivitySurfaceSessionViewModel,
    options: Readonly<{
        showSubtitle?: boolean;
        showStatus?: boolean;
        actionLabel?: string;
        actionTarget?: string;
    }> = {},
): React.ReactElement {
    const actionTarget = options.actionTarget ?? `${ACTIVITY_SURFACE_TARGETS.openSessionPrefix}${session.sessionId}`;
    const detailLines = resolveActivitySurfaceDetailLines(session, {
        showStatus: options.showStatus,
        showSubtitle: options.showSubtitle,
        maxLines: 2,
    });

    return (
        <Button target={actionTarget} modifiers={[buttonStyle('bordered'), controlSize('regular')]}>
            <HStack modifiers={[padding({ all: 8 })]} spacing={8}>
                <Image systemName={resolveActivitySurfaceAttentionSymbol(session.attentionState)} />
                <VStack spacing={2}>
                    <Text modifiers={[font({ weight: 'semibold', size: 14 })]}>
                        {session.title}
                    </Text>
                    {detailLines.map((line) => (
                        <Text key={line} modifiers={[font({ size: 12 })]}>
                            {line}
                        </Text>
                    ))}
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
