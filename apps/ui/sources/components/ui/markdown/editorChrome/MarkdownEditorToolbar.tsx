import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { Text } from '@/components/ui/text/Text';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import type {
    MarkdownEditorCommand,
    MarkdownEditorController,
    MarkdownSelectionState,
} from '@/components/ui/markdown/editor/markdownEditorTypes';

/**
 * Phase-1 formatting toolbar for the rich markdown editor (Lane C / C2).
 *
 * Drives the editor purely through the `MarkdownEditorController` contract
 * (`runCommand` + `subscribeSelection`). It never imports `@tiptap/*` or any
 * surface/bridge module — it reads from `MarkdownSelectionState` and writes
 * back commands. This makes it identical on web (react-native-web) and native.
 *
 * Phase-1 scope (R-A9): headings H1-H3, bold/italic/strike/inline-code,
 * bullet/ordered/task lists, blockquote, code block, horizontal rule. Links are
 * created via autolink/linkOnPaste in the surface — the toolbar only exposes
 * open/unlink for an already-selected link (R-A13/R-A18). There is no
 * insert-link chip in Phase 1.
 */

export type MarkdownEditorToolbarProps = Readonly<{
    controller: MarkdownEditorController;
    /**
     * Visual variant.
     * - `'panel'` (default): full footer bar with its own border + background; on
     *   native it is wrapped in `KeyboardStickyFooter` so it sits above the
     *   keyboard. Used by `RichMarkdownEditorPanel` in the file-pane.
     * - `'inline'`: chrome-less variant intended to sit inside a host header row
     *   (e.g. the prompt-editor screens, left of the Raw/Rich dropdown). The host
     *   provides the container; this variant adds NO outer bar background and is
     *   ALWAYS rendered inline (no keyboard-sticky wrap), since on a prompt screen
     *   it must read as part of the field's own header, not as a floating footer.
     */
    variant?: 'panel' | 'inline';
    testID?: string;
}>;

type OcticonName = React.ComponentProps<typeof Octicons>['name'];

const DEFAULT_SELECTION_STATE: MarkdownSelectionState = {
    marks: { bold: false, italic: false, strike: false, code: false },
    blockType: 'paragraph',
    isLinkActive: false,
    canUndo: false,
    canRedo: false,
};

const ICON_SIZE = 16;

/**
 * Static descriptor for each always-present formatting chip. `isActive` reads
 * the live selection so the chip can reflect the mark/block currently under the
 * cursor; `command` is dispatched on press.
 */
type ToolbarChipSpec = Readonly<{
    id: string;
    icon: OcticonName;
    label: string;
    command: MarkdownEditorCommand;
    isActive: (state: MarkdownSelectionState) => boolean;
    /** Optional numeric badge (used to disambiguate H1/H2/H3 which share a glyph). */
    badge?: string;
}>;

