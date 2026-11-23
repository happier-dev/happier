import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';

export const VOICE_TOP_BAR_PILL_HEIGHT = 28;
/** The live pill's target name stops here and ellipsizes: the pill sits in the title strip beside the tabs. */
export const VOICE_TOP_BAR_TARGET_MAX_WIDTH = 160;
export const VOICE_ISLAND_DESKTOP = Object.freeze({ width: 330, height: 56, mark: 26 });
export const VOICE_ISLAND_PHONE = Object.freeze({ height: 58, mark: 28 });
/** The island mark's slot: never smaller than the drawn mark, the same under every pointer (a finger reaches past it through the hit area). */
export const VOICE_ISLAND_MARK_SLOT = 40;
export const VOICE_ORB_MARK_SIZE = 30;
export const VOICE_ORB_BODY_SIZE = 44;
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
        style={[styles.pill, { height: VOICE_TOP_BAR_PILL_HEIGHT }]}>
        {props.mark}<View style={styles.pillLabel}>{props.label}</View>
        {props.showDivider ? <View style={styles.divider} /> : null}
        {props.transport}{props.overlay}
    </View>;
}

export function VoiceIslandAnatomy(props: Readonly<{
    width: number; height: number; testID?: string;
    mark: React.ReactNode; body: React.ReactNode; transport: React.ReactNode;
}>) {
    return <GlassPanel testID={props.testID} radius={props.height / 2} shadowLevel={3}
        frameStyle={{ width: props.width, height: props.height }} style={styles.capsule}>
        <View style={[styles.islandMark, { width: VOICE_ISLAND_MARK_SLOT, height: VOICE_ISLAND_MARK_SLOT }]}>{props.mark}</View>
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
        flexDirection: 'row', alignItems: 'center', paddingRight: theme.space.s2,
        borderRadius: VOICE_TOP_BAR_PILL_HEIGHT / 2, backgroundColor: theme.colors.surface.selected,
    },
    // Concentric: the trailing well sits as far from the capsule's end as from its top and bottom
    // ((56 − 32) / 2 desktop, (58 − 32) / 2 phone).
    capsule: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space.s10, paddingLeft: theme.space.s4, paddingRight: theme.space.s12 },
    pillLabel: { minWidth: 0, flexShrink: 1, justifyContent: 'center', paddingLeft: theme.space.s2, paddingRight: theme.space.s8 },
    divider: { width: 1, height: 14, marginHorizontal: theme.space.s2, backgroundColor: theme.colors.border.default },
    islandMark: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    islandBody: { flex: 1, minWidth: 0, justifyContent: 'center', gap: 1, alignSelf: 'stretch' },
    orb: { width: VOICE_ORB_BODY_SIZE, height: VOICE_ORB_BODY_SIZE, alignItems: 'center', justifyContent: 'center' },
}));
