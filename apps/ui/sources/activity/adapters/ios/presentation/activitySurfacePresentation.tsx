import * as React from 'react';
import { PlatformColor } from 'react-native';

import { Button, HStack, Image, Text, VStack } from '@expo/ui/swift-ui';
import {
    background,
    border,
    buttonStyle,
    clipShape,
    font,
    foregroundStyle,
    lineLimit,
    padding,
    shadow,
    shapes,
    type BuiltInModifier,
} from '@expo/ui/swift-ui/modifiers';
import type { SFSymbol } from 'sf-symbols-typescript';

import { ACTIVITY_SURFACE_TARGETS, createActivitySurfaceSessionTarget } from '@/activity/actions/activitySurfaceTargets';
import type { ActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';

export type ActivitySurfaceWidgetPreset = 'focus' | 'sessions';

const panelBackgroundColor = PlatformColor('secondarySystemBackground');
const panelElevatedBackgroundColor = PlatformColor('tertiarySystemBackground');
const panelBorderColor = PlatformColor('separator');
const panelShadowColor = PlatformColor('black');

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

export function isActivitySurfaceUrgentAttentionState(
    attentionState: ActivitySurfaceSessionViewModel['attentionState'],
): boolean {
    return attentionState === 'permission_required' || attentionState === 'action_required';
}

export function resolveActivitySurfaceAttentionSymbol(
    attentionState: ActivitySurfaceSessionViewModel['attentionState'],
): SFSymbol {
    switch (attentionState) {
        case 'permission_required':
            return 'hand.raised.fill';
        case 'action_required':
            return 'exclamationmark.bubble.fill';
        case 'thinking':
            return Math.floor(Date.now() / 1_000) % 2 === 0 ? 'sparkles' : 'sparkles.rectangle.stack.fill';
        case 'pending':
            return 'clock.badge.exclamationmark';
        case 'unread':
            return 'tray.full.fill';
        case 'quiet':
        default:
            return 'circle.dotted';
    }
}

export function resolveActivitySurfaceAttentionTintName(
    attentionState: ActivitySurfaceSessionViewModel['attentionState'],
): string {
    switch (attentionState) {
        case 'permission_required':
            return 'systemRed';
        case 'action_required':
            return 'systemOrange';
        case 'thinking':
            return 'systemBlue';
        case 'pending':
            return 'systemYellow';
        case 'unread':
            return 'systemIndigo';
        case 'quiet':
        default:
            return 'secondaryLabel';
    }
}

export function buildActivitySurfaceAttentionIconModifiers(
    attentionState: ActivitySurfaceSessionViewModel['attentionState'],
): BuiltInModifier[] {
    return [
        foregroundStyle(PlatformColor(resolveActivitySurfaceAttentionTintName(attentionState))),
    ];
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
        prioritizeStatusText?: boolean;
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

    const prioritizeStatusText = options.prioritizeStatusText ?? false;
    if (options.showStatus !== false) {
        if (prioritizeStatusText) {
            maybePush(session.statusText);
        }
    }
    if (options.showPreviewText !== false) {
        maybePush(session.previewText);
    }
    if (options.showStatus !== false && !prioritizeStatusText) {
        maybePush(session.statusText);
    }
    if (options.showSubtitle !== false) {
        maybePush(session.subtitle);
    }

    const maxLines = options.maxLines ?? lines.length;
    return lines.slice(0, maxLines);
}

export function resolveActivitySurfaceSessionCardButtonStyle(
    _attentionState?: ActivitySurfaceSessionViewModel['attentionState'],
): 'plain' {
    return 'plain';
}

function buildPanelModifiers(params: Readonly<{
    elevated?: boolean;
    paddingAll?: number;
    radius?: number;
}>): BuiltInModifier[] {
    const elevated = params.elevated ?? false;
    const radius = params.radius ?? (elevated ? 18 : 22);

    return [
        padding({ all: params.paddingAll ?? 10 }),
        background(
            elevated ? panelElevatedBackgroundColor : panelBackgroundColor,
            shapes.roundedRectangle({
                cornerRadius: radius,
                roundedCornerStyle: 'continuous',
            }),
        ),
        border({ color: panelBorderColor, width: 1 }),
        clipShape('roundedRectangle', radius),
        shadow({
            radius: elevated ? 8 : 12,
            y: elevated ? 4 : 6,
            color: panelShadowColor,
        }),
    ];
}

function renderActivitySurfaceBadge(label: string): React.ReactElement {
    return (
        <Text
            modifiers={[
                font({ weight: 'semibold', design: 'rounded', size: 11 }),
                padding({ horizontal: 8, vertical: 4 }),
                background(panelElevatedBackgroundColor, shapes.capsule()),
                border({ color: panelBorderColor, width: 1 }),
                clipShape('capsule'),
                foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
            ]}
        >
            {label}
        </Text>
    );
}

function renderActivitySurfaceActionChip(
    label: string,
    target: string,
): React.ReactElement {
    return (
        <Button target={target} modifiers={[buttonStyle('plain')]}>
            <Text
                modifiers={[
                    font({ weight: 'semibold', design: 'rounded', size: 12 }),
                    padding({ horizontal: 10, vertical: 6 }),
                    background(panelElevatedBackgroundColor, shapes.capsule()),
                    border({ color: panelBorderColor, width: 1 }),
                    clipShape('capsule'),
                ]}
            >
                {label}
            </Text>
        </Button>
    );
}

export function renderActivitySurfaceOverflowBadge(
    overflowCount: number,
): React.ReactElement | null {
    if (overflowCount <= 0) {
        return null;
    }

    return renderActivitySurfaceBadge(`+${overflowCount}`);
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
            prioritizeStatusText: isActivitySurfaceUrgentAttentionState(primary.attentionState),
            maxLines: 2,
        })
        : [];

    return (
        <VStack modifiers={buildPanelModifiers({ paddingAll: 12, radius: 22 })} spacing={8}>
            <HStack spacing={6}>
                <Text modifiers={[font({ weight: 'semibold', design: 'rounded', size: 11 }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
                    {presetLabel}
                </Text>
                {renderActivitySurfaceOverflowBadge(options.overflowCount ?? 0)}
            </HStack>
            {primary ? (
                <>
                    <HStack spacing={8}>
                        <Image
                            systemName={resolveActivitySurfaceAttentionSymbol(primary.attentionState)}
                            modifiers={buildActivitySurfaceAttentionIconModifiers(primary.attentionState)}
                        />
                        <Text modifiers={[font({ weight: 'semibold', design: 'rounded', size: 15 }), lineLimit(1)]}>
                            {primary.title}
                        </Text>
                    </HStack>
                    {detailLines.map((line) => (
                        <Text
                            key={line}
                            modifiers={[
                                font({ size: 12 }),
                                lineLimit(1),
                                foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
                            ]}
                        >
                            {line}
                        </Text>
                    ))}
                </>
            ) : (
                <Text modifiers={[font({ size: 12 }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
                    {snapshot.labels.emptyTitle}
                </Text>
            )}
        </VStack>
    );
}

export function renderActivitySurfaceCounts(snapshot: ActivitySurfaceSnapshot): React.ReactElement {
    return (
        <HStack spacing={6}>
            {renderActivitySurfaceBadge(`${snapshot.labels.attentionLabel} ${snapshot.summaryCounts.attentionCount}`)}
            {renderActivitySurfaceBadge(`${snapshot.labels.runningLabel} ${snapshot.summaryCounts.runningCount}`)}
            {renderActivitySurfaceBadge(`${snapshot.labels.permissionLabel} ${snapshot.summaryCounts.permissionCount}`)}
        </HStack>
    );
}

export function renderActivitySurfaceSessionCard(
    session: ActivitySurfaceSessionViewModel,
    options: Readonly<{
        showSubtitle?: boolean;
        showStatus?: boolean;
        showPreviewText?: boolean;
        actionTarget?: string;
        elevated?: boolean;
        paddingAll?: number;
    }> = {},
): React.ReactElement {
    const actionTarget = options.actionTarget ?? createActivitySurfaceSessionTarget(session.sessionId, session.serverId);
    const prioritizeStatusText = isActivitySurfaceUrgentAttentionState(session.attentionState);
    const detailLines = resolveActivitySurfaceDetailLines(session, {
        prioritizeStatusText,
        showPreviewText: options.showPreviewText,
        showStatus: options.showStatus,
        showSubtitle: options.showSubtitle,
        maxLines: 2,
    });

    return (
        <Button target={actionTarget} modifiers={[buttonStyle(resolveActivitySurfaceSessionCardButtonStyle())]}>
            <VStack
                modifiers={buildPanelModifiers({
                    elevated: options.elevated ?? true,
                    paddingAll: options.paddingAll ?? 10,
                    radius: options.elevated === false ? 22 : 18,
                })}
                spacing={6}
            >
                <HStack spacing={8}>
                    <Image
                        systemName={resolveActivitySurfaceAttentionSymbol(session.attentionState)}
                        modifiers={buildActivitySurfaceAttentionIconModifiers(session.attentionState)}
                    />
                    <VStack spacing={2}>
                        <Text modifiers={[font({ weight: 'semibold', design: 'rounded', size: 14 }), lineLimit(1)]}>
                            {session.title}
                        </Text>
                        {detailLines.map((line) => (
                            <Text
                                key={line}
                                modifiers={[
                                    font({ size: 12 }),
                                    lineLimit(1),
                                    foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
                                ]}
                            >
                                {line}
                            </Text>
                        ))}
                    </VStack>
                </HStack>
            </VStack>
        </Button>
    );
}

export function renderActivitySurfaceHeroCard(
    session: ActivitySurfaceSessionViewModel,
    options: Readonly<{
        actionTarget?: string;
        showPreviewText?: boolean;
        showStatus?: boolean;
        showSubtitle?: boolean;
    }> = {},
): React.ReactElement {
    return renderActivitySurfaceSessionCard(session, {
        actionTarget: options.actionTarget,
        elevated: false,
        paddingAll: 12,
        showPreviewText: options.showPreviewText,
        showStatus: options.showStatus ?? true,
        showSubtitle: options.showSubtitle ?? false,
    });
}

export function renderActivitySurfaceSessionStrip(
    sessions: readonly ActivitySurfaceSessionViewModel[],
    options: Readonly<{
        showPreviewText?: boolean;
        showStatus?: boolean;
        showSubtitle?: boolean;
    }> = {},
): React.ReactElement | null {
    if (sessions.length === 0) {
        return null;
    }

    return (
        <VStack spacing={6}>
            {sessions.map((session) => (
                <React.Fragment key={session.sessionId}>
                    {renderActivitySurfaceSessionCard(session, {
                        showPreviewText: options.showPreviewText,
                        showStatus: options.showStatus,
                        showSubtitle: options.showSubtitle,
                    })}
                </React.Fragment>
            ))}
        </VStack>
    );
}

export function renderActivitySurfaceOpenPrimaryButton(
    label: string,
    target: string = ACTIVITY_SURFACE_TARGETS.openPrimarySession,
): React.ReactElement {
    return renderActivitySurfaceActionChip(label, target);
}

export function renderActivitySurfaceOpenInboxButton(
    label: string,
    target: string = ACTIVITY_SURFACE_TARGETS.openInbox,
): React.ReactElement {
    return renderActivitySurfaceActionChip(label, target);
}

export function renderActivitySurfaceAttentionCountBadge(
    value: number,
    label: string,
): React.ReactElement {
    return (
        <VStack modifiers={buildPanelModifiers({ elevated: true, paddingAll: 10, radius: 18 })} spacing={2}>
            <Text modifiers={[font({ weight: 'bold', design: 'rounded', size: 18 })]}>
                {value}
            </Text>
            <Text modifiers={[font({ weight: 'semibold', design: 'rounded', size: 11 }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
                {label}
            </Text>
        </VStack>
    );
}

export function renderActivitySurfacePrimarySummary(
    title: string,
    detailLines: readonly string[],
): React.ReactElement {
    return (
        <VStack modifiers={buildPanelModifiers({ paddingAll: 12, radius: 22 })} spacing={6}>
            <Text modifiers={[font({ weight: 'semibold', design: 'rounded', size: 15 }), lineLimit(1)]}>
                {title}
            </Text>
            {detailLines.map((line) => (
                <Text
                    key={line}
                    modifiers={[
                        font({ size: 12 }),
                        lineLimit(1),
                        foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
                    ]}
                >
                    {line}
                </Text>
            ))}
        </VStack>
    );
}
