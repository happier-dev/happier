import * as React from 'react';
import type { View } from 'react-native';

import { t } from '@/text';
import {
    getPermissionModeTitleForAgentType,
} from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { EffectivePermissionModeDescription } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import { AgentInputContentPopover, type AgentInputContentPopoverConfig } from './AgentInputContentPopover';
import { AgentInputActionMenuPopoverContent } from './AgentInputActionMenuPopoverContent';
import { AgentInputChipPickerPopover } from './AgentInputChipPickerPopover';
import { shouldShowAgentInputChipPickerRail } from './AgentInputChipPickerLayout';
import { AgentInputSelectionListPopover } from './AgentInputSelectionListPopover';
import { PermissionModePicker, type PermissionModePickerOption } from './PermissionModePicker';
import type { PermissionModePickerStyles } from './permissionModePickerStyles';
import type { AgentInputExtraActionChip, AgentInputPopoverAnchor } from '../agentInputContracts';
import type { AgentId } from '@/agents/catalog/catalog';
import type { AgentInputChipPickerOption } from './AgentInputChipPickerTypes';
import type { SelectionListStep } from '@/components/ui/selectionList';

type SimpleOption = Readonly<{
    id: string;
    label: string;
    description?: string;
    bullets?: readonly string[];
    badgeLabel?: string | null;
    detail?: React.ReactNode;
    rightAdornment?: React.ReactNode;
}>;

type SharedContentPopoverLike = Readonly<{
    renderContent: AgentInputContentPopoverConfig['renderContent'];
    boundaryRef?: AgentInputContentPopoverConfig['boundaryRef'];
    maxHeightCap?: AgentInputContentPopoverConfig['maxHeightCap'];
    maxWidthCap?: AgentInputContentPopoverConfig['maxWidthCap'];
    scrollEnabled?: AgentInputContentPopoverConfig['scrollEnabled'];
    keyboardShouldPersistTaps?: AgentInputContentPopoverConfig['keyboardShouldPersistTaps'];
    edgeFades?: AgentInputContentPopoverConfig['edgeFades'];
    edgeIndicators?: AgentInputContentPopoverConfig['edgeIndicators'];
    initialVisibility?: AgentInputContentPopoverConfig['initialVisibility'];
}>;

type AgentInputContentPopoverEntry = Readonly<{
    key: string;
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    boundaryRef?: React.RefObject<View | null> | null;
    content: AgentInputContentPopoverConfig['renderContent'];
    onRequestClose: () => void;
    maxHeightCap?: AgentInputContentPopoverConfig['maxHeightCap'];
    maxWidthCap?: AgentInputContentPopoverConfig['maxWidthCap'];
    scrollEnabled?: AgentInputContentPopoverConfig['scrollEnabled'];
    keyboardShouldPersistTaps?: AgentInputContentPopoverConfig['keyboardShouldPersistTaps'];
    edgeFades?: AgentInputContentPopoverConfig['edgeFades'];
    edgeIndicators?: AgentInputContentPopoverConfig['edgeIndicators'];
    initialVisibility?: AgentInputContentPopoverConfig['initialVisibility'];
}>;

function resolvePopoverAnchorRef(
    anchor: AgentInputPopoverAnchor,
    chipAnchorRef: React.RefObject<View | null>,
    actionMenuAnchorRef: React.RefObject<View | null>,
): React.RefObject<View | null> {
    return anchor === 'chip' ? chipAnchorRef : actionMenuAnchorRef;
}

function renderContentPopover(entry: AgentInputContentPopoverEntry): React.ReactNode {
    if (!entry.open) return null;
    return (
        <AgentInputContentPopover
            key={entry.key}
            open={entry.open}
            anchorRef={entry.anchorRef}
            boundaryRef={entry.boundaryRef}
            content={entry.content}
            onRequestClose={entry.onRequestClose}
            maxHeightCap={entry.maxHeightCap}
            maxWidthCap={entry.maxWidthCap}
            scrollEnabled={entry.scrollEnabled}
            keyboardShouldPersistTaps={entry.keyboardShouldPersistTaps}
            edgeFades={entry.edgeFades}
            edgeIndicators={entry.edgeIndicators}
            initialVisibility={entry.initialVisibility}
        />
    );
}