function buildChipSpecs(): ToolbarChipSpec[] {
    return [
        {
            id: 'heading1',
            icon: 'heading',
            label: t('markdownEditorToolbar.heading1'),
            command: { kind: 'setHeading', level: 1 },
            isActive: (s) => s.blockType === 'heading1',
            badge: '1',
        },
        {
            id: 'heading2',
            icon: 'heading',
            label: t('markdownEditorToolbar.heading2'),
            command: { kind: 'setHeading', level: 2 },
            isActive: (s) => s.blockType === 'heading2',
            badge: '2',
        },
        {
            id: 'heading3',
            icon: 'heading',
            label: t('markdownEditorToolbar.heading3'),
            command: { kind: 'setHeading', level: 3 },
            isActive: (s) => s.blockType === 'heading3',
            badge: '3',
        },
        {
            id: 'bold',
            icon: 'bold',
            label: t('markdownEditorToolbar.bold'),
            command: { kind: 'toggleBold' },
            isActive: (s) => s.marks.bold,
        },
        {
            id: 'italic',
            icon: 'italic',
            label: t('markdownEditorToolbar.italic'),
            command: { kind: 'toggleItalic' },
            isActive: (s) => s.marks.italic,
        },
        {
            id: 'strike',
            icon: 'strikethrough',
            label: t('markdownEditorToolbar.strikethrough'),
            command: { kind: 'toggleStrike' },
            isActive: (s) => s.marks.strike,
        },
        {
            id: 'code',
            icon: 'code',
            label: t('markdownEditorToolbar.code'),
            command: { kind: 'toggleCode' },
            isActive: (s) => s.marks.code,
        },
        {
            id: 'bulletList',
            icon: 'list-unordered',
            label: t('markdownEditorToolbar.bulletList'),
            command: { kind: 'toggleBulletList' },
            isActive: (s) => s.blockType === 'bulletList',
        },
        {
            id: 'orderedList',
            icon: 'list-ordered',
            label: t('markdownEditorToolbar.orderedList'),
            command: { kind: 'toggleOrderedList' },
            isActive: (s) => s.blockType === 'orderedList',
        },
        {
            id: 'taskList',
            icon: 'tasklist',
            label: t('markdownEditorToolbar.taskList'),
            command: { kind: 'toggleTaskList' },
            isActive: (s) => s.blockType === 'taskList',
        },
        {
            id: 'blockquote',
            icon: 'quote',
            label: t('markdownEditorToolbar.blockquote'),
            command: { kind: 'toggleBlockquote' },
            isActive: (s) => s.blockType === 'blockquote',
        },
        {
            id: 'codeBlock',
            icon: 'file-code',
            label: t('markdownEditorToolbar.codeBlock'),
            command: { kind: 'toggleCodeBlock' },
            isActive: (s) => s.blockType === 'codeBlock',
        },
        {
            id: 'horizontalRule',
            icon: 'horizontal-rule',
            label: t('markdownEditorToolbar.horizontalRule'),
            command: { kind: 'setHorizontalRule' },
            isActive: () => false,
        },
    ];
}

