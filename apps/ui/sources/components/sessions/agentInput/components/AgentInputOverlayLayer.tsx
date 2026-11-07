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
import type { AgentInputChipPickerOption } from './AgentInputChipPickerTypes';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { DROPDOWN_MENU_MAX_WIDTH_PX } from '@/components/ui/forms/dropdown/DropdownMenu';
import { AgentInputActionMenuSubmenuContext, type AgentInputActionMenuSubmenu } from '../selection/agentInputActionMenuSubmenu';
import { useAgentInputActionMenuSubmenu } from './useAgentInputActionMenuSubmenu';

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
    onRequestClose?: AgentInputContentPopoverConfig['onRequestClose'];
    boundaryRef?: AgentInputContentPopoverConfig['boundaryRef'];
    maxHeightCap?: AgentInputContentPopoverConfig['maxHeightCap'];
    maxWidthCap?: AgentInputContentPopoverConfig['maxWidthCap'];
    scrollEnabled?: AgentInputContentPopoverConfig['scrollEnabled'];
    keyboardShouldPersistTaps?: AgentInputContentPopoverConfig['keyboardShouldPersistTaps'];
    edgeFades?: AgentInputContentPopoverConfig['edgeFades'];
    edgeIndicators?: AgentInputContentPopoverConfig['edgeIndicators'];
    initialVisibility?: AgentInputContentPopoverConfig['initialVisibility'];
    phonePresentation?: AgentInputContentPopoverConfig['phonePresentation'];
}>;

type AgentInputContentPopoverEntry = Readonly<{
    key: string;
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    /** Opened from a + menu row: rendered as that row's submenu. */
    submenu?: boolean;
    boundaryRef?: React.RefObject<View | null> | null;
    content: AgentInputContentPopoverConfig['renderContent'];
    header?: AgentInputContentPopoverConfig['header'];
    phonePresentation?: AgentInputContentPopoverConfig['phonePresentation'];
    onRequestClose: () => void;
    maxHeightCap?: AgentInputContentPopoverConfig['maxHeightCap'];
    maxWidthCap?: AgentInputContentPopoverConfig['maxWidthCap'];
    scrollEnabled?: AgentInputContentPopoverConfig['scrollEnabled'];
    keyboardShouldPersistTaps?: AgentInputContentPopoverConfig['keyboardShouldPersistTaps'];
    edgeFades?: AgentInputContentPopoverConfig['edgeFades'];
    edgeIndicators?: AgentInputContentPopoverConfig['edgeIndicators'];
    initialVisibility?: AgentInputContentPopoverConfig['initialVisibility'];
}>;

type AgentInputMenuAnchorRefs = Readonly<{
    actionMenu: React.RefObject<View | null>;
    actionMenuRow: React.RefObject<View | null>;
}>;

/** The one place a composer picker's anchor kind becomes the view it hangs from. */
function resolvePopoverAnchorRef(
    anchor: AgentInputPopoverAnchor,
    chipAnchorRef: React.RefObject<View | null> | undefined,
    menuAnchors: AgentInputMenuAnchorRefs,
): React.RefObject<View | null> {
    if (anchor === 'actionMenuRow') return menuAnchors.actionMenuRow;
    return anchor === 'chip' && chipAnchorRef ? chipAnchorRef : menuAnchors.actionMenu;
}

/** A picker a + menu row opened is that row's submenu (`AgentInputActionMenuSubmenuContext`). */
function withActionMenuSubmenu(
    anchor: AgentInputPopoverAnchor,
    submenu: AgentInputActionMenuSubmenu | null,
    node: React.ReactNode,
): React.ReactNode {
    if (anchor !== 'actionMenuRow' || !submenu || node === null) return node;
    return <AgentInputActionMenuSubmenuContext.Provider value={submenu}>{node}</AgentInputActionMenuSubmenuContext.Provider>;
}