function resolveSharedContentPopoverOptions(
    popover: SharedContentPopoverLike,
): Pick<
    AgentInputContentPopoverEntry,
    | 'boundaryRef'
    | 'maxHeightCap'
    | 'maxWidthCap'
    | 'scrollEnabled'
    | 'keyboardShouldPersistTaps'
    | 'edgeFades'
    | 'edgeIndicators'
    | 'initialVisibility'
> {
    return {
        boundaryRef: popover.boundaryRef as React.RefObject<View | null> | null | undefined,
        maxHeightCap: popover.maxHeightCap,
        maxWidthCap: popover.maxWidthCap,
        scrollEnabled: popover.scrollEnabled,
        keyboardShouldPersistTaps: popover.keyboardShouldPersistTaps,
        edgeFades: popover.edgeFades,
        edgeIndicators: popover.edgeIndicators,
        initialVisibility: popover.initialVisibility,
    };
}

export function AgentInputOverlayLayer(props: Readonly<{
    overlayAnchorRef: React.RefObject<View | null>;
    screenWidth: number;

    showPermissionPopover: boolean;
    permissionChipAnchorRef: React.RefObject<View | null>;
    onPermissionPopoverRequestClose: () => void;
    onPermissionSelect: (mode: PermissionMode) => void;
    agentId: AgentId;
    permissionModeOptions: readonly PermissionModePickerOption[];
    effectivePermissionMode: PermissionMode;
    effectivePermissionLabel: string;
    effectivePermissionPolicy: EffectivePermissionModeDescription;
    // FR4-16: typed style contract forwarded to `PermissionModePicker`.
    // The parent `AgentInput.tsx` passes a Unistyles-produced styles object;
    // because Unistyles' inferred output type may not structurally match this
    // narrow contract, the call site uses a documented boundary cast
    // (`as unknown as PermissionModePickerStyles`). This is the only place in
    // the overlay routing where styles are forwarded, so the contract narrows
    // an otherwise opaque object to exactly the fields the picker reads.
    styles: PermissionModePickerStyles;

    showActionMenu: boolean;
    hasActionMenuPopoverSections: boolean;
    actionMenuAnchorRef: React.RefObject<View | null>;
    onActionMenuRequestClose: () => void;
    actionMenuActions: React.ComponentProps<typeof AgentInputActionMenuPopoverContent>['actionMenuActions'];
    maxWidthCap: number;

    showAgentPicker: boolean;
    hasAgentPickerOptions: boolean;
    agentPickerAnchor: AgentInputPopoverAnchor;
    agentChipAnchorRef: React.RefObject<View | null>;
    agentPickerTitle: string;
    agentPickerOptions: ReadonlyArray<AgentInputChipPickerOption>;
    effectiveAgentPickerSelectedOptionId?: string | null;
    onAgentPickerSelect?: (selectedId: string) => void;
    onAgentPickerRequestClose: () => void;
    agentPickerApplyLabel?: string;
    agentPickerDetailPaneHeaderAccessory?: React.ReactNode;

    showSessionModePicker: boolean;
    shouldRenderSessionModeChip: boolean;
    sessionModePickerAnchor: AgentInputPopoverAnchor;
    sessionModeChipAnchorRef: React.RefObject<View | null>;
    sessionModePickerOptions: ReadonlyArray<SimpleOption>;
    sessionModeSelectedOptionId?: string | null;
    onSessionModeSelect?: (selectedId: string) => void;
    onSessionModeRequestClose: () => void;

    activeExtraCollapsedPopoverChip: AgentInputExtraActionChip | null;
    activeExtraCollapsedPopoverAnchor: AgentInputPopoverAnchor;
    extraChipAnchorRefsByKey: Readonly<Record<string, React.RefObject<View | null>>>;
    onActiveExtraCollapsedPopoverChipClose: () => void;

    showMachinePopover: boolean;
    machinePopoverAnchor: AgentInputPopoverAnchor;
    machineChipAnchorRef: React.RefObject<View | null>;
    machinePopover?: SharedContentPopoverLike;
    onMachinePopoverRequestClose: () => void;

    showProfilePopover: boolean;
    profilePopoverAnchor: AgentInputPopoverAnchor;
    profileChipAnchorRef: React.RefObject<View | null>;
    profilePopover?: SharedContentPopoverLike;
    onProfilePopoverRequestClose: () => void;

    showPathPopover: boolean;
    pathPopoverAnchor: AgentInputPopoverAnchor;
    pathChipAnchorRef: React.RefObject<View | null>;
    pathPopover?: SharedContentPopoverLike;
    onPathPopoverRequestClose: () => void;

    showResumePopover: boolean;
    resumePopoverAnchor: AgentInputPopoverAnchor;
    resumeChipAnchorRef: React.RefObject<View | null>;
    resumePopover?: SharedContentPopoverLike;
    onResumePopoverRequestClose: () => void;

    showEnvVarsPopover: boolean;
    envVarsPopoverAnchor: AgentInputPopoverAnchor;
    envVarsChipAnchorRef: React.RefObject<View | null>;
    envVarsPopover?: SharedContentPopoverLike;
    onEnvVarsPopoverRequestClose: () => void;
}>): React.ReactNode {
    const sharedContentPopovers: AgentInputContentPopoverEntry[] = [
        {
            key: 'permission',
            open: props.showPermissionPopover,
            anchorRef: props.permissionChipAnchorRef,
            content: (
                <PermissionModePicker
                    title={getPermissionModeTitleForAgentType(props.agentId)}
                    options={props.permissionModeOptions}
                    selected={props.effectivePermissionMode}
                    onSelect={props.onPermissionSelect}
                    styles={props.styles}
                    effectivePermissionLabel={props.effectivePermissionLabel}
                    effectivePermissionPolicy={props.effectivePermissionPolicy}
                />
            ),
            onRequestClose: props.onPermissionPopoverRequestClose,
            maxHeightCap: 420,
            maxWidthCap: 420,
        },
        {
            key: 'actionMenu',
            open: props.showActionMenu && props.hasActionMenuPopoverSections,
            anchorRef: props.actionMenuAnchorRef,
            content: (
                <AgentInputActionMenuPopoverContent actionMenuActions={props.actionMenuActions} />
            ),
            onRequestClose: props.onActionMenuRequestClose,
            maxHeightCap: 400,
            maxWidthCap: props.maxWidthCap,
            scrollEnabled: true,
            keyboardShouldPersistTaps: 'always',
            edgeFades: { top: true, bottom: true, size: 28 },
            edgeIndicators: true,
            initialVisibility: { bottom: true },
        },
    ];

    if (props.activeExtraCollapsedPopoverChip?.collapsedContentPopover) {
        sharedContentPopovers.push({
            key: `collapsedExtra:${props.activeExtraCollapsedPopoverChip.key}`,
            open: true,
            anchorRef: props.activeExtraCollapsedPopoverAnchor === 'chip'
                ? (props.extraChipAnchorRefsByKey[props.activeExtraCollapsedPopoverChip.key] ?? props.actionMenuAnchorRef)
                : props.actionMenuAnchorRef,
            content: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.renderContent,
            onRequestClose: props.onActiveExtraCollapsedPopoverChipClose,
            boundaryRef: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.boundaryRef as React.RefObject<View | null> | null | undefined,
            maxHeightCap: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.maxHeightCap,
            maxWidthCap: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.maxWidthCap,
            scrollEnabled: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.scrollEnabled,
            keyboardShouldPersistTaps: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.keyboardShouldPersistTaps,
            edgeFades: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.edgeFades,
            edgeIndicators: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.edgeIndicators,
            initialVisibility: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.initialVisibility,
        });
    }

    if (props.machinePopover) {
        sharedContentPopovers.push({
            key: 'machine',
            open: props.showMachinePopover,
            anchorRef: resolvePopoverAnchorRef(props.machinePopoverAnchor, props.machineChipAnchorRef, props.actionMenuAnchorRef),
            content: props.machinePopover.renderContent,
            onRequestClose: props.onMachinePopoverRequestClose,
            ...resolveSharedContentPopoverOptions(props.machinePopover),
        });
    }

    if (props.profilePopover) {
        sharedContentPopovers.push({
            key: 'profile',
            open: props.showProfilePopover,
            anchorRef: resolvePopoverAnchorRef(props.profilePopoverAnchor, props.profileChipAnchorRef, props.actionMenuAnchorRef),
            content: props.profilePopover.renderContent,
            onRequestClose: props.onProfilePopoverRequestClose,
            ...resolveSharedContentPopoverOptions(props.profilePopover),
        });
    }

    if (props.pathPopover) {
        sharedContentPopovers.push({
            key: 'path',
            open: props.showPathPopover,
            anchorRef: resolvePopoverAnchorRef(props.pathPopoverAnchor, props.pathChipAnchorRef, props.actionMenuAnchorRef),
            content: props.pathPopover.renderContent,
            onRequestClose: props.onPathPopoverRequestClose,
            ...resolveSharedContentPopoverOptions(props.pathPopover),
        });
    }

    if (props.resumePopover) {
        sharedContentPopovers.push({
            key: 'resume',
            open: props.showResumePopover,
            anchorRef: resolvePopoverAnchorRef(props.resumePopoverAnchor, props.resumeChipAnchorRef, props.actionMenuAnchorRef),
            content: props.resumePopover.renderContent,
            onRequestClose: props.onResumePopoverRequestClose,
            ...resolveSharedContentPopoverOptions(props.resumePopover),
        });
    }

    if (props.envVarsPopover) {
        sharedContentPopovers.push({
            key: 'envVars',
            open: props.showEnvVarsPopover,
            anchorRef: resolvePopoverAnchorRef(props.envVarsPopoverAnchor, props.envVarsChipAnchorRef, props.actionMenuAnchorRef),
            content: props.envVarsPopover.renderContent,
            onRequestClose: props.onEnvVarsPopoverRequestClose,
            ...resolveSharedContentPopoverOptions(props.envVarsPopover),
        });
    }

    return (
        <>
            {sharedContentPopovers.map(renderContentPopover)}

            {props.showAgentPicker && props.hasAgentPickerOptions ? (
                <AgentInputChipPickerPopover
                    open={props.showAgentPicker}
                    anchorRef={props.agentPickerAnchor === 'chip' ? props.agentChipAnchorRef : props.actionMenuAnchorRef}
                    title={props.agentPickerTitle}
                    options={props.agentPickerOptions}
                    selectedOptionId={props.effectiveAgentPickerSelectedOptionId}
                    onSelect={(selectedId) => {
                        props.onAgentPickerSelect?.(selectedId);
                    }}
                    onRequestClose={props.onAgentPickerRequestClose}
                    applyLabel={props.agentPickerApplyLabel}
                    detailPaneHeaderAccessory={props.agentPickerDetailPaneHeaderAccessory}
                    detailContentOwnsScroll
                    // Keep the popover narrower when the detail rail is hidden so stacked layouts
                    // don't waste horizontal space.
                    maxWidthCap={shouldShowAgentInputChipPickerRail(props.agentPickerOptions, props.screenWidth) ? 720 : 570}
                    maxHeightCap={460}
                />
            ) : null}

            {props.showSessionModePicker && props.shouldRenderSessionModeChip ? (() => {
                const sessionModeRootStep: SelectionListStep = {
                    id: 'session-mode-root',
                    title: t('agentInput.mode.sectionTitle'),
                    sections: [
                        {
                            kind: 'static',
                            id: 'session-mode',
                            options: props.sessionModePickerOptions.map((option) => ({
                                id: option.id,
                                label: option.label,
                                subtitle: option.description,
                            })),
                        },
                    ],
                };
                return (
                    <AgentInputSelectionListPopover
                        open={props.showSessionModePicker}
                        anchorRef={props.sessionModePickerAnchor === 'chip' ? props.sessionModeChipAnchorRef : props.actionMenuAnchorRef}
                        rootStep={sessionModeRootStep}
                        selectedOptionId={props.sessionModeSelectedOptionId ?? null}
                        onSelect={(selectedId) => {
                            props.onSessionModeSelect?.(selectedId);
                        }}
                        onRequestClose={props.onSessionModeRequestClose}
                        maxHeightCap={360}
                    />
                );
            })() : null}

            {props.activeExtraCollapsedPopoverChip?.collapsedOptionsPopover ? (() => {
                const popover = props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover;
                const anchorRef = props.activeExtraCollapsedPopoverAnchor === 'chip'
                    ? (props.extraChipAnchorRefsByKey[props.activeExtraCollapsedPopoverChip.key] ?? props.actionMenuAnchorRef)
                    : props.actionMenuAnchorRef;

                if (popover.presentation === 'list') {
                    // R5's discriminated union enforces `rootStep` is present
                    // when `presentation === 'list'`, but R16d (Fix 4) adds a
                    // dev-only runtime guard so dynamic plugins / generic
                    // settings that erase the type at the boundary cannot
                    // crash the routing site by passing a structurally invalid
                    // descriptor. Returning null defensively (no UI) is better
                    // than rendering an empty/broken popover.
                    if (!popover.rootStep) {
                        if (typeof __DEV__ !== 'undefined' && __DEV__) {
                            // eslint-disable-next-line no-console
                            console.warn(
                                "[AgentInputOverlayLayer] collapsedOptionsPopover with presentation: 'list' is missing required `rootStep`; rendering nothing. This indicates a dynamic descriptor bypassed the discriminated union at the type boundary.",
                            );
                        }
                        return null;
                    }
                    // FR4-W1-CHIP: `AgentInputSelectionListPopover` is the
                    // SINGLE close-after-select owner. It calls per-row
                    // `SelectionListOption.onSelect` synchronously (the
                    // canonical action source for list-mode chips), then
                    // defers `onRequestClose` on web through
                    // `deferAgentInputPopoverClose` internally. The action-
                    // menu list branch therefore:
                    //   - passes a NO-OP `onSelect` (per-option callbacks
                    //     inside the SelectionList carry the action; the
                    //     descriptor-level `onSelect` is intentionally a
                    //     no-op for list-mode chips, see e.g.
                    //     `useNewSessionCheckoutActionChip.tsx`),
                    //   - passes `onRequestClose` directly so the wrapper's
                    //     deferred close path is the ONE close path.
                    // Calling `deferAgentInputPopoverClose(...)` here as well
                    // would schedule a duplicate close on top of the
                    // wrapper's own deferred close.
                    return (
                        <AgentInputSelectionListPopover
                            open
                            anchorRef={anchorRef}
                            rootStep={popover.rootStep}
                            selectedOptionId={popover.selectedOptionId ?? null}
                            onSelect={() => {
                                // Documented no-op: the wrapper handles
                                // close-after-select via `onRequestClose`
                                // (deferred internally on web). Per-row
                                // mutations live on
                                // `SelectionListOption.onSelect`.
                            }}
                            onRequestClose={props.onActiveExtraCollapsedPopoverChipClose}
                            maxHeightCap={popover.maxHeightCap}
                            maxWidthCap={popover.maxWidthCap}
                            heightBehavior={popover.heightBehavior}
                        />
                    );
                }

                // R16d (Fix 4): defensive runtime guard for the 'picker'
                // branch — same rationale as the 'list' branch above.
                if (!popover.options) {
                    if (typeof __DEV__ !== 'undefined' && __DEV__) {
                        // eslint-disable-next-line no-console
                        console.warn(
                            "[AgentInputOverlayLayer] collapsedOptionsPopover with presentation: 'picker' is missing required `options`; rendering nothing. This indicates a dynamic descriptor bypassed the discriminated union at the type boundary.",
                        );
                    }
                    return null;
                }

                return (
                    <AgentInputChipPickerPopover
                        open
                        anchorRef={anchorRef}
                        title={popover.title}
                        options={popover.options}
                        selectedOptionId={popover.selectedOptionId ?? null}
                        applyLabel={popover.applyLabel}
                        railWidth={popover.railWidth}
                        railMaxWidth={popover.railMaxWidth}
                        onSelect={(selectedId) => {
                            props.activeExtraCollapsedPopoverChip?.collapsedOptionsPopover?.onSelect(selectedId);
                            props.onActiveExtraCollapsedPopoverChipClose();
                        }}
                        onRequestClose={props.onActiveExtraCollapsedPopoverChipClose}
                        maxHeightCap={popover.maxHeightCap ?? 420}
                        maxWidthCap={popover.maxWidthCap ?? 360}
                    />
                );
            })() : null}

        </>
    );
}
