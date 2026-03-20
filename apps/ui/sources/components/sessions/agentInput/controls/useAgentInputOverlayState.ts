import * as React from 'react';
import type { View } from 'react-native';

import type { AgentInputExtraActionChip, AgentInputPopoverAnchor } from '../agentInputContracts';

export function useAgentInputOverlayState(params: Readonly<{
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    shouldRenderSessionModeChip: boolean;
    canChangePermission: boolean;
    hasProfilePopover: boolean;
    hasEnvVarsPopover: boolean;
    hasAgentPickerOptions: boolean;
}>): Readonly<{
    overlayAnchorRef: React.RefObject<View | null>;
    actionMenuAnchorRef: React.RefObject<View | null>;
    agentChipAnchorRef: React.RefObject<View | null>;
    permissionChipAnchorRef: React.RefObject<View | null>;
    sessionModeChipAnchorRef: React.RefObject<View | null>;
    profileChipAnchorRef: React.RefObject<View | null>;
    envVarsChipAnchorRef: React.RefObject<View | null>;
    showActionMenu: boolean;
    setShowActionMenu: React.Dispatch<React.SetStateAction<boolean>>;
    closeActionMenu: () => void;
    showAgentPicker: boolean;
    setShowAgentPicker: React.Dispatch<React.SetStateAction<boolean>>;
    closeAgentPicker: () => void;
    agentPickerAnchor: AgentInputPopoverAnchor;
    setAgentPickerAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    showSessionModePicker: boolean;
    setShowSessionModePicker: React.Dispatch<React.SetStateAction<boolean>>;
    closeSessionModePicker: () => void;
    sessionModePickerAnchor: AgentInputPopoverAnchor;
    setSessionModePickerAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    showPermissionPopover: boolean;
    setShowPermissionPopover: React.Dispatch<React.SetStateAction<boolean>>;
    closePermissionPopover: () => void;
    showProfilePopover: boolean;
    setShowProfilePopover: React.Dispatch<React.SetStateAction<boolean>>;
    closeProfilePopover: () => void;
    profilePopoverAnchor: AgentInputPopoverAnchor;
    setProfilePopoverAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    showEnvVarsPopover: boolean;
    setShowEnvVarsPopover: React.Dispatch<React.SetStateAction<boolean>>;
    closeEnvVarsPopover: () => void;
    envVarsPopoverAnchor: AgentInputPopoverAnchor;
    setEnvVarsPopoverAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    activeExtraCollapsedPopoverChip: AgentInputExtraActionChip | null;
    setActiveExtraCollapsedPopoverChipKey: React.Dispatch<React.SetStateAction<string | null>>;
    closeActiveExtraCollapsedPopoverChip: () => void;
}> {
    const [showActionMenu, setShowActionMenu] = React.useState(false);
    const [showAgentPicker, setShowAgentPicker] = React.useState(false);
    const [agentPickerAnchor, setAgentPickerAnchor] = React.useState<AgentInputPopoverAnchor>('chip');
    const [showSessionModePicker, setShowSessionModePicker] = React.useState(false);
    const [sessionModePickerAnchor, setSessionModePickerAnchor] = React.useState<AgentInputPopoverAnchor>('chip');
    const [activeExtraCollapsedPopoverChipKey, setActiveExtraCollapsedPopoverChipKey] = React.useState<string | null>(null);
    const [showPermissionPopover, setShowPermissionPopover] = React.useState(false);
    const [showProfilePopover, setShowProfilePopover] = React.useState(false);
    const [profilePopoverAnchor, setProfilePopoverAnchor] = React.useState<AgentInputPopoverAnchor>('chip');
    const [showEnvVarsPopover, setShowEnvVarsPopover] = React.useState(false);
    const [envVarsPopoverAnchor, setEnvVarsPopoverAnchor] = React.useState<AgentInputPopoverAnchor>('chip');

    const activeExtraCollapsedPopoverChip = React.useMemo(() => {
        if (!activeExtraCollapsedPopoverChipKey) return null;
        return (
            (params.extraActionChips ?? []).find((chip) => (
                chip.key === activeExtraCollapsedPopoverChipKey
                && chip.controlId
                && chip.collapsedOptionsPopover
                && chip.collapsedOptionsPopover.options.length > 0
            )) ?? null
        );
    }, [activeExtraCollapsedPopoverChipKey, params.extraActionChips]);

    const overlayAnchorRef = React.useRef<View>(null);
    const actionMenuAnchorRef = React.useRef<View>(null);
    const agentChipAnchorRef = React.useRef<View>(null);
    const permissionChipAnchorRef = React.useRef<View>(null);
    const sessionModeChipAnchorRef = React.useRef<View>(null);
    const profileChipAnchorRef = React.useRef<View>(null);
    const envVarsChipAnchorRef = React.useRef<View>(null);

    React.useEffect(() => {
        if (!params.shouldRenderSessionModeChip && showSessionModePicker) {
            setShowSessionModePicker(false);
        }
    }, [params.shouldRenderSessionModeChip, showSessionModePicker]);

    React.useEffect(() => {
        if (!params.canChangePermission && showPermissionPopover) {
            setShowPermissionPopover(false);
        }
    }, [params.canChangePermission, showPermissionPopover]);

    React.useEffect(() => {
        if (!activeExtraCollapsedPopoverChip && activeExtraCollapsedPopoverChipKey) {
            setActiveExtraCollapsedPopoverChipKey(null);
        }
    }, [activeExtraCollapsedPopoverChip, activeExtraCollapsedPopoverChipKey]);

    React.useEffect(() => {
        if (
            !activeExtraCollapsedPopoverChipKey
            || (!showActionMenu
                && !showPermissionPopover
                && !showAgentPicker
                && !showSessionModePicker
                && !showProfilePopover
                && !showEnvVarsPopover)
        ) {
            return;
        }
        setActiveExtraCollapsedPopoverChipKey(null);
    }, [
        activeExtraCollapsedPopoverChipKey,
        showActionMenu,
        showPermissionPopover,
        showAgentPicker,
        showSessionModePicker,
        showProfilePopover,
        showEnvVarsPopover,
    ]);

    React.useEffect(() => {
        if (!params.hasProfilePopover && showProfilePopover) {
            setShowProfilePopover(false);
        }
    }, [params.hasProfilePopover, showProfilePopover]);

    React.useEffect(() => {
        if (!params.hasEnvVarsPopover && showEnvVarsPopover) {
            setShowEnvVarsPopover(false);
        }
    }, [params.hasEnvVarsPopover, showEnvVarsPopover]);

    React.useEffect(() => {
        if (!params.hasAgentPickerOptions && showAgentPicker) {
            setShowAgentPicker(false);
        }
    }, [params.hasAgentPickerOptions, showAgentPicker]);

    const closeActionMenu = React.useCallback(() => {
        setShowActionMenu(false);
    }, []);

    const closeAgentPicker = React.useCallback(() => {
        setShowAgentPicker(false);
    }, []);

    const closeSessionModePicker = React.useCallback(() => {
        setShowSessionModePicker(false);
    }, []);

    const closePermissionPopover = React.useCallback(() => {
        setShowPermissionPopover(false);
    }, []);

    const closeProfilePopover = React.useCallback(() => {
        setShowProfilePopover(false);
    }, []);

    const closeEnvVarsPopover = React.useCallback(() => {
        setShowEnvVarsPopover(false);
    }, []);

    const closeActiveExtraCollapsedPopoverChip = React.useCallback(() => {
        setActiveExtraCollapsedPopoverChipKey(null);
    }, []);

    return {
        overlayAnchorRef,
        actionMenuAnchorRef,
        agentChipAnchorRef,
        permissionChipAnchorRef,
        sessionModeChipAnchorRef,
        profileChipAnchorRef,
        envVarsChipAnchorRef,
        showActionMenu,
        setShowActionMenu,
        closeActionMenu,
        showAgentPicker,
        setShowAgentPicker,
        closeAgentPicker,
        agentPickerAnchor,
        setAgentPickerAnchor,
        showSessionModePicker,
        setShowSessionModePicker,
        closeSessionModePicker,
        sessionModePickerAnchor,
        setSessionModePickerAnchor,
        showPermissionPopover,
        setShowPermissionPopover,
        closePermissionPopover,
        showProfilePopover,
        setShowProfilePopover,
        closeProfilePopover,
        profilePopoverAnchor,
        setProfilePopoverAnchor,
        showEnvVarsPopover,
        setShowEnvVarsPopover,
        closeEnvVarsPopover,
        envVarsPopoverAnchor,
        setEnvVarsPopoverAnchor,
        activeExtraCollapsedPopoverChip,
        setActiveExtraCollapsedPopoverChipKey,
        closeActiveExtraCollapsedPopoverChip,
    };
}
