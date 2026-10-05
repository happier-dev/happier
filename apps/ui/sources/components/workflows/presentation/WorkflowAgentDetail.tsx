import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

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
                <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                        rowLayoutMutation({
                            reason: expanded ? 'collapse' : 'expand',
                            sourceId: `workflow-agent-detail:${props.detailTestID ?? 'detail'}`,
                        });
                        setExpanded(!expanded);
                    }}
                    testID={toggleTestID}
                    style={styles.toggle}
                >
                    <Text style={styles.toggleText}>
                        {expanded
                            ? t('tools.workflowActivityView.detailShowLess')
                            : t('tools.workflowActivityView.detailShowMore')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
});
WorkflowAgentDetail.displayName = 'WorkflowAgentDetail';

const styles = StyleSheet.create((theme) => ({
    container: {
        marginLeft: 26,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        gap: 6,
    },
    text: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    mono: {
        fontFamily: 'monospace',
    },
    toggle: {
        alignSelf: 'flex-start',
        minHeight: MINIMUM_TARGET_SIZE,
        justifyContent: 'center',
    },
    toggleText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.link,
    },
}));
