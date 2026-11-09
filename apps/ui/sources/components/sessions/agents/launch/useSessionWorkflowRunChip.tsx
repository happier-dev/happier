import * as React from 'react';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createWorkflowRunActionChip } from '@/components/sessions/agentInput/sessionActions/createWorkflowRunActionChip';
import { WorkflowStartPicker, type WorkflowStartReference } from '@/components/workflows/run/WorkflowStartPicker';
import { t } from '@/text';

import { useSessionBuiltinWorkflowStart } from './useSessionBuiltinWorkflowStart';

/**
 * The Session composer's Run… chip: the shared Workflow picker (built-in, saved and plugin), then the
 * shared start composer with the composer's draft as the question. The run starts from this Session.
 * Closed, the chip mounts no library reads; the picker loads only inside its opened content.
 */
export function useSessionWorkflowRunChip(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    disabled?: boolean;
}>): AgentInputExtraActionChip {
    const start = useSessionBuiltinWorkflowStart({ sessionId: params.sessionId, serverId: params.serverId });
    const select = React.useCallback((selection: WorkflowStartReference) => {
        start(selection);
    }, [start]);
    return React.useMemo(() => createWorkflowRunActionChip({
        label: t('workflows.start.runPattern'),
        title: t('workflows.start.runPatternTitle'),
        testID: 'session-workflow-run-chip',
        currentUiContextCommandScope: 'session.workflow',
        disabled: params.disabled,
        renderContent: ({ requestClose, maxHeight }) => <WorkflowStartPicker hasOriginSession onSelectReference={select}
            onRequestClose={requestClose} maxHeight={maxHeight} currentUiContextCommandScope="session.workflow" />,
    }), [params.disabled, select]);
}
