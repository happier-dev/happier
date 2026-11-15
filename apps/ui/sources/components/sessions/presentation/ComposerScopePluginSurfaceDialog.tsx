import * as React from 'react';
import { View } from 'react-native';

import {
    createComposerControlSurfaceListRootStep,
    createComposerControlSurfaceSplitOptions,
    type ComposerControlSurfaceLayoutContent,
} from '@/components/plugins/actions/pluginContributedActionComposerChips';
import { AgentInputChipPickerSurface } from '@/components/sessions/agentInput/components/AgentInputChipPickerSurface';
import { PluginSurfaceStateTitleContext } from '@/components/plugins/shared/pluginSurfaceStateTitle';
import { SelectionList } from '@/components/ui/selectionList';
import type { CustomModalInjectedProps } from '@/modal';

// The modal card owns the width (its preset, fitted to the window); the surface only caps how wide it reads.
const dialogFrameStyle = { maxWidth: 720 } as const;
const contentDialogFillStyle = { ...dialogFrameStyle, flex: 1 } as const;

export function ComposerScopePluginSurfaceDialog(props: CustomModalInjectedProps & Readonly<{
    title: string;
    layout?: 'content' | 'list' | 'split';
    surfaceKey?: string;
    accessibilityLabel?: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const [surfaceStateTitle, setSurfaceStateTitle] = React.useState<string | null>(null);
    const title = surfaceStateTitle ?? props.title;
    React.useEffect(() => {
        props.setChrome?.({
            kind: 'card',
            title,
            scrollHost: 'body',
            // A declared layout means the surface owns its scrolling: `content`
            // fills the bounded body and scrolls its own List, as the list and
            // split shells do. Only an undeclared dialog (a chip's preview)
            // lets the modal body scroll for it.
            bodyScroll: props.layout === undefined ? 'auto' : 'none',
        });
        return () => props.setChrome?.(null);
    }, [props.layout, props.setChrome, title]);

    const layoutContent: ComposerControlSurfaceLayoutContent = {
        surfaceKey: props.surfaceKey ?? `composer-surface-dialog:${props.title}`,
        label: props.title,
        accessibilityLabel: props.accessibilityLabel ?? props.title,
        renderContent: () => props.children,
    };
    const content = props.layout === 'list'
        ? (
            <SelectionList
                rootStep={createComposerControlSurfaceListRootStep(layoutContent)}
                selectedOptionId={layoutContent.surfaceKey}
                onSelect={() => {
                    // The mounted surface owns its own interaction. The list
                    // shell only provides its semantic scrolling container.
                }}
                onRequestClose={props.onClose}
                optionsHostInlineControls
            />
        )
        : props.layout === 'split'
            ? (
                <AgentInputChipPickerSurface
                    title=""
                    showCloseButton={false}
                    options={createComposerControlSurfaceSplitOptions(layoutContent)}
                    selectedOptionId={layoutContent.surfaceKey}
                    onSelect={() => {
                        // The mounted surface owns its own interaction. The
                        // rail only selects its incumbent detail presentation.
                    }}
                    onRequestClose={props.onClose}
                />
            )
            : props.children;

    return (
        <PluginSurfaceStateTitleContext.Provider value={setSurfaceStateTitle}>
            <View style={props.layout === 'content' ? contentDialogFillStyle : dialogFrameStyle}>
                {content}
            </View>
        </PluginSurfaceStateTitleContext.Provider>
    );
}
