import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { WorkflowRunStateStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { formatWorkflowRunOriginLabel } from '@/components/workflows/run/workflowRunDetailPresentation';
import { Typography } from '@/constants/Typography';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { useActiveServerAccountScope, useWorkflowRun } from '@/sync/store/hooks';
import { refreshWorkflowRunById } from '@/sync/engine/workflows/refreshWorkflowRun';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';

import {
    resolveTranscriptWorkflowRunReference,
    type TranscriptWorkflowRunReference,
} from './transcriptWorkflowRunReference';

/**
 * The transcript's inline managed workflow Run — the exact Session card of
 * Agent Action -> card -> Run detail.
 *
 * It is a REFERENCE, not a Run view. It reads the one Account-scoped
 * `workflowRunsById` row the change stream already keeps current, so there is
 * no second Run store, poll, subscription or Session-owned lifecycle replica
 * here. The only thing it adds is truth at first sight: when the row is not yet
 * known on this client, it asks the canonical exact-Run refresh owner once, and
 * from then on follows the shared row like every other Run surface.
 *
 * Identity is exact. The row's captured Home must be the active Account's Home
 * before the active store is read or refreshed; the same opaque Run id on
 * another Home is a different Run. A read that lands after the Account
 * lifetime retired is discarded by that owner, never merged.
 */

const stylesheet = StyleSheet.create((theme) => ({
    root: { paddingTop: theme.space.s8 },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingVertical: theme.space.s4,
    },
    body: {
        flexShrink: 1,
        gap: theme.space.s4,
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    meta: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
    },
    action: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.secondary.tint,
        marginLeft: 'auto',
    },
}));

export const WorkflowRunActionResultReference = React.memo(function WorkflowRunActionResultReference(
    props: Readonly<{
        tool: ToolCall;
        /** The row's captured Home. Absent means no reference; never an ambient Home. */
        serverId?: string | null;
    }>,
): React.ReactElement | null {
    const reference = React.useMemo(() => resolveTranscriptWorkflowRunReference({
        toolName: props.tool.name,
        state: props.tool.state,
        result: props.tool.result,
    }), [props.tool.name, props.tool.result, props.tool.state]);
    const serverId = props.serverId ?? null;

    // Only a row that truthfully acknowledged a Run on an exact Home subscribes
    // to anything.
    if (!reference || !serverId) return null;
    return <MountedWorkflowRunReference reference={reference} serverId={serverId} />;
});

function MountedWorkflowRunReference(props: Readonly<{
    reference: TranscriptWorkflowRunReference;
    serverId: string;
}>): React.ReactElement | null {
    const styles = stylesheet;
    const transcriptSource = useSessionTranscriptSource();
    const { runId, origin } = props.reference;
    const activeScope = useActiveServerAccountScope();
    // The card answers the one canonical Workflows decision its destination
    // route answers. A historical start result outlives the feature being
    // turned off; while Workflows are unavailable — or not yet known to be
    // available — it neither advertises the Run nor reads it.
    const workflowsAvailable = useWorkflowsAvailability().available;
    // Exact-Home: the active store holds only the active Account's Runs, so a
    // row from another Home never reads or refreshes it.
    const homeIsActive = activeScope !== null
        && areServerProfileIdentifiersEquivalent(activeScope.serverId, props.serverId);
    const readable = workflowsAvailable && homeIsActive;
    const row = useWorkflowRun(readable ? runId : null);
    const summary = row?.summary ?? null;
    const summaryKnown = summary !== null;

    React.useEffect(() => {
        if (!readable || summaryKnown) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        // One exact read by `runId`; the change stream owns every later update.
        // A failed read leaves the link truthful and the status unknown rather
        // than inventing a state, and the Account-change applier retries the
        // durable invalidation on its own cursor.
        void refreshWorkflowRunById(runId, { signal: controller.signal, fence: lifetime }).catch(() => undefined);
        return () => {
            retirement.dispose();
            controller.abort();
        };
    }, [readable, runId, summaryKnown]);

    if (!readable) return null;

    // The same three-way name rule as the Workflows collection: the accepted
    // private title when this device can read it, an explicit unavailable
    // notice when the owner says it cannot, and the neutral label while the row
    // is not yet known — never a title guessed from the tool input.
    const metadata = row?.metadata ?? null;
    const title = metadata?.kind === 'available'
        ? metadata.value.title
        : metadata?.kind === 'unavailable'
            ? t('workflows.contentUnavailable')
            : t('workflows.run.untitled');
    const originLabel = formatWorkflowRunOriginLabel(origin);
    const stateLabel = summary ? describeWorkflowRunState(summary.state, { workflowCustodyState: summary.workflowCustodyState }).label : null;
    const open = (): void => {
        navigateWithBlurOnWeb(() => {
            transcriptSource.navigate?.(createWorkflowRunRoute(runId, props.serverId));
        });
    };

    return (
        <View style={styles.root} testID={`transcript-workflow-run-${runId}`}>
            <HappierPressable
                testID={`transcript-workflow-run-${runId}-open`}
                accessibilityRole="button"
                accessibilityLabel={[title, originLabel, stateLabel].filter((part) => part !== null).join(', ')}
                accessibilityHint={t('workflows.run.open')}
                onPress={open}
                disabled={transcriptSource.navigate === null}
                style={styles.row}
            >
                <View style={styles.body}>
                    <Text style={styles.title}>{title}</Text>
                    <Text style={styles.meta} numberOfLines={1}>{originLabel}</Text>
                    {summary ? (
                        <WorkflowRunStateStatus
                            testID={`transcript-workflow-run-${runId}-state`}
                            state={summary.state}
                            workflowCustodyState={summary.workflowCustodyState}
                        />
                    ) : null}
                </View>
                {transcriptSource.navigate !== null ? <Text style={styles.action}>{t('workflows.run.open')}</Text> : null}
            </HappierPressable>
        </View>
    );
}
