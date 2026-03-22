import type { AgentInputExtraActionChip, AgentInputPopoverAnchor } from '../agentInputContracts';
import type { AgentInputSelectionOverlayState } from './agentInputSelectionOverlayTypes';

export function buildAgentInputSelectionOverlayViewModel(params: Readonly<{
    activeSelectionOverlay: AgentInputSelectionOverlayState | null;
    activeExtraCollapsedPopoverChip: AgentInputExtraActionChip | null;
    closeSelectionOverlay: (id?: AgentInputSelectionOverlayState['id']) => void;
}>): Readonly<{
    showAgentPicker: boolean;
    agentPickerAnchor: AgentInputPopoverAnchor;
    closeAgentPicker: () => void;
    showSessionModePicker: boolean;
    sessionModePickerAnchor: AgentInputPopoverAnchor;
    closeSessionModePicker: () => void;
    showPermissionPopover: boolean;
    closePermissionPopover: () => void;
    showMachinePopover: boolean;
    machinePopoverAnchor: AgentInputPopoverAnchor;
    closeMachinePopover: () => void;
    showPathPopover: boolean;
    pathPopoverAnchor: AgentInputPopoverAnchor;
    closePathPopover: () => void;
    showResumePopover: boolean;
    resumePopoverAnchor: AgentInputPopoverAnchor;
    closeResumePopover: () => void;
    showProfilePopover: boolean;
    profilePopoverAnchor: AgentInputPopoverAnchor;
    closeProfilePopover: () => void;
    showEnvVarsPopover: boolean;
    envVarsPopoverAnchor: AgentInputPopoverAnchor;
    closeEnvVarsPopover: () => void;
    activeExtraCollapsedPopoverChip: AgentInputExtraActionChip | null;
    activeExtraCollapsedPopoverAnchor: AgentInputPopoverAnchor;
    closeActiveExtraCollapsedPopoverChip: () => void;
}> {
    const activeOverlay = params.activeSelectionOverlay;

    return {
        showAgentPicker: activeOverlay?.id === 'agent',
        agentPickerAnchor: activeOverlay?.id === 'agent' ? activeOverlay.anchor : 'chip',
        closeAgentPicker: () => params.closeSelectionOverlay('agent'),
        showSessionModePicker: activeOverlay?.id === 'sessionMode',
        sessionModePickerAnchor: activeOverlay?.id === 'sessionMode' ? activeOverlay.anchor : 'chip',
        closeSessionModePicker: () => params.closeSelectionOverlay('sessionMode'),
        showPermissionPopover: activeOverlay?.id === 'permission',
        closePermissionPopover: () => params.closeSelectionOverlay('permission'),
        showMachinePopover: activeOverlay?.id === 'machine',
        machinePopoverAnchor: activeOverlay?.id === 'machine' ? activeOverlay.anchor : 'chip',
        closeMachinePopover: () => params.closeSelectionOverlay('machine'),
        showPathPopover: activeOverlay?.id === 'path',
        pathPopoverAnchor: activeOverlay?.id === 'path' ? activeOverlay.anchor : 'chip',
        closePathPopover: () => params.closeSelectionOverlay('path'),
        showResumePopover: activeOverlay?.id === 'resume',
        resumePopoverAnchor: activeOverlay?.id === 'resume' ? activeOverlay.anchor : 'chip',
        closeResumePopover: () => params.closeSelectionOverlay('resume'),
        showProfilePopover: activeOverlay?.id === 'profile',
        profilePopoverAnchor: activeOverlay?.id === 'profile' ? activeOverlay.anchor : 'chip',
        closeProfilePopover: () => params.closeSelectionOverlay('profile'),
        showEnvVarsPopover: activeOverlay?.id === 'envVars',
        envVarsPopoverAnchor: activeOverlay?.id === 'envVars' ? activeOverlay.anchor : 'chip',
        closeEnvVarsPopover: () => params.closeSelectionOverlay('envVars'),
        activeExtraCollapsedPopoverChip: activeOverlay?.id === 'collapsedExtra'
            ? params.activeExtraCollapsedPopoverChip
            : null,
        activeExtraCollapsedPopoverAnchor: activeOverlay?.id === 'collapsedExtra' ? activeOverlay.anchor : 'actionMenu',
        closeActiveExtraCollapsedPopoverChip: () => params.closeSelectionOverlay('collapsedExtra'),
    };
}
