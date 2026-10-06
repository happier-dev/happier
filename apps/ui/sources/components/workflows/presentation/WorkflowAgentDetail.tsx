import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

import { clampPreviewLines, normalizeResultPreview } from './resultPreview';
import { ToolFindText, useToolFindState } from '@/components/tools/renderers/core/ToolFindText';

/**
 * Text-labelled controls take the canonical platform target as a real minimum
 * height. `hitSlop` is inert on react-native-web's `Pressable`, and the desktop
 * app IS the web bundle, so a slop-declared target there is a target that does
 * not exist.
 */
const MINIMUM_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

export type WorkflowAgentDetailProps = Readonly<{
    text: string;
    detailTestID?: string;
    messageId?: string;
    findBlockId?: string;
}>;

/**
 * Focused agent-detail preview shared by workflow rows in the popover and transcript card.
 *
 * The raw provider payload is normalized here through the single `resultPreview` owner (U-9/#11):
 * JSON-ish payloads become a compact pretty-print, everything else is trimmed text, and the length
 * is capped. The collapsed body is clamped to a small line budget with a local "Show more" expand so
 * a long summary never floods the popover (U-20). No raw markdown/JSON source dumps.
 */
export const WorkflowAgentDetail = React.memo<WorkflowAgentDetailProps>((props) => {
    const { theme } = useUnistyles();
    const find = useToolFindState(props.messageId);
    const [expanded, setExpanded] = React.useState(false);
    const rowLayoutMutation = useTranscriptRowLayoutMutation();
    const normalized = React.useMemo(() => normalizeResultPreview(props.text, find.active ? null : undefined), [props.text, find.active]);
    const clamped = React.useMemo(() => clampPreviewLines(normalized.display), [normalized.display]);
    const body = expanded || find.active ? normalized.display : clamped.text;
    const bodyTestID = props.detailTestID ? `${props.detailTestID}-body` : undefined;
    const toggleTestID = props.detailTestID ? `${props.detailTestID}-show-more` : undefined;

    return (
        <View style={styles.container} testID={props.detailTestID}>
            <ToolFindText messageId={props.messageId} blockId={props.findBlockId ?? 'tool-workflow-detail'} text={body} style={[styles.text, normalized.kind === 'json' ? styles.mono : null]} testID={bodyTestID} />
            {clamped.clamped && !find.active ? (
                <HappierPressable
                    accessibilityRole="button"
                    expanded={expanded}
                    onPress={() => {
                        rowLayoutMutation({
                            reason: expanded ? 'collapse' : 'expand',
                            sourceId: `workflow-agent-detail:${props.detailTestID ?? 'detail'}`,
                        });
                        setExpanded(!expanded);
                    }}
                    testID={toggleTestID}
                    style={(state) => [styles.toggle, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                >
                    <Text style={styles.toggleText}>
                        {expanded
                            ? t('tools.workflowActivityView.detailShowLess')
                            : t('tools.workflowActivityView.detailShowMore')}
                    </Text>
                </HappierPressable>
            ) : null}
        </View>
    );
});
WorkflowAgentDetail.displayName = 'WorkflowAgentDetail';

const styles = StyleSheet.create((theme) => ({
    container: {
        marginLeft: 18 + theme.margins.sm,
        paddingHorizontal: theme.margins.sm,
        paddingVertical: theme.margins.sm,
        borderRadius: theme.borderRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        gap: theme.margins.xs,
    },
    text: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    mono: {
        ...Typography.mono(),
    },
    toggle: {
        alignSelf: 'flex-start',
        minHeight: MINIMUM_TARGET_SIZE,
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'transparent',
    },
    toggleText: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.link,
    },
}));
