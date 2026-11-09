import * as React from 'react';
import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions';
import { createWorkflowRunActionChip } from '@/components/sessions/agentInput/sessionActions/createWorkflowRunActionChip';
import { WorkflowStartPicker, type WorkflowStartReference } from '@/components/workflows/run/WorkflowStartPicker';
import { createWorkflowStartDetailsTab } from '@/components/workflows/run/workflowStartDetailsModel';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useDiscussionWorkflowCapture } from './useDiscussionWorkflowCapture';

/** Data binding only. The Discussion composition owner places this shared chip. */
export function useDiscussionWorkflowRun(params: Readonly<{
    discussion: DiscussionAddressV1;
    accountLifetime: ServerAccountScopeLifetime;
    paneScopeId: string;
    disabled?: boolean;
}>) {
    const saveAsPattern = useDiscussionWorkflowCapture(params);
    const pane = useAppPaneScope(params.paneScopeId);
    const scoped = areServerProfileIdentifiersEquivalent(params.accountLifetime.scope.serverId, params.discussion.serverId);
    const select = React.useCallback((selection: WorkflowStartReference) => {
        if (!params.accountLifetime.isCurrent() || !scoped || params.disabled) return;
        pane.openDetailsTab(createWorkflowStartDetailsTab(selection.source, selection.name,
            { kind: 'discussion', discussion: params.discussion }), { intent: 'pinned', start: true });
    }, [pane, params.accountLifetime, params.disabled, params.discussion, scoped]);
    const chip = React.useMemo(() => createWorkflowRunActionChip({
        label: t('workflows.start.runPattern'), title: t('workflows.start.runPatternTitle'),
        testID: 'discussion-workflow-run-chip',
        currentUiContextCommandScope: 'discussion.workflow',
        disabled: params.disabled || !scoped,
        renderContent: ({ requestClose, maxHeight }) => <WorkflowStartPicker
            accountLifetime={params.accountLifetime} onSelectReference={select} onRequestClose={requestClose} maxHeight={maxHeight}
            currentUiContextCommandScope="discussion.workflow" />,
    }), [params.accountLifetime, params.disabled, scoped, select]);
    return { chip, select, saveAsPattern };
}
