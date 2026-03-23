import * as React from 'react';
import { Platform, type View } from 'react-native';

import { Popover } from '@/components/ui/popover';
import { t } from '@/text';
import {
    getPermissionModeTitleForAgentType,
} from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { EffectivePermissionModeDescription } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { AgentInputContentPopover, type AgentInputContentPopoverConfig } from './AgentInputContentPopover';
import { AgentInputActionMenuPopoverContent } from './AgentInputActionMenuPopoverContent';
import { AgentInputChipPickerPopover } from './AgentInputChipPickerPopover';
import { AgentInputSimpleOptionsPopover } from './AgentInputSimpleOptionsPopover';
import { PermissionModePicker, type PermissionModePickerOption } from './PermissionModePicker';
import type { AgentInputExtraActionChip, AgentInputPopoverAnchor } from '../agentInputContracts';
import type { AgentId } from '@/agents/catalog/catalog';
import type { AgentInputChipPickerOption } from './AgentInputChipPickerTypes';

type SuggestionItem = Readonly<{
    key: string;
    component?: React.ElementType;
}>;

type SimpleOption = Readonly<{
    id: string;
    label: string;
    description?: string;
    bullets?: readonly string[];
    badgeLabel?: string | null;
    detail?: React.ReactNode;
    rightAdornment?: React.ReactNode;
}>;

