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
    maxHeightCap?: AgentInputContentPopoverConfig['maxHeightCap'];
    maxWidthCap?: AgentInputContentPopoverConfig['maxWidthCap'];
}>;

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
    onActiveExtraCollapsedPopoverChipClose: () => void;

    showProfilePopover: boolean;
    profilePopoverAnchor: AgentInputPopoverAnchor;
    profileChipAnchorRef: React.RefObject<View | null>;
    profilePopover?: ProfileOrEnvPopoverLike;
    onProfilePopoverRequestClose: () => void;

    showEnvVarsPopover: boolean;
    envVarsPopoverAnchor: AgentInputPopoverAnchor;
    envVarsChipAnchorRef: React.RefObject<View | null>;
    envVarsPopover?: ProfileOrEnvPopoverLike;
    onEnvVarsPopoverRequestClose: () => void;
}>): React.ReactNode {
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

            {props.showPermissionPopover ? (
                <AgentInputContentPopover
                    open={props.showPermissionPopover}
                    anchorRef={props.permissionChipAnchorRef}
                    content={(
                        <PermissionModePicker
                            title={getPermissionModeTitleForAgentType(props.agentId)}
                            options={props.permissionModeOptions}
                            selected={props.effectivePermissionMode}
                            onSelect={props.onPermissionSelect}
                            styles={props.styles}
                            effectivePermissionLabel={props.effectivePermissionLabel}
                            effectivePermissionPolicy={props.effectivePermissionPolicy}
                        />
                    )}
                    onRequestClose={props.onPermissionPopoverRequestClose}
                    maxHeightCap={420}
                    maxWidthCap={420}
                />
            ) : null}

            {props.showActionMenu && props.hasActionMenuPopoverSections ? (
                <AgentInputContentPopover
                    open={props.showActionMenu}
                    anchorRef={props.actionMenuAnchorRef}
                    onRequestClose={props.onActionMenuRequestClose}
                    maxHeightCap={400}
                    maxWidthCap={props.maxWidthCap}
                    scrollEnabled={true}
                    keyboardShouldPersistTaps="always"
                    edgeFades={{ top: true, bottom: true, size: 28 }}
                    edgeIndicators={true}
                    initialVisibility={{ bottom: true }}
                    content={(
                        <AgentInputActionMenuPopoverContent actionMenuActions={props.actionMenuActions} />
                    )}
                />
            ) : null}

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
                <AgentInputSimpleOptionsPopover
                    open
                    anchorRef={props.actionMenuAnchorRef}
                    title={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.title}
                    options={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.options}
                    selectedOptionId={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.selectedOptionId ?? null}
                    onSelect={(selectedId) => {
                        props.activeExtraCollapsedPopoverChip?.collapsedOptionsPopover?.onSelect(selectedId);
                        props.onActiveExtraCollapsedPopoverChipClose();
                    }}
                    onRequestClose={props.onActiveExtraCollapsedPopoverChipClose}
                    maxHeightCap={props.activeExtraCollapsedPopoverChip.collapsedOptionsPopover.maxHeightCap ?? 320}
                />
            ) : null}

            {props.showProfilePopover && props.profilePopover ? (
                <AgentInputContentPopover
                    open={props.showProfilePopover}
                    anchorRef={props.profilePopoverAnchor === 'chip' ? props.profileChipAnchorRef : props.actionMenuAnchorRef}
                    content={props.profilePopover.renderContent}
                    onRequestClose={props.onProfilePopoverRequestClose}
                    maxHeightCap={props.profilePopover.maxHeightCap}
                    maxWidthCap={props.profilePopover.maxWidthCap}
                />
            ) : null}

            {props.showEnvVarsPopover && props.envVarsPopover ? (
                <AgentInputContentPopover
                    open={props.showEnvVarsPopover}
                    anchorRef={props.envVarsPopoverAnchor === 'chip' ? props.envVarsChipAnchorRef : props.actionMenuAnchorRef}
                    content={props.envVarsPopover.renderContent}
                    onRequestClose={props.onEnvVarsPopoverRequestClose}
                    maxHeightCap={props.envVarsPopover.maxHeightCap}
                    maxWidthCap={props.envVarsPopover.maxWidthCap}
                />
            ) : null}
        </>
    );
}
