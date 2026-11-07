import * as React from 'react';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { Button, ErrorState, LoadingState, PropertyList, Stack, Text, useExecutePluginAction, usePluginTranslation } from '@happier-dev/plugin-ui';
import { useTriageDetailRequest, type TriageSourceWriteSettlementV1 } from '@happier-dev/triage-sources/ui';
import { POSTHOG_ACTION_IDS, POSTHOG_PLUGIN_ID } from '../../posthogContracts.js';
import type { PosthogAssignmentReadV1 } from '../../source/detail/nativeOverviewContract.js';
import { PosthogIssueAssignInputV1Schema } from '../../source/writeContracts.js';

/** Native assignment is one property commit through the issue's existing declared writer. */
export function PosthogAssigneeProperty({ input, assignment, reading, held, settle, onRefresh }: Readonly<{
    input: TriageDetailSurfaceInputV1;
    assignment: PosthogAssignmentReadV1 | undefined;
    reading: boolean;
    held: boolean;
    settle: (id: string, execution: PluginUiActionControlExecution) => TriageSourceWriteSettlementV1 | null;
    onRefresh: () => void;
}>): React.ReactElement {
    const text = usePluginTranslation();
    const request = useTriageDetailRequest(input);
    const action = React.useMemo(() => ({ pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.assign }), []);
    const { execute, execution } = useExecutePluginAction(action);
    const choices = assignment?.kind === 'ready' ? assignment.choices : [];
    const current = assignment?.current;
    const currentChoice = current === undefined || current === null ? undefined : choices.find(choice =>
        choice.assignee.type === current.type && choice.assignee.id === current.id);
    const currentId = currentChoice === undefined ? null : `${currentChoice.assignee.type}:${currentChoice.assignee.id}`;
    const shown = current === null ? text('plugins.posthog.ui.assignment.unassigned', 'Unassigned') : currentChoice?.name;
    const commit = async (id: string | null) => {
        const choice = choices.find(candidate => `${candidate.assignee.type}:${candidate.assignee.id}` === id);
        const target = PosthogIssueAssignInputV1Schema.safeParse({ v: 1, ...request, assignee: id === null ? null : choice?.assignee });
        if (!target.success) return { status: 'refused' };
        const result = await execute(target.data);
        const settlement = result.status === 'success'
            ? settle('assign', { ok: true, result: result.result })
            : result.status === 'error' || result.status === 'outcomeUnknown'
                ? settle('assign', { ok: false, errorCode: result.code, error: result.message,
                    ...(result.status === 'outcomeUnknown' ? { effectAttempted: true } : {}) })
                : null;
        if (settlement === null) return { status: 'refused' };
        if (settlement.kind === 'applied' || settlement.kind === 'uncertain') onRefresh();
        // The containing source-write group presents the one settlement notice.
        return undefined;
    };
    return <Stack gap="small">
        {shown === undefined ? null : <PropertyList disabled={held || reading || assignment?.kind !== 'ready' || choices.length === 0} items={[{
            id: 'assignee', label: text('plugins.posthog.ui.assignment.label', 'Assignee'), value: shown,
            clearLabel: text('plugins.posthog.ui.assignment.unassigned', 'Unassigned'), busy: execution.status === 'pending',
            editor: { kind: 'choice', value: currentId, searchable: true,
                choices: choices.map(choice => ({ id: `${choice.assignee.type}:${choice.assignee.id}`, label: choice.name,
                    subtitle: choice.assignee.type === 'user' ? text('plugins.posthog.ui.assignment.user', 'User') : text('plugins.posthog.ui.assignment.role', 'Role') })),
                onCommit: commit },
        }]} />}
        {reading ? <LoadingState layout="line" title={text('plugins.posthog.ui.assignment.loading', 'Loading people…')} />
            : assignment?.kind === 'ready' && choices.length === 0
                ? <Text variant="meta" tone="secondary" value={text('plugins.posthog.ui.assignment.empty', 'No one to assign in {project}', { project: input.observation.snapshot.scopeLabel ?? 'PostHog' })} />
                : assignment?.kind !== 'ready' || shown === undefined
                ? <ErrorState layout="line" title={assignment?.kind === 'ready'
                    ? text('plugins.posthog.ui.assignment.currentUnavailable', 'Current assignee is unavailable')
                    : text('plugins.posthog.ui.assignment.failed', 'Could not load assignable people')}
                    action={<Button variant="plain" size="small" title={text('plugins.posthog.ui.assignment.retry', 'Retry')} onPress={onRefresh} />} />
                : null}
    </Stack>;
}
