import type { AgentActivityStatusV1 } from '@happier-dev/protocol';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import {
    resolveAgentActivityStatusWord,
    resolveAgentActivityToneStyle,
} from '../presentation/agentActivityToneStyle';
import { AGENT_ROW_DETAIL_INSET_PX } from '../row/agentRowMetrics';
import { AgentActivityStatusSlot } from '../row/AgentActivityStatusSlot';
import type { AgentActivityPreviewStep } from './deriveAgentActivityPreview';
import { useAgentActivitySidechainPreview } from './useAgentActivitySidechainPreview';

/**
 * What one agent has been doing, disclosed under its row — bounded, and never a transcript.
 *
 * **It is mounted by the disclosure, so it IS the demand-load.** Nothing about a sidechain is
 * fetched to draw a roster; expanding one row mounts one of these, and this hook fetches exactly
 * that sidechain by id through the single hydration owner. That is the whole "lazy" contract, and
 * it is enforced by mounting rather than by a flag a caller could forget to pass.
 *
 * **The same body for every kind that has a target.** A native subagent, an execution run and a
 * workflow agent all disclose the same three things — the last few steps, the last line, whether a
 * person is being waited on — in the popover and in the pane alike, because both hosts render it
 * through `AgentActivitySurface`. The alternative was a workflow-only viewer, which is the
 * split-brain this wave exists to avoid.
 *
 * **Open details is offered only where THIS host can serve it.** An orphan workflow sidechain has no
 * owning tool message, so the existing subagent route cannot address it — but a scoped transcript
 * details tab can, wherever a pane scope exists. So the callback arrives from the pane and is absent
 * in the compact popover, which is anchored to a composer and has nowhere to put a tab. Absent means
 * the preview IS the destination for that row, which is why it states the steps rather than teasing
 * them; a control that leads nowhere must not render (A9).
 */

export type AgentActivityPreviewProps = Readonly<{
    sessionId: string;
    /** The one sidechain this body loads, resolved by `resolveAgentActivityOpenTarget`. */
    sidechainId: string;
    /** Absent when this target is inspectable but not navigable. Never a disabled control. */
    onOpenDetails?: () => void;
    testID?: string;
}>;

/** Tool state → the shared status vocabulary, so a step's mark is the row's mark. */
const STEP_STATUS: Record<AgentActivityPreviewStep['state'], AgentActivityStatusV1> = {
    running: 'running',
    completed: 'succeeded',
    error: 'failed',
    unavailable: 'cancelled',
};

const STEP_GLYPH_PX = 12;

export const AgentActivityPreview = React.memo((props: AgentActivityPreviewProps) => {
    const { theme } = useUnistyles();
    const { onOpenDetails, sessionId, sidechainId, testID } = props;
    const { hasMessages, preview, status } = useAgentActivitySidechainPreview({
        sessionId,
        sidechainId,
    });

    const notice = resolvePreviewNotice({ hasMessages, isEmpty: preview.isEmpty, status });

    return (
        <View style={styles.container} testID={testID}>
            {notice !== null ? (
                <Text style={styles.meta} testID={testID ? `${testID}:notice` : undefined}>
                    {notice}
                </Text>
            ) : null}
            {preview.steps.map((step) => (
                <View
                    key={step.id}
                    style={styles.step}
                    testID={testID ? `${testID}:step:${step.id}` : undefined}
                >
                    <AgentActivityStatusSlot
                        status={STEP_STATUS[step.state]}
                        size={STEP_GLYPH_PX}
                        // A disclosed body is not a live surface: the row above already carries the
                        // one spinner that says this agent is working, and a second one under it
                        // reads as two independent claims about the same agent.
                        animationEnabled={false}
                    />
                    <Text style={styles.stepText} numberOfLines={1}>
                        {step.detail === null ? step.name : `${step.name} · ${step.detail}`}
                    </Text>
                </View>
            ))}
            {preview.lastLine !== null ? (
                <Text
                    style={styles.body}
                    numberOfLines={2}
                    testID={testID ? `${testID}:last-line` : undefined}
                >
                    {preview.lastLine}
                </Text>
            ) : null}
            {preview.pendingPermission ? (
                <Text
                    // Through the one tone binding, never a direct `state.*` read: a second status
                    // colour in this folder is the split-brain its barrel exists to prevent.
                    style={[styles.meta, { color: resolveAgentActivityToneStyle('attention', theme).ink }]}
                    testID={testID ? `${testID}:permission` : undefined}
                >
                    {resolveAgentActivityStatusWord('waiting')}
                </Text>
            ) : null}
            {onOpenDetails ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('session.agentActivity.preview.openDetails')}
                    onPress={onOpenDetails}
                    hitSlop={8}
                    style={styles.link}
                    testID={testID ? `${testID}:open-details` : undefined}
                >
                    <Icon name="arrow-square-out" size={14} color={theme.colors.text.link} />
                    <Text style={styles.linkText}>
                        {t('session.agentActivity.preview.openDetails')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
});

AgentActivityPreview.displayName = 'AgentActivityPreview';

/**
 * The one honest line about why this body is showing nothing, or `null` when it is showing
 * something.
 *
 * "Loading" is claimed only while a fetch is genuinely in flight; a sidechain that arrived empty
 * says so and stops, rather than spinning forever over a transcript that will never have content.
 */
function resolvePreviewNotice(params: Readonly<{
    hasMessages: boolean;
    isEmpty: boolean;
    status: string;
}>): string | null {
    if (params.hasMessages && !params.isEmpty) return null;
    if (params.status === 'error' || params.status === 'not_ready') return t('common.unavailable');
    if (params.status === 'loaded') return t('session.agentActivity.preview.empty');
    return t('common.loading');
}

const styles = StyleSheet.create((theme) => ({
    container: {
        // The same inset, border and ground as `BackgroundTaskDetail`: two kinds of disclosed body
        // under one roster must read as the same object, not as two designs.
        marginLeft: AGENT_ROW_DETAIL_INSET_PX,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        gap: 6,
    },
    step: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    stepText: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    body: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    meta: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    link: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        minHeight: 28,
    },
    linkText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.link,
    },
}));
