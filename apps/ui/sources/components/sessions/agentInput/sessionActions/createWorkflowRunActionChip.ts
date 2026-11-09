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
    pending?: boolean;
    currentUiContextCommandScope?: AgentInputExtraActionChip['currentUiContextCommandScope'];
    onIntent?: () => void;
    renderContent: (args: AgentInputContentPopoverRenderArgs) => ReactNode;
}>): AgentInputExtraActionChip {
    const chip = createExecutionRunStartContentChip({ ...params,
        key: 'workflow-start-definition', controlId: 'workflow', placementId: 'workflow', icon: 'git-branch' });
    return { ...chip, controlId: 'workflow', onIntent: params.onIntent,
        currentUiContextCommandScope: params.currentUiContextCommandScope,
        // A phone shows the picker as the shared bottom sheet rather than a card over the header (lab T4-Rp).
        // Wide enough for the list beside its preview (lab T4-R); narrower windows keep the list alone.
        // The overflow row is named once, by its title: the chip's own "Run…" stays on the chip, never a second line under it.
        collapsedContentPopover: { ...chip.collapsedContentPopover!, label: params.title, scrollEnabled: false, phonePresentation: 'sheet',
            maxWidthCap: WORKFLOW_START_PICKER_MAX_WIDTH_PX } };
}
