import * as React from 'react';

import type { AgentInputExtraActionChip, AgentInputPopoverAnchor } from '../agentInputContracts';
import type {
    AgentInputSelectionOverlayId,
    AgentInputSelectionOverlayState,
} from './agentInputSelectionOverlayTypes';

function isCollapsedExtraOverlay(
    overlay: AgentInputSelectionOverlayState | null,
): overlay is Extract<AgentInputSelectionOverlayState, { id: 'collapsedExtra' }> {
    return overlay?.id === 'collapsedExtra';
}

function hasCollapsedExtraPopover(chip: AgentInputExtraActionChip): boolean {
    return Boolean(
        (
            chip.collapsedOptionsPopover
            && chip.collapsedOptionsPopover.options.length > 0
        )
        || chip.collapsedContentPopover,
    );
}

function isSelectionOverlaySupported(
    overlay: AgentInputSelectionOverlayState | null,
    params: Readonly<{
        shouldRenderSessionModeChip: boolean;
        canChangePermission: boolean;
        hasMachinePopover: boolean;
        hasPathPopover: boolean;
        hasResumePopover: boolean;
        hasProfilePopover: boolean;
        hasEnvVarsPopover: boolean;
        hasAgentPickerOptions: boolean;
        extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    }>,
): boolean {
    if (!overlay) return true;

    switch (overlay.id) {
        case 'agent':
            return params.hasAgentPickerOptions;
        case 'sessionMode':
            return params.shouldRenderSessionModeChip;
        case 'permission':
            return params.canChangePermission;
        case 'machine':
            return params.hasMachinePopover;
        case 'path':
            return params.hasPathPopover;
        case 'resume':
            return params.hasResumePopover;
        case 'profile':
            return params.hasProfilePopover;
        case 'envVars':
            return params.hasEnvVarsPopover;
        case 'collapsedExtra':
            return (params.extraActionChips ?? []).some((chip) => (
                chip.key === overlay.chipKey
                && chip.controlId
                && hasCollapsedExtraPopover(chip)
            ));
    }
}

export function useAgentInputSelectionOverlayController(params: Readonly<{
    shouldRenderSessionModeChip: boolean;
    canChangePermission: boolean;
    hasMachinePopover: boolean;
    hasPathPopover: boolean;
    hasResumePopover: boolean;
    hasProfilePopover: boolean;
    hasEnvVarsPopover: boolean;
    hasAgentPickerOptions: boolean;
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
}>): Readonly<{
    activeSelectionOverlay: AgentInputSelectionOverlayState | null;
    isSelectionOverlayOpen: (id: AgentInputSelectionOverlayId) => boolean;
    openSelectionOverlay: (
        id: AgentInputSelectionOverlayId,
        anchor: AgentInputPopoverAnchor,
        chipKey?: string,
    ) => void;
    toggleSelectionOverlay: (
        id: AgentInputSelectionOverlayId,
        anchor: AgentInputPopoverAnchor,
        chipKey?: string,
    ) => void;
    closeSelectionOverlay: (id?: AgentInputSelectionOverlayId) => void;
    resetSelectionOverlays: () => void;
    closeAllSelectionOverlays: () => void;
    activeExtraCollapsedPopoverChip: AgentInputExtraActionChip | null;
}> {
    const [activeSelectionOverlay, setActiveSelectionOverlay] = React.useState<AgentInputSelectionOverlayState | null>(null);

    const activeExtraCollapsedPopoverChip = React.useMemo(() => {
        if (!isCollapsedExtraOverlay(activeSelectionOverlay)) return null;
        const activeChipKey = activeSelectionOverlay.chipKey;
        return (
            (params.extraActionChips ?? []).find((chip) => (
                chip.key === activeChipKey
                && chip.controlId
                && hasCollapsedExtraPopover(chip)
            )) ?? null
        );
    }, [activeSelectionOverlay, params.extraActionChips]);

    React.useEffect(() => {
        if (!isSelectionOverlaySupported(activeSelectionOverlay, params)) {
            setActiveSelectionOverlay(null);
        }
    }, [
        activeSelectionOverlay,
        params.canChangePermission,
        params.extraActionChips,
        params.hasMachinePopover,
        params.hasAgentPickerOptions,
        params.hasPathPopover,
        params.hasResumePopover,
        params.hasEnvVarsPopover,
        params.hasProfilePopover,
        params.shouldRenderSessionModeChip,
    ]);

    const isSelectionOverlayOpen = React.useCallback((id: AgentInputSelectionOverlayId) => {
        return activeSelectionOverlay?.id === id;
    }, [activeSelectionOverlay]);

    const openSelectionOverlay = React.useCallback((
        id: AgentInputSelectionOverlayId,
        anchor: AgentInputPopoverAnchor,
        chipKey?: string,
    ) => {
        if (id === 'collapsedExtra') {
            if (!chipKey || chipKey.length === 0) {
                setActiveSelectionOverlay(null);
                return;
            }
            setActiveSelectionOverlay({ id, anchor, chipKey });
            return;
        }
        setActiveSelectionOverlay({ id, anchor });
    }, []);

    const toggleSelectionOverlay = React.useCallback((
        id: AgentInputSelectionOverlayId,
        anchor: AgentInputPopoverAnchor,
        chipKey?: string,
    ) => {
        setActiveSelectionOverlay((current) => {
            const collapsedChipKey = current?.id === 'collapsedExtra' ? current.chipKey : null;
            const matchesRequestedOverlay = current?.id === id
                && current.anchor === anchor
                && (id !== 'collapsedExtra' || collapsedChipKey === chipKey);
            if (matchesRequestedOverlay) {
                return null;
            }
            if (id === 'collapsedExtra') {
                if (!chipKey || chipKey.length === 0) return null;
                return { id, anchor, chipKey };
            }
            return { id, anchor };
        });
    }, []);

    const closeSelectionOverlay = React.useCallback((id?: AgentInputSelectionOverlayId) => {
        setActiveSelectionOverlay((current) => {
            if (!current) return null;
            if (!id || current.id === id) {
                return null;
            }
            return current;
        });
    }, []);

    const resetSelectionOverlays = React.useCallback(() => {
        setActiveSelectionOverlay(null);
    }, []);

    return {
        activeSelectionOverlay,
        isSelectionOverlayOpen,
        openSelectionOverlay,
        toggleSelectionOverlay,
        closeSelectionOverlay,
        resetSelectionOverlays,
        closeAllSelectionOverlays: resetSelectionOverlays,
        activeExtraCollapsedPopoverChip,
    };
}