type ProfileOrEnvPopoverLike = Readonly<{
    renderContent: AgentInputContentPopoverConfig['renderContent'];
    boundaryRef?: AgentInputContentPopoverConfig['boundaryRef'];
    maxHeightCap?: AgentInputContentPopoverConfig['maxHeightCap'];
    maxWidthCap?: AgentInputContentPopoverConfig['maxWidthCap'];
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

export function AgentInputOverlayLayer(props: Readonly<{
    suggestions: readonly SuggestionItem[];
    overlayAnchorRef: React.RefObject<View | null>;
    screenWidth: number;
    autocompleteSelectedIndex: number;
    onAutocompleteSelect: (index: number) => void;

    showPermissionPopover: boolean;
    permissionChipAnchorRef: React.RefObject<View | null>;
    onPermissionPopoverRequestClose: () => void;
    onPermissionSelect: (mode: PermissionMode) => void;
    agentId: AgentId;
    permissionModeOptions: readonly PermissionModePickerOption[];
    effectivePermissionMode: PermissionMode;
    effectivePermissionLabel: string;
    effectivePermissionPolicy: EffectivePermissionModeDescription;
    styles: any;

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
    machinePopover?: ProfileOrEnvPopoverLike;
    onMachinePopoverRequestClose: () => void;

    showProfilePopover: boolean;
    profilePopoverAnchor: AgentInputPopoverAnchor;
    profileChipAnchorRef: React.RefObject<View | null>;
    profilePopover?: ProfileOrEnvPopoverLike;
    onProfilePopoverRequestClose: () => void;

    showPathPopover: boolean;
    pathPopoverAnchor: AgentInputPopoverAnchor;
    pathChipAnchorRef: React.RefObject<View | null>;
    pathPopover?: ProfileOrEnvPopoverLike;
    onPathPopoverRequestClose: () => void;

    showResumePopover: boolean;
    resumePopoverAnchor: AgentInputPopoverAnchor;
    resumeChipAnchorRef: React.RefObject<View | null>;
    resumePopover?: ProfileOrEnvPopoverLike;
    onResumePopoverRequestClose: () => void;

    showEnvVarsPopover: boolean;
    envVarsPopoverAnchor: AgentInputPopoverAnchor;
    envVarsChipAnchorRef: React.RefObject<View | null>;
    envVarsPopover?: ProfileOrEnvPopoverLike;
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
            boundaryRef: props.machinePopover.boundaryRef as React.RefObject<View | null> | null | undefined,
            maxHeightCap: props.machinePopover.maxHeightCap,
            maxWidthCap: props.machinePopover.maxWidthCap,
        });
    }

    if (props.profilePopover) {
        sharedContentPopovers.push({
            key: 'profile',
            open: props.showProfilePopover,
            anchorRef: resolvePopoverAnchorRef(props.profilePopoverAnchor, props.profileChipAnchorRef, props.actionMenuAnchorRef),
            content: props.profilePopover.renderContent,
            onRequestClose: props.onProfilePopoverRequestClose,
            boundaryRef: props.profilePopover.boundaryRef as React.RefObject<View | null> | null | undefined,
            maxHeightCap: props.profilePopover.maxHeightCap,
            maxWidthCap: props.profilePopover.maxWidthCap,
        });
    }

    if (props.pathPopover) {
        sharedContentPopovers.push({
            key: 'path',
            open: props.showPathPopover,
            anchorRef: resolvePopoverAnchorRef(props.pathPopoverAnchor, props.pathChipAnchorRef, props.actionMenuAnchorRef),
            content: props.pathPopover.renderContent,
            onRequestClose: props.onPathPopoverRequestClose,
            boundaryRef: props.pathPopover.boundaryRef as React.RefObject<View | null> | null | undefined,
            maxHeightCap: props.pathPopover.maxHeightCap,
            maxWidthCap: props.pathPopover.maxWidthCap,
        });
    }

    if (props.resumePopover) {
        sharedContentPopovers.push({
            key: 'resume',
            open: props.showResumePopover,
            anchorRef: resolvePopoverAnchorRef(props.resumePopoverAnchor, props.resumeChipAnchorRef, props.actionMenuAnchorRef),
            content: props.resumePopover.renderContent,
            onRequestClose: props.onResumePopoverRequestClose,
            boundaryRef: props.resumePopover.boundaryRef as React.RefObject<View | null> | null | undefined,
            maxHeightCap: props.resumePopover.maxHeightCap,
            maxWidthCap: props.resumePopover.maxWidthCap,
        });
    }

    if (props.envVarsPopover) {
        sharedContentPopovers.push({
            key: 'envVars',
            open: props.showEnvVarsPopover,
            anchorRef: resolvePopoverAnchorRef(props.envVarsPopoverAnchor, props.envVarsChipAnchorRef, props.actionMenuAnchorRef),
            content: props.envVarsPopover.renderContent,
            onRequestClose: props.onEnvVarsPopoverRequestClose,
            boundaryRef: props.envVarsPopover.boundaryRef as React.RefObject<View | null> | null | undefined,
            maxHeightCap: props.envVarsPopover.maxHeightCap,
            maxWidthCap: props.envVarsPopover.maxWidthCap,
        });
    }

    return (
        <>
            {props.suggestions.length > 0 && (
                <Popover
                    open={props.suggestions.length > 0}
                    anchorRef={props.overlayAnchorRef}
                    placement="top"
                    gap={8}
                    maxHeightCap={240}
                    maxWidthCap={props.maxWidthCap}
                    backdrop={false}
                    containerStyle={{ paddingHorizontal: props.screenWidth > 700 ? 0 : 8 }}
                >
                    {({ maxHeight }) => (
                        <AgentInputAutocomplete
                            maxHeight={maxHeight}
                            suggestions={props.suggestions.flatMap((suggestion) => {
                                if (typeof suggestion.component !== 'function') return [];
                                const Component = suggestion.component;
                                return [<Component key={suggestion.key} />];
                            })}
                            selectedIndex={props.autocompleteSelectedIndex}
                            onSelect={props.onAutocompleteSelect}
                            itemHeight={Platform.select({ ios: 42, default: 34 }) ?? 34}
                        />
                    )}
                </Popover>
            )}

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
                    maxHeightCap={460}
                />
            ) : null}

            {props.showSessionModePicker && props.shouldRenderSessionModeChip ? (
                <AgentInputSimpleOptionsPopover
                    open={props.showSessionModePicker}
                    anchorRef={props.sessionModePickerAnchor === 'chip' ? props.sessionModeChipAnchorRef : props.actionMenuAnchorRef}
                    title={t('agentInput.mode.sectionTitle')}
                    options={props.sessionModePickerOptions}
                    selectedOptionId={props.sessionModeSelectedOptionId ?? null}
                    onSelect={(selectedId) => {
                        props.onSessionModeSelect?.(selectedId);
                    }}
                    onRequestClose={props.onSessionModeRequestClose}
                    maxHeightCap={360}
                />
            ) : null}

            {props.activeExtraCollapsedPopoverChip?.collapsedOptionsPopover ? (
                <AgentInputChipPickerPopover
                    open
                    anchorRef={props.activeExtraCollapsedPopoverAnchor === 'chip'
                        ? (props.extraChipAnchorRefsByKey[props.activeExtraCollapsedPopoverChip.key] ?? props.actionMenuAnchorRef)
                        : props.actionMenuAnchorRef}
                    title={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.title}
                    options={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.options}
                    selectedOptionId={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.selectedOptionId ?? null}
                    applyLabel={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.applyLabel}
                    railWidth={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.railWidth}
                    railMaxWidth={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.railMaxWidth}
                    onSelect={(selectedId) => {
                        props.activeExtraCollapsedPopoverChip?.collapsedOptionsPopover?.onSelect(selectedId);
                        props.onActiveExtraCollapsedPopoverChipClose();
                    }}
                    onRequestClose={props.onActiveExtraCollapsedPopoverChipClose}
                    maxHeightCap={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.maxHeightCap ?? 420}
                    maxWidthCap={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.maxWidthCap ?? 360}
                />
            ) : null}

        </>
    );
}
