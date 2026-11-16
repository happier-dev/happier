import * as React from 'react';

import { useWorkRelativeTime } from '@/components/sessions/agents/presentation/agentActivityClock';
import { Text } from '@/components/ui/text/Text';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { t } from '@/text';

import { useWorkflowLibrarySummaries, type WorkflowLibraryRunSummary } from '../library/useWorkflowLibrarySummaries';
import { workflowEditorStyles } from './workflowEditorStyles';

/** The age observes the shared clock only while the value is shown. */
function LastRunSummary(props: Readonly<{ run: NonNullable<WorkflowLibraryRunSummary['lastRun']> }>) {
    const age = useWorkRelativeTime(Date.parse(props.run.finishedAt ?? props.run.startedAt));
    return <>{readWorkflowRunWorkStatusFacts(props.run).word} · {age}</>;
}

/**
 * A saved workflow's last run in words ("Completed · 42 min ago"), from the library's push-driven
 * source-summary owner: the value of More settings' "Last run" row.
 */
export function WorkflowLastRun(props: Readonly<{ definitionId: string; testID: string }>): React.ReactElement {
    const read = useWorkflowLibrarySummaries([props.definitionId]);
    const summary = read.summaries?.get(props.definitionId);
    return (
        <Text testID={props.testID} style={workflowEditorStyles.metaText}>
            {summary?.lastRun ? <LastRunSummary run={summary.lastRun} />
                : summary ? t('workflows.page.inspector.noRunsYet')
                : t(read.failed ? 'workflows.contentUnavailable' : 'common.loading')}
        </Text>
    );
}
