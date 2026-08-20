import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { SessionAgentTransitionBriefPreviewV1 } from '@happier-dev/protocol';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import {
    previewSessionAgentTransitionBriefOnMachine,
    type SessionAgentTransitionBriefPreviewQueryV1,
} from '@/sync/ops/sessionAgentTransitionBriefPreview';
import { t } from '@/text';

import { readHandedOverBriefSections } from './handedOverBriefSections';

export const AGENT_TRANSITION_HANDED_OVER_MODAL_TEST_ID = 'agent-transition-handed-over-modal';

/** What the card can say, in the order it learns it. */
type HandedOverContextState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'answered'; preview: SessionAgentTransitionBriefPreviewV1 }>
    | Readonly<{ kind: 'unreachable' }>;

export type AgentTransitionHandedOverContextModalProps = CustomModalInjectedProps & Readonly<{
    sessionId: string;
    machineId: string | null;
    serverId: string | null;
    /** The transcript cutoff the divider recorded. `0` means nothing was carried over. */
    sourceCutoffSeqInclusive: number;
    /** The boundary's two Agents, exactly as the divider records them. */
    sourceAgentId: string;
    targetAgentId: string;
    /** Scrolls this Session's transcript to the last message the brief could include. */
    onJumpToCutoff: (() => void) | null;
}>;

function readQueryState(query: SessionAgentTransitionBriefPreviewQueryV1): HandedOverContextState {
    return query.status === 'answered'
        ? { kind: 'answered', preview: query.preview }
        : { kind: 'unreachable' };
}

/**
 * The context one Agent handed the next, rebuilt on open.
 *
 * Nothing was stored to show: the seed text is blanked the instant the target
 * accepts it. The machine rebuilds it by running the SAME bounded context pass
 * the transition ran, bounded by the SAME cutoff the divider recorded — so this
 * card cannot drift into showing a brief that was never sent. What it CAN differ
 * on is stated in the card itself rather than left for the reader to discover:
 * it is a reconstruction from today's transcript, not a copy taken at the time.
 */
