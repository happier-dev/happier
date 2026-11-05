import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { LinearGradient } from 'expo-linear-gradient';
import { parseThemeColor } from '@/theme/parseThemeColor';

import type { PaneArrangement } from '@/components/ui/panels/paneBreakpoints';
import { DEFAULT_RIGHT_PANEL_PLACEMENT, type RightPanelPlacement } from '@/components/appShell/panes/arrangement/useRightPanelPlacement';

/**
 * A miniature of the window (lab ade-shell SET), painted from the theme's own roles so a tile shows
 * where things go rather than naming it. The rail and the navigation column stand on the canvas and
 * the page is the one lifted sheet (calm-shell `csedge.S1`). Session first puts the chat in the page
 * with the editor beside it: its own sheet on the canvas (`separate`), or joined to the page by a hairline
 * (`line`) or the header's soft shade (`shadow`); the action rail stands on the canvas after it (R11-1).
 * Editor first puts Files and the editor in the middle with the session at the right, always inside the page.
 * Static: no subscriptions.
 */
export const PaneArrangementPreview = React.memo(function PaneArrangementPreview(props: Readonly<{
    arrangement: PaneArrangement;
    rightPanel?: RightPanelPlacement;
}>) {
    const { theme } = useUnistyles();
    const editorFirst = props.arrangement === 'editor';
    const panelOnCanvas = !editorFirst && (props.rightPanel ?? DEFAULT_RIGHT_PANEL_PLACEMENT) === 'separate';
    const shade = !editorFirst && props.rightPanel === 'shadow';
    const shadeStart = theme.colors.shadowJoinedPanelShade;
    const shadeEnd = parseThemeColor(shadeStart)?.alpha(0).rgb().string() ?? 'transparent';
    const chat = (
        <View key="chat" style={[styles.column, editorFirst ? [styles.chatNarrow, styles.edgeLeading] : styles.flex]}>
            <View style={[styles.bubble, styles.bubbleMine]} />
            <View style={[styles.line, styles.lineLong]} />
            <View style={[styles.line, styles.lineMid]} />
            <View style={[styles.line, styles.lineShort]} />
            <View style={styles.grow} />
            <View style={styles.composer} />
        </View>
    );
    const editor = (
        <View key="editor" style={[styles.column, styles.editor, editorFirst ? styles.flex : [styles.editorSide, panelOnCanvas ? styles.panelSheet : shade ? null : styles.edgeLeading]]}>
            {shade ? (
                // The positioned box is a View (as the shell's own shade in MultiPaneHost); the gradient only fills it.
                <View pointerEvents="none" style={styles.shade}>
                    <LinearGradient colors={[shadeEnd, shadeStart]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ flex: 1 }} />
                </View>
            ) : null}
            {[0.7, 0.5, 0.85, 0.6, 0.4, 0.75, 0.55].map((width, index) => (
                <View key={index} style={[styles.code, index === 3 ? styles.codeAdded : null, { width: `${width * 100}%` }]} />
            ))}
        </View>
    );
    const navigation = (
        <View key="navigation" style={[styles.column, styles.navigation]}>
            {(editorFirst ? [0.8, 0.6, 0.7, 0.5, 0.65] : [0.8, 0.7, 0.75, 0.6]).map((width, index) => <View key={index} style={[styles.line, { width: `${width * 100}%` }]} />)}
        </View>
    );
    return (
        <View style={styles.frame}>
            <View style={styles.rail} />
            {navigation}
            <View style={styles.sheet}>
                {editorFirst ? [editor, chat] : panelOnCanvas ? chat : [chat, editor]}
            </View>
            {panelOnCanvas ? editor : null}
            {editorFirst ? null : <View style={styles.railTrailing} />}
            <View style={styles.inset} />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    frame: {
        flex: 1, flexDirection: 'row', overflow: 'hidden', backgroundColor: theme.colors.background.canvas,
    },
    rail: { width: 8 },
    sheet: {
        flex: 1, flexDirection: 'row', overflow: 'hidden', minWidth: 0,
        marginTop: 4, marginBottom: 3, borderRadius: 3,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.subtle,
    },
    inset: { width: 3 },
    column: { paddingHorizontal: 5, paddingVertical: 6, gap: 3, minWidth: 0 },
    flex: { flex: 1 },
    grow: { flex: 1 },
    navigation: { width: '22%' },
    chatNarrow: { width: '30%' },
    edgeLeading: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.subtle },
    editor: { gap: 3 },
    editorSide: { width: '34%' },
    // Separate: the panel's own sheet, a gap from the page, like the page's corners.
    panelSheet: { marginLeft: 3, marginTop: 4, marginBottom: 3, borderRadius: 3, backgroundColor: theme.colors.surface.base },
    // Shadow: the shade falls from the panel's edge onto the page, like the header's.
    shade: { position: 'absolute', top: 0, bottom: 0, right: '100%', width: 4 },
    railTrailing: { width: 6 },
    line: { height: 3, borderRadius: 1.5, backgroundColor: theme.colors.text.tertiary, opacity: 0.4 },
    lineLong: { width: '90%' },
    lineMid: { width: '70%' },
    lineShort: { width: '45%' },
    bubble: { height: 8, borderRadius: 3, marginBottom: 2 },
    bubbleMine: { alignSelf: 'flex-end', width: '55%', backgroundColor: theme.colors.text.tertiary, opacity: 0.25 },
    composer: { height: 9, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.strong },
    code: { height: 3, borderRadius: 1.5, backgroundColor: theme.colors.text.secondary, opacity: 0.5 },
    codeAdded: { backgroundColor: theme.colors.diff.added.border, opacity: 0.9 },
}));
