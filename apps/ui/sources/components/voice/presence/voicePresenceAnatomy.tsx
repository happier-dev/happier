import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { resolveMinimumInteractiveTargetSize, resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';

export const VOICE_TOP_BAR_PILL_HEIGHT = 28;
export const VOICE_ISLAND_DESKTOP = Object.freeze({ width: 330, height: 56, mark: 26 });
export const VOICE_ISLAND_PHONE = Object.freeze({ height: 58, mark: 28 });
export const VOICE_ORB_MARK_SIZE = 30;
export const VOICE_ORB_BODY_SIZE = Math.max(44, resolveMinimumInteractiveTargetSize(Platform.OS));
export const VOICE_ORB_CAPTION_WIDTH = 168;
export const VOICE_ORB_OPTIONS_GAP = 8;

/** Native touch areas stop at ancestor bounds; reserve either caption side without moving the mark. */
export function resolveVoiceOrbInteractionPadding(platform: string, showOptions: boolean): number {
    return platform !== 'web' && showOptions ? VOICE_ORB_OPTIONS_GAP + VOICE_ORB_CAPTION_WIDTH : 0;
}

export function resolveVoiceOrbContainerWidth(platform: string, showOptions: boolean): number {
    return VOICE_ORB_BODY_SIZE + 2 * resolveVoiceOrbInteractionPadding(platform, showOptions);
}

/** Placement-free frames shared by live containers and static settings specimens. No Voice hooks. */
export function VoiceTopBarAnatomy(props: Readonly<{
    anchorRef?: React.RefObject<View | null>; testID?: string;
    mark: React.ReactNode; label: React.ReactNode; transport: React.ReactNode;
    showDivider: boolean; overlay?: React.ReactNode;
}>) {
    return <View ref={props.anchorRef} collapsable={false} testID={props.testID}
        style={[styles.pill, { height: Math.max(VOICE_TOP_BAR_PILL_HEIGHT, resolveTouchTargetFloorPx() ?? 0) }]}>
        {props.mark}<View style={styles.pillLabel}>{props.label}</View>
        {props.showDivider ? <View style={styles.divider} /> : null}
        {props.transport}{props.overlay}
    </View>;
}

export function VoiceIslandAnatomy(props: Readonly<{
    width: number; height: number; testID?: string;
    mark: React.ReactNode; body: React.ReactNode; transport: React.ReactNode;
}>) {
    const markTarget = resolveMinimumInteractiveTargetSize(Platform.OS);
    return <GlassPanel testID={props.testID} radius={props.height / 2} shadowLevel={3}
        frameStyle={{ width: props.width, height: props.height }} style={styles.capsule}>
        <View style={[styles.islandMark, { width: markTarget, height: markTarget }]}>{props.mark}</View>
        <View style={styles.islandBody}>{props.body}</View>{props.transport}
    </GlassPanel>;
}

export function VoiceOrbAnatomy(props: Readonly<{ anchorRef?: React.RefObject<View | null>; testID?: string; width?: number; children: React.ReactNode }>) {
    return <View ref={props.anchorRef} collapsable={false} pointerEvents={Platform.OS === 'web' ? 'auto' : 'box-none'}
        style={[styles.orb, { width: props.width ?? VOICE_ORB_BODY_SIZE }]} testID={props.testID}>{props.children}</View>;
}

const styles = StyleSheet.create((theme) => ({
    pill: {
        maxWidth: '100%', minWidth: 0, flexShrink: 1, height: VOICE_TOP_BAR_PILL_HEIGHT,
        flexDirection: 'row', alignItems: 'center', paddingRight: 2,
        borderRadius: VOICE_TOP_BAR_PILL_HEIGHT / 2, backgroundColor: theme.colors.state.neutral.background,
    },
    // Concentric: the trailing well sits as far from the capsule's end as from its top and bottom
    // ((56 − 32) / 2 desktop, (58 − 34) / 2 phone).
    capsule: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 4, paddingRight: 12 },
    pillLabel: { minWidth: 0, flexShrink: 1, justifyContent: 'center', paddingLeft: 2, paddingRight: 9 },
    divider: { width: 1, height: 14, marginHorizontal: 2, backgroundColor: theme.colors.border.default },
    islandMark: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    islandBody: { flex: 1, minWidth: 0, justifyContent: 'center', gap: 1, alignSelf: 'stretch' },
    orb: { width: VOICE_ORB_BODY_SIZE, height: VOICE_ORB_BODY_SIZE, alignItems: 'center', justifyContent: 'center' },
}));
