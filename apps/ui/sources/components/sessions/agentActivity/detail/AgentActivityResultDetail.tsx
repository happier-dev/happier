import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { AGENT_ROW_DETAIL_INSET_PX } from '../row/agentRowMetrics';
import { clampPreviewLines, normalizeResultPreview } from './resultPreview';

export type AgentActivityResultDetailProps = Readonly<{
    text: string;
    detailTestID?: string;
}>;

/**
 * The disclosed body under an agent-activity row: one normalized, bounded result preview.
 *
 * It lives here rather than with the workflow renderer because the row above it is shared and the
 * detail under it is the same problem for every kind of agent work — a provider hands back an opaque
 * string that is sometimes JSON, sometimes prose, and sometimes a dump. The single `resultPreview`
 * owner turns that into a compact pretty-print or trimmed text with a hard character cap; this
 * component clamps the collapsed body to a small line budget with a local "Show more" so a long
 * summary never floods a popover. No raw markdown or JSON source dumps.
 *
 * A host renders it as a sibling of the row through `AgentActivityDisclosure`; it never becomes part
 * of the row's own anatomy.
 */
export const AgentActivityResultDetail = React.memo<AgentActivityResultDetailProps>((props) => {
    const [expanded, setExpanded] = React.useState(false);
    const normalized = React.useMemo(() => normalizeResultPreview(props.text), [props.text]);
    const clamped = React.useMemo(() => clampPreviewLines(normalized.display), [normalized.display]);
    const body = expanded ? normalized.display : clamped.text;
    const bodyTestID = props.detailTestID ? `${props.detailTestID}-body` : undefined;
    const toggleTestID = props.detailTestID ? `${props.detailTestID}-show-more` : undefined;

    return (
        <View style={styles.container} testID={props.detailTestID}>
            <Text style={[styles.text, normalized.kind === 'json' ? styles.mono : null]} testID={bodyTestID}>
                {body}
            </Text>
            {clamped.clamped ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={() => setExpanded((current) => !current)}
                    hitSlop={8}
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
AgentActivityResultDetail.displayName = 'AgentActivityResultDetail';

const styles = StyleSheet.create((theme) => ({
    container: {
        marginLeft: AGENT_ROW_DETAIL_INSET_PX,
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
        minHeight: 28,
        justifyContent: 'center',
    },
    toggleText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.link,
    },
}));
