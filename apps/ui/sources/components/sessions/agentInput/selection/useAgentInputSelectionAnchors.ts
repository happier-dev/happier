import * as React from 'react';
import type { View } from 'react-native';

export function useAgentInputSelectionAnchors(): Readonly<{
    overlayAnchorRef: React.RefObject<View | null>;
    actionMenuAnchorRef: React.RefObject<View | null>;
    agentChipAnchorRef: React.RefObject<View | null>;
    permissionChipAnchorRef: React.RefObject<View | null>;
    machineChipAnchorRef: React.RefObject<View | null>;
    sessionModeChipAnchorRef: React.RefObject<View | null>;
    pathChipAnchorRef: React.RefObject<View | null>;
    resumeChipAnchorRef: React.RefObject<View | null>;
    profileChipAnchorRef: React.RefObject<View | null>;
    envVarsChipAnchorRef: React.RefObject<View | null>;
}> {
    const overlayAnchorRef = React.useRef<View>(null);
    const actionMenuAnchorRef = React.useRef<View>(null);
    const agentChipAnchorRef = React.useRef<View>(null);
    const permissionChipAnchorRef = React.useRef<View>(null);
    const machineChipAnchorRef = React.useRef<View>(null);
    const sessionModeChipAnchorRef = React.useRef<View>(null);
    const pathChipAnchorRef = React.useRef<View>(null);
    const resumeChipAnchorRef = React.useRef<View>(null);
    const profileChipAnchorRef = React.useRef<View>(null);
    const envVarsChipAnchorRef = React.useRef<View>(null);

    return {
        overlayAnchorRef,
        actionMenuAnchorRef,
        agentChipAnchorRef,
        permissionChipAnchorRef,
        machineChipAnchorRef,
        sessionModeChipAnchorRef,
        pathChipAnchorRef,
        resumeChipAnchorRef,
        profileChipAnchorRef,
        envVarsChipAnchorRef,
    };
}