export function AgentTransitionHandedOverContextModal(
    props: AgentTransitionHandedOverContextModalProps,
): React.ReactElement {
    const { theme } = useUnistyles();
    const { machineId, serverId, sessionId, sourceAgentId, sourceCutoffSeqInclusive, targetAgentId } = props;
    const [attempt, setAttempt] = React.useState(0);
    const [state, setState] = React.useState<HandedOverContextState>({ kind: 'loading' });

    React.useEffect(() => {
        // No machine to address is not proof of anything about the daemon, and
        // it is certainly not "nothing was carried over".
        if (!machineId) {
            setState({ kind: 'unreachable' });
            return;
        }
        let applies = true;
        setState({ kind: 'loading' });
        void previewSessionAgentTransitionBriefOnMachine({
            machineId,
            serverId,
            sessionId,
            sourceCutoffSeqInclusive,
            sourceAgentId,
            targetAgentId,
        })
            .catch((): SessionAgentTransitionBriefPreviewQueryV1 => ({ status: 'indeterminate' }))
            .then((query) => {
                if (!applies) return;
                setState(readQueryState(query));
            });
        return () => {
            applies = false;
        };
    }, [attempt, machineId, serverId, sessionId, sourceAgentId, sourceCutoffSeqInclusive, targetAgentId]);

    const retry = React.useCallback(() => setAttempt((value) => value + 1), []);

    const retryable = state.kind === 'unreachable'
        || (state.kind === 'answered'
            && state.preview.type === 'unavailable'
            && state.preview.reason !== 'unsupported_session');

    return (
        <View style={styles.body} testID={AGENT_TRANSITION_HANDED_OVER_MODAL_TEST_ID}>
            <View style={styles.notice}>
                <Icon name="info" size={14} color={theme.colors.text.tertiary} />
                <Text
                    testID="agent-transition-handed-over-notice"
                    style={[styles.noticeText, { color: theme.colors.text.tertiary }]}
                >
                    {t('session.agentContinuation.handedOver.reconstructed')}
                </Text>
            </View>

            {state.kind === 'loading' ? (
                <View style={styles.status}>
                    <ActivitySpinner size={14} color={theme.colors.text.secondary} />
                    <Text style={[styles.statusText, { color: theme.colors.text.secondary }]}>
                        {t('session.agentContinuation.handedOver.loading')}
                    </Text>
                </View>
            ) : null}

            {state.kind === 'answered' && state.preview.type === 'rebuilt' ? (
                <View
                    testID="agent-transition-handed-over-brief"
                    style={[styles.brief, { backgroundColor: theme.colors.surface.inset, borderColor: theme.colors.border.default }]}
                >
                    {readHandedOverBriefSections(state.preview.briefText).map((section, index) => (
                        <View key={`${section.container ?? 'text'}-${index}`} style={styles.section}>
                            {section.label ? (
                                <View style={styles.sectionHeading}>
                                    <Text style={[styles.sectionLabel, { color: theme.colors.text.tertiary }]} numberOfLines={1}>
                                        {section.label}
                                    </Text>
                                    {section.attributes ? (
                                        <Text
                                            selectable
                                            style={[styles.sectionAttributes, { color: theme.colors.text.tertiary }]}
                                            numberOfLines={1}
                                        >
                                            {section.attributes}
                                        </Text>
                                    ) : null}
                                </View>
                            ) : null}
                            {section.body.length > 0 ? (
                                <Text
                                    selectable
                                    style={section.container === null
                                        ? [styles.briefProse, { color: theme.colors.text.secondary }]
                                        : [styles.briefText, { color: theme.colors.text.primary }]}
                                >
                                    {section.body}
                                </Text>
                            ) : null}
                        </View>
                    ))}
                </View>
            ) : null}

            {state.kind === 'answered' && state.preview.type === 'empty' ? (
                <Text
                    testID="agent-transition-handed-over-status"
                    style={[styles.statusText, { color: theme.colors.text.secondary }]}
                >
                    {t('session.agentContinuation.handedOver.empty')}
                </Text>
            ) : null}

            {state.kind === 'answered' && state.preview.type === 'unavailable' ? (
                <Text
                    testID="agent-transition-handed-over-status"
                    style={[styles.statusText, { color: theme.colors.text.secondary }]}
                >
                    {state.preview.reason === 'operation_unavailable'
                        ? t('session.agentContinuation.handedOver.unavailableOperation')
                        : t('session.agentContinuation.handedOver.unavailableSource')}
                </Text>
            ) : null}

            {state.kind === 'unreachable' ? (
                <Text
                    testID="agent-transition-handed-over-status"
                    style={[styles.statusText, { color: theme.colors.text.secondary }]}
                >
                    {t('session.agentContinuation.handedOver.unreachable')}
                </Text>
            ) : null}

            <View style={styles.actions}>
                {props.onJumpToCutoff ? (
                    <Pressable
                        testID="agent-transition-handed-over-jump"
                        accessibilityRole="button"
                        onPress={() => {
                            props.onJumpToCutoff?.();
                            props.onClose();
                        }}
                        style={({ pressed }) => [
                            styles.action,
                            { borderColor: theme.colors.border.default, opacity: pressed ? 0.7 : 1 },
                        ]}
                    >
                        <Icon name="arrow-down" size={14} color={theme.colors.text.link} />
                        <Text style={[styles.actionText, { color: theme.colors.text.link }]}>
                            {t('session.agentContinuation.handedOver.jumpAction')}
                        </Text>
                    </Pressable>
                ) : null}
                {retryable ? (
                    <Pressable
                        testID="agent-transition-handed-over-retry"
                        accessibilityRole="button"
                        onPress={retry}
                        style={({ pressed }) => [
                            styles.action,
                            { borderColor: theme.colors.border.default, opacity: pressed ? 0.7 : 1 },
                        ]}
                    >
                        <Icon name="arrow-clockwise" size={14} color={theme.colors.text.link} />
                        <Text style={[styles.actionText, { color: theme.colors.text.link }]}>
                            {t('session.agentContinuation.handedOver.retryAction')}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        </View>
    );
}

const styles = StyleSheet.create((_theme) => ({
    body: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 14,
        gap: 12,
    },
    notice: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    noticeText: {
        flex: 1,
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 17,
    },
    status: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 19,
    },
    brief: {
        // Concentric with the modal card: the card's own radius less this
        // block's inset from it, so the inner corner does not read as a second,
        // tighter shape stamped inside the first.
        borderRadius: 10,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        // One block, sections inside it. The seed IS one document, and giving
        // each container its own bordered card would claim it arrived as
        // several — and stack four concentric shapes inside the modal.
        gap: 12,
    },
    section: {
        gap: 4,
    },
    sectionHeading: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 8,
    },
    sectionLabel: {
        ...Typography.default('semiBold'),
        fontSize: 10,
        lineHeight: 14,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
    },
    sectionAttributes: {
        flexShrink: 1,
        ...Typography.mono(),
        fontSize: 10,
        lineHeight: 14,
    },
    briefText: {
        ...Typography.mono(),
        fontSize: 12,
        lineHeight: 18,
    },
    briefProse: {
        // The framer's own sentences, the only lines in the seed that are about
        // the prompt rather than about the conversation. Setting them in the UI
        // face keeps the mono for the recording, where a monospaced line is
        // carrying real structure rather than decorating prose.
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 17,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 40,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 10,
        borderWidth: 1,
    },
    actionText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
    },
}));
