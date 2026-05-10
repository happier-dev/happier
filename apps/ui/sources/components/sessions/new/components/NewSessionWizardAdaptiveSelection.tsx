import * as React from 'react';
import { View, type View as RNView } from 'react-native';

import { AgentInputContentPopover, type AgentInputContentPopoverConfig } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ResolvedAdaptiveSelectionPresentation } from '@/components/ui/selection/AdaptiveSelectionSection';
import type { NewSessionWizardSectionPresentation } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';

export function resolveWizardAdaptivePresentation(
    value: NewSessionWizardSectionPresentation | undefined,
    autoPresentation: ResolvedAdaptiveSelectionPresentation,
): ResolvedAdaptiveSelectionPresentation {
    if (value === 'list') return 'expanded';
    if (value === 'dropdown') return 'compact';
    return autoPresentation;
}

export function NewSessionWizardPopoverItem(props: Readonly<{
    testID: string;
    title: string;
    subtitle?: string | null;
    icon: React.ReactNode;
    popover?: AgentInputContentPopoverConfig;
    boundaryRef: React.RefObject<RNView>;
}>) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<RNView>(null);
    return (
        <ItemGroup title="">
            <View ref={anchorRef} collapsable={false}>
                <Item
                    testID={props.testID}
                    title={props.title}
                    subtitle={props.subtitle ?? undefined}
                    leftElement={props.icon}
                    showChevron={true}
                    disabled={!props.popover}
                    onPress={() => {
                        if (!props.popover) return;
                        setOpen(true);
                    }}
                />
                {props.popover ? (
                    <AgentInputContentPopover
                        open={open}
                        anchorRef={anchorRef}
                        boundaryRef={props.popover.boundaryRef ?? props.boundaryRef}
                        content={props.popover.renderContent}
                        maxHeightCap={props.popover.maxHeightCap}
                        maxWidthCap={props.popover.maxWidthCap}
                        scrollEnabled={props.popover.scrollEnabled}
                        keyboardShouldPersistTaps={props.popover.keyboardShouldPersistTaps}
                        edgeFades={props.popover.edgeFades}
                        edgeIndicators={props.popover.edgeIndicators}
                        initialVisibility={props.popover.initialVisibility}
                        onRequestClose={() => setOpen(false)}
                    />
                ) : null}
            </View>
        </ItemGroup>
    );
}

export function NewSessionWizardDropdownSelectionItem(props: Readonly<{
    testID: string;
    title: string;
    subtitle?: string | null;
    icon: React.ReactNode;
    items: readonly DropdownMenuItem[];
    selectedId?: string | null;
    search?: boolean;
    searchPlaceholder?: string;
    boundaryRef: React.RefObject<RNView>;
    onSelect: (id: string) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    return (
        <ItemGroup title="">
            <DropdownMenu
                open={open}
                onOpenChange={setOpen}
                items={props.items}
                selectedId={props.selectedId}
                onSelect={props.onSelect}
                rowKind="item"
                variant="selectable"
                search={props.search}
                searchPlaceholder={props.searchPlaceholder}
                showCategoryTitles={false}
                matchTriggerWidth
                connectToTrigger
                popoverBoundaryRef={props.boundaryRef}
                itemTrigger={{
                    title: props.title,
                    subtitle: props.subtitle ?? undefined,
                    showSelectedDetail: false,
                    showSelectedSubtitle: false,
                    icon: props.icon,
                    itemProps: { testID: props.testID },
                }}
            />
        </ItemGroup>
    );
}
