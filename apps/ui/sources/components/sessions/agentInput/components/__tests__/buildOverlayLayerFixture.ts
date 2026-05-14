import * as React from 'react';
import type { View } from 'react-native';

import type { AgentInputOverlayLayer } from '../AgentInputOverlayLayer';
import type { PermissionModePickerStyles } from '../permissionModePickerStyles';

/**
 * Typed fixture builder for `AgentInputOverlayLayer` test props.
 *
 * The overlay's props are declared inline at the function signature, so we
 * derive the canonical prop shape via `React.ComponentProps<typeof
 * AgentInputOverlayLayer>`. The builder fills every required field with a
 * minimal, behaviorally-inert default so tests can spread it and override
 * only the slice they care about, without resorting to `as any`.
 */
export type AgentInputOverlayLayerProps = React.ComponentProps<typeof AgentInputOverlayLayer>;

function noopRef(): React.RefObject<View | null> {
    return { current: null } as React.RefObject<View | null>;
}

function buildDefaultOverlayLayerFixture(): AgentInputOverlayLayerProps {
    const sharedRef = noopRef();
    return {
        suggestions: [],
        overlayAnchorRef: sharedRef,
        screenWidth: 800,
        autocompleteSelectedIndex: 0,
        onAutocompleteSelect: () => {},

        showPermissionPopover: false,
        permissionChipAnchorRef: sharedRef,
        onPermissionPopoverRequestClose: () => {},
        onPermissionSelect: () => {},
        // The fixture intentionally uses one of the catalog AgentIds; tests
        // that care about the agent identity can override via `overrides`.
        agentId: 'codex',
        permissionModeOptions: [],
        effectivePermissionMode: 'default',
        effectivePermissionLabel: '',
        effectivePermissionPolicy: {
            effectiveMode: 'default',
            reasons: [],
            notes: [],
        },
        // FR4-16: the overlay accepts a typed `PermissionModePickerStyles`
        // contract. Tests get an inert empty-shape fixture; per-spec overrides
        // can refine individual fields.
        styles: ({
            overlaySection: {},
            overlaySectionTitle: {},
            overlayOptionRow: {},
            overlayOptionRowPressed: {},
            overlayRadioOuter: {},
            overlayRadioOuterSelected: {},
            overlayRadioOuterUnselected: {},
            overlayRadioInner: {},
            overlayOptionLabel: {},
            overlayOptionLabelSelected: {},
            overlayOptionLabelUnselected: {},
            overlayOptionDescription: {},
        } satisfies PermissionModePickerStyles),

        showActionMenu: false,
        hasActionMenuPopoverSections: false,
        actionMenuAnchorRef: sharedRef,
        onActionMenuRequestClose: () => {},
        actionMenuActions: [],
        maxWidthCap: 720,

        showAgentPicker: false,
        hasAgentPickerOptions: false,
        agentPickerAnchor: 'chip',
        agentChipAnchorRef: sharedRef,
        agentPickerTitle: '',
        agentPickerOptions: [],
        effectiveAgentPickerSelectedOptionId: null,
        onAgentPickerSelect: () => {},
        onAgentPickerRequestClose: () => {},

        showSessionModePicker: false,
        shouldRenderSessionModeChip: false,
        sessionModePickerAnchor: 'chip',
        sessionModeChipAnchorRef: sharedRef,
        sessionModePickerOptions: [],
        sessionModeSelectedOptionId: null,
        onSessionModeSelect: () => {},
        onSessionModeRequestClose: () => {},

        activeExtraCollapsedPopoverChip: null,
        activeExtraCollapsedPopoverAnchor: 'actionMenu',
        extraChipAnchorRefsByKey: {},
        onActiveExtraCollapsedPopoverChipClose: () => {},

        showMachinePopover: false,
        machinePopoverAnchor: 'chip',
        machineChipAnchorRef: sharedRef,
        onMachinePopoverRequestClose: () => {},

        showProfilePopover: false,
        profilePopoverAnchor: 'chip',
        profileChipAnchorRef: sharedRef,
        onProfilePopoverRequestClose: () => {},

        showPathPopover: false,
        pathPopoverAnchor: 'chip',
        pathChipAnchorRef: sharedRef,
        onPathPopoverRequestClose: () => {},

        showResumePopover: false,
        resumePopoverAnchor: 'chip',
        resumeChipAnchorRef: sharedRef,
        onResumePopoverRequestClose: () => {},

        showEnvVarsPopover: false,
        envVarsPopoverAnchor: 'chip',
        envVarsChipAnchorRef: sharedRef,
        onEnvVarsPopoverRequestClose: () => {},
    };
}

/**
 * Build a fully-typed `AgentInputOverlayLayer` props object with the given
 * overrides merged on top of the inert defaults. Returning a value satisfying
 * `AgentInputOverlayLayerProps` lets callers spread the result into JSX
 * without an `as any` escape.
 */
export function buildOverlayLayerFixture(
    overrides: Partial<AgentInputOverlayLayerProps> = {},
): AgentInputOverlayLayerProps {
    return {
        ...buildDefaultOverlayLayerFixture(),
        ...overrides,
    };
}
