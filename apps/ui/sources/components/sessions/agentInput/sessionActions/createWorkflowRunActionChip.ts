import type { AgentInputExtraActionChip } from '../agentInputContracts';
import { createExecutionRunStartContentChip } from '@/components/sessions/runs/launcher/executionRunStartChips';
import type { AgentInputContentPopoverRenderArgs } from '../components/AgentInputContentPopover';
import type { ReactNode } from 'react';

/** Room for the picker's list beside its preview (lab T4-R); narrower windows keep the list alone. */
const WORKFLOW_START_PICKER_MAX_WIDTH_PX = 640;

/** Shared Run… descriptor. The composer owns intent/overflow; details mount only in its demanded content. */
export function createWorkflowRunActionChip(params: Readonly<{
    label: string;
    title: string;
    testID: string;
    disabled?: boolean;
    onIntent?: () => void;
    renderContent: (args: AgentInputContentPopoverRenderArgs) => ReactNode;
}>): AgentInputExtraActionChip {
    const chip = createExecutionRunStartContentChip({ ...params,
        key: 'workflow-start-definition', controlId: 'workflow', placementId: 'workflow', icon: 'git-branch' });
    return { ...chip, controlId: 'workflow', onIntent: params.onIntent,
        // A phone shows the picker as the shared bottom sheet rather than a card over the header (lab T4-Rp).
        // Wide enough for the list beside its preview (lab T4-R); narrower windows keep the list alone.
        collapsedContentPopover: { ...chip.collapsedContentPopover!, scrollEnabled: false, phonePresentation: 'sheet',
            maxWidthCap: WORKFLOW_START_PICKER_MAX_WIDTH_PX } };
}
