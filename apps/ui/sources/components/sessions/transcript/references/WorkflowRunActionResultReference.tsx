import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { View } from 'react-native';
import {
    HAPPIER_WORK_UPDATE_CARD_FACT_ICON_SIZE_PX,
    HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX,
    HappierWorkUpdateCard,
    type HappierWorkUpdateCardFact,
} from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ManagedRunMiniMap } from '@/components/sessions/work/WorkItemRow';
import { WORKER_KIND_GLYPHS } from '@/components/sessions/work/workerKindGlyphs';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { renderWorkUpdateCardSurface, useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { useSaveRunAsWorkflow } from '@/components/workflows/run/useSaveRunAsWorkflow';
import { Typography } from '@/constants/Typography';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { useActiveServerAccountScope, useActiveServerAccountScopeLifetime, useServerScopedMachineLabel, useWorkflowRun } from '@/sync/store/hooks';
import { refreshWorkflowRunById } from '@/sync/engine/workflows/refreshWorkflowRun';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
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
    // The head reads "Started a workflow · {name}": the verb quiet, the workflow's name the title.
    title: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    verb: {
        ...Typography.variant('label'),
        color: theme.colors.text.secondary,
    },
    body: { gap: theme.space.s8 },
    fact: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    progress: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
}));

const MARK_SIZE = HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX;
const FACT_ICON_SIZE = HAPPIER_WORK_UPDATE_CARD_FACT_ICON_SIZE_PX;

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
    const { theme } = useUnistyles();
    const workTheme = useWorkTheme();
    const transcriptSource = useSessionTranscriptSource();
    const { runId } = props.reference;
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
    const status = summary ? resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(summary) }) : null;
    const progress = summary ? describeWorkflowRunProgress(summary.stepProgress) : null;
    const canNavigate = transcriptSource.navigate !== null;
    const open = (): void => {
        navigateWithBlurOnWeb(() => {
            transcriptSource.navigate?.(createWorkflowRunRoute(runId, props.serverId));
        });
    };
    // A workflow written for this task has no source in the library; only it can be saved as one.
    const sourceless = summary?.sourceArtifactId === null;
    const facts: HappierWorkUpdateCardFact[] = summary ? [{
        id: 'machine',
        icon: <Icon name="laptop" size={FACT_ICON_SIZE} color={theme.colors.text.tertiary} />,
        label: <RunMachineLabel serverId={props.serverId} machineId={summary.machineId} />,
    }] : [];

    return (
        <View style={styles.root}>
            <HappierWorkUpdateCard
                testID={`transcript-workflow-run-${runId}`}
                slotTestIDPrefix={`transcript-workflow-run-${runId}`}
                tone={status?.tone ?? 'neutral'}
                theme={workTheme}
                host={WORK_HOST}
                renderSurface={renderWorkUpdateCardSurface}
                mark={<Icon name={WORKER_KIND_GLYPHS.workflow_run} size={MARK_SIZE} color={theme.colors.text.secondary} />}
                title={(
                    <Text numberOfLines={1} style={styles.title}>
                        <Text style={styles.verb}>{`${t('workflows.transcriptCard.startedWorkflow')} \u00b7 `}</Text>
                        {title}
                    </Text>
                )}
                state={status?.word}
                meta={summary ? formatShortRelativeTime(Date.parse(summary.createdAt)) : undefined}
                facts={facts}
                actions={canNavigate ? (
                    <>
                        {sourceless && summary ? <SaveRunAsWorkflowAction runId={runId} serverId={props.serverId} /> : null}
                        <RoundButton testID={`transcript-workflow-run-${runId}-open`} size="small" display="secondary"
                            title={t('workflows.run.open')} accessibilityLabel={[t('workflows.run.open'), title].join(', ')} onPress={open} />
                    </>
                ) : undefined}
            >
                {summary ? (
                    <View style={styles.body}>
                        {sourceless ? <Text style={styles.fact}>{t('workflows.transcriptCard.writtenForTask')}</Text> : null}
                        <ManagedRunMiniMap runId={runId} serverId={props.serverId}
                            testIDPrefix={`transcript-workflow-run-${runId}-map`} onOpen={open} />
                        {progress ? <Text testID={`transcript-workflow-run-${runId}-progress`} style={styles.progress}>{progress}</Text> : null}
                    </View>
                ) : null}
            </HappierWorkUpdateCard>
        </View>
    );
}

const RunMachineLabel = React.memo(function RunMachineLabel(props: Readonly<{ serverId: string; machineId: string }>) {
    const label = useServerScopedMachineLabel(props.serverId, props.machineId);
    return label ? <Text numberOfLines={1} style={stylesheet.fact}>{label}</Text> : null;
});

/**
 * Save as workflow (07 S15): opens the run's workflow as an unsaved draft for review, with zero writes.
 * The draft needs the accepted definition and context, which the exact Run read carries; the card reads
 * it only when the person asks, then hands it to the one Save owner the Run page uses.
 */
const SaveRunAsWorkflowAction = React.memo(function SaveRunAsWorkflowAction(props: Readonly<{ runId: string; serverId: string }>) {
    const accountLifetime = useActiveServerAccountScopeLifetime();
    const isCurrent = React.useCallback(() => true, []);
    const save = useSaveRunAsWorkflow({ accountLifetime, serverId: props.serverId, isCurrent });
    const [reading, setReading] = React.useState(false);
    const press = (): void => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null || reading) return;
        setReading(true);
        void workflowRunDetailActions.getRun(props.runId).then((opened) => {
            if (!lifetime.isCurrent()) return;
            save({ run: opened.run, definition: opened.authoredDefinition, acceptedContext: opened.acceptedContext });
        }, () => undefined).finally(() => setReading(false));
    };
    return (
        <RoundButton testID={`transcript-workflow-run-${props.runId}-save`} size="small" display="inverted"
            title={t('workflows.run.saveAsWorkflow')} loading={reading} onPress={press} />
    );
});