function renderContentPopover(entry: AgentInputContentPopoverEntry, submenu: AgentInputActionMenuSubmenu | null): React.ReactNode {
    if (!entry.open) return null;
    return withActionMenuSubmenu(entry.submenu ? 'actionMenuRow' : 'chip', submenu,
        <AgentInputContentPopover
            key={entry.key}
            open={entry.open}
            anchorRef={entry.anchorRef}
            boundaryRef={entry.boundaryRef}
            content={entry.content}
            header={entry.header}
            phonePresentation={entry.phonePresentation}
            onRequestClose={entry.onRequestClose}
            maxHeightCap={entry.maxHeightCap}
            maxWidthCap={entry.maxWidthCap}
            scrollEnabled={entry.scrollEnabled}
            keyboardShouldPersistTaps={entry.keyboardShouldPersistTaps}
            edgeFades={entry.edgeFades}
            edgeIndicators={entry.edgeIndicators}
            initialVisibility={entry.initialVisibility}
        />,
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
    | 'phonePresentation'
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
        phonePresentation: popover.phonePresentation,
    };
}

export function AgentInputOverlayLayer(props: Readonly<{
    overlayAnchorRef: React.RefObject<View | null>;
    screenWidth: number;

    showPermissionPopover: boolean;
    permissionPopoverAnchor: AgentInputPopoverAnchor;
    permissionChipAnchorRef: React.RefObject<View | null>;
    onPermissionPopoverRequestClose: () => void;
    onPermissionSelect: (mode: PermissionMode) => void;
    agentId: string;
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
    /** The + menu row a picker opened from it hangs from (`actionMenuRow`). */
    actionMenuRowAnchorRef: React.RefObject<View | null>;
    /** The + menu opens its rows' pickers beside it (false where the menu is a phone sheet). */
    actionMenuPresentsSubmenus: boolean;
    /** A picker opened from a + menu row is open beside the menu. */
    actionMenuSubmenuOpen: boolean;
    /** Close the picker open beside the + menu and keep the menu open. */
    onActionMenuSubmenuReturn: () => void;
    onActionMenuRequestClose: () => void;
    actionMenuActions: React.ComponentProps<typeof AgentInputActionMenuPopoverContent>['actionMenuActions'];
    onCustomizeComposer?: () => void;
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
    // Where the menu does not present submenus (a phone sheet), a row's picker hangs from the + button.
    const menuAnchors: AgentInputMenuAnchorRefs = {
        actionMenu: props.actionMenuAnchorRef,
        actionMenuRow: props.actionMenuPresentsSubmenus ? props.actionMenuRowAnchorRef : props.actionMenuAnchorRef,
    };
    const actionMenuSubmenu = useAgentInputActionMenuSubmenu({
        actions: props.actionMenuActions,
        menuOpen: props.showActionMenu,
        submenuOpen: props.actionMenuSubmenuOpen,
        rowAnchorRef: props.actionMenuRowAnchorRef,
        returnToMenu: props.onActionMenuSubmenuReturn,
    });
    const submenu = props.actionMenuPresentsSubmenus ? actionMenuSubmenu.submenu : null;
    const sharedContentPopovers: AgentInputContentPopoverEntry[] = [
        {
            key: 'permission',
            open: props.showPermissionPopover,
            anchorRef: resolvePopoverAnchorRef(props.permissionPopoverAnchor, props.permissionChipAnchorRef, menuAnchors),
            submenu: props.permissionPopoverAnchor === 'actionMenuRow',
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
                <AgentInputActionMenuPopoverContent
                    actionMenuActions={actionMenuSubmenu.actions}
                    onCustomizeComposer={props.onCustomizeComposer}
                    onPointerLeave={actionMenuSubmenu.onMenuPointerLeave}
                />
            ),
            onRequestClose: props.onActionMenuRequestClose,
            // Tall enough for the lab's whole menu (add actions, every control placed In +, Customize) without scrolling.
            maxHeightCap: 560,
            // On a phone the menu is the shared bottom sheet (lab C2pp), like every other composer picker.
            phonePresentation: 'sheet',
            // The + menu is a menu (lab C2plus), never as wide as the composer it opens from.
            maxWidthCap: Math.min(DROPDOWN_MENU_MAX_WIDTH_PX, props.maxWidthCap),
            scrollEnabled: true,
            keyboardShouldPersistTaps: 'always',
            edgeFades: { top: true, bottom: true, size: 28 },
            edgeIndicators: true,
            initialVisibility: { bottom: true },
        },
    ];

    if (
        props.activeExtraCollapsedPopoverChip?.collapsedContentPopover
        && !props.activeExtraCollapsedPopoverChip.renderCollapsedPopover
    ) {
        sharedContentPopovers.push({
            key: `collapsedExtra:${props.activeExtraCollapsedPopoverChip.key}`,
            open: true,
            anchorRef: resolvePopoverAnchorRef(props.activeExtraCollapsedPopoverAnchor,
                props.extraChipAnchorRefsByKey[props.activeExtraCollapsedPopoverChip.key], menuAnchors),
            submenu: props.activeExtraCollapsedPopoverAnchor === 'actionMenuRow',
            content: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.renderContent,
            header: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.header,
            phonePresentation: props.activeExtraCollapsedPopoverChip.collapsedContentPopover.phonePresentation,
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
            anchorRef: resolvePopoverAnchorRef(props.machinePopoverAnchor, props.machineChipAnchorRef, menuAnchors),
            submenu: props.machinePopoverAnchor === 'actionMenuRow',
            content: props.machinePopover.renderContent,
            onRequestClose: props.onMachinePopoverRequestClose,
            ...resolveSharedContentPopoverOptions(props.machinePopover),
        });
    }

    if (props.profilePopover) {
        sharedContentPopovers.push({
            key: 'profile',
            open: props.showProfilePopover,
            anchorRef: resolvePopoverAnchorRef(props.profilePopoverAnchor, props.profileChipAnchorRef, menuAnchors),
            submenu: props.profilePopoverAnchor === 'actionMenuRow',
            content: props.profilePopover.renderContent,
            onRequestClose: props.onProfilePopoverRequestClose,
            ...resolveSharedContentPopoverOptions(props.profilePopover),
        });
    }

    if (props.pathPopover) {
        sharedContentPopovers.push({
            key: 'path',
            open: props.showPathPopover,
            anchorRef: resolvePopoverAnchorRef(props.pathPopoverAnchor, props.pathChipAnchorRef, menuAnchors),
            submenu: props.pathPopoverAnchor === 'actionMenuRow',
            content: props.pathPopover.renderContent,
            onRequestClose: props.onPathPopoverRequestClose,
            ...resolveSharedContentPopoverOptions(props.pathPopover),
        });
    }

    if (props.resumePopover) {
        sharedContentPopovers.push({
            key: 'resume',
            open: props.showResumePopover,
            anchorRef: resolvePopoverAnchorRef(props.resumePopoverAnchor, props.resumeChipAnchorRef, menuAnchors),
            submenu: props.resumePopoverAnchor === 'actionMenuRow',
            content: props.resumePopover.renderContent,
            onRequestClose: props.onResumePopoverRequestClose,
            ...resolveSharedContentPopoverOptions(props.resumePopover),
        });
    }

    if (props.envVarsPopover) {
        sharedContentPopovers.push({
            key: 'envVars',
            open: props.showEnvVarsPopover,
            anchorRef: resolvePopoverAnchorRef(props.envVarsPopoverAnchor, props.envVarsChipAnchorRef, menuAnchors),
            submenu: props.envVarsPopoverAnchor === 'actionMenuRow',
            content: props.envVarsPopover.renderContent,
            onRequestClose: props.onEnvVarsPopoverRequestClose,
            ...resolveSharedContentPopoverOptions(props.envVarsPopover),
        });
    }

    return (
        <>
            {sharedContentPopovers.map((entry) => (
                <React.Fragment key={entry.key}>{renderContentPopover(entry, submenu)}</React.Fragment>
            ))}

            {props.showAgentPicker && props.hasAgentPickerOptions ? withActionMenuSubmenu(props.agentPickerAnchor, submenu,
                <AgentInputChipPickerPopover
                    open={props.showAgentPicker}
                    anchorRef={resolvePopoverAnchorRef(props.agentPickerAnchor, props.agentChipAnchorRef, menuAnchors)}
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
                    maxWidthCap={shouldShowAgentInputChipPickerRail(props.agentPickerOptions, props.screenWidth) ? props.maxWidthCap : 570}
                    // The lab's engine popover height (MP3); like every chip picker it hangs from its
                    // chip on the roomier side (owner 2026-10-12).
                    maxHeightCap={640}
                />,
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
                return withActionMenuSubmenu(props.sessionModePickerAnchor, submenu,
                    <AgentInputSelectionListPopover
                        open={props.showSessionModePicker}
                        anchorRef={resolvePopoverAnchorRef(props.sessionModePickerAnchor, props.sessionModeChipAnchorRef, menuAnchors)}
                        rootStep={sessionModeRootStep}
                        selectedOptionId={props.sessionModeSelectedOptionId ?? null}
                        onSelect={(selectedId) => {
                            props.onSessionModeSelect?.(selectedId);
                        }}
                        onRequestClose={props.onSessionModeRequestClose}
                        maxHeightCap={360}
                    />,
                );
            })() : null}

            {props.activeExtraCollapsedPopoverChip?.renderCollapsedPopover ? (() => {
                const chip = props.activeExtraCollapsedPopoverChip;
                const renderCollapsedPopover = chip.renderCollapsedPopover;
                if (!renderCollapsedPopover) return null;
                const anchorRef = resolvePopoverAnchorRef(props.activeExtraCollapsedPopoverAnchor,
                    props.extraChipAnchorRefsByKey[chip.key], menuAnchors);
                return withActionMenuSubmenu(props.activeExtraCollapsedPopoverAnchor, submenu, renderCollapsedPopover({
                    anchorRef,
                    onRequestClose: props.onActiveExtraCollapsedPopoverChipClose,
                }));
            })() : null}

            {!props.activeExtraCollapsedPopoverChip?.renderCollapsedPopover
                && props.activeExtraCollapsedPopoverChip?.collapsedOptionsPopover ? (() => {
                const popover = props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover;
                const anchorRef = resolvePopoverAnchorRef(props.activeExtraCollapsedPopoverAnchor,
                    props.extraChipAnchorRefsByKey[props.activeExtraCollapsedPopoverChip.key], menuAnchors);

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
                    return withActionMenuSubmenu(props.activeExtraCollapsedPopoverAnchor, submenu,
                        <AgentInputSelectionListPopover
                            open
                            anchorRef={anchorRef}
                            rootStep={popover.rootStep}
                            selectedOptionId={popover.selectedOptionId ?? null}
                            {...(popover.selection ? { selection: popover.selection } : {})}
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
                        />,
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

                return withActionMenuSubmenu(props.activeExtraCollapsedPopoverAnchor, submenu,
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
                            // A chip that reports its selection was refused —
                            // a Composer transaction conflict or a non-editable
                            // draft — keeps its overflow open instead of
                            // dismissing as if the choice had applied.
                            const applied = props.activeExtraCollapsedPopoverChip
                                ?.collapsedOptionsPopover?.onSelect(selectedId);
                            if (applied === false) return;
                            props.onActiveExtraCollapsedPopoverChipClose();
                        }}
                        onRequestClose={props.onActiveExtraCollapsedPopoverChipClose}
                        maxHeightCap={popover.maxHeightCap ?? 420}
                        maxWidthCap={popover.maxWidthCap ?? 360}
                    />,
                );
            })() : null}

        </>
    );
}
