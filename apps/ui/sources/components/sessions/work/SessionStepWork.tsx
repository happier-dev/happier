import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope, useWorkflowRun } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { refreshWorkflowRunById } from '@/sync/engine/workflows/refreshWorkflowRun';
import { joinHappierFacts, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { WORKER_KIND_GLYPHS } from './workerKindGlyphs';
import { WorkSection, WorkSectionEmptyLine } from './WorkSection';

/** The workflow run a Session is a step of (`origin.kind === 'run_step'`), or `null` for every other Session. */
export function readSessionWorkflowStepRunId(session: Pick<Session, 'origin'> | null | undefined): string | null {
    const origin = session?.origin;
    return origin?.kind === 'run_step' && origin.runId ? origin.runId : null;
}

const stylesheet = StyleSheet.create((theme) => ({
    partOf: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        minWidth: 0,
    },
    copy: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
    },
    facts: {
        ...Typography.rowMeta(),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    line: {
        ...Typography.default(),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
    },
}));

/**
 * The Work tab of a workflow step Session (ORC §3.3 "Step sessions", lab `session-F`): the run it is
 * part of, opened in one tap, and one line saying why there is nothing to set here — the workflow
 * owns the step's checks, so no Role, Goal, triggers or "+" are offered. Work the step itself
 * started still lists below (`children`); with none, the Work section says so in its one quiet line.
 *
 * Reads the one Account-scoped run row; when this device does not know the run yet it asks the
 * canonical exact-run refresh owner once, in the run's exact Home only.
 */
export const SessionStepWork = React.memo(function SessionStepWork(props: Readonly<{
    runId: string;
    serverId: string | null;
    machineName: string | null;
    /** The step's own work list; omitted when it started nothing. */
    children?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const activeScope = useActiveServerAccountScope();
    const inActiveHome = activeScope !== null && props.serverId !== null
        && areServerProfileIdentifiersEquivalent(activeScope.serverId, props.serverId);
    const run = useWorkflowRun(inActiveHome ? props.runId : null);
    const known = run?.summary != null;

    React.useEffect(() => {
        if (!inActiveHome || known) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        // A failed read keeps the neutral name; the change stream owns every later update.
        void refreshWorkflowRunById(props.runId, { signal: controller.signal, fence: lifetime }).catch(() => undefined);
        return () => { retirement.dispose(); controller.abort(); };
    }, [inActiveHome, known, props.runId]);

    const runName = formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(run?.metadata));
    const facts = joinHappierFacts(
        run?.summary ? describeWorkflowRunProgress(run.summary.stepProgress) : null,
        props.machineName,
    );
    const openRun = React.useCallback(() => {
        router.push({ pathname: '/workflows/runs/[runId]', params: { runId: props.runId } } as never);
    }, [props.runId, router]);

    return (
        <>
            <SurfaceCard testID="session-work-step-part-of" padding="sm">
                <View style={styles.partOf} accessible accessibilityLabel={t('sessionWork.step.partOf', { run: runName })}>
                    <Icon name={WORKER_KIND_GLYPHS.workflow_run} size={18} color={theme.colors.text.secondary} />
                    <View style={styles.copy}>
                        <Text testID="session-work-step-run" style={styles.title} numberOfLines={1}>{runName}</Text>
                        {facts ? <Text testID="session-work-step-facts" style={styles.facts} numberOfLines={1}>{facts}</Text> : null}
                    </View>
                    <RoundButton testID="session-work-step-open-run" size="small" display="secondary" title={t('runs.openRun')} onPress={openRun} />
                </View>
            </SurfaceCard>
            <WorkSection testID="session-work-step-triggers" anatomy="page" title={t('workflows.triggers.section.title')} count={0} countMode="none">
                <WorkSectionEmptyLine testID="session-work-step-checks" text={t('sessionWork.step.checkedByWorkflow')} />
            </WorkSection>
            <WorkSection testID="session-work-step-work" anatomy="page" title={t('sessionWork.title')} count={0} countMode="none">
                {props.children ?? <WorkSectionEmptyLine testID="session-work-step-nothing" text={t('sessionWork.step.nothingStarted')} />}
            </WorkSection>
        </>
    );
});