function MarkdownEditorToolbarInner(props: MarkdownEditorToolbarProps): React.ReactElement {
    const { controller, testID, variant = 'panel' } = props;
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isInline = variant === 'inline';

    const [selectionState, setSelectionState] = React.useState<MarkdownSelectionState>(DEFAULT_SELECTION_STATE);

    React.useEffect(() => {
        const unsubscribe = controller.subscribeSelection(setSelectionState);
        return () => {
            unsubscribe();
        };
    }, [controller]);

    const chipSpecs = React.useMemo(() => buildChipSpecs(), []);

    const runCommand = React.useCallback(
        (command: MarkdownEditorCommand) => {
            hapticsLight();
            controller.runCommand(command);
        },
        [controller],
    );

    const handleOpenLink = React.useCallback(() => {
        // Open is a controller command (R-A18): the surface owns HOW a link is
        // opened (web `window.open`, native bridge), so the chrome stays decoupled
        // and never touches a surface/bridge module itself.
        runCommand({ kind: 'openLink' });
    }, [runCommand]);

    const handleUnlink = React.useCallback(() => {
        runCommand({ kind: 'unlink' });
    }, [runCommand]);

    const activeForeground = theme.colors.state.active.foreground;
    const inactiveForeground = theme.colors.text.secondary;

    const renderChip = (spec: ToolbarChipSpec) => {
        const active = spec.isActive(selectionState);
        return (
            <Pressable
                key={spec.id}
                testID={testID ? `${testID}:${spec.id}` : undefined}
                accessibilityRole="button"
                accessibilityLabel={spec.label}
                accessibilityState={{ selected: active }}
                aria-pressed={active}
                hitSlop={6}
                onPress={() => runCommand(spec.command)}
                style={({ pressed }) => [
                    styles.chip,
                    {
                        backgroundColor: active
                            ? theme.colors.state.active.background
                            : theme.colors.surface.base,
                        borderColor: active
                            ? theme.colors.state.active.border
                            : theme.colors.border.default,
                        opacity: pressed ? 0.7 : 1,
                    },
                ]}
            >
                <Octicons
                    name={spec.icon}
                    size={ICON_SIZE}
                    color={active ? activeForeground : inactiveForeground}
                />
                {spec.badge ? (
                    <Text
                        style={[
                            styles.badge,
                            { color: active ? activeForeground : inactiveForeground },
                        ]}
                        allowFontScaling={false}
                    >
                        {spec.badge}
                    </Text>
                ) : null}
            </Pressable>
        );
    };

    // Inline variant sits on the host's own background (the field header), so we
    // fade against `surface.base` instead of the panel's `surface.inset`.
    const fadeColor = isInline ? theme.colors.surface.base : theme.colors.surface.inset;
    const scrollContentStyle = isInline ? styles.scrollContentInline : styles.scrollContent;

    const content = (
        <HorizontalScrollableRow
            testID={testID ? `${testID}:scroll` : undefined}
            contentTestID={testID ? `${testID}:scroll-content` : undefined}
            fadeColor={fadeColor}
            indicatorColor={theme.colors.text.secondary}
            contentStyle={scrollContentStyle}
        >
            {chipSpecs.map(renderChip)}

            {selectionState.isLinkActive ? (
                <View style={styles.linkGroup} testID={testID ? `${testID}:link-actions` : undefined}>
                    <View style={styles.divider} />
                    <Pressable
                        testID={testID ? `${testID}:openLink` : undefined}
                        accessibilityRole="button"
                        accessibilityLabel={t('markdownEditorToolbar.openLink')}
                        hitSlop={6}
                        onPress={handleOpenLink}
                        style={({ pressed }) => [
                            styles.chip,
                            {
                                backgroundColor: theme.colors.surface.base,
                                borderColor: theme.colors.border.default,
                                opacity: pressed ? 0.7 : 1,
                            },
                        ]}
                    >
                        <Octicons name="link-external" size={ICON_SIZE} color={inactiveForeground} />
                    </Pressable>
                    <Pressable
                        testID={testID ? `${testID}:unlink` : undefined}
                        accessibilityRole="button"
                        accessibilityLabel={t('markdownEditorToolbar.unlink')}
                        hitSlop={6}
                        onPress={handleUnlink}
                        style={({ pressed }) => [
                            styles.chip,
                            {
                                backgroundColor: theme.colors.surface.base,
                                borderColor: theme.colors.border.default,
                                opacity: pressed ? 0.7 : 1,
                            },
                        ]}
                    >
                        <Octicons name="unlink" size={ICON_SIZE} color={inactiveForeground} />
                    </Pressable>
                </View>
            ) : null}
        </HorizontalScrollableRow>
    );

    // Inline variant: render JUST the scrolling chip row, no bar chrome, no
    // keyboard-sticky wrap. The host provides the surrounding header layout.
    if (isInline) {
        return (
            <View testID={testID} accessibilityRole="toolbar" style={styles.inlineRoot}>
                {content}
            </View>
        );
    }

    const bar = (
        <View
            testID={testID}
            accessibilityRole="toolbar"
            style={styles.bar}
        >
            {content}
        </View>
    );

    // On native the toolbar sits above the software keyboard via
    // `KeyboardStickyFooter`. On web that wrapper is a plain passthrough View, so
    // the bar simply renders inline.
    if (Platform.OS === 'web') {
        return bar;
    }
    return <KeyboardStickyFooter>{bar}</KeyboardStickyFooter>;
}

const stylesheet = StyleSheet.create((theme) => ({
    bar: {
        backgroundColor: theme.colors.surface.inset,
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.border.default,
    },
    scrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    // Inline variant content row: same chip layout, no outer padding (the host
    // header provides spacing) and slightly tighter vertical alignment so the
    // chips read level with the adjacent dropdown trigger.
    scrollContentInline: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 0,
        paddingVertical: 0,
    },
    // Wrapper around the inline scroll row so the parent's flex layout can size
    // it (the host owns spacing/background; we only need `position: relative`
    // for the fade overlays inside `HorizontalScrollableRow`).
    inlineRoot: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
    },
    chip: {
        width: 34,
        height: 34,
        borderRadius: 9,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    badge: {
        position: 'absolute',
        right: 4,
        bottom: 3,
        fontSize: 9,
        fontWeight: '700',
        lineHeight: 10,
    },
    linkGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    divider: {
        width: 1,
        height: 20,
        marginHorizontal: 2,
        backgroundColor: theme.colors.border.default,
    },
}));

export const MarkdownEditorToolbar = React.memo(MarkdownEditorToolbarInner);
